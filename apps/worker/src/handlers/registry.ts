import type { RegisteredHandler } from '@djs/core';
import { httpRequestHandler } from './http-request.js';
import { sendEmailHandler } from './send-email.js';
import { simulateHandler } from './simulate.js';

/**
 * The handler registry.
 *
 * `jobs.handler` is `text`, not an enum, precisely so that adding a handler is
 * a worker deployment rather than a database migration. The API validates
 * submissions against this list, so an unknown handler is rejected at
 * submission with 422 instead of failing repeatedly on a worker.
 */
export class HandlerRegistry {
  private readonly handlers = new Map<string, RegisteredHandler>();

  constructor(defs: RegisteredHandler[] = []) {
    for (const def of defs) this.register(def);
  }

  register(def: RegisteredHandler): void {
    if (this.handlers.has(def.name)) {
      throw new Error(`Handler "${def.name}" is already registered`);
    }
    this.handlers.set(def.name, def);
  }

  get(name: string): RegisteredHandler | undefined {
    return this.handlers.get(name);
  }

  has(name: string): boolean {
    return this.handlers.has(name);
  }

  names(): string[] {
    return [...this.handlers.keys()].sort();
  }

  /** Serialised for `GET /handlers`, which drives the Create Job form. */
  describe(): Array<Omit<RegisteredHandler, 'handle'>> {
    return [...this.handlers.values()].map(({ handle: _handle, ...rest }) => rest);
  }
}

export function createDefaultRegistry(): HandlerRegistry {
  return new HandlerRegistry([httpRequestHandler, sendEmailHandler, simulateHandler]);
}
