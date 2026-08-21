import { defineHandler, NonRetryableError } from '@djs/core';

interface SimulatePayload {
  duration_ms?: number;
  /** 0-1. Throws a retryable error at this rate. */
  fail_probability?: number;
  /** 0-1. Throws a NON-retryable error — straight to the DLQ, no retries. */
  permanent_failure_probability?: number;
  /** Ignore the abort signal, to exercise the timeout path. */
  ignore_abort?: boolean;
}

/**
 * The demo weapon.
 *
 * Exists purely to make the system's behaviour visible: retries, backoff,
 * dead-lettering, throughput under load, and crash recovery. Set a failure
 * probability and watch the DLQ fill with exactly the share you asked for.
 *
 * Also the workhorse of the concurrency tests, where `duration_ms` controls how
 * long a slot stays occupied.
 */
export const simulateHandler = defineHandler<SimulatePayload, unknown>({
  name: 'simulate',
  description:
    'Sleeps for duration_ms, then optionally fails. Used to demonstrate retries, backoff and the DLQ.',
  payloadSchema: {
    type: 'object',
    properties: {
      duration_ms: { type: 'integer', minimum: 0, maximum: 600000, default: 100 },
      fail_probability: { type: 'number', minimum: 0, maximum: 1, default: 0 },
      permanent_failure_probability: { type: 'number', minimum: 0, maximum: 1, default: 0 },
      ignore_abort: { type: 'boolean', default: false },
    },
    additionalProperties: false,
  },
  examplePayload: { duration_ms: 500, fail_probability: 0.1 },

  async handle(payload, ctx) {
    const durationMs = payload.duration_ms ?? 100;
    const failP = payload.fail_probability ?? 0;
    const permP = payload.permanent_failure_probability ?? 0;

    ctx.log.info('simulate: starting', { durationMs, attempt: ctx.attempt });

    await sleep(durationMs, payload.ignore_abort ? undefined : ctx.signal);

    if (Math.random() < permP) {
      ctx.log.error('simulate: permanent failure — this will not be retried');
      throw new NonRetryableError('Simulated permanent failure (payload is unprocessable)');
    }

    if (Math.random() < failP) {
      ctx.log.warn('simulate: transient failure', { attempt: ctx.attempt });
      throw new Error(`Simulated transient failure on attempt ${ctx.attempt}`);
    }

    ctx.log.info('simulate: completed');
    return { simulated: true, durationMs, attempt: ctx.attempt };
  },
});

/** Abortable sleep. Rejects with an AbortError so the timeout path is exercised. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    function onAbort(): void {
      clearTimeout(timer);
      reject(abortError(signal!));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function abortError(signal: AbortSignal): Error {
  const err = new Error(String(signal.reason ?? 'aborted'));
  err.name = 'AbortError';
  return err;
}
