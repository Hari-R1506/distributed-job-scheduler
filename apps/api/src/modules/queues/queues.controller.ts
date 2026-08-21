import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { PrismaService } from '../../prisma.service.js';
import { TenancyService, Principal } from '../../common/guards.js';
import type { AuthPrincipal } from '../auth/auth.service.js';
import { AppError, ERROR_CODES } from '../../common/errors.js';
import { QueueStatsService } from './queue-stats.service.js';

class CreateQueueDto {
  @ApiProperty({ example: 'email-notifications' })
  @IsString()
  @MaxLength(64)
  @Matches(/^[a-z0-9][a-z0-9-_]*$/, {
    message: 'name must be lowercase alphanumeric with hyphens or underscores',
  })
  name!: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) description?: string;

  @ApiPropertyOptional({ minimum: 0, maximum: 255, default: 100 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(255)
  default_priority?: number;

  @ApiPropertyOptional({
    description: 'Global cap on concurrent executions for this queue. null = unlimited.',
  })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  max_concurrency?: number | null;

  @ApiProperty() @IsString() retry_policy_id!: string;

  @ApiPropertyOptional({
    minimum: 45000,
    description: 'Lease duration. Must exceed WORKER_TIMEOUT_MS so a worker is declared dead before its jobs are reclaimed.',
  })
  @IsOptional() @Type(() => Number) @IsInt() @Min(45_000)
  visibility_timeout_ms?: number;

  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  default_job_timeout_ms?: number;

  @ApiPropertyOptional({ default: true }) @IsOptional() @IsBoolean() dlq_enabled?: boolean;

  @ApiPropertyOptional({ description: 'Auto-purge terminal jobs after this many days.' })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  retention_days?: number;
}

/**
 * Standalone rather than `extends CreateQueueDto`.
 *
 * PATCH semantics genuinely differ from POST: every field is optional, and
 * "absent" must mean "leave unchanged" rather than "reset to default".
 * Re-declaring inherited required fields as optional also trips TS2612, and
 * silencing that with `declare` would leave the validation decorators on the
 * base class where they still demand a value.
 */
class UpdateQueueDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(/^[a-z0-9][a-z0-9-_]*$/, {
    message: 'name must be lowercase alphanumeric with hyphens or underscores',
  })
  name?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) description?: string;

  @ApiPropertyOptional({ minimum: 0, maximum: 255 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(255)
  default_priority?: number;

  @ApiPropertyOptional({ description: 'null = unlimited.' })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  max_concurrency?: number | null;

  @ApiPropertyOptional() @IsOptional() @IsString() retry_policy_id?: string;

  @ApiPropertyOptional({ minimum: 45000 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(45_000)
  visibility_timeout_ms?: number;

  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  default_job_timeout_ms?: number;

  @ApiPropertyOptional() @IsOptional() @IsBoolean() dlq_enabled?: boolean;

  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  retention_days?: number;
}

class PauseDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) reason?: string;
}

@ApiTags('queues')
@Controller()
export class QueuesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenancy: TenancyService,
    private readonly stats: QueueStatsService,
  ) {}

  @Get('projects/:projectId/queues')
  @ApiOperation({ summary: 'List queues with live health' })
  async list(@Param('projectId') projectId: string, @Principal() principal: AuthPrincipal) {
    await this.tenancy.project(principal, projectId);
    const queues = await this.prisma.queue.findMany({
      where: { projectId },
      orderBy: { name: 'asc' },
      include: { retryPolicy: { select: { id: true, name: true, strategy: true } } },
    });

    const stats = await this.stats.forQueues(queues.map((q) => q.id));
    return { data: queues.map((q) => ({ ...toQueue(q), stats: stats[q.id] })) };
  }

  @Post('projects/:projectId/queues')
  @HttpCode(201)
  @ApiOperation({ summary: 'Create a queue' })
  async create(
    @Param('projectId') projectId: string,
    @Body() dto: CreateQueueDto,
    @Principal() principal: AuthPrincipal,
  ) {
    await this.tenancy.project(principal, projectId);

    // The referenced policy must belong to THIS project — otherwise a caller
    // could bind their queue to another tenant's policy by guessing an id.
    const policy = await this.prisma.retryPolicy.findFirst({
      where: { id: dto.retry_policy_id, projectId },
      select: { id: true },
    });
    if (!policy) throw AppError.notFound('Retry policy');

    const queue = await this.prisma.queue.create({
      data: {
        projectId,
        name: dto.name,
        description: dto.description ?? null,
        defaultPriority: dto.default_priority ?? 100,
        maxConcurrency: dto.max_concurrency ?? null,
        retryPolicyId: policy.id,
        visibilityTimeoutMs: dto.visibility_timeout_ms ?? 60_000,
        defaultJobTimeoutMs: dto.default_job_timeout_ms ?? 30_000,
        dlqEnabled: dto.dlq_enabled ?? true,
        retentionDays: dto.retention_days ?? null,
      },
      include: { retryPolicy: { select: { id: true, name: true, strategy: true } } },
    });
    return toQueue(queue);
  }

  @Get('queues/:queueId')
  async detail(@Param('queueId') queueId: string, @Principal() principal: AuthPrincipal) {
    await this.tenancy.queue(principal, queueId);
    const queue = await this.prisma.queue.findUniqueOrThrow({
      where: { id: queueId },
      include: {
        retryPolicy: true,
        subscriptions: {
          include: { worker: { select: { id: true, name: true, status: true } } },
        },
      },
    });
    const stats = await this.stats.forQueues([queueId]);
    return {
      ...toQueue(queue),
      stats: stats[queueId],
      workers: queue.subscriptions.map((s) => s.worker),
    };
  }

  @Patch('queues/:queueId')
  @ApiOperation({
    summary: 'Update queue configuration',
    description:
      'Changes affect NEW jobs only. Each job snapshots its retry contract at creation, so editing a policy cannot rewrite the behaviour of jobs already in flight.',
  })
  async update(
    @Param('queueId') queueId: string,
    @Body() dto: UpdateQueueDto,
    @Principal() principal: AuthPrincipal,
  ) {
    const existing = await this.tenancy.queue(principal, queueId);

    if (dto.retry_policy_id) {
      const policy = await this.prisma.retryPolicy.findFirst({
        where: { id: dto.retry_policy_id, projectId: existing.projectId },
        select: { id: true },
      });
      if (!policy) throw AppError.notFound('Retry policy');
    }

    const queue = await this.prisma.queue.update({
      where: { id: queueId },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
        ...(dto.default_priority !== undefined ? { defaultPriority: dto.default_priority } : {}),
        ...(dto.max_concurrency !== undefined ? { maxConcurrency: dto.max_concurrency } : {}),
        ...(dto.retry_policy_id !== undefined ? { retryPolicyId: dto.retry_policy_id } : {}),
        ...(dto.visibility_timeout_ms !== undefined
          ? { visibilityTimeoutMs: dto.visibility_timeout_ms }
          : {}),
        ...(dto.default_job_timeout_ms !== undefined
          ? { defaultJobTimeoutMs: dto.default_job_timeout_ms }
          : {}),
        ...(dto.dlq_enabled !== undefined ? { dlqEnabled: dto.dlq_enabled } : {}),
        ...(dto.retention_days !== undefined ? { retentionDays: dto.retention_days } : {}),
      },
      include: { retryPolicy: { select: { id: true, name: true, strategy: true } } },
    });
    return { ...toQueue(queue), applies_to: 'new jobs only' };
  }

  @Post('queues/:queueId/pause')
  // POST defaults to 201 in Nest. Pausing creates nothing, so 201 would be a
  // lie in the generated OpenAPI — and clients written against the spec would
  // branch on the wrong code.
  @HttpCode(200)
  @ApiOperation({
    summary: 'Pause a queue',
    description:
      'Stops new claims. Running jobs are NOT killed — pause means "stop starting", not "abort", because aborting would leave side effects half-applied.',
  })
  async pause(
    @Param('queueId') queueId: string,
    @Body() dto: PauseDto,
    @Principal() principal: AuthPrincipal,
  ) {
    const queue = await this.tenancy.queue(principal, queueId);
    if (queue.isPaused) {
      throw AppError.conflict(ERROR_CODES.CONFLICT, 'Queue is already paused');
    }
    await this.prisma.queue.update({
      where: { id: queueId },
      data: {
        isPaused: true,
        pausedAt: new Date(),
        pauseReason: dto.reason ?? null,
        ...(principal.kind === 'user' ? { pausedById: principal.userId } : {}),
      },
    });
    return { id: queueId, is_paused: true, paused_at: new Date().toISOString() };
  }

  @Post('queues/:queueId/resume')
  @HttpCode(200)
  async resume(@Param('queueId') queueId: string, @Principal() principal: AuthPrincipal) {
    const queue = await this.tenancy.queue(principal, queueId);
    if (!queue.isPaused) {
      throw AppError.conflict(ERROR_CODES.CONFLICT, 'Queue is not paused');
    }
    await this.prisma.queue.update({
      where: { id: queueId },
      data: { isPaused: false, pausedAt: null, pausedById: null, pauseReason: null },
    });
    // Wake workers immediately rather than making them wait out a poll interval.
    await this.prisma
      .$executeRawUnsafe(`SELECT pg_notify('jobs_ready', $1)`, queueId)
      .catch(() => {});
    return { id: queueId, is_paused: false };
  }

  @Get('queues/:queueId/stats')
  async queueStats(
    @Param('queueId') queueId: string,
    @Query('window') window: string | undefined,
    @Principal() principal: AuthPrincipal,
  ) {
    await this.tenancy.queue(principal, queueId);
    const stats = await this.stats.forQueues([queueId], window ?? '24h');
    return stats[queueId];
  }

  @Delete('queues/:queueId')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a queue. Refuses if it still holds jobs unless force=true.' })
  async remove(
    @Param('queueId') queueId: string,
    @Query('force') force: string | undefined,
    @Principal() principal: AuthPrincipal,
  ): Promise<void> {
    await this.tenancy.queue(principal, queueId);
    const jobCount = await this.prisma.job.count({ where: { queueId } });
    if (jobCount > 0 && force !== 'true') {
      throw AppError.conflict(
        ERROR_CODES.IN_USE,
        `Queue still holds ${jobCount} jobs. Pass ?force=true to delete them along with it.`,
      );
    }
    await this.prisma.queue.delete({ where: { id: queueId } });
  }
}

function toQueue(q: Record<string, unknown>) {
  return {
    id: q['id'],
    project_id: q['projectId'],
    name: q['name'],
    description: q['description'],
    default_priority: q['defaultPriority'],
    max_concurrency: q['maxConcurrency'],
    visibility_timeout_ms: q['visibilityTimeoutMs'],
    default_job_timeout_ms: q['defaultJobTimeoutMs'],
    is_paused: q['isPaused'],
    paused_at: q['pausedAt'],
    pause_reason: q['pauseReason'],
    dlq_enabled: q['dlqEnabled'],
    retention_days: q['retentionDays'],
    retry_policy: q['retryPolicy'],
    created_at: q['createdAt'],
  };
}
