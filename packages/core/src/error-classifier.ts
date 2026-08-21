/**
 * Stable, machine-readable failure codes. Stored on `job_executions.error_code`
 * and `jobs.last_error_code`, and used to group the DLQ inbox.
 */
export type ErrorCode =
  // ── retryable ──
  | 'TIMEOUT'
  | 'HTTP_5XX'
  | 'RATE_LIMITED'
  | 'CONNECTION_REFUSED'
  | 'CONNECTION_RESET'
  | 'DNS_FAILURE'
  | 'NETWORK_TIMEOUT'
  | 'LEASE_EXPIRED'
  | 'UNKNOWN'
  // ── non-retryable ──
  | 'HTTP_4XX'
  | 'VALIDATION_ERROR'
  | 'UNKNOWN_HANDLER'
  | 'NON_RETRYABLE'
  | 'CANCELLED';

export interface Classification {
  code: ErrorCode;
  retryable: boolean;
  /** Minimum delay before the next attempt, e.g. from an HTTP `Retry-After`. */
  retryAfterMs?: number;
  message: string;
}

/**
 * Not every failure deserves five attempts. Retrying a `400 Bad Request` four
 * more times burns 75 seconds and four concurrency slots to reach a conclusion
 * that was available on attempt 1.
 */
const RETRYABLE: Readonly<Record<ErrorCode, boolean>> = {
  TIMEOUT: true,
  HTTP_5XX: true,
  RATE_LIMITED: true,
  CONNECTION_REFUSED: true,
  CONNECTION_RESET: true,
  DNS_FAILURE: true,
  NETWORK_TIMEOUT: true,
  LEASE_EXPIRED: true,
  // Unknown errors default to RETRYABLE — fail safe, not fail fast. A handler
  // throwing something we do not recognise is more likely a transient bug than
  // a permanent one, and the max-attempts cap bounds the cost of being wrong.
  UNKNOWN: true,

  HTTP_4XX: false,
  VALIDATION_ERROR: false,
  UNKNOWN_HANDLER: false,
  NON_RETRYABLE: false,
  CANCELLED: false,
};

/** Thrown by a handler that knows its failure is permanent. */
export class NonRetryableError extends Error {
  readonly code: ErrorCode = 'NON_RETRYABLE';
  constructor(message: string) {
    super(message);
    this.name = 'NonRetryableError';
  }
}

/** Thrown when a handler exceeds `jobs.timeout_ms`. */
export class JobTimeoutError extends Error {
  readonly code: ErrorCode = 'TIMEOUT';
  constructor(timeoutMs: number) {
    super(`Handler exceeded its ${timeoutMs}ms timeout and was aborted.`);
    this.name = 'JobTimeoutError';
  }
}

export class HttpResponseError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'HttpResponseError';
  }
}

function nodeErrorCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err
    ? String((err as { code: unknown }).code)
    : undefined;
}

export function classifyError(err: unknown): Classification {
  const message = err instanceof Error ? err.message : String(err);

  if (err instanceof NonRetryableError) {
    return { code: 'NON_RETRYABLE', retryable: false, message };
  }
  if (err instanceof JobTimeoutError) {
    return { code: 'TIMEOUT', retryable: true, message };
  }

  if (err instanceof HttpResponseError) {
    // 408 Request Timeout and 429 Too Many Requests are the two 4xx codes that
    // genuinely mean "try again" rather than "your request is wrong".
    if (err.status === 429) {
      const out: Classification = { code: 'RATE_LIMITED', retryable: true, message };
      if (err.retryAfterMs !== undefined) out.retryAfterMs = err.retryAfterMs;
      return out;
    }
    if (err.status === 408) return { code: 'TIMEOUT', retryable: true, message };
    if (err.status >= 500) return { code: 'HTTP_5XX', retryable: true, message };
    if (err.status >= 400) return { code: 'HTTP_4XX', retryable: false, message };
  }

  switch (nodeErrorCode(err)) {
    case 'ECONNREFUSED':
      return { code: 'CONNECTION_REFUSED', retryable: true, message };
    case 'ECONNRESET':
    case 'EPIPE':
      return { code: 'CONNECTION_RESET', retryable: true, message };
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return { code: 'DNS_FAILURE', retryable: true, message };
    case 'ETIMEDOUT':
    case 'UND_ERR_CONNECT_TIMEOUT':
    case 'UND_ERR_HEADERS_TIMEOUT':
      return { code: 'NETWORK_TIMEOUT', retryable: true, message };
  }

  if (err instanceof Error && err.name === 'AbortError') {
    return { code: 'TIMEOUT', retryable: true, message };
  }
  if (err instanceof Error && /validation|invalid|schema/i.test(err.message)) {
    return { code: 'VALIDATION_ERROR', retryable: false, message };
  }

  return { code: 'UNKNOWN', retryable: true, message };
}

export function isRetryable(code: ErrorCode): boolean {
  return RETRYABLE[code];
}

/**
 * Whether a job should be retried, given its classification, its position in
 * the retry contract, and any per-policy narrowing.
 */
export function shouldRetry(
  classification: Classification,
  attemptCount: number,
  maxAttempts: number,
  retryOnErrorCodes: readonly string[] = [],
): boolean {
  if (!classification.retryable) return false;
  if (attemptCount >= maxAttempts) return false;
  // An empty list means "retry anything the classifier considers retryable".
  if (retryOnErrorCodes.length > 0 && !retryOnErrorCodes.includes(classification.code)) return false;
  return true;
}

/**
 * A stable grouping key for the DLQ inbox. 400 failures are usually 3 problems;
 * grouping by signature is what turns a table dump into a triage list.
 *
 * Normalisation strips the parts that differ between otherwise-identical
 * failures — ids, timestamps, hostnames, quoted values — so they collapse into
 * one group.
 */
export function errorSignature(code: string, message: string | null | undefined): string {
  const normalised = (message ?? '')
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>')
    .replace(/\b\d{4}-\d{2}-\d{2}t?[\d:.]*z?\b/g, '<timestamp>')
    .replace(/\bhttps?:\/\/[^\s"']+/g, '<url>')
    // Deliberately NOT \b\d+\b: in "failed after 300ms" there is no word
    // boundary between the digits and the unit, so the bounded form leaves the
    // number in place and two identical failures land in different DLQ groups.
    .replace(/\d+/g, '<n>')
    .replace(/"[^"]*"|'[^']*'/g, '<str>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);

  return `${code}:${normalised}`;
}

export function truncateError(text: string | undefined, maxBytes: number): string | undefined {
  if (!text) return undefined;
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  return `${Buffer.from(text, 'utf8').subarray(0, maxBytes - 15).toString('utf8')}…[truncated]`;
}

/** Stored on job_executions.error_message. */
export const ERROR_MESSAGE_MAX_BYTES = 4 * 1024;
/** Stored on job_executions.error_stack. */
export const ERROR_STACK_MAX_BYTES = 16 * 1024;
