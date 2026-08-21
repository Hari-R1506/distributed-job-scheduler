export type JobStatus =
  | 'SCHEDULED'
  | 'QUEUED'
  | 'CLAIMED'
  | 'RUNNING'
  | 'RETRYING'
  | 'COMPLETED'
  | 'FAILED'
  | 'DEAD_LETTER'
  | 'CANCELLED';

export const JOB_STATUSES: readonly JobStatus[] = [
  'SCHEDULED',
  'QUEUED',
  'CLAIMED',
  'RUNNING',
  'RETRYING',
  'COMPLETED',
  'FAILED',
  'DEAD_LETTER',
  'CANCELLED',
] as const;

/**
 * The lifecycle, as data.
 *
 * Keeping the transition table here — rather than scattered across services —
 * turns "we designed a state machine" from a claim in a document into an
 * invariant the code enforces. Every write goes through `assertTransition`, and
 * the whole table is covered by one exhaustive test over all 81 (from, to) pairs.
 *
 * The brief writes the lifecycle as `Queued -> Scheduled -> Claimed -> ...`;
 * causally SCHEDULED precedes QUEUED (a future job becomes eligible, then gets
 * picked up), so that is how it is modelled here. See ARCHITECTURE.md §6.1.
 *
 * Note there is no FAILED -> RETRYING edge: "failed" is a property of an
 * ATTEMPT (job_executions.status), not of a job. Attempts fail; jobs die.
 * At the job level a recoverable failure goes straight to RETRYING.
 */
export const LEGAL_TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  SCHEDULED: ['QUEUED', 'CANCELLED'],
  QUEUED: ['CLAIMED', 'CANCELLED'],
  // CLAIMED -> RETRYING / DEAD_LETTER happens when the reaper recovers a job
  // whose worker died between claiming and starting it.
  CLAIMED: ['RUNNING', 'RETRYING', 'DEAD_LETTER', 'FAILED'],
  RUNNING: ['COMPLETED', 'RETRYING', 'DEAD_LETTER', 'FAILED', 'CANCELLED'],
  RETRYING: ['QUEUED', 'CANCELLED'],
  // Terminal. A DLQ replay creates a NEW job with parent_job_id set; it never
  // resurrects this one, so the audit trail survives (ARCHITECTURE.md §12.5).
  COMPLETED: [],
  FAILED: [],
  DEAD_LETTER: [],
  CANCELLED: [],
} as const;

export const TERMINAL_STATUSES: readonly JobStatus[] = [
  'COMPLETED',
  'FAILED',
  'DEAD_LETTER',
  'CANCELLED',
] as const;

/** Statuses in which a worker holds a lease. Guarded by a CHECK constraint. */
export const IN_FLIGHT_STATUSES: readonly JobStatus[] = ['CLAIMED', 'RUNNING'] as const;

/** Statuses waiting on a clock, which the promotion loop moves to QUEUED. */
export const PENDING_CLOCK_STATUSES: readonly JobStatus[] = ['SCHEDULED', 'RETRYING'] as const;

export function isTerminal(status: JobStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function isInFlight(status: JobStatus): boolean {
  return IN_FLIGHT_STATUSES.includes(status);
}

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

export class IllegalTransitionError extends Error {
  readonly code = 'ILLEGAL_STATE_TRANSITION';
  constructor(
    readonly from: JobStatus,
    readonly to: JobStatus,
    readonly jobId?: string,
  ) {
    super(
      `Illegal job transition ${from} -> ${to}${jobId ? ` (job ${jobId})` : ''}. ` +
        `Legal targets from ${from}: ${LEGAL_TRANSITIONS[from].join(', ') || '(terminal)'}`,
    );
    this.name = 'IllegalTransitionError';
  }
}

export function assertTransition(from: JobStatus, to: JobStatus, jobId?: string): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to, jobId);
}

/** Whether a user may cancel a job in this state (ARCHITECTURE.md §6.2). */
export function canCancel(status: JobStatus): boolean {
  return canTransition(status, 'CANCELLED');
}

/**
 * Cancelling a RUNNING job is COOPERATIVE: the API sets `cancel_requested` and
 * the handler aborts at its next await point. Everything else cancels outright.
 */
export function cancellationIsCooperative(status: JobStatus): boolean {
  return status === 'RUNNING';
}
