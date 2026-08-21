import { hostname } from 'node:os';
import { assertTimingInvariants, TIMING } from '@djs/core';
import { claimJobs, type ClaimedJobRow, type PrismaClient } from '@djs/db';
import { ExecutorPool } from './executor-pool.js';
import { Heartbeat } from './heartbeat.js';
import { LogBuffer } from './log-buffer.js';
import { createMetrics, runJob, type WorkerMetrics } from './job-runner.js';
import type { HandlerRegistry } from './handlers/registry.js';

export interface WorkerOptions {
  prisma: PrismaClient;
  registry: HandlerRegistry;
  orgId: string;
  name: string;
  concurrency: number;
  /** Queue names to serve, or '*' for every queue in the org. */
  queues: string[] | '*';
  pollMinMs?: number;
  pollMaxMs?: number;
  heartbeatMs?: number;
  shutdownGraceMs?: number;
  log?: WorkerLog;
}

export interface WorkerLog {
  debug(o: object, m?: string): void;
  info(o: object, m?: string): void;
  warn(o: object, m?: string): void;
  error(o: object, m?: string): void;
}

const silentLog: WorkerLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

interface SubscribedQueue {
  id: string;
  name: string;
  dlqEnabled: boolean;
  visibilityTimeoutMs: number;
  weight: number;
}

export type WorkerState = 'STARTING' | 'ACTIVE' | 'DRAINING' | 'STOPPED';

/**
 * One worker process.
 *
 * Five loops, decoupled by a slot counter: the claim loop, the executor pool,
 * the heartbeat, the log flusher, and (in production) a NOTIFY listener. The
 * claim loop never waits on execution, and execution never holds a transaction.
 */
export class Worker {
  readonly metrics: WorkerMetrics = createMetrics();

  private readonly pool: ExecutorPool;
  private readonly log: WorkerLog;
  private readonly pollMinMs: number;
  private readonly pollMaxMs: number;
  private readonly shutdownGraceMs: number;
  private readonly heartbeatMs: number;

  private state: WorkerState = 'STARTING';
  private workerId!: string;
  private queues: SubscribedQueue[] = [];
  private heartbeat!: Heartbeat;
  private logBuffer!: LogBuffer;
  private pollDelayMs: number;
  private loopPromise?: Promise<void>;
  private wake?: () => void;
  private processedTotal = 0;

  constructor(private readonly opts: WorkerOptions) {
    this.pool = new ExecutorPool(opts.concurrency);
    this.log = opts.log ?? silentLog;
    this.pollMinMs = opts.pollMinMs ?? 250;
    this.pollMaxMs = opts.pollMaxMs ?? 2_000;
    this.heartbeatMs = opts.heartbeatMs ?? TIMING.HEARTBEAT_INTERVAL_MS;
    this.shutdownGraceMs = opts.shutdownGraceMs ?? TIMING.SHUTDOWN_GRACE_MS;
    this.pollDelayMs = this.pollMinMs;
  }

  get id(): string {
    return this.workerId;
  }

  get status(): WorkerState {
    return this.state;
  }

  get activeCount(): number {
    return this.pool.activeCount;
  }

