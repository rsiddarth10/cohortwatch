import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/** Integration tests (Testcontainers: real Redpanda + Redis). Needs Docker. `npm run test:integration`. */
export default defineConfig({
  resolve: {
    alias: {
      '@cw/domain': src('./packages/domain/src/index.ts'),
      '@cw/common': src('./packages/common/src/index.ts'),
    },
  },
  test: {
    include: ['services/*/src/**/*.itest.ts'],
    environment: 'node',
    testTimeout: 180_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
});
