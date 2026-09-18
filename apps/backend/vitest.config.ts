import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Phase 15: the load-test suite (src/loadtest/**) is real and
    // maintained but deliberately excluded from the default fast suite -
    // it seeds/dispatches 10,000+ leads against a real local Postgres
    // instance and takes minutes, not milliseconds. Run it explicitly via
    // `pnpm run loadtest` (vitest.loadtest.config.ts), never as part of
    // `pnpm run test`.
    exclude: ['**/node_modules/**', 'src/loadtest/**'],
  },
});
