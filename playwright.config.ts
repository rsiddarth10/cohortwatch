import { defineConfig } from '@playwright/test';

/** E2E smoke against the running compose stack (local only: needs `docker compose up`). */
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 120_000,
  use: { baseURL: process.env.WEB_URL ?? 'http://localhost:3000', viewport: { width: 1440, height: 900 } },
  reporter: 'list',
});
