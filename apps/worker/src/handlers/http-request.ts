import { defineHandler, HttpResponseError } from '@djs/core';

interface HttpRequestPayload {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  body?: unknown;
  /** Response bytes to keep in the execution result. */
  max_response_bytes?: number;
}

const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024;

/**
 * The genuinely useful handler — it makes this a real webhook scheduler rather
 * than a demo.
 *
 * It is also where the idempotency story becomes concrete. Exactly-once
 * execution across a crash boundary is impossible (ARCHITECTURE.md §16), so we
 * guarantee at-least-once and PUSH IDEMPOTENCY TO THE BOUNDARY: every request
 * carries a stable `Idempotency-Key` derived from the job id, so a well-behaved
 * downstream deduplicates a repeated delivery for us.
 */
export const httpRequestHandler = defineHandler<HttpRequestPayload, unknown>({
  name: 'http_request',
  description:
    'Sends an HTTP request. Retries on 5xx, 408, 429 and network errors; 4xx is permanent.',
  payloadSchema: {
    type: 'object',
    required: ['url'],
    properties: {
      url: { type: 'string', format: 'uri' },
      method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], default: 'POST' },
      headers: { type: 'object', additionalProperties: { type: 'string' } },
      body: {},
      max_response_bytes: { type: 'integer', minimum: 0, maximum: 65536 },
    },
    additionalProperties: false,
  },
  examplePayload: {
    url: 'https://httpbin.org/post',
    method: 'POST',
    body: { hello: 'world' },
  },

  async handle(payload, ctx) {
    const method = payload.method ?? 'POST';
    const hasBody = method !== 'GET' && payload.body !== undefined;

    ctx.log.info('http_request: sending', { method, url: payload.url, attempt: ctx.attempt });

    const response = await fetch(payload.url, {
      method,
      headers: {
        ...(hasBody ? { 'content-type': 'application/json' } : {}),
        // Stable across every attempt of this job — that is the whole point.
        'idempotency-key': ctx.idempotencyToken,
        'x-djs-job-id': ctx.jobId,
        'x-djs-attempt': String(ctx.attempt),
        ...payload.headers,
      },
      ...(hasBody ? { body: JSON.stringify(payload.body) } : {}),
      // The executor's timeout and any cancellation both arrive through here.
      signal: ctx.signal,
    });

    const text = await readCapped(response, payload.max_response_bytes ?? DEFAULT_MAX_RESPONSE_BYTES);

    if (!response.ok) {
      ctx.log.warn('http_request: non-2xx response', {
        status: response.status,
        bodyPreview: text.slice(0, 200),
      });
      throw new HttpResponseError(
        response.status,
        `${method} ${payload.url} returned ${response.status} ${response.statusText}`,
        parseRetryAfter(response.headers.get('retry-after')),
      );
    }

    ctx.log.info('http_request: succeeded', { status: response.status });
    return { status: response.status, body: tryParseJson(text) };
  },
});

/**
 * Reads at most `maxBytes`, then abandons the rest.
 *
 * Without a cap, one endpoint returning a 500 MB response would be buffered
 * into memory and then written into `job_executions.result`. The database is
 * not a blob store, and the worker is not a proxy.
 */
async function readCapped(response: Response, maxBytes: number): Promise<string> {
  if (maxBytes === 0 || !response.body) return '';

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      total += value.byteLength;
      if (total >= maxBytes) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }

  return Buffer.concat(chunks).subarray(0, maxBytes).toString('utf8');
}

/** `Retry-After` is either delay-seconds or an HTTP date. Both are used as a backoff floor. */
function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;

  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;

  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());

  return undefined;
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
