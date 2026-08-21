import { describe, it, expect } from 'vitest';
import {
  computeBackoffMs,
  nextRunAt,
  totalBackoffWindowMs,
  describeBackoff,
  type BackoffContract,
} from '@djs/core';

/** 0.5 lands exactly in the middle of the jitter range, i.e. no adjustment. */
const noJitter = () => 0.5;

const base = (over: Partial<BackoffContract> = {}): BackoffContract => ({
  strategy: 'EXPONENTIAL',
  baseDelayMs: 5_000,
  maxDelayMs: 300_000,
  jitterPct: 0,
  ...over,
});

describe('computeBackoffMs', () => {
  describe('FIXED', () => {
    it('returns the base delay for every attempt', () => {
      const c = base({ strategy: 'FIXED' });
      expect(computeBackoffMs(c, 1, noJitter)).toBe(5_000);
      expect(computeBackoffMs(c, 2, noJitter)).toBe(5_000);
      expect(computeBackoffMs(c, 9, noJitter)).toBe(5_000);
    });
  });

  describe('LINEAR', () => {
    it('scales with the attempt number', () => {
      const c = base({ strategy: 'LINEAR' });
      expect(computeBackoffMs(c, 1, noJitter)).toBe(5_000);
      expect(computeBackoffMs(c, 2, noJitter)).toBe(10_000);
      expect(computeBackoffMs(c, 3, noJitter)).toBe(15_000);
      expect(computeBackoffMs(c, 4, noJitter)).toBe(20_000);
    });
  });

  describe('EXPONENTIAL', () => {
    it('doubles each attempt', () => {
      const c = base();
      expect(computeBackoffMs(c, 1, noJitter)).toBe(5_000);
      expect(computeBackoffMs(c, 2, noJitter)).toBe(10_000);
      expect(computeBackoffMs(c, 3, noJitter)).toBe(20_000);
      expect(computeBackoffMs(c, 4, noJitter)).toBe(40_000);
      expect(computeBackoffMs(c, 5, noJitter)).toBe(80_000);
    });

    it('matches the table published in ARCHITECTURE.md §11.1', () => {
      const c = base();
      // base 5s, max 300s: 5, 10, 20, 40 then dead-letter on attempt 5.
      expect([1, 2, 3, 4].map((n) => computeBackoffMs(c, n, noJitter))).toEqual([
        5_000, 10_000, 20_000, 40_000,
      ]);
    });
  });

  describe('the cap', () => {
    it('never exceeds maxDelayMs, however many attempts', () => {
      const c = base({ maxDelayMs: 30_000 });
      expect(computeBackoffMs(c, 3, noJitter)).toBe(20_000);
      expect(computeBackoffMs(c, 4, noJitter)).toBe(30_000); // would be 40_000
      expect(computeBackoffMs(c, 20, noJitter)).toBe(30_000);
    });

    it('applies before jitter, so jitter can push slightly past the cap', () => {
      // Deliberate: jittering a capped value keeps the herd spread out. The
      // alternative — capping after jitter — collapses every attempt at the cap
      // back onto the same instant, defeating the point of jitter entirely.
      const c = base({ maxDelayMs: 10_000, jitterPct: 10 });
      const d = computeBackoffMs(c, 10, () => 1);
      expect(d).toBeGreaterThan(10_000);
      expect(d).toBeLessThanOrEqual(11_000);
    });
  });

  describe('jitter', () => {
    it('stays within +/- jitterPct across 1000 samples', () => {
      const c = base({ strategy: 'FIXED', baseDelayMs: 10_000, jitterPct: 10 });
      const samples = Array.from({ length: 1000 }, () => computeBackoffMs(c, 1));

      for (const s of samples) {
        expect(s).toBeGreaterThanOrEqual(9_000);
        expect(s).toBeLessThanOrEqual(11_000);
      }
    });

    it('actually spreads the values — this is the whole point', () => {
      // Without jitter, 500 jobs that failed in the same second would all retry
      // in the SAME millisecond and re-DDoS a recovering service (§11.2).
      const c = base({ strategy: 'FIXED', baseDelayMs: 10_000, jitterPct: 10 });
      const samples = Array.from({ length: 500 }, () => computeBackoffMs(c, 1));

      expect(new Set(samples).size).toBeGreaterThan(100);
      expect(Math.max(...samples) - Math.min(...samples)).toBeGreaterThan(1_000);
    });

    it('is deterministic when jitterPct is 0', () => {
      const c = base({ strategy: 'FIXED', jitterPct: 0 });
      const samples = new Set(Array.from({ length: 50 }, () => computeBackoffMs(c, 1)));
      expect(samples.size).toBe(1);
    });
  });

  it('rejects attempt numbers below 1', () => {
    expect(() => computeBackoffMs(base(), 0)).toThrow(RangeError);
    expect(() => computeBackoffMs(base(), -1)).toThrow(RangeError);
  });

  it('never returns a negative delay', () => {
    const c = base({ strategy: 'FIXED', baseDelayMs: 0, jitterPct: 100 });
    for (let i = 0; i < 100; i++) expect(computeBackoffMs(c, 1)).toBeGreaterThanOrEqual(0);
  });
});

describe('nextRunAt', () => {
  it('offsets from the supplied clock, not the wall clock', () => {
    const now = new Date('2026-08-20T10:00:00.000Z');
    const c = base({ strategy: 'FIXED', baseDelayMs: 30_000 });
    expect(nextRunAt(c, 1, now, noJitter).toISOString()).toBe('2026-08-20T10:00:30.000Z');
  });
});

describe('totalBackoffWindowMs', () => {
  it('sums the waits between attempts, not after the last one', () => {
    // 5 attempts => 4 waits: 5 + 10 + 20 + 40 = 75s. The final attempt
    // dead-letters rather than sleeping.
    expect(totalBackoffWindowMs(base(), 5)).toBe(75_000);
  });

  it('is zero for a single-attempt policy', () => {
    expect(totalBackoffWindowMs(base(), 1)).toBe(0);
  });
});

describe('describeBackoff', () => {
  it('renders the prose the Create Job form shows before submission', () => {
    expect(describeBackoff(base(), 5)).toBe(
      'up to 5 attempts, exponential backoff 5s → 40s',
    );
    expect(describeBackoff(base({ strategy: 'FIXED' }), 3)).toBe(
      'up to 3 attempts, fixed 5s between each',
    );
  });
});
