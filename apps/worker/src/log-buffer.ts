import type { LogLevel } from '@djs/core';
import type { PrismaClient } from '@djs/db';

export interface BufferedLog {
  jobId: string;
  executionId: bigint;
  level: LogLevel;
  message: string;
  context: Record<string, unknown> | null;
  loggedAt: Date;
}

/**
 * Batches handler log lines and writes them outside the job's transactions.
 *
 * `job_logs` is the highest-volume table in the system. Inserting each line
 * inline would put an unbounded number of writes inside the completion
 * transaction — a chatty handler would lengthen the very transaction that must
 * stay at sub-millisecond (ARCHITECTURE.md §22.2).
 *
 * Accepted cost: up to `flushIntervalMs` of logs lost on SIGKILL. That is the
 * correct trade — logs are diagnostic, job state is authoritative, and job
 * state is never buffered.
 */
export class LogBuffer {
  private buffer: BufferedLog[] = [];
  private timer?: NodeJS.Timeout;
  private flushing = false;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly opts: {
      flushIntervalMs: number;
      maxBuffered: number;
      /** Hard ceiling, so a runaway handler cannot exhaust memory. */
      maxQueued?: number;
      onError?: (err: unknown) => void;
    },
  ) {}

  start(): void {
    this.timer ??= setInterval(() => void this.flush(), this.opts.flushIntervalMs);
    this.timer.unref?.();
  }

  push(entry: BufferedLog): void {
    const ceiling = this.opts.maxQueued ?? 10_000;
    if (this.buffer.length >= ceiling) {
      // Drop rather than grow without bound. Losing debug lines beats an OOM
      // that takes every in-flight job down with it.
      this.buffer.shift();
    }
    this.buffer.push(entry);
    if (this.buffer.length >= this.opts.maxBuffered) void this.flush();
  }

  get pending(): number {
    return this.buffer.length;
  }

  async flush(): Promise<void> {
    if (this.flushing || this.buffer.length === 0) return;

    this.flushing = true;
    const batch = this.buffer;
    this.buffer = [];

    try {
      await this.prisma.jobLog.createMany({
        data: batch.map((e) => ({
          jobId: e.jobId,
          executionId: e.executionId,
          level: e.level,
          message: e.message.slice(0, 8192),
          context: (e.context ?? undefined) as never,
          loggedAt: e.loggedAt,
        })),
      });
    } catch (err) {
      // Logs are best-effort. A failed flush must never fail a job, and must
      // never be retried into an unbounded backlog.
      this.opts.onError?.(err);
    } finally {
      this.flushing = false;
    }
  }

  /** Graceful stop: cancel the timer, then write whatever is still buffered. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.flush();
  }

  /**
   * Crash stop: cancel the timer and DISCARD the buffer without writing.
   *
   * Used only to simulate SIGKILL, where buffered lines are genuinely lost.
   * Flushing here would make the simulation dishonest — and, since the client
   * is about to be disconnected, would fail anyway.
   */
  abandon(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.buffer = [];
  }
}
