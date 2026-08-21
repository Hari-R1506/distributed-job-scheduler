import type { Prisma, PrismaClient } from '@prisma/client';
import {
  computeBackoffMs,
  classifyError,
  shouldRetry,
  errorSignature,
  truncateError,
  ERROR_MESSAGE_MAX_BYTES,
  ERROR_STACK_MAX_BYTES,
  type BackoffContract,
} from '@djs/core';
import { SQL } from '../sql.js';

/**
 * Every write that moves a job through its lifecycle lives here, so the
 * conditional-write discipline is applied in exactly one place rather than
 * re-derived at each call site.
 *
 * THE RULE that makes all of this safe: every transition out of an in-flight
 * state carries `AND worker_id = $me AND status = $expected`. Zero rows updated
 * means "I no longer own this job" — the reaper took it while I was slow — and
 * the worker must abandon its result rather than write it.
 *
 * See ARCHITECTURE.md §6.2 and §22.
 */

/** Raw row shape returned by `RETURNING j.*`. Snake_case, straight from SQL. */
export interface ClaimedJobRow {
  id: string;
  queue_id: string;
  project_id: string;
  handler: string;
  payload: unknown;
  priority: number;
  status: string;
  run_at: Date;
  attempt_count: number;
  max_attempts: number;
  backoff_strategy: 'FIXED' | 'LINEAR' | 'EXPONENTIAL';
  backoff_base_ms: number;
  backoff_max_ms: number;
  backoff_jitter_pct: number;
  timeout_ms: number;
  worker_id: string | null;
  lease_expires_at: Date | null;
  idempotency_key: string | null;
  request_id: string | null;
}

export function backoffContractOf(job: ClaimedJobRow): BackoffContract {
  return {
    strategy: job.backoff_strategy,
    baseDelayMs: job.backoff_base_ms,
    maxDelayMs: job.backoff_max_ms,
    jitterPct: job.backoff_jitter_pct,
  };
}

export interface ClaimParams {
  queueId: string;
  workerId: string;
  freeSlots: number;
  visibilityTimeoutMs: number;
}

/**
 * Claim up to `freeSlots` jobs from one queue.
 *
 * Runs in a single short transaction (1-3ms): advisory lock, capacity check,
 * SKIP LOCKED selection, claim. The transaction is CLOSED before the handler
 * runs — execution never happens inside a transaction.
 *
 * The advisory lock is what makes the per-queue concurrency count exact.
 * SKIP LOCKED alone cannot enforce it: two workers lock DIFFERENT rows, so
 * there is no row-level conflict to detect — the conflict is over an aggregate,
 * and aggregates are not lockable. See ARCHITECTURE.md §7 and §8.2.
 */
export async function claimJobs(
  prisma: PrismaClient,
  { queueId, workerId, freeSlots, visibilityTimeoutMs }: ClaimParams,
): Promise<ClaimedJobRow[]> {
  if (freeSlots <= 0) return [];

  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(SQL.CLAIM_LOCK, queueId);
      return tx.$queryRawUnsafe<ClaimedJobRow[]>(
        SQL.CLAIM_JOBS,
        queueId,
        workerId,
        freeSlots,
        visibilityTimeoutMs,
      );
    },
    // Deliberately tight. This transaction holds a per-queue advisory lock; if
    // it ever ran long it would stall every other claimer on that queue. A
    // timeout here is a bug worth surfacing loudly, not waiting out.
    { timeout: 5_000, maxWait: 5_000 },
  );
}

export interface StartResult {
  executionId: bigint;
}

/**
 * CLAIMED -> RUNNING, plus the execution row, atomically.
 *
 * Returns null when the guard matches zero rows, which is how a worker
 * discovers its lease was revoked while the job waited for a free slot. The
 * caller MUST drop the job without invoking the handler — this single check is
 * what prevents the duplicate execution the reaper would otherwise cause.
 */
export async function markRunning(
  prisma: PrismaClient,
  job: ClaimedJobRow,
  workerId: string,
): Promise<StartResult | null> {
  return prisma.$transaction(async (tx) => {
    const updated = await tx.$executeRaw`
      UPDATE jobs
         SET status = 'RUNNING', started_at = now(), updated_at = now()
       WHERE id = ${job.id}::uuid
         AND worker_id = ${workerId}::uuid
         AND status = 'CLAIMED'`;

    if (updated === 0) return null;

    const rows = await tx.$queryRaw<{ id: bigint }[]>`
      INSERT INTO job_executions (job_id, attempt, worker_id, status, started_at, created_at)
      VALUES (${job.id}::uuid, ${job.attempt_count}, ${workerId}::uuid, 'RUNNING', now(), now())
      RETURNING id`;

    return { executionId: rows[0]!.id };
  });
}

/**
 * RUNNING -> COMPLETED.
 *
 * Returns false when the lease was lost. The caller increments
 * `duplicate_execution_detected_total` and discards the result — the job is
 * already being handled elsewhere, and writing here would corrupt its history.
 */
