import { defineHandler, NonRetryableError } from '@djs/core';

interface SendEmailPayload {
  to: string;
  subject: string;
  body: string;
  from?: string;
}

/**
 * A mock. It logs instead of sending.
 *
 * Deliberately not wired to a real provider: the brief says handlers may be
 * simulated, and an SMTP integration would be credentials and flakiness for
 * zero marks (ARCHITECTURE.md §28.1). It exists to make the demo legible — a
 * queue called `email-notifications` reads better than one called `queue-2`.
 */
export const sendEmailHandler = defineHandler<SendEmailPayload, unknown>({
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

  async handle(payload, ctx) {
    // A malformed address will never become valid on a retry, so this fails
    // permanently rather than burning four more attempts to learn the same thing.
    if (!payload.to.includes('@')) {
      throw new NonRetryableError(`"${payload.to}" is not a valid email address`);
    }

    // The recipient is logged; the body is NOT. Message bodies are user data of
    // unknown sensitivity, and a log aggregator is the last place they belong
    // (ARCHITECTURE.md §20.3).
    ctx.log.info('send_email: delivering', {
      to: payload.to,
      subject: payload.subject,
      bodyLength: payload.body.length,
    });

    await new Promise((r) => setTimeout(r, 50));

    ctx.log.info('send_email: delivered (mock)');
    return { delivered: true, to: payload.to, mock: true };
  },
});
