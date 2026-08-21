import { randomBytes, createHash } from 'node:crypto';
import { createPrismaClient, type PrismaClient } from '@djs/db';
import { nextFireTime } from '@djs/core';

/**
 * Demo data.
 *
 * The goal is that an evaluator running `make up && make seed` sees a system
 * that is obviously alive within 60 seconds: four queues with different
 * personalities, two cron schedules, and enough history for the dashboard to
 * have something to draw.
 *
 * Idempotent — re-running updates rather than duplicating.
 */
const DEMO_EMAIL = 'demo@codity.ai';
const DEMO_PASSWORD = 'demo-password-change-me';

async function main(): Promise<void> {
  const prisma = createPrismaClient(process.env['DATABASE_URL']!, { connectionLimit: 5 });

  try {
    // Attach to whoever already signed up, rather than always creating a
    // separate 'demo' org.
    //
    // Without this the first-run experience is broken in a way that looks like
    // a bug: you start the stack, seed it, register in the UI — and land on an
    // empty dashboard, because your brand-new account owns a brand-new org and
    // the demo queues live somewhere else. Tenant isolation working exactly as
    // designed, and completely baffling to a first-time user.
    // Prefer an org owned by a REAL account over the seeded placeholder.
    // Ordering by createdAt alone picks whichever ran first, which after a
    // previous seed is the placeholder — putting the demo data right back in
    // the org the human cannot log into.
    const existingMember =
      (await prisma.membership.findFirst({
        where: { user: { passwordHash: { not: { startsWith: 'seed$' } } } },
        orderBy: { createdAt: 'asc' },
        include: { org: true },
      })) ??
      (await prisma.membership.findFirst({
        orderBy: { createdAt: 'asc' },
        include: { org: true },
      }));

    const org = existingMember
      ? existingMember.org
      : await prisma.organization.upsert({
          where: { slug: 'demo' },
          update: {},
          create: { name: 'Codity Demo', slug: 'demo' },
        });

    if (existingMember) {
      console.log(`  Seeding into your existing organization: ${org.name}`);
    }

    // argon2id is used by the API; the seed avoids the native dependency by
    // writing a marker the API recognises and rejects for login until the user
    // sets a real password. Seeded credentials that actually work are how demo
    // databases end up in production.
    // Only mint the placeholder demo user when nobody has registered. It exists
    // to own the seeded rows, and its password hash is a deliberately unusable
    // marker — see verifyPassword() in the API.
    const user = existingMember
      ? await prisma.user.findUniqueOrThrow({ where: { id: existingMember.userId } })
      : await prisma.user.upsert({
          where: { email: DEMO_EMAIL },
          update: {},
          create: {
            email: DEMO_EMAIL,
            name: 'Demo User',
            passwordHash: `seed$${createHash('sha256').update(DEMO_PASSWORD).digest('hex')}`,
          },
        });

    await prisma.membership.upsert({
      where: { orgId_userId: { orgId: org.id, userId: user.id } },
      update: {},
      create: { orgId: org.id, userId: user.id, role: 'OWNER' },
    });

    const project = await prisma.project.upsert({
      where: { orgId_slug: { orgId: org.id, slug: 'default' } },
      update: {},
      create: {
        orgId: org.id,
        name: 'Default Project',
        slug: 'default',
        description: 'Demo project created by the seed script.',
        createdById: user.id,
      },
    });

    // ── Retry policies: one per backoff strategy, so the dashboard shows all
    //    three side by side rather than only the default. ──
    const policies = await upsertPolicies(prisma, project.id);

    // ── Queues, each with a distinct personality ──
    const queues = [
      {
        name: 'email-notifications',
        description: 'Outbound email. Tight concurrency to respect a provider rate limit.',
        maxConcurrency: 3,
        policy: policies.exponential,
        defaultPriority: 100,
      },
      {
        name: 'webhooks',
        description: 'Outbound HTTP callbacks. Wider concurrency, aggressive retries.',
        maxConcurrency: 20,
        policy: policies.exponential,
        defaultPriority: 150,
      },
      {
        name: 'report-generation',
        description: 'Long-running reports. Low concurrency, generous timeout.',
        maxConcurrency: 2,
        policy: policies.linear,
        defaultPriority: 50,
      },
      {
        name: 'bulk-import',
        description: 'High-volume background work. Unlimited concurrency, fixed backoff.',
        maxConcurrency: null,
        policy: policies.fixed,
        defaultPriority: 10,
      },
    ];

    const created: Record<string, string> = {};
    for (const q of queues) {
      const row = await prisma.queue.upsert({
        where: { projectId_name: { projectId: project.id, name: q.name } },
        update: { description: q.description },
        create: {
          projectId: project.id,
          name: q.name,
          description: q.description,
          maxConcurrency: q.maxConcurrency,
          retryPolicyId: q.policy,
          defaultPriority: q.defaultPriority,
          defaultJobTimeoutMs: q.name === 'report-generation' ? 120_000 : 30_000,
          visibilityTimeoutMs: q.name === 'report-generation' ? 300_000 : 60_000,
        },
        select: { id: true },
      });
      created[q.name] = row.id;
    }

    // ── Cron schedules ──
    const now = new Date();
    const schedules = [
      {
        name: 'hourly-metrics-refresh',
        queue: 'bulk-import',
        cron: '0 * * * *',
        timezone: 'UTC',
        payload: { duration_ms: 2000 },
      },
      {
        name: 'daily-digest-email',
        queue: 'email-notifications',
        cron: '0 9 * * *',
        // A non-UTC zone, so the DST handling is visible in the UI rather than
        // only in the tests.
        timezone: 'Asia/Kolkata',
        payload: { duration_ms: 500 },
      },
    ];

    for (const s of schedules) {
      await prisma.scheduledJob.upsert({
        where: { projectId_name: { projectId: project.id, name: s.name } },
        update: { cronExpression: s.cron, timezone: s.timezone },
        create: {
          projectId: project.id,
          queueId: created[s.queue]!,
          name: s.name,
          cronExpression: s.cron,
          timezone: s.timezone,
          handler: 'simulate',
          payload: s.payload,
          createdById: user.id,
          nextRunAt: nextFireTime({ expression: s.cron, timezone: s.timezone }, now),
        },
      });
    }

    // ── An API key, so the load generator has a legitimate way to authenticate ──
    const plaintext = `sk_demo_${randomBytes(24).toString('hex')}`;
    const existingKey = await prisma.apiKey.findFirst({
      where: { projectId: project.id, name: 'seed-key', revokedAt: null },
    });
    if (!existingKey) {
      await prisma.apiKey.create({
        data: {
          projectId: project.id,
          name: 'seed-key',
          keyPrefix: plaintext.slice(0, 12),
          keyHash: createHash('sha256').update(plaintext).digest('hex'),
          scopes: ['jobs:read', 'jobs:write'],
          createdById: user.id,
        },
      });
    }

    // ── A handful of jobs so the dashboard is not empty on first load ──
    const seeded = await seedSampleJobs(prisma, project.id, created);

    console.log(`
  Seed complete.

    Organization   ${org.name} (${org.slug})
    Project        ${project.name}
    User           ${user.email}
    Queues         ${Object.keys(created).join(', ')}
    Schedules      ${schedules.map((s) => s.name).join(', ')}
    Sample jobs    ${seeded}
${existingKey ? '' : `    API key        ${plaintext}\n                   (shown once — store it now)\n`}
  Open http://localhost:5173 ${existingMember ? 'and refresh' : 'and register an account, then re-run `npm run seed`'}
`);
  } finally {
    await prisma.$disconnect();
  }
}

