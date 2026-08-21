import { Client } from 'pg';
import { SCHEDULER_LOCK_ID } from '@djs/db';

export interface LeaderElectionOptions {
  databaseUrl: string;
  /** How often a follower retries for leadership. */
  retryMs?: number;
  onAcquired?: () => void;
  onLost?: (reason: string) => void;
  onError?: (err: unknown) => void;
}

/**
 * Leader election via a PostgreSQL session-scoped advisory lock.
 *
 * Three of the scheduler's loops — promotion, cron materialisation, reaping —
 * are GLOBALLY SINGULAR. Running two copies fires every cron twice.
 *
 * The alternative was a dedicated deployable that operators must remember to
 * run exactly one of. That works right up until somebody scales it to 2. This
 * makes correctness STRUCTURAL rather than procedural: every process may
 * attempt the lock, exactly one wins, and the rest run as followers.
 *
 * Failover is free. If the leader's process dies, its TCP session ends,
 * Postgres releases the advisory lock automatically, and the next follower to
 * retry becomes leader. No lease to expire, no heartbeat to miss, no split
 * brain — the database is the arbiter.
 *
 * ⚠️ It uses a DEDICATED `pg` client, not Prisma. Session-scoped advisory locks
 * belong to a connection, and Prisma pools connections — it would hand the lock
 * back to the pool and later give you a different connection that does not hold
 * it. This is also why the NOTIFY listener needs its own connection.
 */
export class LeaderElection {
  private client?: Client;
  private timer?: NodeJS.Timeout;
  private leader = false;
  private stopped = false;
  private readonly retryMs: number;

  constructor(private readonly opts: LeaderElectionOptions) {
    this.retryMs = opts.retryMs ?? 5_000;
  }

  get isLeader(): boolean {
    return this.leader;
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.attempt();
    this.timer = setInterval(() => void this.attempt(), this.retryMs);
    this.timer.unref?.();
  }

  private async attempt(): Promise<void> {
    if (this.stopped) return;

    try {
      if (!this.client) {
        this.client = new Client({ connectionString: this.opts.databaseUrl });
        // If the connection drops, so does the lock. Surface that as losing
        // leadership rather than silently continuing to believe we hold it —
        // a leader that thinks it is leading while another process actually is
        // would double-fire every cron.
        this.client.on('error', (err) => this.demote(`connection error: ${err.message}`));
        this.client.on('end', () => this.demote('connection closed'));
        await this.client.connect();
      }

      if (this.leader) {
        // Confirm we still hold it. Cheap, and it catches a connection that was
        // reset underneath us without emitting an event.
        const res = await this.client.query<{ held: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM pg_locks
              WHERE locktype = 'advisory' AND pid = pg_backend_pid()
                AND ((classid::bigint << 32) | objid::bigint) = $1::bigint
           ) AS held`,
          [SCHEDULER_LOCK_ID.toString()],
        );
        if (!res.rows[0]?.held) this.demote('advisory lock no longer held');
        return;
      }

      const res = await this.client.query<{ acquired: boolean }>(
        'SELECT pg_try_advisory_lock($1::bigint) AS acquired',
        [SCHEDULER_LOCK_ID.toString()],
      );

      if (res.rows[0]?.acquired) {
        this.leader = true;
        this.opts.onAcquired?.();
      }
    } catch (err) {
      this.opts.onError?.(err);
      // Rebuild the connection on the next tick rather than reusing a broken one.
      this.demote('election attempt failed');
      await this.client?.end().catch(() => {});
      this.client = undefined;
    }
  }

  private demote(reason: string): void {
    if (!this.leader) return;
    this.leader = false;
    this.opts.onLost?.(reason);
  }

  /** Release leadership so another process can take over without waiting. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;

    if (this.client) {
      // Explicit unlock, so failover on a clean shutdown is immediate rather
      // than waiting for the OS to tear the socket down.
      if (this.leader) {
        await this.client
          .query('SELECT pg_advisory_unlock($1::bigint)', [SCHEDULER_LOCK_ID.toString()])
          .catch(() => {});
      }
      this.client.removeAllListeners();
      await this.client.end().catch(() => {});
      this.client = undefined;
    }
    this.leader = false;
  }
}
