import {
  JobTimeoutError,
  type HandlerContext,
  type JobLogger,
  type LogLevel,
} from '@djs/core';
import {
  markRunning,
  completeJob,
  failJob,
  type ClaimedJobRow,
  type PrismaClient,
} from '@djs/db';
import type { HandlerRegistry } from './handlers/registry.js';
import type { LogBuffer } from './log-buffer.js';

export interface WorkerMetrics {
  claimed: number;
  completed: number;
  failed: number;
  retried: number;
  deadLettered: number;
  /**
   * A conditional write matched zero rows: this worker discovered it no longer
   * owned a job it believed it held.
   *
   * MUST STAY AT ZERO in normal operation. It is non-zero only when a worker
   * was slow enough to be reaped and then came back — the zombie-worker case.
   * Surfacing it as a metric is far more convincing than claiming duplicates
   * cannot happen (ARCHITECTURE.md §19.3).
   */
  duplicateExecutionDetected: number;
}

export function createMetrics(): WorkerMetrics {
  return {
    claimed: 0,
    completed: 0,
    failed: 0,
    retried: 0,
    deadLettered: 0,
    duplicateExecutionDetected: 0,
  };
}

export interface JobRunnerDeps {
  prisma: PrismaClient;
  registry: HandlerRegistry;
  workerId: string;
  metrics: WorkerMetrics;
  logBuffer?: LogBuffer;
  log: {
    debug(o: object, m?: string): void;
    info(o: object, m?: string): void;
    warn(o: object, m?: string): void;
    error(o: object, m?: string): void;
  };
}

export interface RunOutcome {
  status: 'COMPLETED' | 'RETRYING' | 'DEAD_LETTER' | 'FAILED' | 'LEASE_LOST' | 'NOT_STARTED';
  durationMs: number;
}

/**
 * Executes one claimed job end to end.
 *
 * The shape here is load-bearing:
 *
 *   1. markRunning — a CONDITIONAL write. Zero rows means the reaper took this
 *      job while it queued for a slot, and we must not invoke the handler.
 *   2. the handler runs OUTSIDE any transaction, bounded by an AbortSignal.
 *   3. completion or failure is a single short transaction, again guarded.
 *
 * Step 1 is what makes the lease scheme safe. Skip it and a slow worker
 * silently double-executes every job the reaper reclaimed.
 */
