import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'packages/**/test/**/*.test.ts', 'apps/**/test/**/*.test.ts'],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 60_000,
    hookTimeout: 180_000,
    setupFiles: ['tests/setup.ts'],
  },
});
