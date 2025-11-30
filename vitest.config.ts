import tsconfigPaths from 'vite-tsconfig-paths';
import { defineConfig } from 'vitest/config';

const testDatabaseUrl =
  process.env.TEST_DATABASE_URL ?? 'postgresql://labeling:labeling@localhost:5432/labeling_test';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    // integration tests share one database, so files run one at a time
    fileParallelism: false,
    env: { NODE_ENV: 'test' },
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'node',
          include: ['tests/unit/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          environment: 'node',
          include: ['tests/integration/**/*.test.ts'],
          globalSetup: ['tests/integration/global-setup.ts'],
          env: { DATABASE_URL: testDatabaseUrl, TEST_DATABASE_URL: testDatabaseUrl },
          hookTimeout: 30_000,
          testTimeout: 15_000,
        },
      },
    ],
  },
});