export async function completeJob(
  prisma: PrismaClient,
  params: {
    job: ClaimedJobRow;
    workerId: string;
    executionId: bigint;
    result: unknown;
    durationMs: number;
  },
): Promise<boolean> {
  const { job, workerId, executionId, result, durationMs } = params;
  const resultJson = (result ?? null) as Prisma.InputJsonValue | null;

  try {
    await prisma.$transaction(async (tx) => {
      // The job is updated FIRST, so the guard decides the whole transaction
      // before any history is written.
      const updated = await tx.$executeRaw`
        UPDATE jobs
           SET status = 'COMPLETED',
               finished_at = now(),
               worker_id = NULL,
               lease_expires_at = NULL,
               result = ${resultJson}::jsonb,
               last_error_code = NULL,
               last_error_message = NULL,
               updated_at = now()
         WHERE id = ${job.id}::uuid
           AND worker_id = ${workerId}::uuid
           AND status = 'RUNNING'`;

      if (updated === 0) throw new LeaseLostError(job.id);

      await tx.$executeRaw`
        UPDATE job_executions
           SET status = 'SUCCEEDED', finished_at = now(),
               duration_ms = ${durationMs}, result = ${resultJson}::jsonb
         WHERE id = ${executionId}`;
    });
    return true;
  } catch (err) {
    if (err instanceof LeaseLostError) return false;
    throw err;
  }
}

export class LeaseLostError extends Error {
  readonly code = 'LEASE_LOST';
  constructor(readonly jobId: string) {
    super(`Lease lost for job ${jobId}; another worker owns it now.`);
    this.name = 'LeaseLostError';
  }
}

export type FailureOutcome = 'RETRYING' | 'DEAD_LETTER' | 'FAILED' | 'LEASE_LOST';

/**
 * RUNNING -> RETRYING | DEAD_LETTER | FAILED, in one transaction.
 *
 * The retry decision and the failure record must be atomic: a crash between
 * them would lose the job entirely.
 *
 * NOTE the worker does not sleep. It computes the next `run_at`, writes it, and
 * frees its slot immediately. Sleeping through the backoff would hold a
 * concurrency slot for the entire window — the most common design mistake in
 * this problem.
 */
export async function failJob(
  prisma: PrismaClient,
  params: {
    job: ClaimedJobRow;
    workerId: string;
    executionId: bigint | null;
    error: unknown;
    durationMs: number;
    dlqEnabled: boolean;
    retryOnErrorCodes?: readonly string[];
  },
): Promise<FailureOutcome> {
  const { job, workerId, executionId, error, durationMs, dlqEnabled } = params;

  const classification = classifyError(error);
  const willRetry = shouldRetry(
    classification,
    job.attempt_count,
    job.max_attempts,
    params.retryOnErrorCodes ?? [],
  );

  // A 429 tells us when to come back; honour it as a floor on the backoff
  // rather than retrying into the same rate limit.
  const backoffMs = willRetry
    ? Math.max(
        computeBackoffMs(backoffContractOf(job), job.attempt_count),
        classification.retryAfterMs ?? 0,
      )
    : 0;

  const nextStatus: Exclude<FailureOutcome, 'LEASE_LOST'> = willRetry
    ? 'RETRYING'
    : dlqEnabled
      ? 'DEAD_LETTER'
      : 'FAILED';

  const message = truncateError(classification.message, ERROR_MESSAGE_MAX_BYTES) ?? null;
  const stack =
    truncateError(error instanceof Error ? error.stack : undefined, ERROR_STACK_MAX_BYTES) ?? null;
  const execStatus = classification.code === 'TIMEOUT' ? 'TIMED_OUT' : 'FAILED';

  try {
    await prisma.$transaction(async (tx) => {
      const updated = await tx.$executeRawUnsafe(
        `UPDATE jobs
            SET status = $1::job_status,
                run_at = CASE WHEN $2::boolean
                              THEN now() + make_interval(secs => $3::numeric / 1000.0)
                              ELSE run_at END,
                finished_at = CASE WHEN $2::boolean THEN NULL ELSE now() END,
                worker_id = NULL,
                lease_expires_at = NULL,
                last_error_code = $4,
                last_error_message = $5,
                updated_at = now()
          WHERE id = $6::uuid
            AND worker_id = $7::uuid
            AND status = 'RUNNING'`,
        nextStatus,
        willRetry,
        backoffMs,
        classification.code,
        message,
        job.id,
        workerId,
      );

      if (updated === 0) throw new LeaseLostError(job.id);

      if (executionId !== null) {
        await tx.$executeRawUnsafe(
          `UPDATE job_executions
              SET status = $1::execution_status, finished_at = now(),
                  duration_ms = $2, error_code = $3, error_message = $4, error_stack = $5
            WHERE id = $6`,
          execStatus,
          durationMs,
          classification.code,
          message,
          stack,
          executionId,
        );
      }

      if (nextStatus === 'DEAD_LETTER') {
        await insertDlqEntry(tx, {
          job,
          reason:
            classification.retryable === false ? 'NON_RETRYABLE_ERROR' : 'MAX_ATTEMPTS_EXCEEDED',
          errorCode: classification.code,
          errorMessage: message,
        });
      }
    });

    return nextStatus;
  } catch (err) {
    if (err instanceof LeaseLostError) return 'LEASE_LOST';
    throw err;
  }
}

