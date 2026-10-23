import { defineConfig } from 'vitest/config';
import dotenv from 'dotenv';

dotenv.config();

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) {
  throw new Error(
    'TEST_DATABASE_URL is not set. Tests refuse to run rather than risk touching the development database.',
  );
}
if (testDatabaseUrl === process.env.DATABASE_URL) {
  throw new Error('TEST_DATABASE_URL must not be the same database as DATABASE_URL.');
}

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/**/*.test.ts'],
    globalSetup: ['./tests/helpers/globalSetup.ts'],
    // Integration tests share one PostgreSQL database and truncate between
    // cases, so they must not run concurrently.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: testDatabaseUrl,
      LOG_LEVEL: 'silent',
      // Tests read the e-mail outbox; they must never send real mail, whatever the developer's .env holds.
      SMTP_HOST: '',
      SMTP_USER: '',
      SMTP_PASS: '',
      // ...nor touch real payment or storage accounts.
      RAZORPAY_KEY_ID: '',
      RAZORPAY_KEY_SECRET: '',
    },
  },
});
