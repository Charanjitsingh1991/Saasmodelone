import 'dotenv/config';
import { defineConfig } from '@playwright/test';
import { webPort } from './tests/e2e/ports.js';

const webOrigin = `http://localhost:${webPort}`;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  reporter: [['list']],
  use: {
    baseURL: webOrigin,
    browserName: 'chromium',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    // The production bundle, served by the preview server. The port follows
    // E2E_WEB_PORT so the journey can run beside a development server that
    // already holds the default one.
    command: `pnpm build:web && pnpm --filter @saasmodels/web exec vite preview --port ${webPort} --strictPort`,
    url: `${webOrigin}/login`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
