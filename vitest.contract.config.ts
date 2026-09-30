import { defineConfig } from 'vitest/config';

/** Pact consumer contracts (S9): `npm run test:contract` writes pacts/*.json. */
export default defineConfig({
  test: {
    include: ['tests/contract/**/*.pact.test.ts'],
    testTimeout: 60_000,
    pool: 'threads',
    fileParallelism: false,
  },
});
