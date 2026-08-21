import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../../prisma.service.js';
import { TenancyService, Principal } from '../../common/guards.js';
import type { AuthPrincipal } from '../auth/auth.service.js';

@ApiTags('metrics')
@Controller()
export class MetricsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenancy: TenancyService,
  ) {}

  @Get('projects/:projectId/metrics/overview')
  @ApiOperation({ summary: 'The dashboard stat cards' })
  async overview(@Param('projectId') projectId: string, @Principal() principal: AuthPrincipal) {
    const project = await this.tenancy.project(principal, projectId);
    const since = new Date(Date.now() - 24 * 3_600_000);

    const [live, rollup, dlqOpen, workers, oldest, capacity] = await Promise.all([
      this.prisma.job.groupBy({ by: ['status'], where: { projectId }, _count: true }),
      this.prisma.queueMetricMinute.aggregate({
        where: { queue: { projectId }, bucket: { gte: since } },
        _sum: { completedCount: true, failedCount: true, dlqCount: true, totalDurationMs: true },
        _max: { p95DurationMs: true },
      }),
      this.prisma.deadLetterJob.count({ where: { projectId, resolvedAt: null } }),
      this.prisma.worker.groupBy({
        by: ['status'],
        where: { orgId: project.orgId },
        _count: true,
      }),
      this.prisma.$queryRaw<{ oldest: Date | null }[]>`
        SELECT MIN(run_at) AS oldest FROM jobs
         WHERE project_id = ${projectId}::uuid AND status = 'QUEUED'`,
      this.prisma.worker.aggregate({
        where: {
          orgId: project.orgId,
          status: 'ACTIVE',
          lastHeartbeatAt: { gte: new Date(Date.now() - 30_000) },
        },
        _sum: { concurrency: true, activeJobCount: true },
      }),
    ]);

    const count = (s: string): number => live.find((l) => l.status === s)?._count ?? 0;
    const completed = rollup._sum.completedCount ?? 0;
    const deadLettered = rollup._sum.dlqCount ?? 0;
    const totalDuration = Number(rollup._sum.totalDurationMs ?? 0);
    const terminal = completed + deadLettered;

    const oldestQueued = oldest[0]?.oldest;
    const totalCapacity = capacity._sum.concurrency ?? 0;
    const inUse = capacity._sum.activeJobCount ?? 0;

    return {
      // Live counts, from the partial status indexes.
      queued: count('QUEUED'),
      scheduled: count('SCHEDULED'),
      retrying: count('RETRYING'),
      running: count('CLAIMED') + count('RUNNING'),
      completed_total: count('COMPLETED'),

      // Windowed, from the pre-aggregated rollups — never counted from `jobs`.
      completed_24h: completed,
      // Labelled ATTEMPTS deliberately: a job that succeeds on attempt 3
      // contributes 2 here and 1 to completed. Conflating the two is a common
      // and confusing bug.
      failed_attempts_24h: rollup._sum.failedCount ?? 0,
      dead_lettered_24h: deadLettered,

      dlq_open: dlqOpen,
      // Computed over jobs reaching a TERMINAL state, not over attempts.
      success_rate_24h: terminal > 0 ? Number((completed / terminal).toFixed(4)) : null,
      avg_duration_ms: completed > 0 ? Math.round(totalDuration / completed) : 0,
      // Honest label: an exact cross-bucket percentile needs a t-digest, which
      // is out of scope. This is the max of per-minute p95s.
      p95_duration_ms_approx: rollup._max.p95DurationMs ?? 0,
      throughput_per_min: Number((completed / 1440).toFixed(2)),

      workers_active: workers.find((w) => w.status === 'ACTIVE')?._count ?? 0,
      workers_dead: workers.find((w) => w.status === 'DEAD')?._count ?? 0,
      capacity_used: totalCapacity > 0 ? `${inUse}/${totalCapacity}` : '0/0',

      // ⭐ The single best SLO proxy. If this climbs, something is wrong
      // regardless of what every other number says.
      oldest_queued_age_s: oldestQueued
        ? Math.floor((Date.now() - oldestQueued.getTime()) / 1000)
        : null,
    };
  }

  @Get('projects/:projectId/metrics/throughput')
  @ApiOperation({
    summary: 'Time series for the throughput chart',
    description:
      'Served from queue_metrics_minute. Answering this from job_executions would aggregate millions of rows on every dashboard poll.',
  })
  async throughput(
    @Param('projectId') projectId: string,
    @Query('window') window: string | undefined,
    @Query('bucket') bucket: string | undefined,
    @Query('queue_id') queueId: string | undefined,
    @Principal() principal: AuthPrincipal,
  ) {
    await this.tenancy.project(principal, projectId);

    const minutes = window === '1h' ? 60 : window === '7d' ? 10_080 : 1_440;
    const since = new Date(Date.now() - minutes * 60_000);
    // Minute buckets over 7 days would be 10,080 points for a chart a few
    // hundred pixels wide. Downsample server-side rather than shipping them.
    const grain = bucket ?? (minutes > 1_440 ? '1h' : minutes > 180 ? '5m' : '1m');
    const truncTo = grain === '1h' ? 'hour' : 'minute';
    const groupMinutes = grain === '5m' ? 5 : 1;

    const rows = await this.prisma.$queryRawUnsafe<
      { bucket: Date; completed: bigint; failed: bigint; dead_lettered: bigint; avg_ms: number }[]
    >(
      `SELECT date_trunc($1, m.bucket)
                - make_interval(mins => (EXTRACT(MINUTE FROM m.bucket)::int % $2))  AS bucket,
              sum(m.completed_count)::bigint AS completed,
              sum(m.failed_count)::bigint    AS failed,
              sum(m.dlq_count)::bigint       AS dead_lettered,
              CASE WHEN sum(m.completed_count) > 0
                   THEN (sum(m.total_duration_ms) / sum(m.completed_count))::int
                   ELSE 0 END                AS avg_ms
         FROM queue_metrics_minute m
         JOIN queues q ON q.id = m.queue_id
        WHERE q.project_id = $3::uuid
          AND m.bucket >= $4::timestamptz
          ${queueId ? 'AND m.queue_id = $5::uuid' : ''}
        GROUP BY 1
        ORDER BY 1`,
      ...[truncTo, groupMinutes, projectId, since, ...(queueId ? [queueId] : [])],
    );

    return {
      window,
      bucket: grain,
      data: rows.map((r) => ({
        bucket: r.bucket.toISOString(),
        completed: Number(r.completed),
        failed: Number(r.failed),
        dead_lettered: Number(r.dead_lettered),
        avg_duration_ms: r.avg_ms,
      })),
    };
  }

  @Get('projects/:projectId/metrics/latency')
  @ApiOperation({
    summary: 'Queue wait vs execution time',
    description:
      'Queue wait (created -> started) is the user-facing latency and is far more actionable than execution time alone. Measured on first attempts only.',
  })
  async latency(@Param('projectId') projectId: string, @Principal() principal: AuthPrincipal) {
    await this.tenancy.project(principal, projectId);

    const rows = await this.prisma.$queryRaw<
      {
        p50_wait_ms: number | null;
        p95_wait_ms: number | null;
        p99_wait_ms: number | null;
        p50_exec_ms: number | null;
        p95_exec_ms: number | null;
      }[]
    >`
      SELECT
        percentile_disc(0.50) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (e.started_at - j.created_at)) * 1000)::int AS p50_wait_ms,
        percentile_disc(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (e.started_at - j.created_at)) * 1000)::int AS p95_wait_ms,
        percentile_disc(0.99) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (e.started_at - j.created_at)) * 1000)::int AS p99_wait_ms,
        percentile_disc(0.50) WITHIN GROUP (ORDER BY e.duration_ms)::int AS p50_exec_ms,
        percentile_disc(0.95) WITHIN GROUP (ORDER BY e.duration_ms)::int AS p95_exec_ms
      FROM job_executions e
      JOIN jobs j ON j.id = e.job_id
     WHERE j.project_id = ${projectId}::uuid
       AND e.attempt = 1
       AND e.finished_at >= now() - interval '24 hours'`;

    return rows[0] ?? {};
  }
}
