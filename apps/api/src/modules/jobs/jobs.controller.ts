import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { PrismaService } from '../../prisma.service.js';
import { TenancyService, Principal, type AuthedRequest } from '../../common/guards.js';
import type { AuthPrincipal } from '../auth/auth.service.js';
import { paginate, cursorWhere, type Cursor } from '../../common/pagination.js';
import { JobsService } from './jobs.service.js';
import { HANDLER_CATALOG } from './handler-catalog.js';
import {
  CreateBatchDto,
  CreateJobDto,
  JobResponse,
  ListJobsQuery,
} from './jobs.dto.js';

@ApiTags('jobs')
@Controller()
export class JobsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenancy: TenancyService,
    private readonly jobs: JobsService,
  ) {}

  @Get('handlers')
  @ApiOperation({
    summary: 'List available job handlers',
    description:
      'Drives the Create Job form: selecting a handler loads its schema and an example payload, so the UI never hardcodes a handler list.',
  })
  listHandlers() {
    return { data: HANDLER_CATALOG };
  }

  @Post('queues/:queueId/jobs')
  @ApiOperation({ summary: 'Create a job' })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description:
      'Makes creation idempotent. A retried request carrying the same key returns the original job with 200 and X-Idempotent-Replay: true, rather than creating a duplicate.',
  })
  @ApiResponse({ status: 201, description: 'Created', type: JobResponse })
  @ApiResponse({ status: 200, description: 'Idempotent replay of an existing job' })
  @ApiResponse({ status: 409, description: 'Queue is paused' })
  @ApiResponse({ status: 422, description: 'Unknown handler, or payload fails its schema' })
  async create(
    @Param('queueId') queueId: string,
    @Body() dto: CreateJobDto,
    @Principal() principal: AuthPrincipal,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const queue = await this.tenancy.queue(principal, queueId);

    const result = await this.jobs.create(queue, dto, {
      ...(principal.kind === 'user' ? { userId: principal.userId } : {}),
      ...(req.requestId ? { requestId: req.requestId } : {}),
      ...(req.header('idempotency-key') ? { idempotencyKey: req.header('idempotency-key')! } : {}),
    });

    // 200 vs 201 is the honest signal: the caller learns whether this request
    // created something or replayed an earlier one.
    if (result.replayed) {
      res.status(200);
      res.setHeader('X-Idempotent-Replay', 'true');
    } else {
      res.status(201);
    }

    return toJobResponse(result.job);
  }

  @Post('queues/:queueId/jobs/batch')
  @HttpCode(207)
  @ApiOperation({
    summary: 'Create up to 1,000 jobs',
    description:
      'Returns 207 Multi-Status. Unless stop_on_error is set, valid jobs commit and invalid ones are reported by index.',
  })
  async createBatch(
    @Param('queueId') queueId: string,
    @Body() dto: CreateBatchDto,
    @Principal() principal: AuthPrincipal,
    @Req() req: AuthedRequest,
  ) {
    const queue = await this.tenancy.queue(principal, queueId);
    return this.jobs.createBatch(queue, dto.jobs, {
      ...(principal.kind === 'user' ? { userId: principal.userId } : {}),
      ...(req.requestId ? { requestId: req.requestId } : {}),
      ...(dto.stop_on_error !== undefined ? { stopOnError: dto.stop_on_error } : {}),
    });
  }

  @Get('projects/:projectId/jobs')
  @ApiOperation({ summary: 'The job explorer — filtered, cursor-paginated' })
  async list(
    @Param('projectId') projectId: string,
    @Query() query: ListJobsQuery,
    @Principal() principal: AuthPrincipal,
  ) {
    await this.tenancy.project(principal, projectId);

    const statuses = normaliseStatuses(query.status);
    const where = {
      projectId,
      ...(query.queue_id ? { queueId: query.queue_id } : {}),
      ...(statuses.length > 0 ? { status: { in: statuses as never } } : {}),
      ...(query.handler ? { handler: query.handler } : {}),
      ...(query.batch_id ? { batchId: query.batch_id } : {}),
      ...(query.scheduled_job_id ? { scheduledJobId: query.scheduled_job_id } : {}),
      ...(query.priority_gte !== undefined || query.priority_lte !== undefined
        ? {
            priority: {
              ...(query.priority_gte !== undefined ? { gte: query.priority_gte } : {}),
              ...(query.priority_lte !== undefined ? { lte: query.priority_lte } : {}),
            },
          }
        : {}),
      ...(query.created_after || query.created_before
        ? {
            createdAt: {
              ...(query.created_after ? { gte: new Date(query.created_after) } : {}),
              ...(query.created_before ? { lte: new Date(query.created_before) } : {}),
            },
          }
        : {}),
      // `id` is @db.Uuid, and Prisma's UuidFilter has no startsWith — a uuid
      // is not a string to Postgres. So an exact id wins when the term parses
      // as one, and otherwise the term is treated as a handler search, which is
      // what people actually type.
      ...searchFilter(query.search),
    };

    return paginate(
      query,
      (take, cursor) =>
        this.prisma.job.findMany({
          where: { ...where, ...cursorWhere(cursor, 'createdAt') },
          // Matches idx_jobs_explorer (project_id, status, created_at DESC).
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take,
          select: JOB_LIST_SELECT,
        }),
      (row): Cursor => ({ v: row.createdAt.toISOString(), i: row.id }),
      toJobResponse,
    );
  }

  @Get('jobs/:jobId')
  @ApiOperation({
    summary: 'Job detail with its attempt history',
    description:
      'Executions are inlined (capped at 20) because the detail page always needs them; the full list is at /jobs/:id/executions.',
  })
  async detail(@Param('jobId') jobId: string, @Principal() principal: AuthPrincipal) {
    const job = await this.tenancy.job(principal, jobId);

    const [executions, dlq, queue] = await Promise.all([
      this.prisma.jobExecution.findMany({
        where: { jobId },
        orderBy: { attempt: 'desc' },
        take: 20,
        select: {
          id: true,
          attempt: true,
          status: true,
          startedAt: true,
          finishedAt: true,
          durationMs: true,
          errorCode: true,
          errorMessage: true,
          worker: { select: { id: true, name: true } },
        },
      }),
      this.prisma.deadLetterJob.findUnique({ where: { jobId } }),
      this.prisma.queue.findUnique({ where: { id: job.queueId }, select: { name: true } }),
    ]);

    return {
      ...toJobResponse(job),
      queue_name: queue?.name ?? null,
      payload: job.payload,
      metadata: job.metadata,
      result: job.result,
      parent_job_id: job.parentJobId,
      batch_id: job.batchId,
      scheduled_job_id: job.scheduledJobId,
      timeout_ms: job.timeoutMs,
      retry_policy: {
        strategy: job.backoffStrategy,
        base_delay_ms: job.backoffBaseMs,
        max_delay_ms: job.backoffMaxMs,
        jitter_pct: job.backoffJitterPct,
      },
      executions: executions.map((e) => ({
        id: String(e.id),
        attempt: e.attempt,
        status: e.status,
        started_at: e.startedAt.toISOString(),
        finished_at: e.finishedAt?.toISOString() ?? null,
        duration_ms: e.durationMs,
        error_code: e.errorCode,
        error_message: e.errorMessage,
        worker: e.worker,
      })),
      dead_letter: dlq
        ? { id: dlq.id, reason: dlq.reason, resolved_at: dlq.resolvedAt, resolution: dlq.resolution }
        : null,
    };
  }

  @Get('jobs/:jobId/executions')
  @ApiOperation({ summary: 'Full attempt history' })
  async executions(@Param('jobId') jobId: string, @Principal() principal: AuthPrincipal) {
    await this.tenancy.job(principal, jobId);
    const rows = await this.prisma.jobExecution.findMany({
      where: { jobId },
      orderBy: { attempt: 'asc' },
      include: { worker: { select: { id: true, name: true } } },
    });
    return {
      data: rows.map((e) => ({
        id: String(e.id),
        attempt: e.attempt,
        status: e.status,
        started_at: e.startedAt.toISOString(),
        finished_at: e.finishedAt?.toISOString() ?? null,
        duration_ms: e.durationMs,
        error_code: e.errorCode,
        error_message: e.errorMessage,
        error_stack: e.errorStack,
        worker: e.worker,
      })),
    };
  }

  @Get('jobs/:jobId/logs')
  @ApiOperation({ summary: 'Handler log lines, optionally scoped to one attempt' })
  async logs(
    @Param('jobId') jobId: string,
    @Query('execution_id') executionId: string | undefined,
    @Query('level') level: string | undefined,
    @Principal() principal: AuthPrincipal,
  ) {
    await this.tenancy.job(principal, jobId);
    const rows = await this.prisma.jobLog.findMany({
      where: {
        jobId,
        ...(executionId ? { executionId: BigInt(executionId) } : {}),
        ...(level ? { level: level.toUpperCase() as never } : {}),
      },
      orderBy: { loggedAt: 'asc' },
      take: 1000,
    });
    return {
      data: rows.map((l) => ({
        id: String(l.id),
        execution_id: String(l.executionId),
        level: l.level,
        message: l.message,
        context: l.context,
        logged_at: l.loggedAt.toISOString(),
      })),
    };
  }

  @Post('jobs/:jobId/cancel')
  @HttpCode(200)
  @ApiResponse({ status: 200, description: 'Cancelled immediately' })
  @ApiResponse({
    status: 202,
    description: 'RUNNING job — cancellation requested; the handler aborts at its next await point',
  })
  @ApiResponse({ status: 409, description: 'Job is already terminal' })
  @ApiOperation({
    summary: 'Cancel a job',
    description:
      'SCHEDULED/QUEUED/RETRYING cancel immediately (200). A RUNNING job is cancelled cooperatively and returns 202 — the handler aborts at its next await point.',
  })
  async cancel(@Param('jobId') jobId: string, @Principal() principal: AuthPrincipal, @Res({ passthrough: true }) res: Response) {
    const job = await this.tenancy.job(principal, jobId);
    const result = await this.jobs.cancel(jobId, job.status as never);
    res.status(result.status === 'RUNNING' ? 202 : 200);
    return result;
  }

  @Post('jobs/:jobId/retry')
  @HttpCode(201)
  @ApiOperation({
    summary: 'Retry a terminal job',
    description:
      'Creates a NEW job with parent_job_id set. The original is never reset, so its execution history survives.',
  })
  async retry(@Param('jobId') jobId: string, @Principal() principal: AuthPrincipal) {
    const job = await this.tenancy.job(principal, jobId);
    const replay = await this.jobs.retry(jobId);
    return { ...toJobResponse(replay), parent_job_id: jobId };
  }
}

