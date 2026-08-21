/**
 * @djs/core — the shared domain.
 *
 * Pure logic: no database, no HTTP, no framework. Imported by the API, the
 * worker, the scheduler AND the web app, which is the point — the state machine
 * is tested once and enforced everywhere, and the retry maths cannot drift
 * between what the worker computes and what the UI previews to the user.
 *
 * Nothing in this package may import from @djs/db, nestjs, or react.
 */

export * from './backoff.js';
export * from './job-state-machine.js';
export * from './error-classifier.js';
export * from './priority.js';
export * from './cron.js';
export * from './handler-contract.js';
export * from './constants.js';
