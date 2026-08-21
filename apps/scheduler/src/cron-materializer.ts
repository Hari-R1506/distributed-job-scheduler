import { nextFireTime, resolveMisfire, type MisfirePolicy } from '@djs/core';
import type { PrismaClient } from '@djs/db';

export interface MaterializeResult {
  schedulesFired: number;
  jobsCreated: number;
  slotsSkipped: number;
  queueIds: string[];
}

/**
 * Turns due `scheduled_jobs` templates into concrete `jobs` rows.
 *
 * A scheduled_jobs row is a TEMPLATE PLUS A CURSOR. It never executes anything
 * itself; the scheduler materialises jobs from it.
 *
 * ── Duplicate firing is prevented TWICE, deliberately ────────────────────────
 *
 *  1. An optimistic CAS on `next_run_at`. If another process already advanced
 *     the cursor, the UPDATE matches zero rows and the whole transaction rolls
 *     back — no job is inserted.
 *
 *  2. `UNIQUE (scheduled_job_id, scheduled_for)` on `jobs`. Even if two
 *     processes somehow both passed the CAS, the second INSERT violates the
 *     constraint.
 *
 * Belt AND braces is right here, and it is the only place in this system where
 * that is true. The failure is silent and the consequence — a nightly billing
 * job running twice — is unrecoverable. Layer 1 avoids the error; layer 2 makes
 * it impossible. See ARCHITECTURE.md §10.3.
 */
export async function materializeDueSchedules(
  prisma: PrismaClient,
  opts: { batchSize?: number; now?: Date } = {},
): Promise<MaterializeResult> {
  const now = opts.now ?? new Date();
  const batchSize = opts.batchSize ?? 100;

  const due = await prisma.scheduledJob.findMany({
    where: {
      isEnabled: true,
      nextRunAt: { lte: now },
      OR: [{ startAt: null }, { startAt: { lte: now } }],
      AND: [{ OR: [{ endAt: null }, { endAt: { gte: now } }] }],
    },
    orderBy: { nextRunAt: 'asc' },
    take: batchSize,
  });

  const result: MaterializeResult = {
    schedulesFired: 0,
    jobsCreated: 0,
    slotsSkipped: 0,
    queueIds: [],
  };
  const touchedQueues = new Set<string>();

  for (const schedule of due) {
    const spec = { expression: schedule.cronExpression, timezone: schedule.timezone };

    let plan;
    try {
      plan = resolveMisfire(
        spec,
        schedule.nextRunAt,
        now,
        schedule.misfirePolicy as MisfirePolicy,
        schedule.catchupLimit,
      );
    } catch {
      // An expression that no longer parses (it was valid when stored, or the
      // row was edited directly). Disable it rather than wedging the scheduler
      // in a loop it can never advance past.
      await prisma.scheduledJob.update({
        where: { id: schedule.id },
        data: { isEnabled: false },
      });
      continue;
    }

    if (plan.fireFor.length === 0) continue;

    const created = await fireSchedule(prisma, schedule, plan.fireFor, plan.nextRunAt, now);

    if (created > 0) {
      result.schedulesFired++;
      result.jobsCreated += created;
      touchedQueues.add(schedule.queueId);
    }
    result.slotsSkipped += plan.skipped;
  }

  result.queueIds = [...touchedQueues];
  return result;
}

/** One transaction: advance the cursor and insert the job(s), or neither. */
async function fireSchedule(
  prisma: PrismaClient,
  schedule: {
    id: string;
    projectId: string;
    queueId: string;
    handler: string;
    payload: unknown;
    priority: number;
    maxAttempts: number | null;
    timeoutMs: number | null;
    retryPolicyId: string | null;
    nextRunAt: Date;
  },
  slots: Date[],
  nextCursor: Date,
  now: Date,
): Promise<number> {
  try {
    return await prisma.$transaction(async (tx) => {
      // ── GUARD 1: optimistic CAS on the cursor ──
      // `nextRunAt` in the WHERE clause is the value we OBSERVED. If anyone
      // advanced it since, this matches nothing and we abort without inserting.
      const advanced = await tx.scheduledJob.updateMany({
        where: { id: schedule.id, nextRunAt: schedule.nextRunAt },
        data: { nextRunAt: nextCursor, lastRunAt: now },
      });
      if (advanced.count === 0) return 0;

      // The queue's retry policy supplies whatever the template omits, so a
      // schedule inherits queue defaults rather than freezing them at creation.
      const queue = await tx.queue.findUniqueOrThrow({
        where: { id: schedule.queueId },
        select: { defaultJobTimeoutMs: true, retryPolicy: true, isPaused: true },
      });
      const policy = queue.retryPolicy;

      let created = 0;
      let lastJobId: string | undefined;

      for (const slot of slots) {
        // ── GUARD 2: the unique index on (scheduled_job_id, scheduled_for) ──
        // createMany + skipDuplicates turns the constraint violation into a
        // no-op rather than aborting the transaction.
        const res = await tx.job.createMany({
          data: [
            {
              queueId: schedule.queueId,
              projectId: schedule.projectId,
              scheduledJobId: schedule.id,
              // The INTENDED slot, which may differ from run_at if the
              // scheduler lagged. Also the second half of the unique key.
              scheduledFor: slot,
              // Fire now, not at the historical slot: a missed slot should run
              // immediately on recovery, not be instantly overdue.
              runAt: now,
              status: 'QUEUED',
              handler: schedule.handler,
              payload: (schedule.payload ?? {}) as never,
              priority: schedule.priority,
              maxAttempts: schedule.maxAttempts ?? policy.maxAttempts,
              backoffStrategy: policy.strategy,
              backoffBaseMs: policy.baseDelayMs,
              backoffMaxMs: policy.maxDelayMs,
              backoffJitterPct: policy.jitterPct,
              retryPolicyId: schedule.retryPolicyId ?? policy.id,
              timeoutMs: schedule.timeoutMs ?? queue.defaultJobTimeoutMs,
            },
          ],
          skipDuplicates: true,
        });

        if (res.count > 0) {
          created += res.count;
          const row = await tx.job.findFirst({
            where: { scheduledJobId: schedule.id, scheduledFor: slot },
            select: { id: true },
          });
          if (row) lastJobId = row.id;
        }
      }

      if (lastJobId) {
        await tx.scheduledJob.update({
          where: { id: schedule.id },
          data: { lastJobId },
        });
      }

      return created;
    });
  } catch {
    // A failure here means the cursor was NOT advanced, so the schedule fires
    // late on the next tick rather than being skipped. Late, never lost.
    return 0;
  }
}

/** Recompute a schedule's cursor — used after a cron/timezone edit or a resume. */
export async function recomputeNextRun(
  prisma: PrismaClient,
  scheduleId: string,
  from: Date = new Date(),
): Promise<Date> {
  const s = await prisma.scheduledJob.findUniqueOrThrow({ where: { id: scheduleId } });
  const next = nextFireTime({ expression: s.cronExpression, timezone: s.timezone }, from);
  await prisma.scheduledJob.update({ where: { id: scheduleId }, data: { nextRunAt: next } });
  return next;
}
