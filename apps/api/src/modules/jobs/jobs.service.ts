import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
// ajv 8 ships a CJS default export. Under NodeNext module resolution the bare
// `import Ajv from 'ajv'` binds the MODULE NAMESPACE, not the constructor, so
// `new Ajv()` fails with "not constructable". Unwrapping .default explicitly is
// the documented interop shim, and it breaks loudly rather than silently if the
// package ever ships real ESM.
import AjvModule, { type ValidateFunction, type Ajv as AjvType } from 'ajv';
import addFormatsModule from 'ajv-formats';

const Ajv = ((AjvModule as unknown as { default?: unknown }).default ??
  AjvModule) as unknown as new (opts?: Record<string, unknown>) => AjvType;
const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ??
  addFormatsModule) as (ajv: AjvType) => void;
import {
  LIMITS,
  resolvePriority,
  canCancel,
  cancellationIsCooperative,
  isTerminal,
  type JobStatus,
} from '@djs/core';
import { PrismaService } from '../../prisma.service.js';
import { AppError, ERROR_CODES } from '../../common/errors.js';
import { HANDLER_CATALOG } from './handler-catalog.js';
import type { CreateJobDto } from './jobs.dto.js';

/** Columns the create/retry responses need. Kept in one place so a field added
 *  to the response shape cannot silently serialise as null. */
const CREATED_JOB_SELECT = {
  id: true,
  queueId: true,
  status: true,
  handler: true,
  runAt: true,
  priority: true,
  attemptCount: true,
  maxAttempts: true,
  createdAt: true,
} as const;

export interface CreateJobResult {
  job: {
    id: string;
    queueId: string;
    status: string;
    handler: string;
    runAt: Date;
    priority: number;
    attemptCount: number;
    maxAttempts: number;
    createdAt: Date;
  };
  /** True when an idempotency key matched an existing job — respond 200, not 201. */
  replayed: boolean;
}

@Injectable()
export class JobsService {
  private readonly ajv: AjvType;
  private readonly validators = new Map<string, ValidateFunction>();

  constructor(private readonly prisma: PrismaService) {
    this.ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(this.ajv);
    for (const h of HANDLER_CATALOG) {
      this.validators.set(h.name, this.ajv.compile(h.payloadSchema));
    }
  }

  /**
   * Create one job.
   *
   * Validation happens HERE, at submission, not on a worker. A payload that
   * cannot possibly succeed should be rejected with 422 while the caller is
   * still holding the request — not accepted, queued, claimed, executed,
   * failed, retried four times and finally dead-lettered twenty minutes later.
   */
  async create(
    queue: {
      id: string;
      projectId: string;
      isPaused: boolean;
      defaultPriority: number;
      defaultJobTimeoutMs: number;
      retryPolicyId: string;
    },
    dto: CreateJobDto,
    ctx: { userId?: string; requestId?: string; idempotencyKey?: string },
  ): Promise<CreateJobResult> {
    this.assertHandler(dto.handler, dto.payload);
    const runAt = this.resolveRunAt(dto);

    if (queue.isPaused && !dto.allow_when_paused) {
      throw AppError.conflict(
        ERROR_CODES.QUEUE_PAUSED,
        'This queue is paused and is not accepting new jobs. Pass allow_when_paused to queue anyway.',
      );
    }

    const policy = await this.prisma.retryPolicy.findUniqueOrThrow({
      where: { id: queue.retryPolicyId },
    });

    const idempotencyKey = ctx.idempotencyKey ?? dto.idempotency_key;

    // ── Idempotent creation ──
    // ON CONFLICT DO NOTHING against the partial unique index
    // (queue_id, idempotency_key). A client whose POST succeeded but whose
    // response was lost retries with the same key and gets the SAME job back.
    if (idempotencyKey) {
      const existing = await this.prisma.job.findFirst({
        where: { queueId: queue.id, idempotencyKey },
        select: CREATED_JOB_SELECT,
      });
      if (existing) return { job: existing, replayed: true };
    }

    const data = {
      queueId: queue.id,
      projectId: queue.projectId,
      handler: dto.handler,
      payload: (dto.payload ?? {}) as never,
      metadata: (dto.metadata ?? undefined) as never,
      priority: dto.priority === undefined ? queue.defaultPriority : resolvePriority(dto.priority),
      // A job whose run_at is in the future starts SCHEDULED and is promoted by
      // the scheduler; one that is due now goes straight to QUEUED.
      status: (runAt === undefined ? 'QUEUED' : 'SCHEDULED') as JobStatus,
      ...(runAt === undefined ? {} : { runAt }),
      // Snapshotted, so editing the queue's policy later cannot rewrite the
      // contract of a job already in flight (ARCHITECTURE.md §29.7).
      maxAttempts: dto.max_attempts ?? policy.maxAttempts,
      backoffStrategy: policy.strategy,
      backoffBaseMs: policy.baseDelayMs,
      backoffMaxMs: policy.maxDelayMs,
      backoffJitterPct: policy.jitterPct,
      retryPolicyId: policy.id,
      timeoutMs: dto.timeout_ms ?? queue.defaultJobTimeoutMs,
      ...(idempotencyKey ? { idempotencyKey } : {}),
      ...(ctx.userId ? { createdById: ctx.userId } : {}),
      ...(ctx.requestId ? { requestId: ctx.requestId } : {}),
    };

    try {
      const job = await this.prisma.job.create({
        data,
        select: CREATED_JOB_SELECT,
      });
      await this.notifyIfReady(job.status, queue.id);
      return { job, replayed: false };
    } catch (err) {
      // Lost the race to a concurrent request carrying the same key. The unique
      // index is the real guarantee; the pre-check above is only an optimisation.
      if (idempotencyKey && isUniqueViolation(err)) {
        const existing = await this.prisma.job.findFirstOrThrow({
          where: { queueId: queue.id, idempotencyKey },
          select: CREATED_JOB_SELECT,
        });
        return { job: existing, replayed: true };
      }
      throw err;
    }
  }

