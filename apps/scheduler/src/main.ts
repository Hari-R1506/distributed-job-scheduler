import { hostname } from 'node:os';
import { createServer } from 'node:http';
import pino from 'pino';
import { REDACT_PATHS, TIMING } from '@djs/core';
import { createPrismaClient } from '@djs/db';
import { Scheduler } from './scheduler.js';

/**
 * Scheduler entrypoint.
 *
 * Every process started this way attempts leadership. Exactly one wins and runs
 * the time-driven loops; the rest idle as hot standbys. That means you can run
 * N of these and correctness does not depend on anyone remembering to run
 * exactly one (ARCHITECTURE.md §3.3).
 */
async function main(): Promise<void> {
  const cfg = readConfig();

  const log = pino({
    level: cfg.logLevel,
    redact: { paths: [...REDACT_PATHS], censor: '[redacted]' },
    base: { service: 'scheduler', host: hostname(), pid: process.pid },
    ...(cfg.pretty ? { transport: { target: 'pino-pretty', options: { colorize: true } } } : {}),
  });

  const prisma = createPrismaClient(cfg.databaseUrl, { connectionLimit: 3 });

  const scheduler = new Scheduler({
    prisma,
    databaseUrl: cfg.databaseUrl,
    tickMs: cfg.tickMs,
    promoteBatch: cfg.promoteBatch,
    reapBatch: cfg.reapBatch,
    workerTimeoutMs: cfg.workerTimeoutMs,
    retention: {
      jobLogDays: cfg.retentionJobLogDays,
      heartbeatHours: cfg.retentionHeartbeatHours,
      deadWorkerDays: cfg.retentionDeadWorkerDays,
    },
    log,
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) process.exit(1);
    shuttingDown = true;
    log.info({ signal }, 'signal received; releasing leadership');
    // Releasing the advisory lock explicitly means a standby takes over
    // immediately rather than waiting for the socket to be torn down.
    await scheduler.stop().catch(() => {});
    await prisma.$disconnect().catch(() => {});
    server.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  const server = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', leader: scheduler.isLeader }));
    } else if (req.url === '/ready') {
      void prisma
        .$queryRaw`SELECT 1`
        .then(() => res.writeHead(200).end('{"ready":true}'))
        .catch(() => res.writeHead(503).end('{"ready":false}'));
    } else if (req.url === '/metrics') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(
        [
          '# HELP djs_scheduler_is_leader 1 if this process holds the scheduler advisory lock.',
          '# TYPE djs_scheduler_is_leader gauge',
          `djs_scheduler_is_leader ${scheduler.isLeader ? 1 : 0}`,
          '',
        ].join('\n'),
      );
    } else {
      res.writeHead(404).end();
    }
  });
  server.listen(cfg.httpPort);

  await scheduler.start();
  log.info(
    { port: cfg.httpPort, tickMs: cfg.tickMs, leader: scheduler.isLeader },
    'scheduler ready',
  );
}

function readConfig() {
  const req = (key: string): string => {
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

  return {
    databaseUrl: req('DATABASE_URL'),
    tickMs: num('SCHEDULER_TICK_MS', TIMING.SCHEDULER_TICK_MS),
    promoteBatch: num('SCHEDULER_PROMOTE_BATCH', 500),
    reapBatch: num('SCHEDULER_REAP_BATCH', 200),
    workerTimeoutMs: num('WORKER_TIMEOUT_MS', TIMING.WORKER_TIMEOUT_MS),
    retentionJobLogDays: num('RETENTION_JOB_LOGS_DAYS', 7),
    retentionHeartbeatHours: num('RETENTION_HEARTBEATS_HOURS', 24),
    retentionDeadWorkerDays: num('RETENTION_DEAD_WORKERS_DAYS', 7),
    httpPort: num('SCHEDULER_HTTP_PORT', 3200),
    logLevel: process.env['LOG_LEVEL'] ?? 'info',
    pretty: process.env['NODE_ENV'] !== 'production',
  };
}

main().catch((err) => {
  console.error('Scheduler failed to start:', err);
  process.exit(1);
});
