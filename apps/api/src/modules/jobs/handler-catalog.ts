/**
 * The handler catalogue, as the API knows it.
 *
 * ⚠️ Deliberately a standalone declaration rather than an import from
 * apps/worker. The API and the workers are separate deployables that can be on
 * different versions; if the API imported the worker's registry it would be
 * asserting a runtime coupling that does not exist, and a monorepo import would
 * hide that from you.
 *
 * The catalogue drives two things: payload validation at submission time, and
 * `GET /handlers`, which populates the Create Job form.
 *
 * Keep in sync with apps/worker/src/handlers/. A worker rejects an unknown
 * handler non-retryably, so drift fails loudly rather than silently.
 */
export interface HandlerCatalogEntry {
  name: string;
  description: string;
  payloadSchema: Record<string, unknown>;
  examplePayload: Record<string, unknown>;
}

export const HANDLER_CATALOG: HandlerCatalogEntry[] = [
  {
    name: 'http_request',
    description:
      'Sends an HTTP request. Retries on 5xx, 408, 429 and network errors; 4xx is permanent.',
    payloadSchema: {
      type: 'object',
      required: ['url'],
      properties: {
        url: { type: 'string', format: 'uri' },
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
        headers: { type: 'object', additionalProperties: { type: 'string' } },
        body: {},
        max_response_bytes: { type: 'integer', minimum: 0, maximum: 65536 },
      },
      additionalProperties: false,
    },
    examplePayload: { url: 'https://httpbin.org/post', method: 'POST', body: { hello: 'world' } },
  },
  {
    name: 'send_email',
    description: 'Mock email delivery. Logs the message rather than sending it.',
    payloadSchema: {
      type: 'object',
      required: ['to', 'subject', 'body'],
      properties: {
        to: { type: 'string', format: 'email' },
        subject: { type: 'string', maxLength: 200 },
        body: { type: 'string', maxLength: 10000 },
        from: { type: 'string', format: 'email' },
      },
      additionalProperties: false,
    },
    examplePayload: {
      to: 'user@example.com',
      subject: 'Your report is ready',
      body: 'The report you requested has finished generating.',
    },
  },
  {
    name: 'simulate',
    description:
      'Sleeps for duration_ms, then optionally fails. Used to demonstrate retries, backoff and the DLQ.',
    payloadSchema: {
      type: 'object',
      properties: {
        duration_ms: { type: 'integer', minimum: 0, maximum: 600000 },
        fail_probability: { type: 'number', minimum: 0, maximum: 1 },
        permanent_failure_probability: { type: 'number', minimum: 0, maximum: 1 },
        ignore_abort: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    examplePayload: { duration_ms: 500, fail_probability: 0.1 },
  },
];