export async function runJob(
  deps: JobRunnerDeps,
  job: ClaimedJobRow,
  queue: { name: string; dlqEnabled: boolean; retryOnErrorCodes?: readonly string[] },
  signal: AbortSignal,
): Promise<RunOutcome> {
  const { prisma, registry, workerId, metrics, log } = deps;
  const started = Date.now();

  const handler = registry.get(job.handler);
  if (!handler) {
    // Unregistered handler. Non-retryable — this is a misconfiguration, not a
    // transient fault, and no number of retries will conjure the function.
    const startedRow = await markRunning(prisma, job, workerId);
    const outcome = await failJob(prisma, {
      job,
      workerId,
      executionId: startedRow?.executionId ?? null,
      error: Object.assign(new Error(`No handler registered for "${job.handler}"`), {
        code: 'UNKNOWN_HANDLER',
      }),
      durationMs: Date.now() - started,
      dlqEnabled: queue.dlqEnabled,
    });
    return { status: outcome, durationMs: Date.now() - started };
  }

  // ── 1. CLAIMED -> RUNNING, guarded ────────────────────────────────────────
  const startedRow = await markRunning(prisma, job, workerId);
  if (!startedRow) {
    metrics.duplicateExecutionDetected++;
    log.warn(
      { event: 'job.lease_lost', jobId: job.id, attempt: job.attempt_count, phase: 'markRunning' },
      'lease lost before start; dropping job without executing it',
    );
    return { status: 'LEASE_LOST', durationMs: Date.now() - started };
  }

  const { executionId } = startedRow;
  log.debug({ event: 'job.started', jobId: job.id, executionId: String(executionId) }, 'started');

  // ── 2. Execute, outside any transaction ───────────────────────────────────
  const timeoutAc = new AbortController();
  const timer = setTimeout(() => timeoutAc.abort('TIMEOUT'), job.timeout_ms);
  // Either the pool's signal (shutdown/cancel) or our timeout ends the job.
  const combined = AbortSignal.any([signal, timeoutAc.signal]);

  const ctx: HandlerContext = {
    jobId: job.id,
    attempt: job.attempt_count,
    maxAttempts: job.max_attempts,
    queueName: queue.name,
    // Stable across attempts — it IS the job id. Handlers use it as their
    // dedupe key at the boundary.
    idempotencyToken: job.id,
    signal: combined,
    log: makeJobLogger(deps, job.id, executionId),
  };

  let result: unknown;
  let error: unknown;

  try {
    // The single unchecked boundary in the worker, and it is deliberate.
    // `job.payload` is jsonb of unknown shape; the guarantee that it matches
    // the handler's expected type comes from schema validation at SUBMISSION
    // time, not from anything the worker can prove. Confining the cast to one
    // line makes that boundary visible rather than diffuse.
    result = await handler.handle(job.payload as never, ctx);
  } catch (err) {
    // Distinguish "we timed out" from "the handler threw an AbortError for its
    // own reasons" — only the former is a TIMEOUT.
    error = timeoutAc.signal.aborted ? new JobTimeoutError(job.timeout_ms) : err;
  } finally {
    clearTimeout(timer);
  }

  const durationMs = Date.now() - started;

  // ── 3. Persist the outcome, guarded ───────────────────────────────────────
  if (error === undefined) {
    const ok = await completeJob(prisma, { job, workerId, executionId, result, durationMs });
    if (!ok) {
      metrics.duplicateExecutionDetected++;
      log.warn(
        { event: 'job.lease_lost', jobId: job.id, phase: 'complete' },
        'lease lost after execution; discarding result',
      );
      return { status: 'LEASE_LOST', durationMs };
    }
    metrics.completed++;
    log.info({ event: 'job.completed', jobId: job.id, durationMs }, 'completed');
    return { status: 'COMPLETED', durationMs };
  }

  const outcome = await failJob(prisma, {
    job,
    workerId,
    executionId,
    error,
    durationMs,
    dlqEnabled: queue.dlqEnabled,
    ...(queue.retryOnErrorCodes ? { retryOnErrorCodes: queue.retryOnErrorCodes } : {}),
  });

  switch (outcome) {
    case 'LEASE_LOST':
      metrics.duplicateExecutionDetected++;
      log.warn({ event: 'job.lease_lost', jobId: job.id, phase: 'fail' }, 'lease lost on failure');
      break;
    case 'RETRYING':
      metrics.failed++;
      metrics.retried++;
      log.info(
        { event: 'job.retry_scheduled', jobId: job.id, attempt: job.attempt_count, durationMs },
        'attempt failed; retry scheduled',
      );
      break;
    default:
      metrics.failed++;
      metrics.deadLettered++;
      log.warn(
        { event: 'job.dead_lettered', jobId: job.id, attempts: job.attempt_count },
        'attempts exhausted; dead-lettered',
      );
  }

  return { status: outcome, durationMs };
}

/**
 * Handler-facing logger. Lines are buffered and batch-inserted OUTSIDE the
 * job's transactions, so a chatty handler never lengthens a hot transaction.
 * Cost: up to 1s of logs lost on SIGKILL — the right trade, since logs are
 * diagnostic and job state is authoritative.
 */
function makeJobLogger(deps: JobRunnerDeps, jobId: string, executionId: bigint): JobLogger {
  const write = (level: LogLevel, message: string, context?: Record<string, unknown>): void => {
    deps.logBuffer?.push({
      jobId,
      executionId,
      level,
      message,
      context: context ?? null,
      loggedAt: new Date(),
    });
  };

  return {
    debug: (m, c) => write('DEBUG', m, c),
    info: (m, c) => write('INFO', m, c),
    warn: (m, c) => write('WARN', m, c),
    error: (m, c) => write('ERROR', m, c),
  };
}