/**
 * The DLQ entry is an index over the failure plus resolution metadata. The
 * original `jobs` row stays exactly where it is, so job_id foreign keys remain
 * valid and the job detail page works identically for a dead-lettered job.
 */
async function insertDlqEntry(
  tx: Prisma.TransactionClient,
  params: {
    job: ClaimedJobRow;
    reason: string;
    errorCode: string | null;
    errorMessage: string | null;
  },
): Promise<void> {
  const { job, reason, errorCode, errorMessage } = params;

  await tx.$executeRawUnsafe(
    `INSERT INTO dead_letter_jobs
       (id, job_id, queue_id, project_id, reason, error_code, error_message,
        total_attempts, payload_snapshot, error_signature,
        first_failed_at, dead_lettered_at)
     SELECT gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, $4::dlq_reason, $5, $6,
            $7, $8::jsonb, $9,
            -- The first attempt's start, so "how long has this been broken"
            -- is answerable without walking the execution history.
            COALESCE((SELECT MIN(started_at) FROM job_executions WHERE job_id = $1::uuid), now()),
            now()
     -- Idempotent: the reaper and a worker can both conclude a job is dead.
     ON CONFLICT (job_id) DO NOTHING`,
    job.id,
    job.queue_id,
    job.project_id,
    reason,
    errorCode,
    errorMessage,
    job.attempt_count,
    // A COPY, so a replay is possible even after retention purges the original.
    JSON.stringify(job.payload ?? {}),
    errorSignature(errorCode ?? 'UNKNOWN', errorMessage),
  );
}

/** SCHEDULED | RETRYING -> QUEUED. Returns the affected queue ids for NOTIFY. */
export async function promoteDueJobs(
  prisma: PrismaClient,
  batchSize: number,
): Promise<{ queueIds: string[]; count: number }> {
  const rows = await prisma.$queryRawUnsafe<{ queue_id: string; id: string }[]>(
    SQL.PROMOTE_DUE,
    batchSize,
  );
  return { queueIds: [...new Set(rows.map((r) => r.queue_id))], count: rows.length };
}

export interface ReapedJob {
  id: string;
  status: string;
  attempt_count: number;
  queue_id: string;
  project_id: string;
  previous_worker_id: string | null;
  can_retry: boolean;
  dlq_enabled: boolean;
  payload: unknown;
}

/**
 * Recover jobs whose lease expired.
 *
 * This is the safety net that makes worker crashes a non-event. Graceful
 * shutdown is an optimisation; the lease is the guarantee.
 *
 * Runs in one transaction per batch: reclaim the jobs, close their open
 * execution rows as ABANDONED, and write DLQ entries for any that exhausted
 * their attempts.
 */
export async function reapExpiredLeases(
  prisma: PrismaClient,
  batchSize: number,
): Promise<ReapedJob[]> {
  return prisma.$transaction(async (tx) => {
    const reaped = await tx.$queryRawUnsafe<ReapedJob[]>(SQL.REAP_EXPIRED, batchSize);
    if (reaped.length === 0) return [];

    const ids = reaped.map((r) => r.id);

    // An execution row left in RUNNING would otherwise pollute the metrics
    // rollup forever, since nothing else ever closes it.
    await tx.$executeRawUnsafe(
      `UPDATE job_executions
          SET status = 'ABANDONED', finished_at = now(),
              duration_ms = EXTRACT(MILLISECONDS FROM (now() - started_at))::int,
              error_code = 'LEASE_EXPIRED',
              error_message = 'Worker stopped responding; the attempt was abandoned.'
        WHERE status = 'RUNNING' AND job_id = ANY($1::uuid[])`,
      ids,
    );

    for (const job of reaped.filter((r) => r.status === 'DEAD_LETTER')) {
      await insertDlqEntry(tx, {
        job: {
          id: job.id,
          queue_id: job.queue_id,
          project_id: job.project_id,
          payload: job.payload,
          attempt_count: job.attempt_count,
        } as ClaimedJobRow,
        reason: 'LEASE_EXPIRED',
        errorCode: 'LEASE_EXPIRED',
        errorMessage: 'Worker stopped responding; the lease expired on the final attempt.',
      });
    }

    return reaped;
  });
}

/** Mark workers that have stopped heartbeating. Returns the newly dead ones. */
export async function markDeadWorkers(
  prisma: PrismaClient,
  timeoutMs: number,
): Promise<{ id: string; name: string }[]> {
  return prisma.$queryRawUnsafe<{ id: string; name: string }[]>(
    `UPDATE workers
        SET status = 'DEAD', stopped_at = now()
      WHERE status IN ('ACTIVE','DRAINING','STARTING')
        AND last_heartbeat_at < now() - make_interval(secs => $1::numeric / 1000.0)
    RETURNING id, name`,
    timeoutMs,
  );
}
