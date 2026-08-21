import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { claimJobs } from '@djs/db';
import { PRIORITY_VALUES } from '@djs/core';
import {
  createFixture,
  destroyFixture,
  createQueue,
  seedJobs,
  type Fixture,
} from '../setup/fixtures.js';

describe('priority ordering', () => {
  let f: Fixture;

  beforeAll(async () => {
    f = await createFixture();
  });
  afterAll(async () => {
    await destroyFixture(f);
  });

  /**
   * ⭐ THE TRAP THE BRIEF IS TESTING
   *
   *   "A HIGH priority job scheduled for tomorrow should NOT execute before a
   *    LOW priority job that is ready now."
   *
   * The answer is a one-word distinction: ELIGIBILITY is a WHERE clause;
   * PRIORITY is an ORDER BY clause, and they must never be mixed. Because
   * `run_at <= now()` filters BEFORE the sort, tomorrow's CRITICAL job is not
   * in the candidate set at all — it cannot outrank anything because it is not
   * competing yet.
   *
   * Sorting by (priority, run_at) across ALL jobs — the common mistake — would
   * let it win. See ARCHITECTURE.md §9.2.
   */
  it('never lets a future-dated CRITICAL job preempt a ready LOW one', async () => {
    const queueId = await createQueue(f, { maxConcurrency: null });

    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await seedJobs(f, queueId, {
      count: 10,
      priority: PRIORITY_VALUES.CRITICAL,
      status: 'SCHEDULED',
      runAt: tomorrow,
    });
    await seedJobs(f, queueId, {
      count: 5,
      priority: PRIORITY_VALUES.BULK,
      status: 'QUEUED',
    });

    const [workerId] = await registerWorkers(f, ['trap']);
    const claimed = await claimJobs(f.prisma, {
      queueId,
      workerId: workerId!,
      freeSlots: 50,
      visibilityTimeoutMs: 60_000,
    });

    expect(claimed).toHaveLength(5);
    expect(claimed.every((j) => j.priority === PRIORITY_VALUES.BULK)).toBe(true);

    // The CRITICAL jobs are untouched, still waiting on their clock.
    const scheduled = await f.prisma.job.count({ where: { queueId, status: 'SCHEDULED' } });
    expect(scheduled).toBe(10);
  });

  it('claims strictly in descending priority among eligible jobs', async () => {
    const queueId = await createQueue(f, { maxConcurrency: null });

    // Interleaved on insert, so insertion order cannot accidentally produce the
    // right answer.
    const ladder = [
      PRIORITY_VALUES.BULK,
      PRIORITY_VALUES.CRITICAL,
      PRIORITY_VALUES.NORMAL,
      PRIORITY_VALUES.LOW,
      PRIORITY_VALUES.HIGH,
    ];
    await seedJobs(f, queueId, { count: 50, priority: (i) => ladder[i % ladder.length]! });

    const [workerId] = await registerWorkers(f, ['ladder']);

    const order: number[] = [];
    for (;;) {
      const batch = await claimJobs(f.prisma, {
        queueId,
        workerId: workerId!,
        freeSlots: 5,
        visibilityTimeoutMs: 60_000,
      });
      if (batch.length === 0) break;
      order.push(...batch.map((j) => j.priority));
    }

    expect(order).toHaveLength(50);
    // Monotonically non-increasing: 200s, then 150s, then 100s, 50s, 10s.
    expect([...order].sort((a, b) => b - a)).toEqual(order);
    expect(order.slice(0, 10).every((p) => p === PRIORITY_VALUES.CRITICAL)).toBe(true);
    expect(order.slice(-10).every((p) => p === PRIORITY_VALUES.BULK)).toBe(true);
  });

  it('is FIFO within a priority band, by run_at', async () => {
    const queueId = await createQueue(f, { maxConcurrency: null });

    const base = Date.now() - 60_000;
    // Descending run_at on insert: the LAST inserted is the OLDEST, so a
    // correct result cannot come from insertion order.
    await seedJobs(f, queueId, {
      count: 10,
      priority: PRIORITY_VALUES.NORMAL,
      runAt: (i) => new Date(base + (10 - i) * 1000),
    });

    const [workerId] = await registerWorkers(f, ['fifo']);
    const claimed = await claimJobs(f.prisma, {
      queueId,
      workerId: workerId!,
      freeSlots: 10,
      visibilityTimeoutMs: 60_000,
    });

    const runAts = claimed.map((j) => j.run_at.getTime());
    expect([...runAts].sort((a, b) => a - b)).toEqual(runAts);

    // Uses run_at, not created_at: for a retry, "ready since" is the correct
    // fairness basis — a job whose backoff expired an hour ago should go before
    // one whose backoff expired a second ago.
    expect(runAts[0]).toBeLessThan(runAts[runAts.length - 1]!);
  });

  it('breaks exact ties deterministically by id', async () => {
    const queueId = await createQueue(f, { maxConcurrency: null });
    const sameInstant = new Date();

    // Identical priority AND identical run_at — the common case for a batch
    // insert. Without the id tiebreak the order would be arbitrary and the
    // tests non-reproducible.
    await seedJobs(f, queueId, { count: 20, priority: 100, runAt: sameInstant });

    const [workerId] = await registerWorkers(f, ['tiebreak']);
    const claimed = await claimJobs(f.prisma, {
      queueId,
      workerId: workerId!,
      freeSlots: 20,
      visibilityTimeoutMs: 60_000,
    });

    const ids = claimed.map((j) => j.id);
    expect([...ids].sort()).toEqual(ids);
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
