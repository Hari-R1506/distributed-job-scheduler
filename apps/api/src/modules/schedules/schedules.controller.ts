import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsInt, IsIn, IsISO8601, IsObject, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';
import {
  validateCron,
  nextFireTime,
  nextFireTimes,
  describeCron,
  InvalidCronError,
} from '@djs/core';
import { PrismaService } from '../../prisma.service.js';
import { TenancyService, Principal, Public } from '../../common/guards.js';
import type { AuthPrincipal } from '../auth/auth.service.js';
import { AppError, ERROR_CODES } from '../../common/errors.js';

class CreateScheduleDto {
  @ApiProperty() @IsString() queue_id!: string;
  @ApiProperty() @IsString() @MaxLength(100) name!: string;
  @ApiProperty({ example: '0 9 * * *' }) @IsString() cron_expression!: string;
  @ApiPropertyOptional({ default: 'UTC', description: 'IANA name, e.g. Asia/Kolkata.' })
  @IsOptional() @IsString()
  timezone?: string;
  @ApiProperty() @IsString() handler!: string;
  @ApiPropertyOptional() @IsOptional() @IsObject() payload?: Record<string, unknown>;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() priority?: number;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1) max_attempts?: number;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1) timeout_ms?: number;
  @ApiPropertyOptional({ enum: ['SKIP', 'FIRE_ONCE', 'BACKFILL'], default: 'SKIP' })
  @IsOptional() @IsIn(['SKIP', 'FIRE_ONCE', 'BACKFILL'])
  misfire_policy?: 'SKIP' | 'FIRE_ONCE' | 'BACKFILL';
  @ApiPropertyOptional() @IsOptional() @IsISO8601() start_at?: string;
  @ApiPropertyOptional() @IsOptional() @IsISO8601() end_at?: string;
}

class UpdateScheduleDto {
  @ApiPropertyOptional() @IsOptional() @IsString() cron_expression?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() timezone?: string;
  @ApiPropertyOptional() @IsOptional() @IsObject() payload?: Record<string, unknown>;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() priority?: number;
}

class ValidateCronDto {
  @ApiProperty() @IsString() cron_expression!: string;
  @ApiPropertyOptional({ default: 'UTC' }) @IsOptional() @IsString() timezone?: string;
}