  /**
   * Registration, subscription resolution, and validation.
   *
   * Everything that can be wrong with the configuration is detected HERE and
   * fails loudly. A worker that starts with a bad config and silently claims
   * nothing is far worse than one that refuses to boot.
   */
  async start(): Promise<void> {
    const { prisma, orgId, name, concurrency, registry } = this.opts;

    this.queues = await this.resolveQueues();
    if (this.queues.length === 0) {
      throw new Error(
        `Worker "${name}" resolved zero queues from ${JSON.stringify(this.opts.queues)}. ` +
          `A worker with no subscriptions would idle forever without saying why.`,
      );
    }

    // The timing invariant that makes crash recovery safe, checked against the
    // TIGHTEST lease among the subscribed queues (§14.1).
    assertTimingInvariants({
      heartbeatIntervalMs: this.heartbeatMs,
      workerTimeoutMs: TIMING.WORKER_TIMEOUT_MS,
      visibilityTimeoutMs: Math.min(...this.queues.map((q) => q.visibilityTimeoutMs)),
      shutdownGraceMs: this.shutdownGraceMs,
    });

    if (registry.names().length === 0) {
      throw new Error('Worker started with an empty handler registry');
    }

    const worker = await prisma.worker.create({
      data: {
        orgId,
        name,
        hostname: hostname(),
        pid: process.pid,
        version: process.env['npm_package_version'] ?? '1.0.0',
        status: 'STARTING',
        concurrency,
        metadata: { handlers: registry.names(), node: process.version },
      },
      select: { id: true },
    });
    this.workerId = worker.id;

    await prisma.workerSubscription.createMany({
      data: this.queues.map((q) => ({ workerId: this.workerId, queueId: q.id, weight: q.weight })),
      skipDuplicates: true,
    });

    this.logBuffer = new LogBuffer(prisma, {
      flushIntervalMs: TIMING.LOG_FLUSH_INTERVAL_MS,
      maxBuffered: TIMING.LOG_FLUSH_MAX_BUFFERED,
      onError: (err) => this.log.warn({ err: String(err) }, 'job log flush failed'),
    });
    this.logBuffer.start();

    this.heartbeat = new Heartbeat({
      prisma,
      workerId: this.workerId,
      intervalMs: this.heartbeatMs,
      visibilityTimeoutMs: Math.min(...this.queues.map((q) => q.visibilityTimeoutMs)),
      sample: () => ({
        activeJobCount: this.pool.activeCount,
        processedTotal: this.processedTotal,
      }),
      status: () => (this.state === 'STOPPED' ? 'DRAINING' : this.state),
      onError: (err) => this.log.warn({ err: String(err) }, 'heartbeat failed'),
    });
    this.heartbeat.start();

    this.state = 'ACTIVE';
    await prisma.worker.update({ where: { id: this.workerId }, data: { status: 'ACTIVE' } });

    this.log.info(
      {
        event: 'worker.registered',
        workerId: this.workerId,
        name,
        concurrency,
        queues: this.queues.map((q) => q.name),
      },
      'worker registered',
    );

    this.loopPromise = this.claimLoop();
  }

  /** Wake the claim loop early — driven by NOTIFY in production, by tests otherwise. */
  notify(): void {
    this.wake?.();
  }

  private async claimLoop(): Promise<void> {
    while (this.state === 'ACTIVE') {
      // A saturated worker issues ZERO claim queries. Polling while full is a
      // real and common failure: N busy workers hammering the database for
      // work they have no capacity to accept.
      if (this.pool.isSaturated()) {
        await this.pool.onSlotFree();
        continue;
      }

      let claimedAny = false;
      try {
        for (const queue of this.queues) {
          if (this.state !== 'ACTIVE') break;
          const free = this.pool.freeSlots();
          if (free === 0) break;

          const jobs = await claimJobs(this.opts.prisma, {
            queueId: queue.id,
            workerId: this.workerId,
            freeSlots: free,
            visibilityTimeoutMs: queue.visibilityTimeoutMs,
          });

          for (const job of jobs) {
            this.metrics.claimed++;
            claimedAny = true;
            this.dispatch(job, queue);
          }
        }
      } catch (err) {
        // Database trouble. In-flight jobs keep running — they only need the
        // database at completion — and we back off rather than spin.
        this.log.error({ event: 'db.unavailable', err: String(err) }, 'claim failed; backing off');
        await this.sleep(Math.min(this.pollDelayMs * 4, 30_000));
        continue;
      }

      if (claimedAny) {
        this.pollDelayMs = this.pollMinMs; // busy: poll aggressively
      } else {
        // Idle: back off toward pollMaxMs, jittered so a fleet of workers does
        // not synchronise onto the same tick.
        await this.waitForWork(this.jitter(this.pollDelayMs));
        this.pollDelayMs = Math.min(Math.round(this.pollDelayMs * 1.5), this.pollMaxMs);
      }
    }
  }

  private dispatch(job: ClaimedJobRow, queue: SubscribedQueue): void {
    this.pool.dispatch(job.id, async (signal) => {
      const outcome = await runJob(
        {
          prisma: this.opts.prisma,
          registry: this.opts.registry,
          workerId: this.workerId,
          metrics: this.metrics,
          logBuffer: this.logBuffer,
          log: this.log,
        },
        job,
        { name: queue.name, dlqEnabled: queue.dlqEnabled },
        signal,
      );
      if (outcome.status !== 'LEASE_LOST') this.processedTotal++;
    });
  }

