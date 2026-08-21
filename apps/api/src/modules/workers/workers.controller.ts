import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { TIMING } from '@djs/core';
import { PrismaService } from '../../prisma.service.js';
import { TenancyService, Principal } from '../../common/guards.js';
import type { AuthPrincipal } from '../auth/auth.service.js';

/**
 * Read-only. There is deliberately no POST /workers.
 *
 * Workers register themselves through the DATABASE, not over HTTP, which keeps
 * the API off the critical path of job execution entirely: a worker that can
 * only reach Postgres is still fully functional. That is a real availability
 * property, not an implementation detail (ARCHITECTURE.md §17.7).
 */
@ApiTags('workers')
@Controller()
export class WorkersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenancy: TenancyService,
  ) {}

  @Get('orgs/:orgId/workers')
  @ApiOperation({ summary: 'The fleet, with derived health' })
  async list(
    @Param('orgId') orgId: string,
    @Query('status') status: string | undefined,
    @Principal() principal: AuthPrincipal,
  ) {
    await this.tenancy.org(principal, orgId);

    const workers = await this.prisma.worker.findMany({
      where: {
        orgId,
        ...(status
          ? { status: status.toUpperCase() as never }
          : // Stopped workers are kept for their execution history, but would
            // otherwise clutter the fleet view forever.
            {
              OR: [
                { status: { not: 'STOPPED' } },
                { stoppedAt: { gte: new Date(Date.now() - 3_600_000) } },
              ],
            }),
      },
      orderBy: [{ status: 'asc' }, { name: 'asc' }],
      include: {
        subscriptions: { include: { queue: { select: { id: true, name: true } } } },
      },
    });

    return { data: workers.map(toWorker) };
  }

  @Get('workers/:workerId')
  async detail(@Param('workerId') workerId: string, @Principal() principal: AuthPrincipal) {
    const worker = await this.prisma.worker.findUniqueOrThrow({
      where: { id: workerId },
      include: { subscriptions: { include: { queue: { select: { id: true, name: true } } } } },
    });
    await this.tenancy.org(principal, worker.orgId);

    const running = await this.prisma.job.findMany({
      where: { workerId, status: { in: ['CLAIMED', 'RUNNING'] } },
      select: { id: true, handler: true, startedAt: true, attemptCount: true },
    });

    return { ...toWorker(worker), running_jobs: running };
  }

  @Get('workers/:workerId/heartbeats')
  @ApiOperation({ summary: 'Sampled history behind the worker charts' })
  async heartbeats(
    @Param('workerId') workerId: string,
    @Query('window') window: string | undefined,
    @Principal() principal: AuthPrincipal,
  ) {
    const worker = await this.prisma.worker.findUniqueOrThrow({
      where: { id: workerId },
      select: { orgId: true },
    });
    await this.tenancy.org(principal, worker.orgId);

    const minutes = window === '24h' ? 1440 : window === '6h' ? 360 : 60;
    const rows = await this.prisma.workerHeartbeat.findMany({
      where: { workerId, recordedAt: { gte: new Date(Date.now() - minutes * 60_000) } },
      orderBy: { recordedAt: 'asc' },
    });

    return {
      data: rows.map((h) => ({
        recorded_at: h.recordedAt.toISOString(),
        active_job_count: h.activeJobCount,
        jobs_processed_delta: h.jobsProcessedDelta,
        mem_mb: h.memMb,
      })),
    };
  }
}

function toWorker(w: Record<string, unknown>) {
  const last = w['lastHeartbeatAt'] as Date;
  const ageMs = Date.now() - last.getTime();

  return {
    id: w['id'],
    name: w['name'],
    status: w['status'],
    hostname: w['hostname'],
    pid: w['pid'],
    concurrency: w['concurrency'],
    active_job_count: w['activeJobCount'],
    started_at: (w['startedAt'] as Date).toISOString(),
    last_heartbeat_at: last.toISOString(),
    seconds_since_heartbeat: Math.floor(ageMs / 1000),
    stopped_at: (w['stoppedAt'] as Date | null)?.toISOString() ?? null,
    // The amber band matters: it separates "briefly busy" from "gone", which is
    // where an operator catches a degrading worker before it takes jobs with it.
    health:
      w['status'] === 'DEAD' || ageMs > TIMING.WORKER_TIMEOUT_MS
        ? 'dead'
        : ageMs > TIMING.HEARTBEAT_INTERVAL_MS * 2
          ? 'lagging'
          : 'healthy',
    queues: (w['subscriptions'] as { queue: unknown }[] | undefined)?.map((s) => s.queue) ?? [],
  };
}
