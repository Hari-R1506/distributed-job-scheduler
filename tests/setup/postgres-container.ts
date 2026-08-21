import { execSync } from 'node:child_process';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * Boots a real PostgreSQL 16 for the integration and concurrency suites.
 *
 * Testcontainers is MANDATORY here, not a preference. An in-memory or mocked
 * database cannot exhibit `FOR UPDATE SKIP LOCKED` semantics, row-level locks,
 * advisory locks, or MVCC snapshot behaviour — so a mocked concurrency test
 * proves precisely nothing about the property it claims to verify.
 *
 * One container is shared across the run; each test file works in its own
 * organization so they stay independent without paying startup repeatedly.
 */
let container: StartedPostgreSqlContainer | undefined;

export async function setup(): Promise<void> {
  // Allow pointing at an already-running database (CI services, or a local
  // `make up`) — Testcontainers startup dominates an otherwise fast suite.
  if (process.env['TEST_DATABASE_URL']) {
    process.env['DATABASE_URL'] = process.env['TEST_DATABASE_URL'];
    migrate(process.env['DATABASE_URL']);
    return;
  }

  container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('job_scheduler_test')
    .withUsername('test')
    .withPassword('test')
    // The suite runs many short transactions across ~20 concurrent claimers.
    .withCommand(['postgres', '-c', 'max_connections=300', '-c', 'fsync=off'])
    .start();

  const url = `${container.getConnectionUri()}?schema=public`;
  process.env['DATABASE_URL'] = url;
  process.env['TEST_DATABASE_URL'] = url;

  migrate(url);
}

export async function teardown(): Promise<void> {
  await container?.stop();
}

function migrate(url: string): void {
  // The real migrations, not `db push`. The partial indexes and CHECK
  // constraints live in migration 2, and testing against a schema that lacks
  // them would validate a system nobody is going to run.
  execSync('npx prisma migrate deploy --schema packages/db/prisma/schema.prisma', {
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'inherit',
  });
}
