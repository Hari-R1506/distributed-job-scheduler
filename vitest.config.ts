import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/** Resolve workspace packages to SOURCE, so tests need no build step. */
const alias = {
  '@djs/core': r('./packages/core/src/index.ts'),
  '@djs/db': r('./packages/db/src/index.ts'),
};

/**
 * Four suites with different needs:
 *
 *   unit          pure logic, no I/O, runs in ~1s
 *   integration   API against a real Postgres (Testcontainers)
 *   concurrency   the race tests — real parallel workers, real row locks
 *   e2e           Playwright, run separately
 *
 * Testcontainers is mandatory for the last two, not a preference. An in-memory
 * or mocked database cannot exhibit FOR UPDATE SKIP LOCKED semantics, row
 * locks, or MVCC snapshots — so a mocked concurrency test proves nothing at all.
 * See ARCHITECTURE.md §27.1.
 */
export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          // One container is shared across the suite; each test works in its
          // own org so they stay independent without paying container startup.
          globalSetup: ['tests/setup/postgres-container.ts'],
          testTimeout: 30_000,
          hookTimeout: 120_000,
          // Integration tests share a database; parallel files would race on
          // global state like the scheduler advisory lock.
          fileParallelism: false,
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'concurrency',
          include: ['tests/concurrency/**/*.test.ts'],
          environment: 'node',
          globalSetup: ['tests/setup/postgres-container.ts'],
          // Draining 500 jobs across 20 claimers takes a while under load.
          testTimeout: 120_000,
          hookTimeout: 120_000,
          fileParallelism: false,
          // Race conditions are probabilistic: a single green run proves
          // nothing. CI runs this suite with --repeat 20.
          retry: 0,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['packages/core/src/**', 'apps/*/src/**'],
      exclude: ['**/*.d.ts', '**/dist/**', '**/main.ts'],
      thresholds: {
        // packages/core is pure logic with no excuse for gaps.
        'packages/core/src/**': { statements: 90, branches: 85, functions: 90, lines: 90 },
      },
    },
  },
});
