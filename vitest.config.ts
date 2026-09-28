import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    // Tests run against sources, so no build is needed first.
    alias: {
      '@cw/domain': src('./packages/domain/src/index.ts'),
      '@cw/common': src('./packages/common/src/index.ts'),
    },
  },
  test: {
    include: ['packages/*/src/**/*.test.ts', 'services/*/src/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'text', 'html', 'lcov', 'json-summary'],
      reportsDirectory: 'coverage',
      include: ['packages/*/src/**/*.ts', 'services/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/index.ts'],
      thresholds: {
        // Brief §2.2: pure domain logic at >= 80%.
        'packages/domain/src/**': { lines: 80, functions: 80, branches: 80, statements: 80 },
      },
    },
  },
});
