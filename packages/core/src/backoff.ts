export type BackoffStrategy = 'FIXED' | 'LINEAR' | 'EXPONENTIAL';

export interface BackoffContract {
  strategy: BackoffStrategy;
  baseDelayMs: number;
  maxDelayMs: number;
  /** 0-100. Applied as ±pct of the computed delay. */
  jitterPct: number;
}

/**
 * Delay before the next attempt, given the attempt that just failed (1-based).
 *
 *   FIXED        base
 *   LINEAR       base x attempt
 *   EXPONENTIAL  base x 2^(attempt-1)
 *
 * ...then capped at maxDelayMs, then jittered.
 *
 * With base=5s, max=300s:
 *
 *   attempt │ FIXED │ LINEAR │ EXPONENTIAL
 *   ────────┼───────┼────────┼────────────
 *      1    │  5s   │   5s   │    5s
 *      2    │  5s   │  10s   │   10s
 *      3    │  5s   │  15s   │   20s
 *      4    │  5s   │  20s   │   40s
 *
 * NOTE: this is mirrored in SQL in `reap-expired.sql`, so the reaper can
 * recover a job in one round trip. A unit test asserts the two implementations
 * agree across the full parameter space — if you change one, change both.
 */
export function computeBackoffMs(
  contract: BackoffContract,
  attempt: number,
  random: () => number = Math.random,
): number {
  if (attempt < 1) throw new RangeError(`attempt must be >= 1, got ${attempt}`);

  const { strategy, baseDelayMs, maxDelayMs, jitterPct } = contract;

  let delay: number;
  switch (strategy) {
    case 'FIXED':
      delay = baseDelayMs;
      break;
    case 'LINEAR':
      delay = baseDelayMs * attempt;
      break;
    case 'EXPONENTIAL':
      delay = baseDelayMs * Math.pow(2, attempt - 1);
      break;
    default: {
      // Exhaustiveness: adding a strategy without handling it is a compile error.
      const never: never = strategy;
      throw new Error(`unknown backoff strategy: ${String(never)}`);
    }
  }

  delay = Math.min(delay, maxDelayMs);

  // Jitter is not decoration. A downstream API goes down for 60s and 500 jobs
  // fail in the same second; without jitter all 500 retry at EXACTLY t+5s, then
  // t+15s, then t+35s — a synchronised thundering herd that re-DDoSes the
  // service the instant it recovers, likely knocking it back over. With ±10%
  // the retries smear and the recovering service sees a ramp instead of a wall.
  if (jitterPct > 0) {
    const factor = 1 + (random() * 2 - 1) * (jitterPct / 100);
    delay = delay * factor;
  }

  return Math.max(0, Math.round(delay));
}

/** The instant the next attempt becomes eligible. Written to `jobs.run_at`. */
export function nextRunAt(
  contract: BackoffContract,
  attempt: number,
  now: Date = new Date(),
  random: () => number = Math.random,
): Date {
  return new Date(now.getTime() + computeBackoffMs(contract, attempt, random));
}

/**
 * Total worst-case time from the first failure to dead-lettering, ignoring
 * execution time. Used by the Create Job form to spell out the retry contract
 * in prose before the user submits.
 */
export function totalBackoffWindowMs(contract: BackoffContract, maxAttempts: number): number {
  let total = 0;
  // The final attempt dead-letters rather than sleeping, so there are
  // maxAttempts-1 waits.
  for (let attempt = 1; attempt < maxAttempts; attempt++) {
    total += computeBackoffMs(contract, attempt, () => 0.5); // 0.5 => no jitter
  }
  return total;
}

export function describeBackoff(contract: BackoffContract, maxAttempts: number): string {
  const first = computeBackoffMs(contract, 1, () => 0.5);
  const last = computeBackoffMs(contract, Math.max(1, maxAttempts - 1), () => 0.5);
  const s = (ms: number) => (ms >= 1000 ? `${Math.round(ms / 1000)}s` : `${ms}ms`);

  if (contract.strategy === 'FIXED') {
    return `up to ${maxAttempts} attempts, fixed ${s(first)} between each`;
  }
  return `up to ${maxAttempts} attempts, ${contract.strategy.toLowerCase()} backoff ${s(first)} → ${s(last)}`;
}
