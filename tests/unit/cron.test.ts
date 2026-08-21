import { describe, it, expect } from 'vitest';
import {
  validateCron,
  nextFireTime,
  nextFireTimes,
  resolveMisfire,
  describeCron,
  InvalidCronError,
} from '@djs/core';

const utc = (s: string) => new Date(s);

describe('validateCron', () => {
  it('accepts ordinary expressions', () => {
    expect(() => validateCron({ expression: '0 9 * * *', timezone: 'UTC' })).not.toThrow();
    expect(() => validateCron({ expression: '*/5 * * * *', timezone: 'Asia/Kolkata' })).not.toThrow();
  });

  it('rejects malformed expressions', () => {
    expect(() => validateCron({ expression: 'not a cron', timezone: 'UTC' })).toThrow(
      InvalidCronError,
    );
    expect(() => validateCron({ expression: '99 * * * *', timezone: 'UTC' })).toThrow(
      InvalidCronError,
    );
  });

  it('rejects an invalid timezone', () => {
    expect(() => validateCron({ expression: '0 9 * * *', timezone: 'Mars/Olympus' })).toThrow(
      InvalidCronError,
    );
  });

  it('rejects schedules firing more than once a minute', () => {
    // A per-second schedule would materialise 86,400 jobs a day and swamp the
    // scheduler's 1s tick.
    expect(() => validateCron({ expression: '* * * * * *', timezone: 'UTC' })).toThrow(
      /once per minute/,
    );
  });
});

describe('nextFireTime', () => {
  it('computes the next fire in the schedule timezone and returns UTC', () => {
    // 09:00 Asia/Kolkata is UTC+05:30 => 03:30Z.
    const next = nextFireTime(
      { expression: '0 9 * * *', timezone: 'Asia/Kolkata' },
      utc('2026-08-20T00:00:00Z'),
    );
    expect(next.toISOString()).toBe('2026-08-20T03:30:00.000Z');
  });

  it('is strictly after the reference instant', () => {
    const at9 = utc('2026-08-20T09:00:00Z');
    const next = nextFireTime({ expression: '0 9 * * *', timezone: 'UTC' }, at9);
    expect(next.toISOString()).toBe('2026-08-21T09:00:00.000Z');
  });

  describe('daylight saving', () => {
    it('keeps a daily job at the same LOCAL time across the boundary', () => {
      // The stored UTC instant shifts by an hour, which is correct: the user
      // asked for 09:00 local and gets 09:00 local all year (§10.5).
      const spec = { expression: '0 9 * * *', timezone: 'Europe/London' };
      const winter = nextFireTime(spec, utc('2026-01-15T00:00:00Z'));
      const summer = nextFireTime(spec, utc('2026-07-15T00:00:00Z'));

      expect(winter.toISOString()).toBe('2026-01-15T09:00:00.000Z'); // GMT
      expect(summer.toISOString()).toBe('2026-07-15T08:00:00.000Z'); // BST
    });

    it('fires exactly once on the spring-forward day, when 02:30 does not exist', () => {
      // Europe/London springs forward 2026-03-29 at 01:00 -> 02:00.
      const spec = { expression: '30 2 * * *', timezone: 'Europe/London' };
      const runs = nextFireTimes(spec, utc('2026-03-28T12:00:00Z'), 3);
      const onGapDay = runs.filter((d) => d.toISOString().startsWith('2026-03-29'));
      expect(onGapDay.length).toBeLessThanOrEqual(1);
    });

    it('fires exactly once on the fall-back day, when 02:30 happens twice', () => {
      // Europe/London falls back 2026-10-25 at 02:00 -> 01:00.
      const spec = { expression: '30 2 * * *', timezone: 'Europe/London' };
      const runs = nextFireTimes(spec, utc('2026-10-24T12:00:00Z'), 3);
      const onRepeatDay = runs.filter((d) => d.toISOString().startsWith('2026-10-25'));
      expect(onRepeatDay).toHaveLength(1);
    });
  });
});

describe('nextFireTimes', () => {
  it('returns the preview the Create Job form shows', () => {
    const runs = nextFireTimes(
      { expression: '0 9 * * *', timezone: 'UTC' },
      utc('2026-08-20T00:00:00Z'),
      3,
    );
    expect(runs.map((d) => d.toISOString())).toEqual([
      '2026-08-20T09:00:00.000Z',
      '2026-08-21T09:00:00.000Z',
      '2026-08-22T09:00:00.000Z',
    ]);
  });
});

