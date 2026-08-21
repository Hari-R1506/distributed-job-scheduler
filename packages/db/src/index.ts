import { PrismaClient } from '@prisma/client';

export * from '@prisma/client';
export { SQL } from './sql.js';
export * from './repositories/job-lifecycle.js';

export interface PrismaOptions {
  /** Connection pool ceiling. Sized per process — see ARCHITECTURE.md §22.3. */
  connectionLimit?: number;
  logQueries?: boolean;
}

/**
 * Pool sizes are deliberate, not defaults:
 *
 *   api       10               short queries only
 *   worker    concurrency + 3  one per concurrent job's short transactions,
 *                              plus heartbeat and log flusher. The dedicated
 *                              LISTEN connection is NOT pooled — a pooled
 *                              connection is reset between checkouts, which
 *                              silently drops the subscription. That bug
 *                              presents as "notifications work in dev and stop
 *                              working under load".
 *   scheduler 3                one per loop family
 */
export function createPrismaClient(url: string, opts: PrismaOptions = {}): PrismaClient {
  const dsn = new URL(url);
  if (opts.connectionLimit) {
    dsn.searchParams.set('connection_limit', String(opts.connectionLimit));
  }
  // Fail fast rather than queue forever behind an exhausted pool.
  dsn.searchParams.set('pool_timeout', '10');

  return new PrismaClient({
    datasources: { db: { url: dsn.toString() } },
    log: opts.logQueries ? ['query', 'warn', 'error'] : ['warn', 'error'],
  });
}

/** Advisory-lock key for scheduler leader election (ARCHITECTURE.md §3.3). */
export const SCHEDULER_LOCK_ID = 4_815_162_342n;

/** Channel workers LISTEN on. Payload is the queue id. */
export const JOBS_READY_CHANNEL = 'jobs_ready';
