import { CronExpressionParser } from 'cron-parser';

export type MisfirePolicy = 'SKIP' | 'FIRE_ONCE' | 'BACKFILL';

export interface CronSpec {
  expression: string;
  /** IANA name (`Asia/Kolkata`). Never a fixed offset — offsets are wrong twice a year. */
  timezone: string;
}

export class InvalidCronError extends Error {
  readonly code = 'INVALID_CRON';
  constructor(expression: string, reason: string) {
    super(`Invalid cron expression "${expression}": ${reason}`);
    this.name = 'InvalidCronError';
  }
}

/** Schedules firing more often than this are rejected at write time. */
export const MIN_CRON_INTERVAL_MS = 60_000;

export function validateCron(spec: CronSpec, from: Date = new Date()): void {
  let first: Date;
  let second: Date;
  try {
    const it = CronExpressionParser.parse(spec.expression, {
      currentDate: from,
      tz: spec.timezone,
    });
    first = it.next().toDate();
    second = it.next().toDate();
  } catch (err) {
    throw new InvalidCronError(spec.expression, err instanceof Error ? err.message : String(err));
  }

  // A cron firing every second would materialise 86,400 jobs a day per schedule
  // and swamp the scheduler's 1s tick.
  if (second.getTime() - first.getTime() < MIN_CRON_INTERVAL_MS) {
    throw new InvalidCronError(spec.expression, 'schedules may not fire more than once per minute');
  }
}

/**
 * The next fire time strictly after `from`, computed in the schedule's own
 * timezone and returned as a UTC instant.
 *
 * DST is handled by cron-parser, and both edge cases matter:
 *   spring-forward — a 02:30 daily job: 02:30 does not exist, so it fires at 03:00, once
 *   fall-back      — a 02:30 daily job: 02:30 happens twice, so it fires once
 *
 * "Every day at 09:00 Europe/London" is a different UTC instant in summer than
 * in winter. That shift is correct: the user asked for 9am local and gets 9am
 * local all year.
 */
export function nextFireTime(spec: CronSpec, from: Date): Date {
  try {
    return CronExpressionParser.parse(spec.expression, {
      currentDate: from,
      tz: spec.timezone,
    })
      .next()
      .toDate();
  } catch (err) {
    throw new InvalidCronError(spec.expression, err instanceof Error ? err.message : String(err));
  }
}

export function nextFireTimes(spec: CronSpec, from: Date, count: number): Date[] {
  const it = CronExpressionParser.parse(spec.expression, { currentDate: from, tz: spec.timezone });
  return Array.from({ length: count }, () => it.next().toDate());
}

export interface MisfireResolution {
  /** Slots to materialise now. Empty means the schedule was simply not due. */
  fireFor: Date[];
  /** The cursor value to CAS `scheduled_jobs.next_run_at` to. */
  nextRunAt: Date;
  /** Slots deliberately dropped — surfaced in the UI so a gap is never silent. */
  skipped: number;
}

/**
 * The scheduler was down 09:00-09:30 and an every-5-minutes schedule missed six
 * slots. What should happen?
 *
 *   SKIP (default) — fire once for the MOST RECENT missed slot, fast-forward
 *                    past the rest. A metrics refresh does not need six catch-up
 *                    runs; it needs one run now and then the normal cadence.
 *   FIRE_ONCE      — fire once for the OLDEST missed slot, advance one step.
 *                    For pipeline steps where order carries meaning.
 *   BACKFILL       — materialise every missed slot, capped by catchupLimit.
 *                    For reports where each period must genuinely be produced.
 *
 * SKIP is the default because silent backfill after an outage turns a scheduler
 * outage into a downstream one: recovery generates a thundering herd of
 * catch-up jobs against a system that just came back up.
 */
export function resolveMisfire(
  spec: CronSpec,
  cursor: Date,
  now: Date,
  policy: MisfirePolicy,
  catchupLimit = 10,
): MisfireResolution {
  if (cursor > now) return { fireFor: [], nextRunAt: cursor, skipped: 0 };

  // Every slot from the cursor up to now, bounded so a schedule that has been
  // disabled for a year cannot produce an unbounded loop.
  const missed: Date[] = [cursor];
  let probe = cursor;
  const HARD_CAP = 10_000;
  while (missed.length < HARD_CAP) {
    probe = nextFireTime(spec, probe);
    if (probe > now) break;
    missed.push(probe);
  }
  const afterAll = probe > now ? probe : nextFireTime(spec, probe);

  switch (policy) {
    case 'SKIP': {
      const latest = missed[missed.length - 1]!;
      return { fireFor: [latest], nextRunAt: afterAll, skipped: missed.length - 1 };
    }
    case 'FIRE_ONCE': {
      const oldest = missed[0]!;
      return { fireFor: [oldest], nextRunAt: nextFireTime(spec, oldest), skipped: 0 };
    }
    case 'BACKFILL': {
      const fireFor = missed.slice(0, catchupLimit);
      const last = fireFor[fireFor.length - 1]!;
      return {
        fireFor,
        nextRunAt: missed.length > catchupLimit ? afterAll : nextFireTime(spec, last),
        skipped: Math.max(0, missed.length - catchupLimit),
      };
    }
  }
}

/** Human-readable description for the UI. Nobody reads `0 9 * * *` correctly. */
export function describeCron(spec: CronSpec): string {
  const parts = spec.expression.trim().split(/\s+/);
  const tz = spec.timezone === 'UTC' ? 'UTC' : spec.timezone;

  if (parts.length === 5) {
    const [min, hour, dom, month, dow] = parts as [string, string, string, string, string];
    const at = (h: string, m: string) => `${h.padStart(2, '0')}:${m.padStart(2, '0')}`;

    if (dom === '*' && month === '*' && dow === '*' && !hour.includes('*') && !min.includes('*')) {
      return `every day at ${at(hour, min)} ${tz}`;
    }
    if (dom === '*' && month === '*' && dow === '*' && hour === '*' && min.startsWith('*/')) {
      return `every ${min.slice(2)} minutes`;
    }
    if (dom === '*' && month === '*' && dow === '*' && hour.startsWith('*/') && min === '0') {
      return `every ${hour.slice(2)} hours, on the hour`;
    }
    if (dom === '*' && month === '*' && dow !== '*' && !hour.includes('*')) {
      const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      const day = names[Number(dow) % 7] ?? `day ${dow}`;
      return `every ${day} at ${at(hour, min)} ${tz}`;
    }
  }
  return `cron: ${spec.expression} (${tz})`;
}
