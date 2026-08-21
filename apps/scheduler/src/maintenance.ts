import { SQL, type PrismaClient } from '@djs/db';

/**
 * The scheduler's non-cron loops: metrics rollup and retention.
 *
 * Both are idempotent and safe to re-run, because a scheduler restart or a
 * leadership handover mid-tick must never corrupt or duplicate anything.
 */

/**
 * Aggregate the minute that just closed into `queue_metrics_minute`.
 *
 * NOT written by the job-completion transaction. Incrementing a counter there
 * would take a row lock on one row per queue, making that row the serialisation
 * point for every completion on the queue — a global mutex by accident.
 *
 * The cost is that dashboard metrics lag by up to 60s. That is the correct
 * trade, and it is the reason the throughput chart can answer "jobs per minute
 * over 24 hours" with a 1,440-row scan instead of aggregating millions of
 * execution rows on every dashboard load.
 */
export async function rollupMetrics(
  prisma: PrismaClient,
  opts: { now?: Date; minutes?: number } = {},
): Promise<{ bucketsWritten: number }> {
  const now = opts.now ?? new Date();
  // Re-run the last few minutes, not just one. A scheduler that was down for
  // 90 seconds would otherwise leave a permanent hole in the chart, and
  // ON CONFLICT DO UPDATE makes re-computing a closed bucket free.
  const minutes = opts.minutes ?? 3;

  const to = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  const from = new Date(to.getTime() - minutes * 60_000);

  const written = await prisma.$executeRawUnsafe(SQL.ROLLUP_MINUTE, from, to);
  return { bucketsWritten: written };
}

export interface RetentionOptions {
  jobLogDays: number;
  heartbeatHours: number;
  deadWorkerDays: number;
  batchSize?: number;
}

/**
 * Prune the append-only tables.
 *
 * `job_logs` is the highest-volume table in the system and the first thing to
 * become a problem — roughly 10 rows per job, so 10M rows at a million jobs.
 * Deleting in bounded batches keeps each transaction short; at real scale this
 * would be `PARTITION BY RANGE (logged_at)` so purging is `DROP PARTITION`
 * rather than a mass DELETE that generates enormous WAL and bloat.
 */
export async function runRetention(
  prisma: PrismaClient,
  opts: RetentionOptions,
): Promise<{ jobLogs: number; heartbeats: number; workers: number }> {
  const batch = opts.batchSize ?? 5_000;

  const jobLogs = await prisma.$executeRawUnsafe(
    `DELETE FROM job_logs
      WHERE id IN (
        SELECT id FROM job_logs
         WHERE logged_at < now() - make_interval(days => $1::int)
         LIMIT $2::int
      )`,
    opts.jobLogDays,
    batch,
  );

  const heartbeats = await prisma.$executeRawUnsafe(
    `DELETE FROM worker_heartbeats
      WHERE id IN (
        SELECT id FROM worker_heartbeats
         WHERE recorded_at < now() - make_interval(hours => $1::int)
         LIMIT $2::int
      )`,
    opts.heartbeatHours,
    batch,
  );

  // Worker rows are referenced by job_executions.worker_id (ON DELETE SET NULL),
  // so purging one loses the "which worker ran this" answer for old attempts.
  // Hence a long retention, and only for workers that are definitively gone.
  const workers = await prisma.$executeRawUnsafe(
    `DELETE FROM workers
      WHERE status IN ('DEAD','STOPPED')
        AND stopped_at < now() - make_interval(days => $1::int)`,
    opts.deadWorkerDays,
  );

  return { jobLogs, heartbeats, workers };
}

/**
 * Purge terminal jobs older than each queue's own `retention_days`.
 *
 * Opt-in per queue (null = keep forever). Cascades to executions, logs and DLQ
 * entries — which is why `dead_letter_jobs.payload_snapshot` exists: a DLQ
 * entry must stay replayable after the original job is gone.
 */
export async function purgeOldJobs(
  prisma: PrismaClient,
  batchSize = 2_000,
): Promise<{ deleted: number }> {
  const deleted = await prisma.$executeRawUnsafe(
    `DELETE FROM jobs
      WHERE id IN (
        SELECT j.id
          FROM jobs j JOIN queues q ON q.id = j.queue_id
         WHERE q.retention_days IS NOT NULL
           AND j.status IN ('COMPLETED','FAILED','CANCELLED')
           AND j.finished_at < now() - make_interval(days => q.retention_days)
         LIMIT $1::int
      )`,
    batchSize,
  );
  return { deleted };
}