const JOB_LIST_SELECT = {
  id: true,
  queueId: true,
  status: true,
  handler: true,
  priority: true,
  attemptCount: true,
  maxAttempts: true,
  runAt: true,
  startedAt: true,
  finishedAt: true,
  lastErrorCode: true,
  lastErrorMessage: true,
  createdAt: true,
} as const;

function toJobResponse(job: Record<string, unknown>) {
  const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : null);
  return {
    id: job['id'] as string,
    queue_id: (job['queueId'] ?? null) as string | null,
    status: job['status'] as string,
    handler: (job['handler'] ?? null) as string | null,
    priority: job['priority'] as number,
    attempt_count: job['attemptCount'] as number,
    max_attempts: (job['maxAttempts'] ?? null) as number | null,
    run_at: iso(job['runAt']),
    started_at: iso(job['startedAt']),
    finished_at: iso(job['finishedAt']),
    last_error_code: (job['lastErrorCode'] ?? null) as string | null,
    last_error_message: (job['lastErrorMessage'] ?? null) as string | null,
    created_at: iso(job['createdAt']),
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function searchFilter(search: string | undefined): Record<string, unknown> {
  if (!search) return {};
  const term = search.trim();
  if (UUID_RE.test(term)) return { id: term };
  return { handler: { contains: term, mode: 'insensitive' } };
}

function normaliseStatuses(status: string | string[] | undefined): string[] {
  if (!status) return [];
  const raw = Array.isArray(status) ? status : [status];
  return raw.flatMap((s) => s.split(',')).map((s) => s.trim().toUpperCase()).filter(Boolean);
}