@ApiTags('schedules')
@Controller()
export class SchedulesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenancy: TenancyService,
  ) {}

  @Post('cron/validate')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Validate a cron expression and preview its next runs',
    description:
      'Powers the live preview on the Create Job form. Nobody reads `0 9 * * *` correctly under time pressure.',
  })
  validateCronExpression(@Body() dto: ValidateCronDto) {
    const spec = { expression: dto.cron_expression, timezone: dto.timezone ?? 'UTC' };
    try {
      validateCron(spec);
    } catch (err) {
      if (err instanceof InvalidCronError) {
        return { valid: false, error: err.message, description: null, next_runs: [] };
      }
      throw err;
    }
    return {
      valid: true,
      error: null,
      description: describeCron(spec),
      next_runs: nextFireTimes(spec, new Date(), 5).map((d) => d.toISOString()),
    };
  }

  @Get('projects/:projectId/scheduled-jobs')
  async list(@Param('projectId') projectId: string, @Principal() principal: AuthPrincipal) {
    await this.tenancy.project(principal, projectId);
    const rows = await this.prisma.scheduledJob.findMany({
      where: { projectId },
      orderBy: { name: 'asc' },
      include: {
        queue: { select: { id: true, name: true } },
        lastJob: { select: { id: true, status: true, finishedAt: true } },
      },
    });
    return { data: rows.map(toSchedule) };
  }

  @Post('projects/:projectId/scheduled-jobs')
  @HttpCode(201)
  async create(
    @Param('projectId') projectId: string,
    @Body() dto: CreateScheduleDto,
    @Principal() principal: AuthPrincipal,
  ) {
    await this.tenancy.project(principal, projectId);
    const queue = await this.tenancy.queue(principal, dto.queue_id);
    if (queue.projectId !== projectId) throw AppError.notFound('Queue');

    const spec = { expression: dto.cron_expression, timezone: dto.timezone ?? 'UTC' };
    // Validated at write time, so a schedule that can never fire is rejected
    // here rather than silently disabling itself on the scheduler's next tick.
    this.assertCron(spec);

    const startFrom = dto.start_at ? new Date(dto.start_at) : new Date();

    const schedule = await this.prisma.scheduledJob.create({
      data: {
        projectId,
        queueId: dto.queue_id,
        name: dto.name,
        cronExpression: spec.expression,
        timezone: spec.timezone,
        handler: dto.handler,
        payload: (dto.payload ?? {}) as never,
        priority: dto.priority ?? queue.defaultPriority,
        maxAttempts: dto.max_attempts ?? null,
        timeoutMs: dto.timeout_ms ?? null,
        misfirePolicy: dto.misfire_policy ?? 'SKIP',
        startAt: dto.start_at ? new Date(dto.start_at) : null,
        endAt: dto.end_at ? new Date(dto.end_at) : null,
        nextRunAt: nextFireTime(spec, startFrom),
        ...(principal.kind === 'user' ? { createdById: principal.userId } : {}),
      },
      include: { queue: { select: { id: true, name: true } } },
    });
    return toSchedule(schedule);
  }

  @Patch('scheduled-jobs/:scheduleId')
  @ApiOperation({
    summary: 'Update a schedule',
    description: 'Changing the cron expression or timezone recomputes next_run_at from now.',
  })
  async update(
    @Param('scheduleId') scheduleId: string,
    @Body() dto: UpdateScheduleDto,
    @Principal() principal: AuthPrincipal,
  ) {
    const existing = await this.prisma.scheduledJob.findUniqueOrThrow({ where: { id: scheduleId } });
    await this.tenancy.project(principal, existing.projectId);

    const spec = {
      expression: dto.cron_expression ?? existing.cronExpression,
      timezone: dto.timezone ?? existing.timezone,
    };
    const timingChanged = dto.cron_expression !== undefined || dto.timezone !== undefined;
    if (timingChanged) this.assertCron(spec);

    const schedule = await this.prisma.scheduledJob.update({
      where: { id: scheduleId },
      data: {
        cronExpression: spec.expression,
        timezone: spec.timezone,
        ...(dto.payload !== undefined ? { payload: dto.payload as never } : {}),
        ...(dto.priority !== undefined ? { priority: dto.priority } : {}),
        // Recomputed from NOW, not from the old cursor: an edited schedule must
        // not immediately fire for a slot that belonged to the old expression.
        ...(timingChanged ? { nextRunAt: nextFireTime(spec, new Date()) } : {}),
      },
      include: { queue: { select: { id: true, name: true } } },
    });
    return toSchedule(schedule);
  }

  @Post('scheduled-jobs/:scheduleId/pause')
  @HttpCode(200)
  async pause(@Param('scheduleId') scheduleId: string, @Principal() principal: AuthPrincipal) {
    const s = await this.prisma.scheduledJob.findUniqueOrThrow({ where: { id: scheduleId } });
    await this.tenancy.project(principal, s.projectId);
    await this.prisma.scheduledJob.update({ where: { id: scheduleId }, data: { isEnabled: false } });
    return { id: scheduleId, is_enabled: false };
  }

  @Post('scheduled-jobs/:scheduleId/resume')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Resume a schedule',
    description:
      'Recomputes next_run_at from now, so resuming does not fire a burst of catch-up jobs for the paused period.',
  })
  async resume(@Param('scheduleId') scheduleId: string, @Principal() principal: AuthPrincipal) {
    const s = await this.prisma.scheduledJob.findUniqueOrThrow({ where: { id: scheduleId } });
    await this.tenancy.project(principal, s.projectId);
    const next = nextFireTime({ expression: s.cronExpression, timezone: s.timezone }, new Date());
    await this.prisma.scheduledJob.update({
      where: { id: scheduleId },
      data: { isEnabled: true, nextRunAt: next },
    });
    return { id: scheduleId, is_enabled: true, next_run_at: next.toISOString() };
  }

  @Post('scheduled-jobs/:scheduleId/trigger')
  @HttpCode(201)
  @ApiOperation({
    summary: 'Fire once immediately',
    description:
      'Does NOT disturb the cursor — the normal schedule continues unchanged. Invaluable for demos and for on-call.',
  })
  async trigger(@Param('scheduleId') scheduleId: string, @Principal() principal: AuthPrincipal) {
    const s = await this.prisma.scheduledJob.findUniqueOrThrow({
      where: { id: scheduleId },
      include: { queue: { include: { retryPolicy: true } } },
    });
    await this.tenancy.project(principal, s.projectId);

    const policy = s.queue.retryPolicy;
    const job = await this.prisma.job.create({
      data: {
        queueId: s.queueId,
        projectId: s.projectId,
        // Deliberately no scheduledJobId/scheduledFor: a manual trigger must not
        // occupy a real cron slot, or the scheduled run for that slot would be
        // suppressed by the exactly-once unique index.
        handler: s.handler,
        payload: s.payload as never,
        priority: s.priority,
        status: 'QUEUED',
        maxAttempts: s.maxAttempts ?? policy.maxAttempts,
        backoffStrategy: policy.strategy,
        backoffBaseMs: policy.baseDelayMs,
        backoffMaxMs: policy.maxDelayMs,
        backoffJitterPct: policy.jitterPct,
        retryPolicyId: policy.id,
        timeoutMs: s.timeoutMs ?? s.queue.defaultJobTimeoutMs,
        metadata: { triggered_manually: true, schedule_id: s.id } as never,
        ...(principal.kind === 'user' ? { createdById: principal.userId } : {}),
      },
      select: { id: true, status: true },
    });

    await this.prisma
      .$executeRawUnsafe(`SELECT pg_notify('jobs_ready', $1)`, s.queueId)
      .catch(() => {});

    return { job_id: job.id, status: job.status, schedule_id: scheduleId };
  }

  @Get('scheduled-jobs/:scheduleId/runs')
  async runs(@Param('scheduleId') scheduleId: string, @Principal() principal: AuthPrincipal) {
    const s = await this.prisma.scheduledJob.findUniqueOrThrow({ where: { id: scheduleId } });
    await this.tenancy.project(principal, s.projectId);
    const jobs = await this.prisma.job.findMany({
      where: { scheduledJobId: scheduleId },
      orderBy: { scheduledFor: 'desc' },
      take: 50,
      select: {
        id: true,
        status: true,
        scheduledFor: true,
        runAt: true,
        startedAt: true,
        finishedAt: true,
        attemptCount: true,
      },
    });
    return {
      data: jobs.map((j) => ({
        id: j.id,
        status: j.status,
        scheduled_for: j.scheduledFor?.toISOString() ?? null,
        // Drift between the intended slot and the actual start is exactly what
        // scheduled_for exists to make visible.
        started_at: j.startedAt?.toISOString() ?? null,
        lateness_ms:
          j.scheduledFor && j.startedAt
            ? j.startedAt.getTime() - j.scheduledFor.getTime()
            : null,
        finished_at: j.finishedAt?.toISOString() ?? null,
        attempt_count: j.attemptCount,
      })),
    };
  }

  @Delete('scheduled-jobs/:scheduleId')
  @HttpCode(204)
  async remove(
    @Param('scheduleId') scheduleId: string,
    @Principal() principal: AuthPrincipal,
  ): Promise<void> {
    const s = await this.prisma.scheduledJob.findUniqueOrThrow({ where: { id: scheduleId } });
    await this.tenancy.project(principal, s.projectId);
    // Jobs already materialised keep running: scheduled_job_id is ON DELETE SET
    // NULL, so deleting the definition does not retract work already queued.
    await this.prisma.scheduledJob.delete({ where: { id: scheduleId } });
  }

  private assertCron(spec: { expression: string; timezone: string }): void {
    try {
      validateCron(spec);
    } catch (err) {
      if (err instanceof InvalidCronError) {
        throw AppError.unprocessable(
          err.message.includes('once per minute')
            ? ERROR_CODES.CRON_TOO_FREQUENT
            : ERROR_CODES.INVALID_CRON,
          err.message,
        );
      }
      throw err;
    }
  }
}

function toSchedule(s: Record<string, unknown>) {
  const spec = {
    expression: s['cronExpression'] as string,
    timezone: s['timezone'] as string,
  };
  return {
    id: s['id'],
    queue: s['queue'],
    name: s['name'],
    cron_expression: spec.expression,
    timezone: spec.timezone,
    description: describeCron(spec),
    handler: s['handler'],
    payload: s['payload'],
    priority: s['priority'],
    misfire_policy: s['misfirePolicy'],
    is_enabled: s['isEnabled'],
    next_run_at: (s['nextRunAt'] as Date).toISOString(),
    next_runs: (s['isEnabled'] as boolean)
      ? nextFireTimes(spec, new Date(), 5).map((d) => d.toISOString())
      : [],
    last_run_at: (s['lastRunAt'] as Date | null)?.toISOString() ?? null,
    last_job: s['lastJob'] ?? null,
    start_at: (s['startAt'] as Date | null)?.toISOString() ?? null,
    end_at: (s['endAt'] as Date | null)?.toISOString() ?? null,
  };
}
