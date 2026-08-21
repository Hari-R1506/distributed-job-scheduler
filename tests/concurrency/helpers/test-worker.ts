import { Worker } from '../../../apps/worker/src/worker.js';
import { createDefaultRegistry } from '../../../apps/worker/src/handlers/registry.js';
import type { WorkerMetrics } from '../../../apps/worker/src/job-runner.js';
import { createPrismaClient, type PrismaClient } from '@djs/db';
import { waitFor, type Fixture } from '../../setup/fixtures.js';

/**
 * A real Worker, with its own Prisma client and connection pool.
 *
 * Deliberately NOT a mock and not a shared client: the point of these tests is
 * that independent processes contend for rows through the database. Sharing one
 * client would let them cooperate through in-process state and quietly hide the
 * very race being tested.
 */
export class TestWorker {
  private constructor(
    readonly worker: Worker,
    private readonly prisma: PrismaClient,
  ) {}

  static async start(
    f: Fixture,
    opts: { name: string; concurrency: number; queues?: string[] | '*'; heartbeatMs?: number },
  ): Promise<TestWorker> {
    const prisma = createPrismaClient(process.env['DATABASE_URL']!, {
      connectionLimit: opts.concurrency + 4,
    });

    const worker = new Worker({
      prisma,
      registry: createDefaultRegistry(),
      orgId: f.orgId,
      name: opts.name,
      concurrency: opts.concurrency,
      queues: opts.queues ?? '*',
      pollMinMs: 10,
      pollMaxMs: 100,
      heartbeatMs: opts.heartbeatMs ?? 5_000,
      shutdownGraceMs: 10_000,
    });

    await worker.start();
    return new TestWorker(worker, prisma);
  }

  get id(): string {
    return this.worker.id;
  }

  get metrics(): WorkerMetrics {
    return this.worker.metrics;
  }

  get activeCount(): number {
    return this.worker.activeCount;
  }

  async stop(): Promise<void> {
    await this.worker.shutdown().catch(() => {});
    await this.prisma.$disconnect().catch(() => {});
  }

  /** SIGKILL equivalent: no drain, no lease release, no final heartbeat. */
  async kill(): Promise<void> {
    await this.worker.simulateCrash();
    await this.prisma.$disconnect().catch(() => {});
  }

  /** Wait until the queue holds no claimable or in-flight work. */
  static async drainAll(
    workers: TestWorker[],
    f: Fixture,
    queueId: string,
    timeoutMs = 60_000,
  ): Promise<void> {
    const settled = await waitFor(async () => {
      const outstanding = await f.prisma.job.count({
        where: {
          queueId,
          status: { in: ['QUEUED', 'SCHEDULED', 'CLAIMED', 'RUNNING', 'RETRYING'] },
        },
      });
      return outstanding === 0 && workers.every((w) => w.activeCount === 0);
    }, timeoutMs);

    if (!settled) {
      const remaining = await f.prisma.job.groupBy({
        by: ['status'],
        where: { queueId },
        _count: true,
      });
      throw new Error(`Queue did not drain within ${timeoutMs}ms. Remaining: ${JSON.stringify(remaining)}`);
    }
  }
}
