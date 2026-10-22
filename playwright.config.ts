import 'dotenv/config';
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:3000',
    browserName: 'chromium',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'pnpm build:web && pnpm --filter @saasmodels/web preview',
    url: 'http://localhost:3000/login',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
