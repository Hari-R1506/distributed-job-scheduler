import { randomUUID } from 'node:crypto';
import { createPrismaClient, type PrismaClient } from '@djs/db';

export interface Fixture {
  prisma: PrismaClient;
  orgId: string;
  projectId: string;
  retryPolicyId: string;
}

/**
 * A fresh tenant per test file.
 *
 * Tests do NOT truncate shared tables — several suites run against one
 * container, and a truncate in one would silently gut another. Instead each
 * gets its own organization, and cleanup is a single cascading delete.
 */
export async function createFixture(opts: { connectionLimit?: number } = {}): Promise<Fixture> {
  const prisma = createPrismaClient(process.env['DATABASE_URL']!, {
    connectionLimit: opts.connectionLimit ?? 40,
  });

  const org = await prisma.organization.create({
    data: { name: 'Test Org', slug: `test-${randomUUID().slice(0, 8)}` },
  });

  const project = await prisma.project.create({
    data: { orgId: org.id, name: 'Test Project', slug: 'test' },
  });

  const policy = await prisma.retryPolicy.create({
    data: {
      projectId: project.id,
      name: 'standard',
      strategy: 'EXPONENTIAL',
      maxAttempts: 3,
      baseDelayMs: 50,
      maxDelayMs: 1_000,
      // Deterministic backoff. Jitter is verified exhaustively in the unit
      // suite; here it would only add flake to timing assertions.
      jitterPct: 0,
      isDefault: true,
    },
  });

  return { prisma, orgId: org.id, projectId: project.id, retryPolicyId: policy.id };
}

export async function destroyFixture(f: Fixture): Promise<void> {
  await f.prisma.organization.delete({ where: { id: f.orgId } }).catch(() => {});
  await f.prisma.$disconnect();
}

export interface QueueOptions {
  name?: string;
  maxConcurrency?: number | null;
  visibilityTimeoutMs?: number;
  isPaused?: boolean;
  dlqEnabled?: boolean;
  defaultJobTimeoutMs?: number;
}

export async function createQueue(f: Fixture, opts: QueueOptions = {}): Promise<string> {
  const queue = await f.prisma.queue.create({
    data: {
      projectId: f.projectId,
      name: opts.name ?? `queue-${randomUUID().slice(0, 8)}`,
      retryPolicyId: f.retryPolicyId,
      maxConcurrency: opts.maxConcurrency === undefined ? null : opts.maxConcurrency,
      // The schema enforces a 45s floor (it must exceed WORKER_TIMEOUT_MS),
      // which is correct in production and far too slow for a test suite.
      // Crash-recovery tests therefore expire leases by moving
      // lease_expires_at directly, never by waiting one out.
      visibilityTimeoutMs: opts.visibilityTimeoutMs ?? 60_000,
      isPaused: opts.isPaused ?? false,
      dlqEnabled: opts.dlqEnabled ?? true,
      defaultJobTimeoutMs: opts.defaultJobTimeoutMs ?? 10_000,
    },
    select: { id: true },
  });
  return queue.id;
}

export interface SeedJobOptions {
  count?: number;
  handler?: string;
  payload?: Record<string, unknown>;
  priority?: number | ((i: number) => number);
  runAt?: Date | ((i: number) => Date);
  status?: 'QUEUED' | 'SCHEDULED';
  maxAttempts?: number;
  timeoutMs?: number;
}

export async function seedJobs(
  f: Fixture,
  queueId: string,
  opts: SeedJobOptions = {},
): Promise<number> {
  const count = opts.count ?? 1;
  const priority = opts.priority ?? 100;

  // When the caller wants "ready now", OMIT run_at and let the column default
  // (`now()`) fill it in.
  //
  // Passing `new Date()` from here would stamp the HOST clock onto a row that
  // the claim query then compares against the DATABASE clock. Those differ by a
  // few milliseconds when Postgres runs in a container, so a job created
  // "immediately" can be briefly not-yet-due and claim zero rows. It surfaced
  // as a 1-in-10 flake, which is precisely what repeated runs are for.
  //
  // The same reasoning applies in production: the API must let the database
  // stamp `run_at` for immediate jobs rather than sending its own clock.
  const runAt = opts.runAt;

  const rows = Array.from({ length: count }, (_, i) => ({
    queueId,
    projectId: f.projectId,
    handler: opts.handler ?? 'simulate',
    payload: (opts.payload ?? { duration_ms: 1 }) as never,
    priority: typeof priority === 'function' ? priority(i) : priority,
    status: opts.status ?? ('QUEUED' as const),
    ...(runAt === undefined ? {} : { runAt: typeof runAt === 'function' ? runAt(i) : runAt }),
    maxAttempts: opts.maxAttempts ?? 3,
    backoffStrategy: 'EXPONENTIAL' as const,
    backoffBaseMs: 50,
    backoffMaxMs: 1_000,
    backoffJitterPct: 0,
    timeoutMs: opts.timeoutMs ?? 10_000,
  }));

  const res = await f.prisma.job.createMany({ data: rows });
  return res.count;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Poll until `predicate` holds or `timeoutMs` elapses. Returns whether it held. */
export async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 20_000,
  intervalMs = 25,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(intervalMs);
  }
  return false;
}
