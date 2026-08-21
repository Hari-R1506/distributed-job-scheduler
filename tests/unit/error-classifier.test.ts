import { describe, it, expect } from 'vitest';
import {
  classifyError,
  shouldRetry,
  errorSignature,
  truncateError,
  NonRetryableError,
  JobTimeoutError,
  HttpResponseError,
  ERROR_MESSAGE_MAX_BYTES,
} from '@djs/core';

function nodeError(code: string): Error {
  return Object.assign(new Error(`socket ${code}`), { code });
}

describe('classifyError', () => {
  describe('retryable — transient conditions worth another attempt', () => {
    it.each([
      [500, 'HTTP_5XX'],
      [502, 'HTTP_5XX'],
      [503, 'HTTP_5XX'],
      [504, 'HTTP_5XX'],
    ])('treats HTTP %i as %s', (status, code) => {
      const c = classifyError(new HttpResponseError(status, 'upstream failed'));
      expect(c.code).toBe(code);
      expect(c.retryable).toBe(true);
    });

    it.each([
      ['ECONNREFUSED', 'CONNECTION_REFUSED'],
      ['ECONNRESET', 'CONNECTION_RESET'],
      ['EPIPE', 'CONNECTION_RESET'],
      ['ENOTFOUND', 'DNS_FAILURE'],
      ['EAI_AGAIN', 'DNS_FAILURE'],
      ['ETIMEDOUT', 'NETWORK_TIMEOUT'],
    ])('treats %s as %s', (nodeCode, expected) => {
      const c = classifyError(nodeError(nodeCode));
      expect(c.code).toBe(expected);
      expect(c.retryable).toBe(true);
    });

    it('treats a job timeout as retryable', () => {
      const c = classifyError(new JobTimeoutError(30_000));
      expect(c.code).toBe('TIMEOUT');
      expect(c.retryable).toBe(true);
      expect(c.message).toContain('30000ms');
    });

    it('treats 408 Request Timeout as a timeout, not a client error', () => {
      const c = classifyError(new HttpResponseError(408, 'request timeout'));
      expect(c.code).toBe('TIMEOUT');
      expect(c.retryable).toBe(true);
    });
  });

  describe('429 Too Many Requests', () => {
    it('is retryable', () => {
      const c = classifyError(new HttpResponseError(429, 'slow down'));
      expect(c.code).toBe('RATE_LIMITED');
      expect(c.retryable).toBe(true);
    });

    it('surfaces Retry-After as a floor on the backoff', () => {
      // Honouring the server's own hint is the difference between backing off
      // politely and being rate-limited again on the next attempt.
      const c = classifyError(new HttpResponseError(429, 'slow down', 12_000));
      expect(c.retryAfterMs).toBe(12_000);
    });
  });

  describe('non-retryable — a permanent condition', () => {
    it.each([400, 401, 403, 404, 409, 422])('treats HTTP %i as permanent', (status) => {
      // Retrying a 400 four more times burns 75 seconds and four concurrency
      // slots to reach a conclusion available on attempt 1 (§11.5).
      const c = classifyError(new HttpResponseError(status, 'bad request'));
      expect(c.code).toBe('HTTP_4XX');
      expect(c.retryable).toBe(false);
    });

    it('honours a handler declaring its own failure permanent', () => {
      const c = classifyError(new NonRetryableError('payload references a deleted account'));
      expect(c.code).toBe('NON_RETRYABLE');
      expect(c.retryable).toBe(false);
    });

    it('treats validation failures as permanent', () => {
      const c = classifyError(new Error('payload failed schema validation'));
      expect(c.code).toBe('VALIDATION_ERROR');
      expect(c.retryable).toBe(false);
    });
  });

  describe('the unknown-error default', () => {
    it('fails SAFE, not fast — unrecognised errors are retryable', () => {
      // A handler throwing something we do not recognise is more likely a
      // transient bug than a permanent one, and max_attempts bounds the cost of
      // being wrong. Defaulting the other way silently dead-letters recoverable
      // work.
      const c = classifyError(new Error('kaboom'));
      expect(c.code).toBe('UNKNOWN');
      expect(c.retryable).toBe(true);
    });

    it('copes with non-Error throwables', () => {
      expect(classifyError('a string').code).toBe('UNKNOWN');
      expect(classifyError(null).message).toBe('null');
      expect(classifyError(42).message).toBe('42');
    });
  });
});