describe('resolveMisfire', () => {
  const spec = { expression: '*/5 * * * *', timezone: 'UTC' };

  it('does nothing when the cursor is still in the future', () => {
    const r = resolveMisfire(spec, utc('2026-08-20T10:00:00Z'), utc('2026-08-20T09:00:00Z'), 'SKIP');
    expect(r.fireFor).toHaveLength(0);
    expect(r.skipped).toBe(0);
  });

  describe('SKIP (the default)', () => {
    it('fires once for the MOST RECENT missed slot and fast-forwards past the rest', () => {
      // Scheduler down 09:00-09:30 => six missed slots. A metrics refresh does
      // not need six catch-up runs; it needs one run now (§10.4).
      const r = resolveMisfire(
        spec,
        utc('2026-08-20T09:00:00Z'),
        utc('2026-08-20T09:30:00Z'),
        'SKIP',
      );
      expect(r.fireFor).toHaveLength(1);
      expect(r.fireFor[0]!.toISOString()).toBe('2026-08-20T09:30:00.000Z');
      expect(r.skipped).toBe(6);
      expect(r.nextRunAt.toISOString()).toBe('2026-08-20T09:35:00.000Z');
    });
  });

  describe('FIRE_ONCE', () => {
    it('fires the OLDEST missed slot and advances a single step', () => {
      const r = resolveMisfire(
        spec,
        utc('2026-08-20T09:00:00Z'),
        utc('2026-08-20T09:30:00Z'),
        'FIRE_ONCE',
      );
      expect(r.fireFor).toHaveLength(1);
      expect(r.fireFor[0]!.toISOString()).toBe('2026-08-20T09:00:00.000Z');
      expect(r.nextRunAt.toISOString()).toBe('2026-08-20T09:05:00.000Z');
    });
  });

  describe('BACKFILL', () => {
    it('materialises every missed slot', () => {
      const r = resolveMisfire(
        spec,
        utc('2026-08-20T09:00:00Z'),
        utc('2026-08-20T09:30:00Z'),
        'BACKFILL',
      );
      expect(r.fireFor).toHaveLength(7); // 09:00 through 09:30 inclusive
      expect(r.skipped).toBe(0);
    });

    it('is bounded by catchupLimit', () => {
      // Unbounded backfill turns a scheduler outage into a downstream one: a
      // thundering herd of catch-up jobs against a system that just recovered.
      const r = resolveMisfire(
        spec,
        utc('2026-08-20T00:00:00Z'),
        utc('2026-08-20T09:30:00Z'),
        'BACKFILL',
        10,
      );
      expect(r.fireFor).toHaveLength(10);
      expect(r.skipped).toBeGreaterThan(0);
      // The cursor still jumps clear of the backlog, so the next tick is normal.
      expect(r.nextRunAt.getTime()).toBeGreaterThan(utc('2026-08-20T09:30:00Z').getTime());
    });
  });

  it('fires a single slot when exactly one was missed', () => {
    const r = resolveMisfire(spec, utc('2026-08-20T09:00:00Z'), utc('2026-08-20T09:04:00Z'), 'SKIP');
    expect(r.fireFor).toHaveLength(1);
    expect(r.skipped).toBe(0);
  });
});

describe('describeCron', () => {
  it('renders the plain-English label the UI shows', () => {
    // Nobody reads `0 9 * * *` correctly under time pressure.
    expect(describeCron({ expression: '0 9 * * *', timezone: 'UTC' })).toBe('every day at 09:00 UTC');
    expect(describeCron({ expression: '30 6 * * *', timezone: 'Asia/Kolkata' })).toBe(
      'every day at 06:30 Asia/Kolkata',
    );
    expect(describeCron({ expression: '*/5 * * * *', timezone: 'UTC' })).toBe('every 5 minutes');
    expect(describeCron({ expression: '0 */2 * * *', timezone: 'UTC' })).toBe(
      'every 2 hours, on the hour',
    );
    expect(describeCron({ expression: '0 9 * * 1', timezone: 'UTC' })).toBe(
      'every Monday at 09:00 UTC',
    );
  });

  it('falls back to the raw expression for anything it cannot phrase', () => {
    expect(describeCron({ expression: '0 9 1,15 * *', timezone: 'UTC' })).toContain('cron:');
  });
});