async function upsertPolicies(prisma: PrismaClient, projectId: string) {
  const defs = [
    {
      name: 'exponential-standard',
      strategy: 'EXPONENTIAL' as const,
      maxAttempts: 5,
      baseDelayMs: 5_000,
      maxDelayMs: 300_000,
      isDefault: true,
    },
    {
      name: 'linear-patient',
      strategy: 'LINEAR' as const,
      maxAttempts: 4,
      baseDelayMs: 10_000,
      maxDelayMs: 120_000,
      isDefault: false,
    },
    {
      name: 'fixed-quick',
      strategy: 'FIXED' as const,
      maxAttempts: 3,
      baseDelayMs: 2_000,
      maxDelayMs: 2_000,
      isDefault: false,
    },
  ];

  const ids: Record<string, string> = {};
  for (const d of defs) {
    const row = await prisma.retryPolicy.upsert({
      where: { projectId_name: { projectId, name: d.name } },
      update: {},
      create: { projectId, ...d, jitterPct: 10 },
      select: { id: true },
    });
    ids[d.strategy.toLowerCase()] = row.id;
  }

  return {
    exponential: ids['exponential']!,
    linear: ids['linear']!,
    fixed: ids['fixed']!,
  };
}

async function seedSampleJobs(
  prisma: PrismaClient,
  projectId: string,
  queues: Record<string, string>,
): Promise<number> {
  const existing = await prisma.job.count({ where: { projectId } });
  if (existing > 0) return 0;

  const policy = await prisma.retryPolicy.findFirstOrThrow({
    where: { projectId, isDefault: true },
  });

  const base = {
    projectId,
    handler: 'simulate',
    maxAttempts: policy.maxAttempts,
    backoffStrategy: policy.strategy,
    backoffBaseMs: policy.baseDelayMs,
    backoffMaxMs: policy.maxDelayMs,
    backoffJitterPct: policy.jitterPct,
    retryPolicyId: policy.id,
    timeoutMs: 30_000,
  };

  const rows = [
    // Immediate work.
    ...Array.from({ length: 20 }, () => ({
      ...base,
      queueId: queues['webhooks']!,
      payload: { duration_ms: 200, fail_probability: 0.15 },
      priority: 150,
      status: 'QUEUED' as const,
    })),
    // Delayed, so the SCHEDULED state is visible on the dashboard.
    ...Array.from({ length: 5 }, (_, i) => ({
      ...base,
      queueId: queues['email-notifications']!,
      payload: { duration_ms: 100 },
      priority: 100,
      status: 'SCHEDULED' as const,
      runAt: new Date(Date.now() + (i + 1) * 60_000),
    })),
    // A batch, sharing one batch_id.
    ...(() => {
      const batchId = crypto.randomUUID();
      return Array.from({ length: 30 }, () => ({
        ...base,
        queueId: queues['bulk-import']!,
        payload: { duration_ms: 50 },
        priority: 10,
        status: 'QUEUED' as const,
        batchId,
      }));
    })(),
    // Guaranteed to exhaust retries, so the DLQ has content immediately.
    ...Array.from({ length: 3 }, () => ({
      ...base,
      queueId: queues['report-generation']!,
      payload: { duration_ms: 100, permanent_failure_probability: 1 },
      priority: 50,
      status: 'QUEUED' as const,
    })),
  ];

  const res = await prisma.job.createMany({ data: rows as never });
  return res.count;
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
