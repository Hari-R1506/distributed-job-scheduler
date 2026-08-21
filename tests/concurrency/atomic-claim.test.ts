import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { claimJobs } from '@djs/db';
import {
  createFixture,
  destroyFixture,
  createQueue,
  seedJobs,
  type Fixture,
} from '../setup/fixtures.js';
import { TestWorker } from './helpers/test-worker.js';

/**
 * ══════════════════════════════════════════════════════════════════════════
 *  THE GATE
 *
 *  If these do not pass, nothing built on top of them counts. The entire
 *  architecture rests on one claim: N workers polling the same queue at the
 *  same instant will never both receive the same job.
 *
 *  Run 20x in CI (`npm run test:race:repeat`). Race conditions are
 *  probabilistic — a single green run proves nothing.
 * ══════════════════════════════════════════════════════════════════════════
 */
describe('atomic job claiming', () => {
  let f: Fixture;

  beforeAll(async () => {
    f = await createFixture({ connectionLimit: 60 });
  });
  afterAll(async () => {
    await destroyFixture(f);
  });

  it('never hands the same job to two claimers (20 concurrent, 500 jobs)', async () => {
    const queueId = await createQueue(f, { maxConcurrency: null });
    await seedJobs(f, queueId, { count: 500 });

    // 20 claimers hammering the same queue simultaneously. No max_concurrency,
    // so nothing but the claim itself is arbitrating.
    const claimers = Array.from({ length: 20 }, (_, i) => `w${i}`);
    const workerIds = await registerWorkers(f, claimers);

    const claimedBy = new Map<string, string>();
    const duplicates: string[] = [];

    await Promise.all(
      workerIds.map(async (workerId) => {
        for (;;) {
          const jobs = await claimJobs(f.prisma, {
            queueId,
            workerId,
            freeSlots: 5,
            visibilityTimeoutMs: 60_000,
          });
          if (jobs.length === 0) break;

          for (const job of jobs) {
            // The assertion that matters, checked in-process as well as in the
            // database: if two claimers ever saw one job, we catch it here.
            const previous = claimedBy.get(job.id);
            if (previous) duplicates.push(`${job.id} claimed by ${previous} AND ${workerId}`);
            claimedBy.set(job.id, workerId);
          }
        }
      }),
    );

    expect(duplicates).toEqual([]);
    expect(claimedBy.size).toBe(500);

    // ...and the database agrees.
    const counts = await f.prisma.job.groupBy({
      by: ['status'],
      where: { queueId },
      _count: true,
    });
    expect(counts).toEqual([{ status: 'CLAIMED', _count: 500 }]);

    // Every job was claimed exactly once, so every attempt counter is exactly 1.
    const wrongAttempts = await f.prisma.job.count({
      where: { queueId, attemptCount: { not: 1 } },
    });
    expect(wrongAttempts).toBe(0);

    // Work actually spread across claimers rather than one winning every race.
    expect(new Set(claimedBy.values()).size).toBeGreaterThan(1);
  });

  it('executes each job exactly once end to end (10 workers, 300 jobs)', async () => {
    const queueId = await createQueue(f, { maxConcurrency: null });
    await seedJobs(f, queueId, { count: 300, payload: { duration_ms: 2 } });

    const workers = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        TestWorker.start(f, { name: `exec-${i}`, concurrency: 5 }),
      ),
    );

    try {
      await TestWorker.drainAll(workers, f, queueId);

      // ── the three assertions ──
      const executions = await f.prisma.jobExecution.count({
        where: { job: { queueId } },
      });
      expect(executions).toBe(300); // not 299, not 301

      const duplicated = await f.prisma.$queryRaw<{ job_id: string; n: bigint }[]>`
        SELECT e.job_id, count(*) AS n
          FROM job_executions e JOIN jobs j ON j.id = e.job_id
         WHERE j.queue_id = ${queueId}::uuid
         GROUP BY e.job_id HAVING count(*) > 1`;
      expect(duplicated).toEqual([]);

      const notCompleted = await f.prisma.job.count({
        where: { queueId, status: { not: 'COMPLETED' } },
      });
      expect(notCompleted).toBe(0);

      // The counter that must never move.
      const dupes = workers.reduce((n, w) => n + w.metrics.duplicateExecutionDetected, 0);
      expect(dupes).toBe(0);
    } finally {
      await Promise.all(workers.map((w) => w.stop()));
    }
  });

  it('claims nothing from a paused queue, whatever the backlog', async () => {
    const queueId = await createQueue(f, { isPaused: true, maxConcurrency: null });
    await seedJobs(f, queueId, { count: 50, priority: 200 });

    const [workerId] = await registerWorkers(f, ['paused-probe']);

    const claimed = await claimJobs(f.prisma, {
      queueId,
      workerId: workerId!,
      freeSlots: 10,
      visibilityTimeoutMs: 60_000,
    });

    // Pause zeroes capacity before priority is even consulted.
    expect(claimed).toHaveLength(0);
    expect(await f.prisma.job.count({ where: { queueId, status: 'QUEUED' } })).toBe(50);
  });

  it('claims nothing that is not yet due', async () => {
    const queueId = await createQueue(f, { maxConcurrency: null });
    const future = new Date(Date.now() + 60 * 60 * 1000);
    await seedJobs(f, queueId, { count: 20, status: 'SCHEDULED', runAt: future, priority: 200 });
    await seedJobs(f, queueId, { count: 5, status: 'QUEUED', priority: 10 });

    const [workerId] = await registerWorkers(f, ['due-probe']);
    const claimed = await claimJobs(f.prisma, {
      queueId,
      workerId: workerId!,
      freeSlots: 50,
      visibilityTimeoutMs: 60_000,
    });

    // Only the 5 ready LOW-priority jobs. The 20 CRITICAL ones are SCHEDULED
    // and not eligible — eligibility is a WHERE clause, not a tiebreak.
    expect(claimed).toHaveLength(5);
    expect(claimed.every((j) => j.priority === 10)).toBe(true);
  });

  it('is a no-op when the caller has no free slots', async () => {
    const queueId = await createQueue(f, { maxConcurrency: null });
    await seedJobs(f, queueId, { count: 10 });
    const [workerId] = await registerWorkers(f, ['zero-slots']);

    const claimed = await claimJobs(f.prisma, {
      queueId,
      workerId: workerId!,
      freeSlots: 0,
      visibilityTimeoutMs: 60_000,
    });

    expect(claimed).toHaveLength(0);
  });
});

async function registerWorkers(f: Fixture, names: string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const name of names) {
    const w = await f.prisma.worker.create({
      data: {
        orgId: f.orgId,
        name,
        hostname: 'test',
        pid: process.pid,
        version: 'test',
        status: 'ACTIVE',
        concurrency: 10,
      },
      select: { id: true },
    });
    ids.push(w.id);
  }
  return ids;
}
