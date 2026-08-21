import { Controller, Get, Res } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { PrismaService } from '../../prisma.service.js';
import { Public } from '../../common/guards.js';

@ApiTags('health')
@Controller()
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Liveness. Deliberately does NOT touch the database.
   *
   * If /health checked Postgres, a brief database blip would get every healthy
   * API process restarted by the orchestrator — turning a short outage into a
   * long one. Liveness answers "is this process wedged", nothing else.
   */
  @Public()
  @Get('health')
  @ApiOperation({ summary: 'Liveness — the process is up' })
  health() {
    return { status: 'ok', uptime_s: Math.floor(process.uptime()) };
  }

  /**
   * Readiness. Does touch the database.
   *
   * Failing here removes the instance from the load balancer without killing
   * it, so it rejoins the moment the dependency returns.
   */
  @Public()
  @Get('ready')
  @ApiOperation({ summary: 'Readiness — database reachable and migrations current' })
  async ready(@Res({ passthrough: true }) res: Response) {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      const pending = await this.prisma.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM _prisma_migrations WHERE finished_at IS NULL`;
      if (Number(pending[0]?.n ?? 0) > 0) {
        res.status(503);
        return { ready: false, reason: 'migrations in progress' };
      }
      return { ready: true };
    } catch {
      res.status(503);
      return { ready: false, reason: 'database unreachable' };
    }
  }

  @Public()
  @Get('metrics')
  @ApiExcludeEndpoint()
  async metrics(@Res({ passthrough: true }) res: Response) {
    const [byStatus, workersAlive, dlqOpen] = await Promise.all([
      this.prisma.job.groupBy({ by: ['status'], _count: true }),
      this.prisma.worker.count({
        where: { status: 'ACTIVE', lastHeartbeatAt: { gte: new Date(Date.now() - 30_000) } },
      }),
      this.prisma.deadLetterJob.count({ where: { resolvedAt: null } }),
    ]);

    res.setHeader('content-type', 'text/plain; version=0.0.4');
    return [
      '# HELP djs_jobs_by_status Current job count per lifecycle state.',
      '# TYPE djs_jobs_by_status gauge',
      ...byStatus.map((s) => `djs_jobs_by_status{status="${s.status}"} ${s._count}`),
      '# TYPE djs_workers_alive gauge',
      `djs_workers_alive ${workersAlive}`,
      '# HELP djs_dlq_open Entries awaiting a human decision.',
      '# TYPE djs_dlq_open gauge',
      `djs_dlq_open ${dlqOpen}`,
      '',
    ].join('\n');
  }
}
