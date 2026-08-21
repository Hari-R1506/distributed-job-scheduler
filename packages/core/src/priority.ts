export type PriorityLabel = 'CRITICAL' | 'HIGH' | 'NORMAL' | 'LOW' | 'BULK';

/**
 * Priority is a 0-255 smallint, higher runs sooner, with named levels the UI
 * exposes.
 *
 * Numeric-with-labels rather than a bare enum, for two reasons: it leaves room
 * between levels (a job at 175 sits between HIGH and CRITICAL), and it lets
 * priority aging add a computed bonus later without a migration.
 */
export const PRIORITY_VALUES: Readonly<Record<PriorityLabel, number>> = {
  CRITICAL: 200,
  HIGH: 150,
  NORMAL: 100,
  LOW: 50,
  BULK: 10,
} as const;

export const PRIORITY_MIN = 0;
export const PRIORITY_MAX = 255;
export const PRIORITY_DEFAULT = PRIORITY_VALUES.NORMAL;

/** Accepts a label or a raw number. Used by the job-creation DTO. */
export function resolvePriority(input: PriorityLabel | number | undefined): number {
  if (input === undefined) return PRIORITY_DEFAULT;
  if (typeof input === 'number') {
    if (!Number.isInteger(input) || input < PRIORITY_MIN || input > PRIORITY_MAX) {
      throw new RangeError(`priority must be an integer ${PRIORITY_MIN}-${PRIORITY_MAX}`);
    }
    return input;
  }
  const value = PRIORITY_VALUES[input];
  if (value === undefined) throw new RangeError(`unknown priority label: ${input}`);
  return value;
}

/** Nearest label at or below the value, for display. */
export function priorityLabel(value: number): PriorityLabel {
  if (value >= PRIORITY_VALUES.CRITICAL) return 'CRITICAL';
  if (value >= PRIORITY_VALUES.HIGH) return 'HIGH';
  if (value >= PRIORITY_VALUES.NORMAL) return 'NORMAL';
  if (value >= PRIORITY_VALUES.LOW) return 'LOW';
  return 'BULK';
}

/**
 * OPTIONAL, off by default.
 *
 * Under sustained CRITICAL load, BULK jobs never run. Aging fixes that by
 * adding a bonus proportional to how long a job has been ready.
 *
 * It is off by default because surprising behaviour is worse than slow
 * behaviour — and because the resulting expression is NOT index-orderable, so
 * enabling it degrades the claim query from an ordered index walk to a bounded
 * sort. That trade belongs to the operator, per queue, made explicitly.
 * See ARCHITECTURE.md §9.4.
 */
export function effectivePriority(
  basePriority: number,
  readySince: Date,
  agingPerMinute: number,
  now: Date = new Date(),
): number {
  if (agingPerMinute <= 0) return basePriority;
  const minutesReady = Math.floor((now.getTime() - readySince.getTime()) / 60_000);
  return Math.min(PRIORITY_MAX, basePriority + Math.max(0, minutesReady) * agingPerMinute);
}