  /** Sleep, but return early if `notify()` fires. */
  private waitForWork(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(finish, ms);
      this.wake = finish;
      function finish(): void {
        clearTimeout(timer);
        resolve();
      }
    });
  }

  private jitter(ms: number): number {
    return Math.round(ms * (0.5 + Math.random()));
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  /**
   * SIGTERM handling. The ordering matters, and step 2 is the one everybody
   * gets wrong.
   */
  async shutdown(): Promise<void> {
    if (this.state === 'STOPPED' || this.state === 'DRAINING') return;

    // 1. Stop claiming. The dashboard shows DRAINING immediately.
    this.state = 'DRAINING';
    this.wake?.();
    this.log.info(
      { event: 'worker.draining', workerId: this.workerId, inFlight: this.pool.activeCount },
      'draining',
    );
    await this.opts.prisma.worker
      .update({ where: { id: this.workerId }, data: { status: 'DRAINING' } })
      .catch(() => {});

    await this.loopPromise?.catch(() => {});

    // 2. KEEP HEARTBEATING. Stop here and the reaper reclaims our in-flight
    //    jobs while we are still running them — causing, on every single
    //    deploy, exactly the duplicate execution this design exists to prevent.
    //    The heartbeat is deliberately NOT stopped until step 4.

    // 3. Await in-flight work, bounded.
    const stragglers = await this.pool.drain(this.shutdownGraceMs);

    if (stragglers.length > 0) {
      // Past the deadline: abort, then release the leases explicitly so another
      // worker picks these up in ~0s rather than after the full lease timeout.
      this.log.warn(
        { workerId: this.workerId, stragglers: stragglers.length },
        'grace period expired; aborting and releasing leases',
      );
      this.pool.abortAll('SHUTDOWN');
      await this.pool.drain(2_000);
      await this.heartbeat.releaseLeases().catch(() => {});
    }

    // 4. Now it is safe to stop heartbeating.
    this.heartbeat.stop();
    await this.logBuffer.stop().catch(() => {});

    this.state = 'STOPPED';
    await this.opts.prisma.worker
      .update({
        where: { id: this.workerId },
        data: { status: 'STOPPED', stoppedAt: new Date(), activeJobCount: 0 },
      })
      .catch(() => {});

    this.log.info(
      { event: 'worker.stopped', workerId: this.workerId, ...this.metrics },
      'worker stopped',
    );
  }

  /**
   * Simulates SIGKILL: stop dead without draining, releasing leases, or
   * sending a final heartbeat. Recovery is left entirely to the reaper, which
   * is the point — graceful shutdown is an optimisation, the lease is the
   * guarantee.
   *
   * Every timer is stopped, including the log buffer's. A real SIGKILL takes
   * the process with it so nothing survives to misbehave; here the process
   * lives on, and a surviving interval would keep firing against a disconnected
   * client. Note it does NOT flush — buffered lines are lost, exactly as they
   * would be in a real crash.
   */
  async simulateCrash(): Promise<void> {
    this.state = 'STOPPED';
    this.wake?.();
    this.heartbeat.stop();
    this.logBuffer.abandon();
    this.pool.abortAll('CRASH');
  }

  private async resolveQueues(): Promise<SubscribedQueue[]> {
    const { prisma, orgId, queues } = this.opts;

    // `WORKER_QUEUES=*` means EVERY queue in the deployment, not just those in
    // the org this worker registered under.
    //
    // Scoping it to one org is the intuitive reading and it strands work: the
    // moment a second organization exists — which happens as soon as anyone
    // registers an account — queues in it have no worker, and the fleet sits
    // idle reporting itself healthy. `org_id` on `workers` is provenance for
    // the dashboard, not an execution boundary.
    //
    // Multi-tenant deployments would run a worker pool per tenant and name the
    // queues explicitly; that is a deployment decision, not a code one.
    const rows = await prisma.queue.findMany({
      where:
        queues === '*'
          ? {}
          : { project: { orgId }, name: { in: queues } },
      select: { id: true, name: true, dlqEnabled: true, visibilityTimeoutMs: true },
      orderBy: { name: 'asc' },
    });

    if (queues !== '*') {
      // An unrecognised queue name is a config error, not something to
      // silently ignore into an idle worker.
      const found = new Set(rows.map((r) => r.name));
      const missing = queues.filter((q) => !found.has(q));
      if (missing.length > 0) {
        throw new Error(`Unknown queue(s) in WORKER_QUEUES: ${missing.join(', ')}`);
      }
    }

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      dlqEnabled: r.dlqEnabled,
      visibilityTimeoutMs: r.visibilityTimeoutMs,
      weight: 100,
    }));
  }
}