describe('shouldRetry', () => {
  const transient = { code: 'HTTP_5XX' as const, retryable: true, message: 'x' };
  const permanent = { code: 'HTTP_4XX' as const, retryable: false, message: 'x' };

  it('retries while attempts remain', () => {
    expect(shouldRetry(transient, 1, 5)).toBe(true);
    expect(shouldRetry(transient, 4, 5)).toBe(true);
  });

  it('stops once attempts are exhausted', () => {
    expect(shouldRetry(transient, 5, 5)).toBe(false);
    expect(shouldRetry(transient, 6, 5)).toBe(false);
  });

  it('never retries a permanent failure, however many attempts remain', () => {
    expect(shouldRetry(permanent, 1, 5)).toBe(false);
  });

  describe('per-policy narrowing', () => {
    it('retries anything retryable when the list is empty', () => {
      expect(shouldRetry(transient, 1, 5, [])).toBe(true);
    });

    it('retries only the listed codes when the list is non-empty', () => {
      expect(shouldRetry(transient, 1, 5, ['HTTP_5XX'])).toBe(true);
      expect(shouldRetry(transient, 1, 5, ['TIMEOUT'])).toBe(false);
    });
  });
});

describe('errorSignature', () => {
  it('collapses failures that differ only in ids and numbers', () => {
    // 400 DLQ entries are usually 3 problems. Grouping by signature is what
    // turns a table dump into a triage list (§12.4).
    const a = errorSignature('HTTP_5XX', 'Request to order 4711 failed after 300ms');
    const b = errorSignature('HTTP_5XX', 'Request to order 9002 failed after 812ms');
    expect(a).toBe(b);
  });

  it('collapses uuids, timestamps and urls', () => {
    const a = errorSignature('X', 'job 550e8400-e29b-41d4-a716-446655440000 at 2026-08-20T10:00:00Z');
    const b = errorSignature('X', 'job 6ba7b810-9dad-11d1-80b4-00c04fd430c8 at 2026-08-19T22:31:07Z');
    expect(a).toBe(b);
    expect(a).toContain('<uuid>');
    expect(a).toContain('<timestamp>');

    expect(errorSignature('X', 'GET https://a.test/v1/x failed')).toBe(
      errorSignature('X', 'GET https://b.test/v2/y failed'),
    );
  });

  it('keeps genuinely different failures apart', () => {
    expect(errorSignature('HTTP_5XX', 'connection refused')).not.toBe(
      errorSignature('HTTP_5XX', 'gateway timeout'),
    );
  });

  it('separates identical messages carrying different codes', () => {
    expect(errorSignature('TIMEOUT', 'failed')).not.toBe(errorSignature('HTTP_4XX', 'failed'));
  });

  it('tolerates a missing message', () => {
    expect(errorSignature('TIMEOUT', null)).toBe('TIMEOUT:');
    expect(errorSignature('TIMEOUT', undefined)).toBe('TIMEOUT:');
  });
});

describe('truncateError', () => {
  it('leaves short text alone', () => {
    expect(truncateError('boom', 4096)).toBe('boom');
  });

  it('truncates past the limit and says so', () => {
    // A handler that throws an error containing the whole request body would
    // otherwise exfiltrate the payload into job_executions (§20.3).
    const out = truncateError('x'.repeat(10_000), ERROR_MESSAGE_MAX_BYTES)!;
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(ERROR_MESSAGE_MAX_BYTES);
    expect(out).toContain('[truncated]');
  });

  it('returns undefined for empty input', () => {
    expect(truncateError(undefined, 100)).toBeUndefined();
    expect(truncateError('', 100)).toBeUndefined();
  });
});
