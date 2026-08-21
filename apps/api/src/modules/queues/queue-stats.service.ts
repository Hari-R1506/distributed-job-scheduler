import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma.service.js';

export interface QueueStats {
  queued: number;
  scheduled: number;
  retrying: number;
  running: number;
  completed_24h: number;
  failed_24h: number;
  dlq_open: number;
  success_rate_24h: number | null;
  avg_duration_ms: number;
  p95_duration_ms: number;
  throughput_per_min: number;
  oldest_queued_age_s: number | null;
  capacity_used: string;
  health: 'healthy' | 'degraded' | 'unhealthy' | 'paused';
}

interface CacheEntry {
  at: number;
  value: Record<string, QueueStats>;
}

/**
 * Queue health, assembled from two sources with different cost profiles.
 *
 *   LIVE COUNTS  — indexed COUNT(*) on `jobs`, cached 3s in-process.
 *   HISTORY      — pre-aggregated `queue_metrics_minute` buckets.
 *
 * Neither is a counter column on `queues`. Incrementing one on every completion
 * would take a row lock on a single row per queue, making it the serialisation
 * point for the entire queue — a global mutex by accident (ARCHITECTURE.md §4.2).
 */
@Injectable()
export class QueueStatsService {
  private cache = new Map<string, CacheEntry>();
  private static readonly TTL_MS = 3_000;

  constructor(private readonly prisma: PrismaService) {}

  async forQueues(queueIds: string[], window = '24h'): Promise<Record<string, QueueStats>> {
    if (queueIds.length === 0) return {};

    const cacheKey = `${window}:${[...queueIds].sort().join(',')}`;
    const hit = this.cache.get(cacheKey);
    if (hit && Date.now() - hit.at < QueueStatsService.TTL_MS) return hit.value;

    const minutes = window === '1h' ? 60 : window === '7d' ? 10_080 : 1_440;
    const since = new Date(Date.now() - minutes * 60_000);

    const [live, rollups, dlq, oldest, capacity] = await Promise.all([
      // One grouped scan over the partial status indexes, not N queries.
      this.prisma.job.groupBy({
        by: ['queueId', 'status'],
        where: {
          queueId: { in: queueIds },
          status: { in: ['QUEUED', 'SCHEDULED', 'RETRYING', 'CLAIMED', 'RUNNING'] },
        },
        _count: true,
      }),
      this.prisma.queueMetricMinute.groupBy({
        by: ['queueId'],
        where: { queueId: { in: queueIds }, bucket: { gte: since } },
        _sum: { completedCount: true, failedCount: true, dlqCount: true, totalDurationMs: true },
        _max: { p95DurationMs: true },
      }),
      this.prisma.deadLetterJob.groupBy({
        by: ['queueId'],
        where: { queueId: { in: queueIds }, resolvedAt: null },
        _count: true,
      }),
      // The best single SLO proxy: if this climbs, something is wrong no matter
      // what the other numbers say.
      this.prisma.$queryRaw<{ queue_id: string; oldest: Date }[]>`
        SELECT queue_id, MIN(run_at) AS oldest
          FROM jobs
         WHERE status = 'QUEUED' AND queue_id = ANY(${queueIds}::uuid[])
         GROUP BY queue_id`,
      this.prisma.queue.findMany({
        where: { id: { in: queueIds } },
        select: { id: true, maxConcurrency: true, isPaused: true },
      }),
    ]);

    const out: Record<string, QueueStats> = {};

    for (const q of capacity) {
      const counts = (status: string): number =>
        live.find((l) => l.queueId === q.id && l.status === status)?._count ?? 0;

      const roll = rollups.find((r) => r.queueId === q.id);
      const completed = roll?._sum.completedCount ?? 0;
      const failed = roll?._sum.failedCount ?? 0;
      const deadLettered = roll?._sum.dlqCount ?? 0;
      const totalDuration = Number(roll?._sum.totalDurationMs ?? 0);

      const running = counts('CLAIMED') + counts('RUNNING');
      const queued = counts('QUEUED');
      const oldestRow = oldest.find((o) => o.queue_id === q.id);
      const oldestAge = oldestRow ? Math.floor((Date.now() - oldestRow.oldest.getTime()) / 1000) : null;
      const dlqOpen = dlq.find((d) => d.queueId === q.id)?._count ?? 0;

      // Success rate is computed over jobs reaching a TERMINAL state, not over
      // attempts. A job that succeeds on attempt 3 is a success, not 67% failure.
      const terminal = completed + deadLettered;

      out[q.id] = {
        queued,
        scheduled: counts('SCHEDULED'),
        retrying: counts('RETRYING'),
        running,
        completed_24h: completed,
        failed_24h: failed,
        dlq_open: dlqOpen,
        success_rate_24h: terminal > 0 ? Number((completed / terminal).toFixed(4)) : null,
        avg_duration_ms: completed > 0 ? Math.round(totalDuration / completed) : 0,
        p95_duration_ms: roll?._max.p95DurationMs ?? 0,
        throughput_per_min: Number((completed / minutes).toFixed(2)),
        oldest_queued_age_s: oldestAge,
        capacity_used: q.maxConcurrency === null ? `${running}/∞` : `${running}/${q.maxConcurrency}`,
        health: healthOf({ paused: q.isPaused, oldestAge, dlqOpen, terminal, completed }),
      };
    }

    this.cache.set(cacheKey, { at: Date.now(), value: out });
    return out;
  }
}

/**
 * Health from SIGNALS, not raw counts.
 *
 * A queue with 10,000 jobs draining fast is healthy; one with 5 jobs stuck for
 * an hour is not. Depth alone tells you neither.
 */
function healthOf(input: {
  paused: boolean;
  oldestAge: number | null;
  dlqOpen: number;
  terminal: number;
  completed: number;
}): QueueStats['health'] {
  if (input.paused) return 'paused';

  const successRate = input.terminal > 0 ? input.completed / input.terminal : 1;
  const age = input.oldestAge ?? 0;

  if (age > 300 || successRate < 0.8) return 'unhealthy';
  if (age > 60 || successRate < 0.95 || input.dlqOpen > 0) return 'degraded';
  return 'healthy';
}
