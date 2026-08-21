import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The hot-path queries live in `packages/db/sql/*.sql` rather than in template
 * literals inside a service.
 *
 * The claim query is the most important 30 lines in this project. As a versioned
 * file it is reviewable, diffable, runnable under `EXPLAIN (ANALYZE, BUFFERS)`,
 * and paste-able into the design document. Buried in a string, it is none of
 * those things.
 */
const SQL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'sql');

function load(name: string): string {
  return readFileSync(join(SQL_DIR, name), 'utf8');
}

/**
 * `claim-jobs.sql` holds two statements: the advisory lock, then the claim CTE.
 * They must run in the same transaction but as separate round trips, because
 * the lock has to be held before the capacity count is taken.
 */
function splitClaim(): { lock: string; claim: string } {
  const raw = load('claim-jobs.sql');
  const marker = raw.indexOf('WITH capacity AS');
  if (marker === -1) throw new Error('claim-jobs.sql: could not locate the claim CTE');

  const lockLine = raw
    .slice(0, marker)
    .split('\n')
    .find((l) => l.trim().startsWith('SELECT pg_advisory_xact_lock'));
  if (!lockLine) throw new Error('claim-jobs.sql: could not locate the advisory lock statement');

  return { lock: lockLine.trim(), claim: raw.slice(marker) };
}

const claim = splitClaim();

export const SQL = {
  /** Per-queue advisory lock. Params: $1 queue_id. See ARCHITECTURE.md §7.4. */
  CLAIM_LOCK: claim.lock,
  /** Params: $1 queue_id, $2 worker_id, $3 free_slots, $4 visibility_timeout_ms. */
  CLAIM_JOBS: claim.claim,
  /** Params: $1 batch_size. Returns (queue_id, id). */
  PROMOTE_DUE: load('promote-due.sql'),
  /** Params: $1 batch_size. Returns the recovery decision per job. */
  REAP_EXPIRED: load('reap-expired.sql'),
  /** Params: $1 from, $2 to. Idempotent. */
  ROLLUP_MINUTE: load('rollup-minute.sql'),
} as const;
