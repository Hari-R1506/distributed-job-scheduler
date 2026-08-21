/**
 * A fixed-size slot pool.
 *
 * Decouples the claim loop from execution: the claim loop asks how many slots
 * are free and never waits on a running handler, and a handler never holds a
 * database transaction. That separation is what keeps claim transactions at
 * 1-3ms regardless of how long jobs take.
 */
export class ExecutorPool {
  private readonly running = new Map<string, AbortController>();
  private slotWaiters: (() => void)[] = [];
  private drainWaiters: (() => void)[] = [];

  constructor(readonly concurrency: number) {
    if (concurrency < 1) throw new RangeError('concurrency must be >= 1');
  }

  get activeCount(): number {
    return this.running.size;
  }

  freeSlots(): number {
    return Math.max(0, this.concurrency - this.running.size);
  }

  isSaturated(): boolean {
    return this.freeSlots() === 0;
  }

  runningJobIds(): string[] {
    return [...this.running.keys()];
  }

  /**
   * Occupy a slot and run `task`. The slot is released when `task` settles,
   * whether it resolved or threw — a leaked slot would permanently shrink this
   * worker's capacity, and the leak is invisible until the worker goes idle
   * while jobs pile up.
   */
  dispatch(jobId: string, task: (signal: AbortSignal) => Promise<void>): void {
    if (this.isSaturated()) {
      throw new Error(`ExecutorPool: dispatch with no free slot (${this.concurrency} in use)`);
    }
    if (this.running.has(jobId)) {
      throw new Error(`ExecutorPool: job ${jobId} is already running on this worker`);
    }

    const ac = new AbortController();
    this.running.set(jobId, ac);

    void task(ac.signal)
      .catch(() => {
        // The task owns its own error handling and persistence. Anything
        // reaching here has already been recorded; swallowing it keeps one bad
        // handler from taking down the process via an unhandled rejection.
      })
      .finally(() => {
        this.running.delete(jobId);
        this.wakeSlotWaiters();
        if (this.running.size === 0) this.wakeDrainWaiters();
      });
  }

  /**
   * Resolves when a slot frees.
   *
   * A saturated worker awaits this instead of polling, so it issues ZERO claim
   * queries while it has no capacity. Ten busy workers hammering the database
   * with claims they cannot use is a real and common failure.
   */
  onSlotFree(): Promise<void> {
    if (!this.isSaturated()) return Promise.resolve();
    return new Promise((resolve) => this.slotWaiters.push(resolve));
  }

  /** Signal cancellation to one running job. Cooperative — the handler must honour it. */
  abort(jobId: string, reason?: string): boolean {
    const ac = this.running.get(jobId);
    if (!ac) return false;
    ac.abort(reason ?? 'CANCELLED');
    return true;
  }

  abortAll(reason: string): void {
    for (const ac of this.running.values()) ac.abort(reason);
  }

  /**
   * Resolves when every in-flight job has settled, or after `timeoutMs`.
   * Returns the ids still running — the caller releases their leases explicitly
   * so another worker picks them up immediately rather than waiting out the
   * full visibility timeout.
   */
  async drain(timeoutMs: number): Promise<string[]> {
    if (this.running.size === 0) return [];

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });
    const empty = new Promise<void>((resolve) => this.drainWaiters.push(resolve));

    await Promise.race([empty, timeout]);
    if (timer) clearTimeout(timer);

    return this.runningJobIds();
  }

  private wakeSlotWaiters(): void {
    const waiters = this.slotWaiters;
    this.slotWaiters = [];
    for (const w of waiters) w();
  }

  private wakeDrainWaiters(): void {
    const waiters = this.drainWaiters;
    this.drainWaiters = [];
    for (const w of waiters) w();
  }
}
