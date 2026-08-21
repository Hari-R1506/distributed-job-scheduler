import { EVENTS, TIMING } from '@djs/core';
import {
  promoteDueJobs,
  reapExpiredLeases,
  markDeadWorkers,
  JOBS_READY_CHANNEL,
  type PrismaClient,
} from '@djs/db';
import { LeaderElection } from './leader-election.js';
import { materializeDueSchedules } from './cron-materializer.js';
import { rollupMetrics, runRetention, purgeOldJobs } from './maintenance.js';

export interface SchedulerLog {
  debug(o: object, m?: string): void;
  info(o: object, m?: string): void;
  warn(o: object, m?: string): void;
  error(o: object, m?: string): void;
}

const silent: SchedulerLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

export interface SchedulerOptions {
  prisma: PrismaClient;
  databaseUrl: string;
  tickMs?: number;
  promoteBatch?: number;
  reapBatch?: number;
  workerTimeoutMs?: number;
  retention?: { jobLogDays: number; heartbeatHours: number; deadWorkerDays: number };
  log?: SchedulerLog;
  /** Skip leader election. Tests only — never in a process that ships. */
  assumeLeadership?: boolean;
}

export interface TickStats {
  promoted: number;
  cronJobs: number;
  reaped: number;
  deadWorkers: number;
}

/**
 * The scheduler.
 *
 * Everything here is TIME-DRIVEN rather than event-driven, and everything here
 * is globally singular — hence leadership. Followers idle, ready to take over.
 *
 * The failure mode is deliberately "late, never lost": if the scheduler is
 * down, scheduled jobs sit in SCHEDULED and fire when it returns. Nothing is
 * dropped, and job CLAIMING is entirely unaffected — workers talk to Postgres
 * directly, so a dead scheduler cannot stop work already queued.
 */
export class Scheduler {
  private readonly log: SchedulerLog;
  private readonly tickMs: number;
  private election?: LeaderElection;
  private fastTimer?: NodeJS.Timeout;
  private slowTimer?: NodeJS.Timeout;
  private ticking = false;
  private slowTicking = false;
  private stopped = false;

  constructor(private readonly opts: SchedulerOptions) {
    this.log = opts.log ?? silent;
    this.tickMs = opts.tickMs ?? TIMING.SCHEDULER_TICK_MS;
  }

  get isLeader(): boolean {
    return this.opts.assumeLeadership === true || this.election?.isLeader === true;
  }

  async start(): Promise<void> {
    this.stopped = false;

    if (!this.opts.assumeLeadership) {
      this.election = new LeaderElection({
        databaseUrl: this.opts.databaseUrl,
        onAcquired: () =>
          this.log.info({ event: EVENTS.SCHEDULER_LEADER_ACQUIRED }, 'became scheduler leader'),
        onLost: (reason) =>
          this.log.warn({ event: EVENTS.SCHEDULER_LEADER_LOST, reason }, 'lost leadership'),
        onError: (err) => this.log.error({ err: String(err) }, 'leader election failed'),
      });
      await this.election.start();
    }

    // Fast loop: promotion, cron, reaping. Every second.
    this.fastTimer = setInterval(() => void this.tick(), this.tickMs);
    this.fastTimer.unref?.();

    // Slow loop: metrics rollup and retention. Every minute — running these at
    // 1Hz would be pure waste, since the rollup granularity IS one minute.
    this.slowTimer = setInterval(() => void this.slowTick(), 60_000);
    this.slowTimer.unref?.();
  }

