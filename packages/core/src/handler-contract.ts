/**
 * The contract between the worker and a job handler.
 *
 * The brief never says what jobs actually DO, so this is an explicit design
 * decision: handlers are named functions in a registry, resolved at execution
 * time. `jobs.handler` is `text` rather than an enum precisely so adding one is
 * a worker deployment, not a migration.
 */

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

export interface JobLogger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

export interface HandlerContext {
  jobId: string;
  /** 1-based. Handlers may branch on it, e.g. to widen a downstream timeout. */
  attempt: number;
  maxAttempts: number;
  queueName: string;

  /**
   * Stable across every attempt of this job (it IS the job id).
   *
   * Exactly-once execution is impossible across a crash boundary: the worker
   * cannot atomically "perform the side effect" and "record that it did", since
   * those live in two systems with no shared transaction. We therefore
   * guarantee AT-LEAST-ONCE and push idempotency to the boundary — this token
   * is the tool handlers use to do that. The built-in http_request handler
   * sends it downstream as an `Idempotency-Key` header.
   * See ARCHITECTURE.md §16.
   */
  idempotencyToken: string;

  /**
   * Aborted when the job exceeds `timeout_ms` or a cancellation is requested.
   * Handlers MUST honour it — pass it to fetch, check it between await points.
   * A handler that ignores it keeps running until the process exits.
   */
  signal: AbortSignal;

  /** Buffered and batch-inserted into job_logs outside the job's transactions. */
  log: JobLogger;
}

export type JobHandler<TPayload = unknown, TResult = unknown> = (
  payload: TPayload,
  ctx: HandlerContext,
) => Promise<TResult>;

export interface HandlerDefinition<TPayload = unknown, TResult = unknown> {
  name: string;
  /** Shown in the Create Job form's handler dropdown. */
  description: string;
  /** JSON Schema. The API validates payloads against it at SUBMISSION time, so
   *  a malformed job is rejected with 422 rather than failing on a worker. */
  payloadSchema: Record<string, unknown>;
  /** Pre-filled in the UI when this handler is selected. */
  examplePayload: Record<string, unknown>;
  handle: JobHandler<TPayload, TResult>;
}

/**
 * A type-erased handler, as the registry stores it.
 *
 * Handlers are authored with a concrete payload type because that is what makes
 * them pleasant to write and read. But `HandlerDefinition<SendEmailPayload>` is
 * not assignable to `HandlerDefinition<unknown>` — `handle` is contravariant in
 * its payload — so a heterogeneous registry needs an explicit erasure point.
 *
 * Erasing here is honest rather than a workaround: at runtime the payload IS
 * `unknown`. It arrives as `jsonb` from the database, and the real guarantee
 * comes from validating it against `payloadSchema` at submission time, not from
 * a compile-time type the worker cannot verify.
 */
export type RegisteredHandler = Omit<HandlerDefinition<never, unknown>, 'handle'> & {
  handle: (payload: never, ctx: HandlerContext) => Promise<unknown>;
};

/** Author a handler with a concrete payload type, store it type-erased. */
export function defineHandler<TPayload, TResult>(
  def: HandlerDefinition<TPayload, TResult>,
): RegisteredHandler {
  return def as unknown as RegisteredHandler;
}

/** Built-in handler names. Deliberately small — see ARCHITECTURE.md §28.1. */
export const BUILTIN_HANDLERS = {
  /** POST/GET an arbitrary URL. The genuinely useful one — makes this a real
   *  webhook scheduler rather than a demo. */
  HTTP_REQUEST: 'http_request',
  /** Mock. Logs instead of sending. */
  SEND_EMAIL: 'send_email',
  /** {duration_ms, fail_probability, permanent_failure_probability}.
   *  Exists purely to demonstrate retries, the DLQ and throughput under load. */
  SIMULATE: 'simulate',
} as const;

export type BuiltinHandlerName = (typeof BUILTIN_HANDLERS)[keyof typeof BUILTIN_HANDLERS];
