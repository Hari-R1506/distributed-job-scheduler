import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  claimJobs,
  markRunning,
  completeJob,
  failJob,
  reapExpiredLeases,
  markDeadWorkers,
} from '@djs/db';
import {
  createFixture,
  destroyFixture,
  createQueue,
  seedJobs,
  waitFor,
  type Fixture,
} from '../setup/fixtures.js';
import { TestWorker } from './helpers/test-worker.js';

/**
 * Crash recovery.
 *
 * The lease is the GUARANTEE; graceful shutdown is only an optimisation. These
 * tests therefore kill workers without letting them drain, and expire leases by
 * moving `lease_expires_at` directly rather than waiting one out — the
 * production floor is 45s, which no test should sit through.
 */
describe('crash recovery', () => {
  let f: Fixture;

  beforeAll(async () => {
    f = await createFixture({ connectionLimit: 40 });
  });
  afterAll(async () => {
    await destroyFixture(f);
  });

  /** Force every in-flight lease for a queue into the past. */
  async function expireLeases(queueId: string): Promise<void> {
    await f.prisma.$executeRaw`
      UPDATE jobs SET lease_expires_at = now() - interval '1 second'
       WHERE queue_id = ${queueId}::uuid AND status IN ('CLAIMED','RUNNING')`;
  }

  it('recovers a job whose worker died mid-execution', async () => {
    const queueId = await createQueue(f, { maxConcurrency: null });
    await seedJobs(f, queueId, { count: 1, payload: { duration_ms: 60_000 }, maxAttempts: 3 });

    const victim = await TestWorker.start(f, { name: 'victim', concurrency: 1 });

    await waitFor(async () =>
      (await f.prisma.job.count({ where: { queueId, status: 'RUNNING' } })) === 1,
    );

    // SIGKILL equivalent: no drain, no lease release, no final heartbeat.
    await victim.kill();

    await expireLeases(queueId);
    const reaped = await reapExpiredLeases(f.prisma, 100);
    expect(reaped).toHaveLength(1);
    expect(reaped[0]!.status).toBe('RETRYING');

    const job = await f.prisma.job.findFirstOrThrow({ where: { queueId } });
    expect(job.status).toBe('RETRYING');
    expect(job.attemptCount).toBe(1);
    // Cleared, or the CHECK constraints would have rejected the new state.
    expect(job.workerId).toBeNull();
    expect(job.leaseExpiresAt).toBeNull();
    expect(job.lastErrorCode).toBe('LEASE_EXPIRED');

    // The orphaned attempt is closed, not left RUNNING forever polluting the
    // metrics rollup.
    const execs = await f.prisma.jobExecution.findMany({ where: { jobId: job.id } });
    expect(execs).toHaveLength(1);
    expect(execs[0]!.status).toBe('ABANDONED');
    expect(execs[0]!.finishedAt).not.toBeNull();

    // A second worker finishes the work with no human involvement.
    await f.prisma.job.update({
      where: { id: job.id },
      data: { status: 'QUEUED', payload: { duration_ms: 1 } },
    });
    const rescuer = await TestWorker.start(f, { name: 'rescuer', concurrency: 1 });
    try {
      await TestWorker.drainAll([rescuer], f, queueId);
      const final = await f.prisma.job.findFirstOrThrow({ where: { queueId } });
      expect(final.status).toBe('COMPLETED');
      expect(await f.prisma.jobExecution.count({ where: { jobId: job.id } })).toBe(2);
    } finally {
      await rescuer.stop();
    }
  });

  it('recovers a job claimed but never started, and still burns the attempt', async () => {
    const queueId = await createQueue(f, { maxConcurrency: null });
    await seedJobs(f, queueId, { count: 1 });
    const [workerId] = await registerWorkers(f, ['claim-only']);

    // Claimed, then the process vanishes before markRunning.
    const claimed = await claimJobs(f.prisma, {
      queueId,
      workerId: workerId!,
      freeSlots: 1,
      visibilityTimeoutMs: 60_000,
    });
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.attempt_count).toBe(1);

    await expireLeases(queueId);
    const reaped = await reapExpiredLeases(f.prisma, 100);
    expect(reaped).toHaveLength(1);

    const job = await f.prisma.job.findFirstOrThrow({ where: { queueId } });
    expect(job.status).toBe('RETRYING');
    // There is no execution row at all — the handler never ran.
    expect(await f.prisma.jobExecution.count({ where: { jobId: job.id } })).toBe(0);

    // The attempt is still consumed. Counting DELIVERIES rather than successes
    // is what stops a job that crashes its worker at claim time from being
    // reclaimed forever and killing the fleet one process at a time.
    expect(job.attemptCount).toBe(1);
  });

  it('dead-letters instead of retrying when the reaper finds the last attempt', async () => {
    const queueId = await createQueue(f, { maxConcurrency: null, dlqEnabled: true });
    await seedJobs(f, queueId, { count: 1, maxAttempts: 1 });
    const [workerId] = await registerWorkers(f, ['last-attempt']);

    await claimJobs(f.prisma, {
      queueId,
      workerId: workerId!,
      freeSlots: 1,
      visibilityTimeoutMs: 60_000,
    });
    await expireLeases(queueId);

    const reaped = await reapExpiredLeases(f.prisma, 100);
    expect(reaped[0]!.status).toBe('DEAD_LETTER');

    const dlq = await f.prisma.deadLetterJob.findFirstOrThrow({ where: { queueId } });
    expect(dlq.reason).toBe('LEASE_EXPIRED');
    expect(dlq.totalAttempts).toBe(1);
    // The payload snapshot is what makes a replay possible even after retention
    // purges the original.
    expect(dlq.payloadSnapshot).toBeTruthy();
    expect(dlq.resolvedAt).toBeNull();
  });

  /**
   * ⭐ THE DANGEROUS ONE
   *
   * A worker is not dead — just slow. A 40-second GC pause, or a network
   * partition to the database. The reaper reclaims its job, another worker runs
   * it, and THEN the original wakes up believing it still owns the job.
   *
   * This is the scenario to lead with in a design review: it demonstrates you
   * found the subtle race, not just the obvious one.
   */
  it('rejects the write of a revived worker that lost its lease', async () => {
    const queueId = await createQueue(f, { maxConcurrency: null });
    await seedJobs(f, queueId, { count: 1 });
    const [zombieId, rescuerId] = await registerWorkers(f, ['zombie', 'rescuer2']);

    // ── W1 claims and starts ──
    const [job] = await claimJobs(f.prisma, {
      queueId,
      workerId: zombieId!,
      freeSlots: 1,
      visibilityTimeoutMs: 60_000,
    });
    const started = await markRunning(f.prisma, job!, zombieId!);
    expect(started).not.toBeNull();

    // ── W1 stalls; the reaper reclaims ──
    await expireLeases(queueId);
    await reapExpiredLeases(f.prisma, 10);
    // The reaper pushed run_at into the future by the backoff interval, so the
    // job is RETRYING and not yet eligible. Promote it immediately — this test
    // is about the zombie's write being refused, not about backoff timing.
    await f.prisma.job.updateMany({
      where: { queueId },
      data: { status: 'QUEUED', runAt: new Date() },
    });

    // ── W2 claims, runs and completes it ──
    const [again] = await claimJobs(f.prisma, {
      queueId,
      workerId: rescuerId!,
      freeSlots: 1,
      visibilityTimeoutMs: 60_000,
    });
    const started2 = await markRunning(f.prisma, again!, rescuerId!);
    const ok = await completeJob(f.prisma, {
      job: again!,
      workerId: rescuerId!,
      executionId: started2!.executionId,
      result: { by: 'rescuer' },
      durationMs: 5,
    });
    expect(ok).toBe(true);

    // ── W1 revives and tries to write its result ──
    const zombieWrite = await completeJob(f.prisma, {
      job: job!,
      workerId: zombieId!,
      executionId: started!.executionId,
      result: { by: 'zombie' },
      durationMs: 5,
    });

    // It affects ZERO rows and reports the loss. It cannot corrupt state.
    expect(zombieWrite).toBe(false);

    // A failure write from the zombie is refused identically.
    const zombieFail = await failJob(f.prisma, {
      job: job!,
      workerId: zombieId!,
      executionId: started!.executionId,
      error: new Error('zombie thinks it failed'),
      durationMs: 5,
      dlqEnabled: true,
    });
    expect(zombieFail).toBe('LEASE_LOST');

    // One authoritative outcome, owned by the worker that actually finished.
    const final = await f.prisma.job.findFirstOrThrow({ where: { queueId } });
    expect(final.status).toBe('COMPLETED');
    expect(final.result).toEqual({ by: 'rescuer' });

    const execs = await f.prisma.jobExecution.findMany({
      where: { jobId: final.id },
      orderBy: { attempt: 'asc' },
    });
    expect(execs).toHaveLength(2);
    expect(execs[0]!.status).toBe('ABANDONED'); // the zombie's, closed by the reaper
    expect(execs[1]!.status).toBe('SUCCEEDED'); // the rescuer's

    // NOTE the residual risk this test cannot remove: the zombie may already
    // have performed its side effect before stalling. That is unavoidable —
    // at-least-once is the honest guarantee — and is why handlers receive a
    // stable idempotency token (ARCHITECTURE.md §16.3).
  });

  it('marks a silent worker DEAD after the timeout', async () => {
    const [workerId] = await registerWorkers(f, ['silent']);

    await f.prisma.worker.update({
      where: { id: workerId! },
      data: { lastHeartbeatAt: new Date(Date.now() - 45_000) },
    });

    const dead = await markDeadWorkers(f.prisma, 30_000);
    expect(dead.map((d) => d.id)).toContain(workerId);

    const w = await f.prisma.worker.findUniqueOrThrow({ where: { id: workerId! } });
    expect(w.status).toBe('DEAD');
    expect(w.stoppedAt).not.toBeNull();
  });

  it('leaves a recently-heartbeating worker alone', async () => {
    const [workerId] = await registerWorkers(f, ['healthy']);
    const dead = await markDeadWorkers(f.prisma, 30_000);
    expect(dead.map((d) => d.id)).not.toContain(workerId);
  });

  it('keeps heartbeating while draining, so the reaper cannot steal in-flight jobs', async () => {
    // The most-missed step in graceful shutdown. Stop heartbeating at SIGTERM
    // and the reaper reclaims jobs still running — causing, on every deploy,
    // the exact duplicate execution the design prevents (ARCHITECTURE.md §15).
    const queueId = await createQueue(f, { maxConcurrency: null });
    await seedJobs(f, queueId, { count: 3, payload: { duration_ms: 400 } });

    const worker = await TestWorker.start(f, {
      name: 'drainer',
      concurrency: 3,
      heartbeatMs: 100,
    });

    await waitFor(async () =>
      (await f.prisma.job.count({ where: { queueId, status: 'RUNNING' } })) === 3,
    );

    const before = await f.prisma.worker.findUniqueOrThrow({ where: { id: worker.id } });
    const leaseBefore = await f.prisma.job.findFirstOrThrow({ where: { queueId } });

    await worker.stop(); // graceful — awaits in-flight work

    const after = await f.prisma.worker.findUniqueOrThrow({ where: { id: worker.id } });

    // Heartbeats continued through the drain...
    expect(after.lastHeartbeatAt.getTime()).toBeGreaterThan(before.lastHeartbeatAt.getTime());
    expect(after.status).toBe('STOPPED');
    // ...and every job finished rather than being abandoned.
    expect(await f.prisma.job.count({ where: { queueId, status: 'COMPLETED' } })).toBe(3);
    expect(leaseBefore.leaseExpiresAt).not.toBeNull();
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
