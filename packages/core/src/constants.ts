/** Limits and invariants shared by every service. */

export const LIMITS = {
  /** `CHECK (pg_column_size(payload) <= 262144)`. The database is not a blob store. */
  PAYLOAD_MAX_BYTES: 256 * 1024,
  BATCH_MAX_JOBS: 1000,
  /** Guards against a typo scheduling something for the year 3000. */
  MAX_SCHEDULE_AHEAD_MS: 365 * 24 * 60 * 60 * 1000,
  JOB_TIMEOUT_MAX_MS: 60 * 60 * 1000,
  PAGE_SIZE_DEFAULT: 50,
  PAGE_SIZE_MAX: 200,
} as const;

export const DEFAULTS = {
  VISIBILITY_TIMEOUT_MS: 60_000,
  JOB_TIMEOUT_MS: 30_000,
  MAX_ATTEMPTS: 5,
  BACKOFF_BASE_MS: 5_000,
  BACKOFF_MAX_MS: 300_000,
  JITTER_PCT: 10,
  QUEUE_MAX_CONCURRENCY: 5,
} as const;

export const TIMING = {
  HEARTBEAT_INTERVAL_MS: 5_000,
  /** 6 missed beats. */
  WORKER_TIMEOUT_MS: 30_000,
  /** Every third heartbeat writes a sample row to worker_heartbeats. */
  HEARTBEAT_SAMPLE_EVERY: 3,
  SCHEDULER_TICK_MS: 1_000,
  REAPER_INTERVAL_MS: 5_000,
  LOG_FLUSH_INTERVAL_MS: 1_000,
  LOG_FLUSH_MAX_BUFFERED: 100,
  SHUTDOWN_GRACE_MS: 30_000,
} as const;

/**
 * The timing invariant that makes crash recovery safe.
 *
 * A worker must be declared DEAD before its jobs are reclaimed. If the lease
 * expired first, the reaper would take jobs from a worker that is merely a few
 * seconds slow — causing exactly the duplicate execution this design exists to
 * prevent. The 2x gap absorbs GC pauses, brief network hiccups and clock skew.
 *
 * Validated at boot in every process: a config violating it is a correctness
 * bug, so we refuse to start rather than run subtly wrong.
 * See ARCHITECTURE.md §14.1.
 */
export function assertTimingInvariants(cfg: {
  heartbeatIntervalMs: number;
  workerTimeoutMs: number;
  visibilityTimeoutMs: number;
  shutdownGraceMs: number;
}): void {
  const problems: string[] = [];

  if (cfg.workerTimeoutMs <= cfg.heartbeatIntervalMs * 2) {
    problems.push(
      `WORKER_TIMEOUT_MS (${cfg.workerTimeoutMs}) must exceed 2x HEARTBEAT_MS (${cfg.heartbeatIntervalMs}) ` +
        `so a single missed beat never marks a healthy worker dead`,
    );
  }
  if (cfg.visibilityTimeoutMs <= cfg.workerTimeoutMs) {
    problems.push(
      `visibility_timeout_ms (${cfg.visibilityTimeoutMs}) must exceed WORKER_TIMEOUT_MS (${cfg.workerTimeoutMs}) ` +
        `so a worker is declared dead BEFORE its jobs are reclaimed`,
    );
  }
  if (cfg.shutdownGraceMs >= cfg.visibilityTimeoutMs) {
    problems.push(
      `WORKER_SHUTDOWN_GRACE_MS (${cfg.shutdownGraceMs}) must be under visibility_timeout_ms ` +
        `(${cfg.visibilityTimeoutMs}) so a draining worker cannot outlive its own lease`,
    );
  }

  if (problems.length > 0) {
    throw new Error(`Timing invariant violated — refusing to start:\n  - ${problems.join('\n  - ')}`);
  }
}

/** Structured log `event` values. A fixed taxonomy makes logs queryable. */
export const EVENTS = {
  JOB_CREATED: 'job.created',
  JOB_CLAIMED: 'job.claimed',
  JOB_STARTED: 'job.started',
  JOB_COMPLETED: 'job.completed',
  JOB_FAILED: 'job.failed',
  JOB_RETRY_SCHEDULED: 'job.retry_scheduled',
  JOB_DEAD_LETTERED: 'job.dead_lettered',
  /** Emitted when a conditional write matches zero rows: this worker lost a
   *  job it believed it owned. The counter behind it must stay at 0. */
  JOB_LEASE_LOST: 'job.lease_lost',
  WORKER_REGISTERED: 'worker.registered',
  WORKER_HEARTBEAT_MISSED: 'worker.heartbeat_missed',
  WORKER_DRAINING: 'worker.draining',
  WORKER_STOPPED: 'worker.stopped',
  SCHEDULER_LEADER_ACQUIRED: 'scheduler.leader_acquired',
  SCHEDULER_LEADER_LOST: 'scheduler.leader_lost',
  SCHEDULER_PROMOTED: 'scheduler.promoted',
  SCHEDULER_CRON_FIRED: 'scheduler.cron_fired',
  SCHEDULER_REAPED: 'scheduler.reaped',
  QUEUE_PAUSED: 'queue.paused',
  QUEUE_RESUMED: 'queue.resumed',
  DB_UNAVAILABLE: 'db.unavailable',
} as const;

/**
 * Never written to application logs. Payloads are user data of unknown
 * sensitivity — API keys, PII, tokens — and a log aggregator is the last place
 * they should land. Logs carry payload_size_bytes and a payload hash instead.
 */
export const REDACT_PATHS = [
  'password',
  'passwordHash',
  'token',
  'accessToken',
  'refreshToken',
  'secret',
  'authorization',
  'apiKey',
  'api_key',
  'card',
  'ssn',
  '*.password',
  '*.token',
  '*.secret',
  '*.authorization',
] as const;
