import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
import { PrismaService } from '../../prisma.service.js';
import { TenancyService, Principal } from '../../common/guards.js';
import type { AuthPrincipal } from '../auth/auth.service.js';
import { AppError, ERROR_CODES } from '../../common/errors.js';
import { paginate, cursorWhere, type Cursor } from '../../common/pagination.js';
import { PaginationQuery } from '../../common/pagination.js';

class ReplayDto {
  @ApiPropertyOptional({ description: 'Corrected payload. Defaults to the snapshot.' })
  @IsOptional() @IsObject() payload?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Send the replay to a different queue.' })
  @IsOptional() @IsString() queue_id?: string;
}

class DiscardDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) note?: string;
}

class ListDlqQuery extends PaginationQuery {
  @ApiPropertyOptional({ default: 'false' }) @IsOptional() @IsString() resolved?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() queue_id?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() reason?: string;
}

/**
 * The DLQ is an INBOX, not an error log.
 *
 * Every entry is a work item needing a human decision: fix the input and
 * replay, or accept the loss. Designing it with a resolution workflow rather
 * than as a table of failures is the difference between a feature and a
 * checkbox.
 */
@ApiTags('dlq')
@Controller()
export class DlqController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenancy: TenancyService,
  ) {}

  @Get('projects/:projectId/dlq')
  @ApiOperation({ summary: 'Triage list — unresolved entries by default' })
  async list(
    @Param('projectId') projectId: string,
    @Query() query: ListDlqQuery,
    @Principal() principal: AuthPrincipal,
  ) {
    await this.tenancy.project(principal, projectId);

    const where = {
      projectId,
      // Default to the triage view. An archive of resolved entries is a
      // different question and needs an explicit ?resolved=true.
      ...(query.resolved === 'true' ? { resolvedAt: { not: null } } : { resolvedAt: null }),
      ...(query.queue_id ? { queueId: query.queue_id } : {}),
      ...(query.reason ? { reason: query.reason as never } : {}),
    };

    return paginate(
      query,
      (take, cursor) =>
        this.prisma.deadLetterJob.findMany({
          where: { ...where, ...cursorWhere(cursor, 'deadLetteredAt') },
          orderBy: [{ deadLetteredAt: 'desc' }, { id: 'desc' }],
          take,
          include: {
            queue: { select: { id: true, name: true } },
            job: { select: { handler: true, priority: true } },
          },
        }),
      (row): Cursor => ({ v: row.deadLetteredAt.toISOString(), i: row.id }),
      (row) => ({
        id: row.id,
        job_id: row.jobId,
        queue: row.queue,
        handler: row.job?.handler ?? null,
        reason: row.reason,
        error_code: row.errorCode,
        error_message: row.errorMessage,
        error_signature: row.errorSignature,
        total_attempts: row.totalAttempts,
        first_failed_at: row.firstFailedAt.toISOString(),
        dead_lettered_at: row.deadLetteredAt.toISOString(),
        resolved_at: row.resolvedAt?.toISOString() ?? null,
        resolution: row.resolution,
        replay_job_id: row.replayJobId,
        ai_summary: row.aiSummary,
      }),
    );
  }

  @Get('projects/:projectId/dlq/groups')
  @ApiOperation({
    summary: 'Unresolved failures grouped by error signature',
    description:
      '400 failures are usually 3 problems. Grouping by normalised signature is what turns a table dump into a triage list.',
  })
  async groups(@Param('projectId') projectId: string, @Principal() principal: AuthPrincipal) {
    await this.tenancy.project(principal, projectId);

    const rows = await this.prisma.$queryRaw<
      {
        error_signature: string | null;
        error_code: string | null;
        sample_message: string | null;
        count: bigint;
        first_seen: Date;
        last_seen: Date;
        queues: string[];
      }[]
    >`
      SELECT d.error_signature,
             d.error_code,
             MIN(d.error_message)      AS sample_message,
             count(*)                  AS count,
             MIN(d.dead_lettered_at)   AS first_seen,
             MAX(d.dead_lettered_at)   AS last_seen,
             array_agg(DISTINCT q.name) AS queues
        FROM dead_letter_jobs d
        JOIN queues q ON q.id = d.queue_id
       WHERE d.project_id = ${projectId}::uuid AND d.resolved_at IS NULL
       GROUP BY d.error_signature, d.error_code
       ORDER BY count DESC
       LIMIT 50`;

    return {
      data: rows.map((r) => ({
        error_signature: r.error_signature,
        error_code: r.error_code,
        sample_message: r.sample_message,
        count: Number(r.count),
        first_seen: r.first_seen.toISOString(),
        last_seen: r.last_seen.toISOString(),
        queues: r.queues,
      })),
    };
  }

  @Get('dlq/:dlqId')
  async detail(@Param('dlqId') dlqId: string, @Principal() principal: AuthPrincipal) {
    const entry = await this.prisma.deadLetterJob.findUnique({
      where: { id: dlqId },
      include: {
        job: { include: { executions: { orderBy: { attempt: 'asc' } } } },
        queue: { select: { id: true, name: true } },
      },
    });
    if (!entry) throw AppError.notFound('DLQ entry');
    await this.tenancy.project(principal, entry.projectId);

    return {
      id: entry.id,
      job_id: entry.jobId,
      queue: entry.queue,
      reason: entry.reason,
      error_code: entry.errorCode,
      error_message: entry.errorMessage,
      total_attempts: entry.totalAttempts,
      payload_snapshot: entry.payloadSnapshot,
      first_failed_at: entry.firstFailedAt.toISOString(),
      dead_lettered_at: entry.deadLetteredAt.toISOString(),
      resolved_at: entry.resolvedAt?.toISOString() ?? null,
      resolution: entry.resolution,
      replay_job_id: entry.replayJobId,
      executions: entry.job.executions.map((e) => ({
        attempt: e.attempt,
        status: e.status,
        started_at: e.startedAt.toISOString(),
        finished_at: e.finishedAt?.toISOString() ?? null,
        duration_ms: e.durationMs,
        error_code: e.errorCode,
        error_message: e.errorMessage,
      })),
    };
  }

  @Post('dlq/:dlqId/replay')
  @HttpCode(201)
  @ApiOperation({
    summary: 'Replay a dead-lettered job',
    description:
      'Creates a NEW job with parent_job_id set — it never resurrects the original, so the failure history survives. Guarded against double-replay.',
  })
  async replay(
    @Param('dlqId') dlqId: string,
    @Body() dto: ReplayDto,
    @Principal() principal: AuthPrincipal,
  ) {
    const entry = await this.prisma.deadLetterJob.findUnique({
      where: { id: dlqId },
      include: { job: true },
    });
    if (!entry) throw AppError.notFound('DLQ entry');
    await this.tenancy.project(principal, entry.projectId);

    if (entry.resolvedAt) {
      throw AppError.conflict(
        ERROR_CODES.ALREADY_RESOLVED,
        `This entry was already ${entry.resolution?.toLowerCase() ?? 'resolved'}${
          entry.replayJobId ? ` as job ${entry.replayJobId}` : ''
        }`,
      );
    }

    const targetQueueId = dto.queue_id ?? entry.queueId;
    if (dto.queue_id) await this.tenancy.queue(principal, dto.queue_id);

    const job = entry.job;

    const replay = await this.prisma.$transaction(async (tx) => {
      const created = await tx.job.create({
        data: {
          queueId: targetQueueId,
          projectId: entry.projectId,
          // The replay chain: you can see a job replayed three times, each with
          // a different payload.
          parentJobId: entry.jobId,
          handler: job.handler,
          // The snapshot, so a replay works even after retention purged the
          // original payload.
          payload: (dto.payload ?? entry.payloadSnapshot) as never,
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
        select: { id: true, status: true, runAt: true },
      });

      // The guard that makes a double-clicked Replay button produce one job.
      const claimed = await tx.deadLetterJob.updateMany({
        where: { id: dlqId, resolvedAt: null },
        data: {
          resolvedAt: new Date(),
          resolution: 'REPLAYED',
          replayJobId: created.id,
          ...(principal.kind === 'user' ? { resolvedById: principal.userId } : {}),
        },
      });
      if (claimed.count === 0) {
        throw AppError.conflict(ERROR_CODES.ALREADY_RESOLVED, 'Entry was resolved concurrently');
      }

      return created;
    });

    await this.prisma
      .$executeRawUnsafe(`SELECT pg_notify('jobs_ready', $1)`, targetQueueId)
      .catch(() => {});

    return { id: replay.id, status: replay.status, parent_job_id: entry.jobId, dlq_id: dlqId };
  }

  @Post('dlq/:dlqId/discard')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Accept the loss',
    description: 'Removes the entry from triage. The record is kept — DLQ entries are never deleted.',
  })
  async discard(
    @Param('dlqId') dlqId: string,
    @Body() dto: DiscardDto,
    @Principal() principal: AuthPrincipal,
  ) {
    const entry = await this.prisma.deadLetterJob.findUnique({ where: { id: dlqId } });
    if (!entry) throw AppError.notFound('DLQ entry');
    await this.tenancy.project(principal, entry.projectId);

    const res = await this.prisma.deadLetterJob.updateMany({
      where: { id: dlqId, resolvedAt: null },
      data: {
        resolvedAt: new Date(),
        resolution: 'DISCARDED',
        resolutionNote: dto.note ?? null,
        ...(principal.kind === 'user' ? { resolvedById: principal.userId } : {}),
      },
    });
    if (res.count === 0) {
      throw AppError.conflict(ERROR_CODES.ALREADY_RESOLVED, 'This entry was already resolved');
    }
    return { id: dlqId, resolution: 'DISCARDED' };
  }
}
