import { hostname } from 'node:os';
import { createServer } from 'node:http';
import pino from 'pino';
import { REDACT_PATHS, TIMING } from '@djs/core';
import { createPrismaClient } from '@djs/db';
import { Worker } from './worker.js';
import { createDefaultRegistry } from './handlers/registry.js';
import { startNotifyListener } from './notify-listener.js';

/**
 * Worker entrypoint.
 *
 * Signal handlers are installed BEFORE the first claim — a signal arriving in
 * the first second must still drain cleanly rather than being unhandled.
 */
async function main(): Promise<void> {
  const cfg = readConfig();

  const log = pino({
    level: cfg.logLevel,
    // Payloads are never logged (§20.3); this catches anything that slips into
    // a structured field by accident.
    redact: { paths: [...REDACT_PATHS], censor: '[redacted]' },
    base: { service: 'worker', worker: cfg.name, host: hostname(), pid: process.pid },
    ...(cfg.pretty ? { transport: { target: 'pino-pretty', options: { colorize: true } } } : {}),
  });

  const prisma = createPrismaClient(cfg.databaseUrl, {
    // One connection per concurrent job's short transactions, plus heartbeat
    // and log flusher. The LISTEN connection is separate and unpooled.
    connectionLimit: cfg.concurrency + 3,
  });

  // Workers register themselves through the DATABASE, not over HTTP. There is
  // no API dependency at all — a worker that can only reach Postgres is still
  // fully functional, which keeps the API off the critical path of execution.
  // Serve the organization that actually HAS queues, not merely the oldest one.
  //
  // Picking the oldest looks equivalent and is not: register an account in the
  // UI and you create a second, empty organization. If a worker latched onto
  // whichever org happened to exist first, it would sit idle next to a queue
  // full of work and report itself perfectly healthy — the worst kind of
  // failure, because nothing looks broken.
  const [busiest] = await prisma.$queryRaw<{ id: string; name: string; queues: bigint }[]>`
    SELECT o.id, o.name, count(q.id) AS queues
      FROM organizations o
      LEFT JOIN projects p ON p.org_id = o.id
      LEFT JOIN queues   q ON q.project_id = p.id
     GROUP BY o.id, o.name
     ORDER BY count(q.id) DESC, o.created_at ASC
     LIMIT 1`;

  if (!busiest) {
    log.error(
      'No organization exists yet. Register an account, or run `npm run seed`, before starting a worker.',
    );
    process.exit(1);
  }

  const org = busiest;
  if (Number(busiest.queues) === 0) {
    log.warn(
      { org: org.name },
      'the selected organization has no queues yet — this worker will idle until one is created',
    );
  }

  const worker = new Worker({
    prisma,
    registry: createDefaultRegistry(),
    orgId: org.id,
    name: cfg.name,
    concurrency: cfg.concurrency,
    queues: cfg.queues,
    pollMinMs: cfg.pollMinMs,
    pollMaxMs: cfg.pollMaxMs,
    heartbeatMs: cfg.heartbeatMs,
    shutdownGraceMs: cfg.shutdownGraceMs,
    log,
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      // A second signal means the operator means it. Obey rather than ignore.
      log.warn({ signal }, 'second signal received; exiting immediately');
      process.exit(1);
    }
    shuttingDown = true;
    log.info({ signal }, 'signal received; draining');
    await worker.shutdown().catch((err) => log.error({ err: String(err) }, 'shutdown failed'));
    await stopListener?.();
    await prisma.$disconnect().catch(() => {});
    server.close();
    process.exit(0);
  };

  // Installed before start(), deliberately.
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // /health never touches the database: a database blip must not get a healthy
  // process restarted, which would turn an outage into a worse one.
  const server = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', state: worker.status, active: worker.activeCount }));
    } else if (req.url === '/ready') {
      void prisma
        .$queryRaw`SELECT 1`
        .then(() => {
          res.writeHead(worker.status === 'ACTIVE' ? 200 : 503, {
            'content-type': 'application/json',
          });
          res.end(JSON.stringify({ ready: worker.status === 'ACTIVE', state: worker.status }));
        })
        .catch(() => {
          res.writeHead(503).end('{"ready":false}');
        });
    } else if (req.url === '/drain' && req.method === 'POST') {
      // Trigger a graceful drain without a signal — handy in Compose and tests.
      res.writeHead(202).end('{"draining":true}');
      void shutdown('HTTP /drain');
    } else if (req.url === '/metrics') {
      const m = worker.metrics;
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(
        [
          `# TYPE djs_worker_jobs_claimed_total counter`,
          `djs_worker_jobs_claimed_total ${m.claimed}`,
          `# TYPE djs_worker_jobs_completed_total counter`,
          `djs_worker_jobs_completed_total ${m.completed}`,
          `# TYPE djs_worker_jobs_failed_total counter`,
          `djs_worker_jobs_failed_total ${m.failed}`,
          `# TYPE djs_worker_jobs_dead_lettered_total counter`,
          `djs_worker_jobs_dead_lettered_total ${m.deadLettered}`,
          `# HELP djs_duplicate_execution_detected_total A worker lost a lease it believed it held. Must stay 0.`,
          `# TYPE djs_duplicate_execution_detected_total counter`,
          `djs_duplicate_execution_detected_total ${m.duplicateExecutionDetected}`,
          `# TYPE djs_worker_active_jobs gauge`,
          `djs_worker_active_jobs ${worker.activeCount}`,
          '',
        ].join('\n'),
      );
    } else {
      res.writeHead(404).end();
    }
  });
  server.listen(cfg.httpPort);

  await worker.start();

  // NOTIFY is the latency optimisation; the worker's poll timer is the
  // correctness guarantee. If every notification were lost the system would
  // still be correct, only slower.
  const stopListener = await startNotifyListener({
    databaseUrl: cfg.databaseUrl,
    onNotify: () => worker.notify(),
    onError: (err) => log.warn({ err: String(err) }, 'notify listener error'),
  });

  log.info({ port: cfg.httpPort }, 'worker ready');
}

function readConfig() {
  const require = (key: string): string => {
    const v = process.env[key];
    if (!v) throw new Error(`Missing required environment variable: ${key}`);
    return v;
  };
  const num = (key: string, fallback: number): number => {
    const raw = process.env[key];
    if (!raw) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error(`${key} must be a number, got "${raw}"`);
    return n;
  };

  const queuesRaw = process.env['WORKER_QUEUES'] ?? '*';

  return {
    databaseUrl: require('DATABASE_URL'),
    name: process.env['WORKER_NAME'] ?? `worker-${hostname()}-${process.pid}`,
    concurrency: num('WORKER_CONCURRENCY', 10),
    queues: (queuesRaw === '*'
      ? '*'
      : queuesRaw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)) as string[] | '*',
    pollMinMs: num('WORKER_POLL_MIN_MS', 250),
    pollMaxMs: num('WORKER_POLL_MAX_MS', 2_000),
    heartbeatMs: num('WORKER_HEARTBEAT_MS', TIMING.HEARTBEAT_INTERVAL_MS),
    shutdownGraceMs: num('WORKER_SHUTDOWN_GRACE_MS', TIMING.SHUTDOWN_GRACE_MS),
    httpPort: num('WORKER_HTTP_PORT', 3100),
    logLevel: process.env['LOG_LEVEL'] ?? 'info',
    pretty: process.env['NODE_ENV'] !== 'production',
  };
}

main().catch((err) => {
  // Fail loudly and immediately. A worker that starts with a bad config and
  // silently claims nothing is far worse than one that refuses to boot.
  console.error('Worker failed to start:', err);
  process.exit(1);
});
