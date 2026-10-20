import { brand } from './brand';
import pino from 'pino';
import { env } from './env';

/**
 * Structured logger. The redaction list is the security boundary for logs —
 * credentials, tokens and cookies must never reach disk or a log aggregator.
 */
export const logger = pino({
  level: env.isTest ? 'silent' : env.LOG_LEVEL,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-api-key"]',
      'res.headers["set-cookie"]',
      'password',
      'passwordHash',
      'currentPassword',
      'newPassword',
      'confirmPassword',
      'token',
      'accessToken',
      'refreshToken',
      'refreshTokenHash',
      '*.password',
      '*.passwordHash',
      '*.accessToken',
      '*.refreshToken',
      'JWT_SECRET',
      'REFRESH_TOKEN_SECRET',
      'DATABASE_URL',
      'STORAGE_SECRET_ACCESS_KEY',
    ],
    censor: '[REDACTED]',
  },
  base: { service: `${brand.slug}-backend` },
  // Worker-thread transports are not usable in serverless functions.
  transport:
    env.isProduction || process.env.VERCEL
      ? undefined
      : { target: 'pino/file', options: { destination: 1 } },
});
