import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createPrismaClient, promoteDueJobs } from '@djs/db';
import { Scheduler } from '../../apps/scheduler/src/scheduler.js';
import { LeaderElection } from '../../apps/scheduler/src/leader-election.js';
import { materializeDueSchedules } from '../../apps/scheduler/src/cron-materializer.js';
import { rollupMetrics } from '../../apps/scheduler/src/maintenance.js';
import {
  createFixture,
  destroyFixture,
  createQueue,
  seedJobs,
  waitFor,
  type Fixture,
} from '../setup/fixtures.js';

describe('scheduler', () => {
  let f: Fixture;

  beforeAll(async () => {
    f = await createFixture({ connectionLimit: 30 });
  });
  afterAll(async () => {
    await destroyFixture(f);
  });

  describe('promotion', () => {
    it('moves SCHEDULED and RETRYING jobs to QUEUED once due', async () => {
      const queueId = await createQueue(f);
      const past = new Date(Date.now() - 5_000);
      const future = new Date(Date.now() + 60 * 60 * 1000);

      await seedJobs(f, queueId, { count: 10, status: 'SCHEDULED', runAt: past });
      await seedJobs(f, queueId, { count: 5, status: 'SCHEDULED', runAt: future });

      await f.prisma.$executeRaw`
        UPDATE jobs SET status = 'RETRYING'
         WHERE queue_id = ${queueId}::uuid AND status = 'SCHEDULED' AND run_at < now()
         AND id IN (SELECT id FROM jobs WHERE queue_id = ${queueId}::uuid LIMIT 3)`;

      const { count, queueIds } = await promoteDueJobs(f.prisma, 500);

      expect(count).toBe(10);
      expect(queueIds).toEqual([queueId]);
      expect(await f.prisma.job.count({ where: { queueId, status: 'QUEUED' } })).toBe(10);
      // Future-dated jobs are untouched — promotion is due-time driven.
      expect(await f.prisma.job.count({ where: { queueId, status: 'SCHEDULED' } })).toBe(5);
    });

    it('returns one queue id per distinct queue, not one per job', async () => {
      // 500 promoted jobs across 2 queues must produce 2 notifications, not 500.
      const a = await createQueue(f, { name: 'notify-a' });
      const b = await createQueue(f, { name: 'notify-b' });
      const past = new Date(Date.now() - 5_000);
      await seedJobs(f, a, { count: 30, status: 'SCHEDULED', runAt: past });
      await seedJobs(f, b, { count: 30, status: 'SCHEDULED', runAt: past });

      const { count, queueIds } = await promoteDueJobs(f.prisma, 500);
      expect(count).toBe(60);
      expect(queueIds.sort()).toEqual([a, b].sort());
    });

    it('is bounded by the batch size, so a backlog cannot make one long transaction', async () => {
      const queueId = await createQueue(f);
      await seedJobs(f, queueId, {
        count: 50,
        status: 'SCHEDULED',
        runAt: new Date(Date.now() - 5_000),
      });

      const first = await promoteDueJobs(f.prisma, 20);
      expect(first.count).toBe(20);
      const second = await promoteDueJobs(f.prisma, 20);
      expect(second.count).toBe(20);
      const third = await promoteDueJobs(f.prisma, 20);
      expect(third.count).toBe(10);
    });
  });

  describe('cron materialisation', () => {
    async function createSchedule(queueId: string, name: string, cron = '*/5 * * * *') {
      return f.prisma.scheduledJob.create({
        data: {
          projectId: f.projectId,
          queueId,
          name,
          cronExpression: cron,
          timezone: 'UTC',
          handler: 'simulate',
          payload: { duration_ms: 1 },
          // Due now.
          nextRunAt: new Date(Date.now() - 1_000),
        },
      });
    }

    it('materialises a job and advances the cursor', async () => {
      const queueId = await createQueue(f, { name: 'cron-basic' });
      const schedule = await createSchedule(queueId, 'basic');

      const res = await materializeDueSchedules(f.prisma);
      expect(res.jobsCreated).toBe(1);

      const job = await f.prisma.job.findFirstOrThrow({
        where: { scheduledJobId: schedule.id },
      });
      expect(job.status).toBe('QUEUED');
      expect(job.handler).toBe('simulate');
      // The intended slot is recorded separately from run_at.
      expect(job.scheduledFor).not.toBeNull();

      const after = await f.prisma.scheduledJob.findUniqueOrThrow({ where: { id: schedule.id } });
      expect(after.nextRunAt.getTime()).toBeGreaterThan(Date.now());
      expect(after.lastJobId).toBe(job.id);
    });

    /**
     * ⭐ The failure that is silent and unrecoverable: a nightly billing job
     * running twice. Two independent guards protect it — the optimistic CAS on
     * next_run_at, and UNIQUE (scheduled_job_id, scheduled_for).
     */
    it('fires exactly once when two schedulers materialise concurrently', async () => {
      const queueId = await createQueue(f, { name: 'cron-race' });
      const schedule = await createSchedule(queueId, 'raced');

      // Two independent clients — no shared in-process state to cooperate through.
      const clientA = createPrismaClient(process.env['DATABASE_URL']!, { connectionLimit: 5 });
      const clientB = createPrismaClient(process.env['DATABASE_URL']!, { connectionLimit: 5 });

      try {
        const [a, b] = await Promise.all([
          materializeDueSchedules(clientA),
          materializeDueSchedules(clientB),
        ]);

        // Exactly one of them created the job.
        expect(a.jobsCreated + b.jobsCreated).toBe(1);

        const jobs = await f.prisma.job.findMany({ where: { scheduledJobId: schedule.id } });
        expect(jobs).toHaveLength(1);
      } finally {
        await clientA.$disconnect();
        await clientB.$disconnect();
      }
    });

    it('cannot create two jobs for the same slot even if materialisation reruns', async () => {
      const queueId = await createQueue(f, { name: 'cron-idem' });
      const schedule = await createSchedule(queueId, 'idempotent');

      await materializeDueSchedules(f.prisma);
      const slot = (await f.prisma.job.findFirstOrThrow({
        where: { scheduledJobId: schedule.id },
      })).scheduledFor!;

      // Rewind the cursor to replay the same slot — simulating a crash between
      // the insert and the commit of the cursor advance.
      await f.prisma.scheduledJob.update({
        where: { id: schedule.id },
        data: { nextRunAt: slot },
      });
      await materializeDueSchedules(f.prisma);

      // The unique index makes the duplicate structurally impossible.
      const jobs = await f.prisma.job.findMany({
        where: { scheduledJobId: schedule.id, scheduledFor: slot },
      });
      expect(jobs).toHaveLength(1);
    });

    it('applies the SKIP misfire policy after an outage', async () => {
      const queueId = await createQueue(f, { name: 'cron-misfire' });
      const schedule = await f.prisma.scheduledJob.create({
        data: {
          projectId: f.projectId,
          queueId,
          name: 'misfired',
          cronExpression: '*/5 * * * *',
          timezone: 'UTC',
          handler: 'simulate',
          payload: {},
          misfirePolicy: 'SKIP',
          // 30 minutes of downtime => six missed slots.
          nextRunAt: new Date(Date.now() - 30 * 60 * 1000),
        },
      });

      const res = await materializeDueSchedules(f.prisma);

      // One job for the most recent missed slot; the rest fast-forwarded past.
      expect(res.jobsCreated).toBe(1);
      expect(res.slotsSkipped).toBeGreaterThan(3);

      const after = await f.prisma.scheduledJob.findUniqueOrThrow({ where: { id: schedule.id } });
      expect(after.nextRunAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('ignores disabled schedules and those outside their validity window', async () => {
      const queueId = await createQueue(f, { name: 'cron-gated' });
      const due = new Date(Date.now() - 1_000);

      await f.prisma.scheduledJob.createMany({
        data: [
          {
            projectId: f.projectId,
            queueId,
            name: 'disabled',
            cronExpression: '*/5 * * * *',
            handler: 'simulate',
            payload: {},
            isEnabled: false,
            nextRunAt: due,
          },
          {
            projectId: f.projectId,
            queueId,
            name: 'not-yet-started',
            cronExpression: '*/5 * * * *',
            handler: 'simulate',
            payload: {},
            startAt: new Date(Date.now() + 60 * 60 * 1000),
            nextRunAt: due,
          },
          {
            projectId: f.projectId,
            queueId,
            name: 'already-ended',
            cronExpression: '*/5 * * * *',
            handler: 'simulate',
            payload: {},
            endAt: new Date(Date.now() - 60 * 60 * 1000),
            nextRunAt: due,
          },
        ],
      });

      const res = await materializeDueSchedules(f.prisma);
      expect(res.jobsCreated).toBe(0);
    });

    it('disables a schedule whose expression no longer parses, instead of wedging', async () => {
      const queueId = await createQueue(f, { name: 'cron-broken' });
      // Bypasses API validation, as a direct database edit would.
      const schedule = await f.prisma.scheduledJob.create({
        data: {
          projectId: f.projectId,
          queueId,
          name: 'broken',
          cronExpression: 'not a cron expression',
          handler: 'simulate',
          payload: {},
          nextRunAt: new Date(Date.now() - 1_000),
        },
      });

      const res = await materializeDueSchedules(f.prisma);
      expect(res.jobsCreated).toBe(0);

      const after = await f.prisma.scheduledJob.findUniqueOrThrow({ where: { id: schedule.id } });
      expect(after.isEnabled).toBe(false);
    });
  });

  describe('leader election', () => {
    it('grants leadership to exactly one of several contenders', async () => {
      const url = process.env['DATABASE_URL']!;
      const contenders = Array.from({ length: 4 }, () => new LeaderElection({ databaseUrl: url }));

      try {
        await Promise.all(contenders.map((c) => c.start()));
        const leaders = contenders.filter((c) => c.isLeader);
        expect(leaders).toHaveLength(1);
      } finally {
        await Promise.all(contenders.map((c) => c.stop()));
      }
    });

    it('hands leadership to a follower when the leader releases it', async () => {
      const url = process.env['DATABASE_URL']!;
      const a = new LeaderElection({ databaseUrl: url, retryMs: 200 });
      const b = new LeaderElection({ databaseUrl: url, retryMs: 200 });

      try {
        await a.start();
        await b.start();

        const [leader, follower] = a.isLeader ? [a, b] : [b, a];
        expect(leader.isLeader).toBe(true);
        expect(follower.isLeader).toBe(false);

        // The leader goes away. Postgres releases the advisory lock with the
        // session — no lease to expire, no heartbeat to miss.
        await leader.stop();

        const promoted = await waitFor(async () => follower.isLeader, 5_000, 100);
        expect(promoted).toBe(true);
      } finally {
        await a.stop();
        await b.stop();
      }
    });

    it('leaves followers idle — only the leader does time-driven work', async () => {
      const queueId = await createQueue(f, { name: 'follower-idle' });
      await seedJobs(f, queueId, {
        count: 10,
        status: 'SCHEDULED',
        runAt: new Date(Date.now() - 5_000),
      });

      const url = process.env['DATABASE_URL']!;
      const blocker = new LeaderElection({ databaseUrl: url });
      await blocker.start();
      expect(blocker.isLeader).toBe(true);

      const follower = new Scheduler({ prisma: f.prisma, databaseUrl: url, tickMs: 50 });
      try {
        await follower.start();
        expect(follower.isLeader).toBe(false);

        const stats = await follower.tick();
        expect(stats.promoted).toBe(0);
        // The jobs are still waiting — a follower must not act.
        expect(await f.prisma.job.count({ where: { queueId, status: 'SCHEDULED' } })).toBe(10);
      } finally {
        await follower.stop();
        await blocker.stop();
      }
    });
  });

  describe('metrics rollup', () => {
    it('aggregates finished executions into per-minute buckets, idempotently', async () => {
      const queueId = await createQueue(f, { name: 'rollup' });
      await seedJobs(f, queueId, { count: 4 });
      const jobs = await f.prisma.job.findMany({ where: { queueId }, select: { id: true } });

      const finishedAt = new Date(Date.now() - 90_000);
      await f.prisma.jobExecution.createMany({
        data: jobs.map((j, i) => ({
          jobId: j.id,
          attempt: 1,
          status: i === 3 ? ('FAILED' as const) : ('SUCCEEDED' as const),
          startedAt: new Date(finishedAt.getTime() - 100),
          finishedAt,
          durationMs: 100 * (i + 1),
        })),
      });

      await rollupMetrics(f.prisma, { minutes: 5 });

      const bucket = await f.prisma.queueMetricMinute.findFirstOrThrow({ where: { queueId } });
      expect(bucket.completedCount).toBe(3);
      expect(bucket.failedCount).toBe(1);
      expect(bucket.maxDurationMs).toBe(400);
      // total_duration_ms is stored so averages stay mergeable into hour buckets.
      expect(Number(bucket.totalDurationMs)).toBe(1000);

      // Re-running must not double-count — a scheduler restart mid-minute
      // cannot be allowed to corrupt a bucket.
      await rollupMetrics(f.prisma, { minutes: 5 });
      const again = await f.prisma.queueMetricMinute.findFirstOrThrow({ where: { queueId } });
      expect(again.completedCount).toBe(3);
      expect(await f.prisma.queueMetricMinute.count({ where: { queueId } })).toBe(1);
    });
  });

  describe('full tick', () => {
    it('promotes, fires cron and reaps in a single pass', async () => {
      const queueId = await createQueue(f, { name: 'full-tick' });
      await seedJobs(f, queueId, {
        count: 5,
        status: 'SCHEDULED',
        runAt: new Date(Date.now() - 5_000),
      });
      await f.prisma.scheduledJob.create({
        data: {
          projectId: f.projectId,
          queueId,
          name: 'full-tick-cron',
          cronExpression: '*/5 * * * *',
          handler: 'simulate',
          payload: {},
          nextRunAt: new Date(Date.now() - 1_000),
        },
      });

      const scheduler = new Scheduler({
        prisma: f.prisma,
        databaseUrl: process.env['DATABASE_URL']!,
        // Drive tick() directly rather than contending for the real lock.
        assumeLeadership: true,
      });

      const stats = await scheduler.tick();

      // Promotion is scheduler-WIDE, not queue-scoped — one loop drains every
      // due job in the deployment. So the global counter also sweeps up
      // leftovers from earlier tests in this file, and asserting an exact
      // number here would be asserting test-file bookkeeping rather than
      // behaviour. The queue-scoped effect is what matters.
      expect(stats.promoted).toBeGreaterThanOrEqual(5);
      expect(stats.cronJobs).toBe(1);

      // 5 promoted + 1 materialised by cron, all in this queue.
      expect(await f.prisma.job.count({ where: { queueId, status: 'QUEUED' } })).toBe(6);
      expect(await f.prisma.job.count({ where: { queueId, status: 'SCHEDULED' } })).toBe(0);
      await scheduler.stop();
    });
  });
});
