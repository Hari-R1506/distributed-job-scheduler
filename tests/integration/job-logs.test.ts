import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createFixture, destroyFixture, createQueue, seedJobs, type Fixture } from '../setup/fixtures.js';
import { TestWorker } from '../concurrency/helpers/test-worker.js';

describe('handler logs reach job_logs', () => {
  let f: Fixture;
  beforeAll(async () => { f = await createFixture(); });
  afterAll(async () => { await destroyFixture(f); });

  it('persists buffered handler log lines', async () => {
    const queueId = await createQueue(f, { maxConcurrency: null });
    await seedJobs(f, queueId, { count: 3, payload: { duration_ms: 5 } });

    const w = await TestWorker.start(f, { name: 'logger', concurrency: 3 });
    try {
      await TestWorker.drainAll([w], f, queueId);
    } finally {
      await w.stop();
    }

    const logs = await f.prisma.jobLog.findMany({ where: { job: { queueId } } });
    console.log('job_logs rows:', logs.length, logs.slice(0,3).map(l => `${l.level}: ${l.message}`));
    expect(logs.length).toBeGreaterThan(0);
    // simulate emits "starting" and "completed" per job
    expect(logs.filter(l => l.message.includes('starting')).length).toBe(3);
    expect(logs.every(l => l.executionId > 0n)).toBe(true);
  });
});
