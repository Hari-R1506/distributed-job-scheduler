import { TIMING } from '@djs/core';
import type { PrismaClient } from '@djs/db';

export interface HeartbeatDeps {
  prisma: PrismaClient;
  workerId: string;
  intervalMs: number;
  visibilityTimeoutMs: number;
  /** Current in-flight count and cumulative processed count. */
  sample: () => { activeJobCount: number; processedTotal: number };
  status: () => 'STARTING' | 'ACTIVE' | 'DRAINING';
  onError?: (err: unknown) => void;
}

/**
 * Two things on one timer, and the second is the important one.
 *
 *   1. Liveness  — `workers.last_heartbeat_at`, updated IN PLACE.
 *   2. LEASE RENEWAL — pushes `lease_expires_at` forward on every job this
 *      worker holds.
 *
 * Renewal is what makes long-running jobs possible at all. Without it a
 * 5-minute job under a 60-second lease is reclaimed four times and ends up
 * running five times concurrently. With it, the lease means "this worker is
 * alive and still holds this job" rather than "this job must finish in 60
 * seconds".
 *
 * Every third beat also appends a sample row to `worker_heartbeats` for the
 * charts. Appending on EVERY beat would be ~172k rows/day for 10 workers at a
 * resolution nobody reads — hence two tiers (ARCHITECTURE.md §14.2).
 */
export class Heartbeat {
  private timer?: NodeJS.Timeout;
  private beats = 0;
  private lastProcessedTotal = 0;
  private running = false;

  constructor(private readonly deps: HeartbeatDeps) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.beat(), this.deps.intervalMs);
    this.timer.unref?.();
    void this.beat();
  }

  async beat(): Promise<void> {
    // Never let beats overlap: a slow database would otherwise pile up
    // concurrent updates on the same row.
    if (this.running) return;
    this.running = true;

    const { prisma, workerId, visibilityTimeoutMs, sample, status } = this.deps;
    const { activeJobCount, processedTotal } = sample();

    try {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`
          UPDATE workers
             SET last_heartbeat_at = now(),
                 active_job_count = ${activeJobCount},
                 status = ${status()}::worker_status
           WHERE id = ${workerId}::uuid`;

        // The renewal. Scoped to this worker's own in-flight jobs, so it can
        // never extend a lease the reaper has already reassigned.
        await tx.$executeRaw`
          UPDATE jobs
             SET lease_expires_at = now() + make_interval(secs => ${visibilityTimeoutMs}::numeric / 1000.0)
           WHERE worker_id = ${workerId}::uuid
             AND status IN ('CLAIMED','RUNNING')`;
      });

      if (++this.beats % TIMING.HEARTBEAT_SAMPLE_EVERY === 0) {
        const delta = processedTotal - this.lastProcessedTotal;
        this.lastProcessedTotal = processedTotal;
        const mem = process.memoryUsage();

        await prisma.workerHeartbeat.create({
          data: {
            workerId,
            activeJobCount,
            // A delta, so throughput is a SUM rather than a
            // difference-of-counters across restarts.
            jobsProcessedDelta: delta,
            memMb: Math.round(mem.rss / 1024 / 1024),
          },
        });
      }
    } catch (err) {
      // A failed heartbeat is survivable: the reaper recovers our jobs and we
      // discover it through a failed conditional write. Crashing here would
      // guarantee the loss we are trying to avoid.
      this.deps.onError?.(err);
    } finally {
      this.running = false;
    }
  }

  /**
   * Explicitly release this worker's leases, used at the end of a drain.
   *
   * Without it, jobs still running when the grace period expires sit unclaimed
   * for the full visibility timeout. Releasing them hands them over in ~0s
   * instead of 60 — the difference between an invisible rolling deploy and one
   * that adds a minute of latency to every in-flight job.
   */
  async releaseLeases(): Promise<number> {
    const { prisma, workerId } = this.deps;
    return prisma.$executeRaw`
      UPDATE jobs
         SET status = 'RETRYING',
             run_at = now(),
             worker_id = NULL,
             lease_expires_at = NULL,
             last_error_code = 'WORKER_SHUTDOWN',
             last_error_message = 'Worker shut down before the job finished; requeued immediately.',
             updated_at = now()
       WHERE worker_id = ${workerId}::uuid
         AND status IN ('CLAIMED','RUNNING')`;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
