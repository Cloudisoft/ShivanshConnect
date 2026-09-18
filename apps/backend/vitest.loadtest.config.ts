import { defineConfig } from 'vitest/config';

/**
 * Phase 15: the load-test suite's own vitest config, run via
 * `pnpm run loadtest` - separate from the default fast suite
 * (vitest.config.ts) because these tests are real, slow (seed + dispatch
 * 10,000+ leads against a real local Postgres instance across three
 * concurrency tiers) and require that real database to be reachable (see
 * src/loadtest/README.md for how to stand it up). `fileParallelism: false`
 * runs the load-test files one at a time - they share one Postgres
 * connection pool's worth of real load and their own console-logged
 * timing report is much easier to read un-interleaved.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/loadtest/**/*.loadtest.test.ts'],
    fileParallelism: false,
    testTimeout: 20 * 60_000,
    hookTimeout: 5 * 60_000,
  },
});
