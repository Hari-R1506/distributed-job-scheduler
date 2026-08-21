import { describe, it, expect } from 'vitest';
import {
  JOB_STATUSES,
  LEGAL_TRANSITIONS,
  canTransition,
  assertTransition,
  IllegalTransitionError,
  isTerminal,
  isInFlight,
  canCancel,
  cancellationIsCooperative,
  type JobStatus,
} from '@djs/core';

describe('job state machine', () => {
  /**
   * The exhaustive test. 9 statuses => 81 ordered pairs, and every single one
   * is asserted against the declared table. Cheap to run, impossible to fool,
   * and it means a transition added to the table without thought immediately
   * shows up as a diff here.
   */
  it('accepts exactly the legal set across all 81 (from, to) pairs', () => {
    const legal: string[] = [];
    const illegal: string[] = [];

    for (const from of JOB_STATUSES) {
      for (const to of JOB_STATUSES) {
        const declared = LEGAL_TRANSITIONS[from].includes(to);
        expect(canTransition(from, to)).toBe(declared);
        (declared ? legal : illegal).push(`${from}->${to}`);
      }
    }

    expect(legal.length + illegal.length).toBe(81);
    expect(legal).toMatchInlineSnapshot(`
      [
        "SCHEDULED->QUEUED",
        "SCHEDULED->CANCELLED",
        "QUEUED->CLAIMED",
        "QUEUED->CANCELLED",
        "CLAIMED->RUNNING",
        "CLAIMED->RETRYING",
        "CLAIMED->FAILED",
        "CLAIMED->DEAD_LETTER",
        "RUNNING->RETRYING",
        "RUNNING->COMPLETED",
        "RUNNING->FAILED",
        "RUNNING->DEAD_LETTER",
        "RUNNING->CANCELLED",
        "RETRYING->QUEUED",
        "RETRYING->CANCELLED",
      ]
    `);
  });

  it('treats every terminal status as a dead end', () => {
    for (const s of ['COMPLETED', 'FAILED', 'DEAD_LETTER', 'CANCELLED'] as JobStatus[]) {
      expect(isTerminal(s)).toBe(true);
      expect(LEGAL_TRANSITIONS[s]).toHaveLength(0);
      for (const to of JOB_STATUSES) expect(canTransition(s, to)).toBe(false);
    }
  });

  it('has no self-transitions', () => {
    for (const s of JOB_STATUSES) expect(canTransition(s, s)).toBe(false);
  });

  describe('the happy path', () => {
    it('walks SCHEDULED -> QUEUED -> CLAIMED -> RUNNING -> COMPLETED', () => {
      const path: JobStatus[] = ['SCHEDULED', 'QUEUED', 'CLAIMED', 'RUNNING', 'COMPLETED'];
      for (let i = 0; i < path.length - 1; i++) {
        expect(() => assertTransition(path[i]!, path[i + 1]!)).not.toThrow();
      }
    });
  });

  describe('the retry loop', () => {
    it('re-enters the ordinary pipeline rather than taking a special path', () => {
      // RUNNING -> RETRYING -> QUEUED -> CLAIMED -> RUNNING. The only thing that
      // differs on the second pass is a higher attempt_count, which is why the
      // state machine stays small (§6.2).
      const loop: JobStatus[] = ['RUNNING', 'RETRYING', 'QUEUED', 'CLAIMED', 'RUNNING'];
      for (let i = 0; i < loop.length - 1; i++) {
        expect(canTransition(loop[i]!, loop[i + 1]!)).toBe(true);
      }
    });

    it('has no FAILED -> RETRYING edge, because attempts fail and jobs die', () => {
      // "Failed" at the JOB level is terminal. A recoverable failure goes
      // straight to RETRYING; the failed attempt is recorded on
      // job_executions.status instead. See ARCHITECTURE.md §4.1.
      expect(canTransition('FAILED', 'RETRYING')).toBe(false);
      expect(canTransition('FAILED', 'QUEUED')).toBe(false);
    });
  });

  describe('reaper recovery', () => {
    it('can recover a job that died between claiming and starting', () => {
      // The worker was SIGKILLed after the claim committed but before
      // markRunning, so there is no execution row at all (§21 case 2).
      expect(canTransition('CLAIMED', 'RETRYING')).toBe(true);
      expect(canTransition('CLAIMED', 'DEAD_LETTER')).toBe(true);
    });

    it('can recover a job that died mid-execution', () => {
      expect(canTransition('RUNNING', 'RETRYING')).toBe(true);
      expect(canTransition('RUNNING', 'DEAD_LETTER')).toBe(true);
    });
  });

  describe('cancellation', () => {
    it('is allowed from every non-terminal state', () => {
      expect(canCancel('SCHEDULED')).toBe(true);
      expect(canCancel('QUEUED')).toBe(true);
      expect(canCancel('RETRYING')).toBe(true);
      expect(canCancel('RUNNING')).toBe(true);
    });

    it('is refused once the job is terminal', () => {
      expect(canCancel('COMPLETED')).toBe(false);
      expect(canCancel('DEAD_LETTER')).toBe(false);
      expect(canCancel('CANCELLED')).toBe(false);
    });

    it('is cooperative only for RUNNING jobs', () => {
      // Everything else flips synchronously. A RUNNING job sets
      // cancel_requested and the handler aborts at its next await point —
      // killing it outright would leave a side effect half-applied.
      expect(cancellationIsCooperative('RUNNING')).toBe(true);
      expect(cancellationIsCooperative('QUEUED')).toBe(false);
    });

    it('cannot be cancelled from CLAIMED', () => {
      // Deliberate gap: a CLAIMED job is already leased and about to start on a
      // worker that has no channel to hear about it. The API returns 409 and
      // the user retries a moment later once it is RUNNING.
      expect(canCancel('CLAIMED')).toBe(false);
    });
  });

  describe('in-flight detection', () => {
    it('matches exactly the states guarded by the lease CHECK constraint', () => {
      // chk_jobs_lease_present / chk_jobs_worker_present fire on these two.
      for (const s of JOB_STATUSES) {
        expect(isInFlight(s)).toBe(s === 'CLAIMED' || s === 'RUNNING');
      }
    });
  });

  describe('assertTransition', () => {
    it('throws a typed error naming the legal alternatives', () => {
      try {
        assertTransition('COMPLETED', 'RUNNING', 'job_123');
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(IllegalTransitionError);
        const e = err as IllegalTransitionError;
        expect(e.code).toBe('ILLEGAL_STATE_TRANSITION');
        expect(e.from).toBe('COMPLETED');
        expect(e.to).toBe('RUNNING');
        expect(e.message).toContain('job_123');
        expect(e.message).toContain('(terminal)');
      }
    });

    it('is silent on a legal transition', () => {
      expect(() => assertTransition('QUEUED', 'CLAIMED')).not.toThrow();
    });
  });
});