  /** Up to 1,000 jobs in one multi-row INSERT sharing a batch_id. */
  async createBatch(
    queue: Parameters<JobsService['create']>[0],
    jobs: CreateJobDto[],
    ctx: { userId?: string; requestId?: string; stopOnError?: boolean },
  ) {
    if (jobs.length === 0) throw AppError.badRequest('Batch must contain at least one job');
    if (jobs.length > LIMITS.BATCH_MAX_JOBS) {
      throw AppError.badRequest(
        `Batch is limited to ${LIMITS.BATCH_MAX_JOBS} jobs; received ${jobs.length}`,
      );
    }

    const policy = await this.prisma.retryPolicy.findUniqueOrThrow({
      where: { id: queue.retryPolicyId },
    });
    const batchId = randomUUID();

    const valid: Record<string, unknown>[] = [];
    const failures: { index: number; error: { code: string; message: string } }[] = [];

    jobs.forEach((dto, index) => {
      try {
        this.assertHandler(dto.handler, dto.payload);
        const runAt = this.resolveRunAt(dto);
        valid.push({
          queueId: queue.id,
          projectId: queue.projectId,
          batchId,
          handler: dto.handler,
          payload: dto.payload ?? {},
          priority:
            dto.priority === undefined ? queue.defaultPriority : resolvePriority(dto.priority),
          status: runAt === undefined ? 'QUEUED' : 'SCHEDULED',
          ...(runAt === undefined ? {} : { runAt }),
          maxAttempts: dto.max_attempts ?? policy.maxAttempts,
          backoffStrategy: policy.strategy,
          backoffBaseMs: policy.baseDelayMs,
          backoffMaxMs: policy.maxDelayMs,
          backoffJitterPct: policy.jitterPct,
          retryPolicyId: policy.id,
          timeoutMs: dto.timeout_ms ?? queue.defaultJobTimeoutMs,
          ...(dto.idempotency_key ? { idempotencyKey: dto.idempotency_key } : {}),
          ...(ctx.userId ? { createdById: ctx.userId } : {}),
          ...(ctx.requestId ? { requestId: ctx.requestId } : {}),
        });
      } catch (err) {
        failures.push({
          index,
          error: {
            code: err instanceof AppError ? err.code : ERROR_CODES.VALIDATION_ERROR,
            message: err instanceof Error ? err.message : 'Invalid job',
          },
        });
      }
    });

    // stop_on_error makes the batch all-or-nothing; otherwise valid rows commit
    // and the invalid ones are reported per index.
    if (failures.length > 0 && ctx.stopOnError) {
      throw AppError.unprocessable(
        ERROR_CODES.VALIDATION_ERROR,
        `${failures.length} of ${jobs.length} jobs are invalid and stop_on_error was set`,
        failures.map((f) => ({ field: `jobs[${f.index}]`, issue: f.error.message })),
      );
    }

    const created =
      valid.length > 0
        ? await this.prisma.job.createMany({ data: valid as never, skipDuplicates: true })
        : { count: 0 };

    if (created.count > 0) await this.notifyIfReady('QUEUED', queue.id);

    return { batchId, created: created.count, failed: failures.length, failures };
  }

  async cancel(jobId: string, status: JobStatus) {
    if (!canCancel(status)) {
      throw AppError.conflict(
        ERROR_CODES.ILLEGAL_STATE_TRANSITION,
        `A job in ${status} cannot be cancelled`,
      );
    }

    // A RUNNING job is cancelled COOPERATIVELY: we set a flag and the handler
    // aborts at its next await point. Killing it outright would leave a side
    // effect half-applied, which is worse than letting it finish.
    if (cancellationIsCooperative(status)) {
      await this.prisma.job.update({
        where: { id: jobId },
        data: { cancelRequested: true },
      });
      return { accepted: true, status: 'RUNNING' as const };
    }

    const res = await this.prisma.job.updateMany({
      // Guarded: the job may have been claimed between our read and this write.
      where: { id: jobId, status: { in: ['SCHEDULED', 'QUEUED', 'RETRYING'] } },
      data: { status: 'CANCELLED', finishedAt: new Date(), workerId: null, leaseExpiresAt: null },
    });

    if (res.count === 0) {
      throw AppError.conflict(
        ERROR_CODES.ILLEGAL_STATE_TRANSITION,
        'The job changed state before it could be cancelled; re-read it and try again',
      );
    }
    return { accepted: true, status: 'CANCELLED' as const };
  }

