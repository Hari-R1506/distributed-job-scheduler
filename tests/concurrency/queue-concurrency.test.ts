import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { claimJobs } from '@djs/db';
import {
  createFixture,
  destroyFixture,
  createQueue,
  seedJobs,
  sleep,
  type Fixture,
} from '../setup/fixtures.js';
import { TestWorker } from './helpers/test-worker.js';

/**
 * Per-queue concurrency is the constraint that SKIP LOCKED alone cannot
 * enforce: two workers lock DIFFERENT rows, so there is no row-level conflict
 * to detect. The conflict is over an AGGREGATE — how many are running — and
 * aggregates are not lockable.
 *
 * That is why the claim transaction takes a per-queue advisory lock before
 * counting. These tests exist to prove it works and, just as importantly, that
 * it does not over-restrict. See ARCHITECTURE.md §8.
 */
describe('per-queue concurrency', () => {
  let f: Fixture;

  beforeAll(async () => {
    f = await createFixture({ connectionLimit: 60 });
  });
  afterAll(async () => {
    await destroyFixture(f);
  });

  it('never exceeds max_concurrency across independent workers', async () => {
    const queueId = await createQueue(f, { maxConcurrency: 3 });
    await seedJobs(f, queueId, { count: 120, payload: { duration_ms: 25 } });

    // 10 workers with 10 slots each = 100 potential parallel jobs, against a
    // queue that permits 3. Nothing but the claim transaction is stopping them.
    const workers = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        TestWorker.start(f, { name: `conc-${i}`, concurrency: 10 }),
      ),
    );

    const samples: number[] = [];
    const sampler = setInterval(() => {
      void f.prisma.job
        .count({ where: { queueId, status: { in: ['CLAIMED', 'RUNNING'] } } })
        .then((n) => samples.push(n))
        .catch(() => {});
    }, 10);

    try {
      await TestWorker.drainAll(workers, f, queueId);
      await sleep(50);
    } finally {
      clearInterval(sampler);
      await Promise.all(workers.map((w) => w.stop()));
    }

    const peak = Math.max(...samples, 0);

    // ── the assertion ──
    expect(peak).toBeLessThanOrEqual(3);

    // ── and the counter-assertion, which matters just as much ──
    // A claim that admitted NOTHING would satisfy the limit trivially. This
    // proves the queue actually saturated, so the limit is a ceiling rather
    // than a deadlock.
    expect(peak).toBe(3);

    expect(await f.prisma.job.count({ where: { queueId, status: 'COMPLETED' } })).toBe(120);
  });

  it('treats a null max_concurrency as unlimited', async () => {
    const queueId = await createQueue(f, { maxConcurrency: null });
    await seedJobs(f, queueId, { count: 40, payload: { duration_ms: 60 } });

    const worker = await TestWorker.start(f, { name: 'unbounded', concurrency: 20 });
    try {
      // Bounded only by the worker's own slot count — a local resource limit,
      // not a coordinated one.
      const reached = await waitForPeak(f, queueId, 10, 5_000);
      expect(reached).toBe(true);
      await TestWorker.drainAll([worker], f, queueId);
    } finally {
      await worker.stop();
    }
  });

  it('accounts for jobs already in flight when computing free capacity', async () => {
    const queueId = await createQueue(f, { maxConcurrency: 5 });
    await seedJobs(f, queueId, { count: 20 });

    const [a, b] = await registerWorkers(f, ['cap-a', 'cap-b']);

    // First claimer takes the whole allowance.
    const first = await claimJobs(f.prisma, {
      queueId,
      workerId: a!,
      freeSlots: 10,
      visibilityTimeoutMs: 60_000,
    });
    expect(first).toHaveLength(5);

    // Second sees zero remaining — the count includes the CLAIMED rows the
    // first claimer just wrote, which is exactly what the advisory lock
    // guarantees is visible.
    const second = await claimJobs(f.prisma, {
      queueId,
      workerId: b!,
      freeSlots: 10,
      visibilityTimeoutMs: 60_000,
    });
    expect(second).toHaveLength(0);

    // Free two slots; the second claimer may now take exactly two.
    await f.prisma.job.updateMany({
      where: { id: { in: first.slice(0, 2).map((j) => j.id) } },
      data: { status: 'COMPLETED', workerId: null, leaseExpiresAt: null, finishedAt: new Date() },
    });

    const third = await claimJobs(f.prisma, {
      queueId,
      workerId: b!,
      freeSlots: 10,
      visibilityTimeoutMs: 60_000,
    });
    expect(third).toHaveLength(2);
  });

  it('claims min(queue capacity, worker free slots)', async () => {
    const queueId = await createQueue(f, { maxConcurrency: 8 });
    await seedJobs(f, queueId, { count: 20 });
    const [workerId] = await registerWorkers(f, ['min-probe']);

    // Queue allows 8, worker offers 3 => 3. The intersection of the two real
    // limits is the whole concurrency model.
    const claimed = await claimJobs(f.prisma, {
      queueId,
      workerId: workerId!,
      freeSlots: 3,
      visibilityTimeoutMs: 60_000,
    });
    expect(claimed).toHaveLength(3);
  });

  it('isolates queues — a saturated queue never blocks a different one', async () => {
    const busy = await createQueue(f, { name: 'busy-queue', maxConcurrency: 1 });
    const free = await createQueue(f, { name: 'free-queue', maxConcurrency: 10 });
    await seedJobs(f, busy, { count: 5 });
    await seedJobs(f, free, { count: 5 });

    const [workerId] = await registerWorkers(f, ['isolation']);

    const fromBusy = await claimJobs(f.prisma, {
      queueId: busy,
      workerId: workerId!,
      freeSlots: 10,
      visibilityTimeoutMs: 60_000,
    });
    const fromFree = await claimJobs(f.prisma, {
      queueId: free,
      workerId: workerId!,
      freeSlots: 10,
      visibilityTimeoutMs: 60_000,
    });

    // The advisory lock is keyed per queue, so `busy` being at its ceiling has
    // no effect on `free`.
    expect(fromBusy).toHaveLength(1);
    expect(fromFree).toHaveLength(5);
  });
});

async function waitForPeak(
  f: Fixture,
  queueId: string,
  target: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const n = await f.prisma.job.count({
      where: { queueId, status: { in: ['CLAIMED', 'RUNNING'] } },
    });
    if (n >= target) return true;
    await sleep(10);
  }
  return false;
}

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
