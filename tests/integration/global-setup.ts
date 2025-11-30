import { execSync } from 'node:child_process';

/** Brings the test database schema up to date once per run. */
export default function setup() {
  const url =
    process.env.TEST_DATABASE_URL ?? 'postgresql://labeling:labeling@localhost:5432/labeling_test';
  execSync('npx prisma migrate deploy', {
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });
}