  /**
   * Manual retry of a terminal job.
   *
   * Creates a NEW job with parent_job_id set — it never resurrects the old one.
   * Resetting the original would erase the execution history the whole
   * `job_executions` table exists to preserve (ARCHITECTURE.md §12.5).
   */
  async retry(jobId: string) {
    const job = await this.prisma.job.findUniqueOrThrow({ where: { id: jobId } });

    if (!isTerminal(job.status as JobStatus)) {
      throw AppError.conflict(
        ERROR_CODES.ILLEGAL_STATE_TRANSITION,
        `Only terminal jobs can be retried; this one is ${job.status}`,
      );
    }

    const replay = await this.prisma.job.create({
      data: {
        queueId: job.queueId,
        projectId: job.projectId,
        parentJobId: job.id,
        handler: job.handler,
        payload: job.payload as never,
        metadata: job.metadata as never,
        priority: job.priority,
        status: 'QUEUED',
        attemptCount: 0,
        maxAttempts: job.maxAttempts,
        backoffStrategy: job.backoffStrategy,
        backoffBaseMs: job.backoffBaseMs,
        backoffMaxMs: job.backoffMaxMs,
        backoffJitterPct: job.backoffJitterPct,
        retryPolicyId: job.retryPolicyId,
        timeoutMs: job.timeoutMs,
      },
      select: CREATED_JOB_SELECT,
    });

    await this.notifyIfReady('QUEUED', job.queueId);
    return replay;
  }

  private assertHandler(handler: string, payload: unknown): void {
    const validate = this.validators.get(handler);
    if (!validate) {
      throw AppError.unprocessable(
        ERROR_CODES.UNKNOWN_HANDLER,
        `No handler named "${handler}". Known handlers: ${[...this.validators.keys()].join(', ')}`,
      );
    }

    const size = Buffer.byteLength(JSON.stringify(payload ?? {}), 'utf8');
    if (size > LIMITS.PAYLOAD_MAX_BYTES) {
      throw AppError.badRequest(
        `Payload is ${size} bytes; the limit is ${LIMITS.PAYLOAD_MAX_BYTES}`,
      );
    }

    if (!validate(payload ?? {})) {
      throw AppError.unprocessable(
        ERROR_CODES.VALIDATION_ERROR,
        `Payload does not match the schema for handler "${handler}"`,
        (validate.errors ?? []).map((e) => ({
          field: `payload${e.instancePath}`,
          issue: e.message ?? 'invalid',
        })),
      );
    }
  }

  /**
   * `undefined` means "immediate" — and immediate jobs deliberately do NOT get
   * a timestamp from this process.
   *
   * The API and the database can be on different machines with clocks a few
   * milliseconds apart. Stamping `run_at` here and then having the claim query
   * compare it against the DATABASE's `now()` makes a just-created job briefly
   * not-yet-due. Letting the column default fill it in removes the skew
   * entirely.
   */
  private resolveRunAt(dto: CreateJobDto): Date | undefined {
    if (dto.run_at && dto.delay_seconds !== undefined) {
      throw AppError.badRequest('Provide either run_at or delay_seconds, not both', [
        { field: 'run_at', issue: 'mutually exclusive with delay_seconds' },
      ]);
    }

    if (dto.delay_seconds !== undefined) {
      if (dto.delay_seconds < 0) throw AppError.badRequest('delay_seconds must not be negative');
      return dto.delay_seconds === 0
        ? undefined
        : new Date(Date.now() + dto.delay_seconds * 1000);
    }

    if (dto.run_at) {
      const when = new Date(dto.run_at);
      if (Number.isNaN(when.getTime())) {
        throw AppError.badRequest('run_at is not a valid ISO-8601 timestamp');
      }
      if (when.getTime() - Date.now() > LIMITS.MAX_SCHEDULE_AHEAD_MS) {
        throw AppError.badRequest('run_at may not be more than one year in the future');
      }
      // Already due — treat as immediate rather than scheduling into the past.
      return when.getTime() <= Date.now() ? undefined : when;
    }

    return undefined;
  }

  /** Wake listening workers. Best-effort: the poll timer is the guarantee. */
  private async notifyIfReady(status: string, queueId: string): Promise<void> {
    if (status !== 'QUEUED') return;
    await this.prisma
      .$executeRawUnsafe(`SELECT pg_notify('jobs_ready', $1)`, queueId)
      .catch(() => {});
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'P2002'
  );
}