  /** One pass of the time-driven work. Public so tests can drive it directly. */
  async tick(): Promise<TickStats> {
    const empty: TickStats = { promoted: 0, cronJobs: 0, reaped: 0, deadWorkers: 0 };
    // Overlapping ticks would double-reap and double-promote. A slow database
    // must make ticks less frequent, never concurrent.
    if (this.ticking || this.stopped || !this.isLeader) return empty;

    this.ticking = true;
    const { prisma } = this.opts;
    const stats = { ...empty };

    try {
      // ── 1. SCHEDULED | RETRYING -> QUEUED ──
      const promoted = await promoteDueJobs(prisma, this.opts.promoteBatch ?? 500);
      stats.promoted = promoted.count;
      if (promoted.count > 0) {
        await this.notifyQueues(promoted.queueIds);
        this.log.debug(
          { event: EVENTS.SCHEDULER_PROMOTED, count: promoted.count },
          'promoted due jobs',
        );
      }

      // ── 2. Fire due cron schedules ──
      const cron = await materializeDueSchedules(prisma);
      stats.cronJobs = cron.jobsCreated;
      if (cron.jobsCreated > 0) {
        await this.notifyQueues(cron.queueIds);
        this.log.info(
          {
            event: EVENTS.SCHEDULER_CRON_FIRED,
            schedules: cron.schedulesFired,
            jobs: cron.jobsCreated,
            skipped: cron.slotsSkipped,
          },
          'cron schedules fired',
        );
      }

      // ── 3. Recover jobs from dead or wedged workers ──
      const reaped = await reapExpiredLeases(prisma, this.opts.reapBatch ?? 200);
      stats.reaped = reaped.length;
      if (reaped.length > 0) {
        await this.notifyQueues([...new Set(reaped.map((r) => r.queue_id))]);
        this.log.warn(
          {
            event: EVENTS.SCHEDULER_REAPED,
            count: reaped.length,
            retried: reaped.filter((r) => r.can_retry).length,
            deadLettered: reaped.filter((r) => !r.can_retry).length,
          },
          'recovered jobs with expired leases',
        );
      }

      // ── 4. Mark workers that stopped heartbeating ──
      const dead = await markDeadWorkers(prisma, this.opts.workerTimeoutMs ?? TIMING.WORKER_TIMEOUT_MS);
      stats.deadWorkers = dead.length;
      if (dead.length > 0) {
        this.log.warn(
          { event: EVENTS.WORKER_HEARTBEAT_MISSED, workers: dead.map((d) => d.name) },
          'workers marked dead',
        );
      }
    } catch (err) {
      // A failed tick is survivable: nothing here is destructive, and the next
      // tick redoes the work. Crashing would forfeit leadership over a blip.
      this.log.error({ event: EVENTS.DB_UNAVAILABLE, err: String(err) }, 'scheduler tick failed');
    } finally {
      this.ticking = false;
    }

    return stats;
  }

  async slowTick(): Promise<void> {
    if (this.slowTicking || this.stopped || !this.isLeader) return;
    this.slowTicking = true;

    try {
      await rollupMetrics(this.opts.prisma);
      if (this.opts.retention) {
        const purged = await runRetention(this.opts.prisma, this.opts.retention);
        const jobs = await purgeOldJobs(this.opts.prisma);
        if (purged.jobLogs + purged.heartbeats + jobs.deleted > 0) {
          this.log.info({ ...purged, jobs: jobs.deleted }, 'retention purge');
        }
      }
    } catch (err) {
      this.log.error({ err: String(err) }, 'scheduler slow tick failed');
    } finally {
      this.slowTicking = false;
    }
  }

  /**
   * Wake listening workers.
   *
   * One NOTIFY per distinct QUEUE, not per job — 500 promoted jobs across 3
   * queues is 3 notifications, not 500. This is the latency optimisation; the
   * workers' poll timer is the correctness guarantee. If every notification
   * were lost the system would still be correct, only slower, which is the
   * right way round (ARCHITECTURE.md §29.2).
   */
  private async notifyQueues(queueIds: string[]): Promise<void> {
    for (const queueId of queueIds) {
      await this.opts.prisma
        .$executeRawUnsafe(`SELECT pg_notify($1, $2)`, JOBS_READY_CHANNEL, queueId)
        .catch(() => {});
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.fastTimer) clearInterval(this.fastTimer);
    if (this.slowTimer) clearInterval(this.slowTimer);
    this.fastTimer = undefined;
    this.slowTimer = undefined;
    // Release the advisory lock explicitly, so a rolling restart hands over
    // immediately instead of waiting for the socket to be torn down.
    await this.election?.stop();
  }
}
