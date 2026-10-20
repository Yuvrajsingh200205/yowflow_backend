import path from 'path';
import dotenv from 'dotenv';
import { z } from 'zod';

if (!process.env.VERCEL) {
  dotenv.config({ path: path.resolve(process.cwd(), '.env'), quiet: true });
}

/** Vercel/dashboard often stores unused keys as "". Zod defaults only apply to undefined. */
function withoutBlanks(input: NodeJS.ProcessEnv): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [
      key,
      typeof value === 'string' && value.trim() === ''
        ? undefined
        : typeof value === 'string'
          ? value.trim().replace(/^["']|["']$/g, '')
          : value,
    ]),
  );
}

const bool = (defaultValue: 'true' | 'false') =>
  z
    .enum(['true', 'false'])
    .default(defaultValue)
    .transform((v) => v === 'true');

const int = (defaultValue: number) =>
  z.coerce.number().int().positive().default(defaultValue);

const onVercel = Boolean(process.env.VERCEL);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default(onVercel ? 'production' : 'development'),
  PORT: int(5000),
  API_BASE_PATH: z.string().startsWith('/').default('/api/v1'),

  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required')
    .refine(
      (v) => v.startsWith('postgresql://') || v.startsWith('postgres://'),
      'DATABASE_URL must be a PostgreSQL connection string. This service does not support any other engine.',
    ),
  TEST_DATABASE_URL: z.string().optional(),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_EXPIRES_IN: z.string().default('15m'),
  REFRESH_TOKEN_SECRET: z
    .string()
    .min(32, 'REFRESH_TOKEN_SECRET must be at least 32 characters'),
  REFRESH_TOKEN_EXPIRES_IN: z.string().default('7d'),
  FREELANCER_ONBOARDING_TOKEN_EXPIRES_IN: z.string().default('48h'),
  COOKIE_SECURE: bool(onVercel || process.env.NODE_ENV === 'production' ? 'true' : 'false'),
  COOKIE_DOMAIN: z.string().optional(),

  CORS_ORIGIN: z
    .string()
    .default(onVercel ? '' : 'http://localhost:3000,http://localhost:3002'),

  /**
   * Suffix that Vercel preview deployments for THIS team end with, e.g.
   * "-acme-projects.vercel.app". Matching on a project-name prefix was unsafe:
   * *.vercel.app subdomains are first-come-first-served, so anyone could claim
   * one starting with the project name and be granted credentialed CORS. A team
   * slug cannot be claimed by an outsider. Empty disables preview matching.
   */
  CORS_VERCEL_PREVIEW_SUFFIX: z.string().default(''),

  RATE_LIMIT_WINDOW_MS: int(15 * 60 * 1000),
  RATE_LIMIT_MAX: int(300),
  AUTH_RATE_LIMIT_MAX: int(10),

  JSON_BODY_LIMIT: z.string().default('1mb'),
  MAX_PAGE_SIZE: int(100),
  DEFAULT_PAGE_SIZE: int(25),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  STORAGE_PROVIDER: z.enum(['LOCAL', 'DATABASE', 'S3', 'R2', 'SUPABASE']).default('LOCAL'),
  STORAGE_BUCKET: z.string().default('yowflow'),
  STORAGE_REGION: z.string().optional(),
  STORAGE_ENDPOINT: z.string().optional(),
  STORAGE_ACCESS_KEY_ID: z.string().optional(),
  STORAGE_SECRET_ACCESS_KEY: z.string().optional(),
  STORAGE_PUBLIC_BASE_URL: z.string().optional(),
  SIGNED_URL_TTL_SECONDS: int(900),

  META_APP_ID: z.string().optional(),
  META_APP_SECRET: z.string().optional(),
  META_PAGE_ID: z.string().optional(),
  META_PAGE_ACCESS_TOKEN: z.string().optional(),
  META_WEBHOOK_VERIFY_TOKEN: z.string().optional(),
  META_GRAPH_API_VERSION: z.string().regex(/^v\d+\.\d+$/).default('v26.0'),

  // Public URL of the frontend; used to build links in e-mails.
  APP_URL: z.string().url().default('http://localhost:3000'),
  // Outbound mail. Without SMTP_HOST the mailer logs instead of sending (development only).
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: int(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_SECURE: bool('false'),
  MAIL_FROM: z.string().default('Yowflow <no-reply@yowflow.com>'),

  // White-label identity. Change these (not the code) to resell under another name.
  BRAND_NAME: z.string().min(1).default('Yowflow'),
  BRAND_COOKIE_PREFIX: z.string().regex(/^[a-z][a-z0-9]{0,15}$/).default('yf'),
  BRAND_SUPPORT_EMAIL: z.string().email().default('support@yowflow.com'),

  SEED_ORG_NAME: z.string().default('Demo Studio'),
  SEED_ORG_SLUG: z.string().default('demo-studio'),
  SEED_ADMIN_EMAIL: z.string().email().default('admin@example.com'),
  SEED_ADMIN_PASSWORD: z.string().default('ChangeMe@Admin2026'),
  SEED_DEMO_DATA: bool('false'),
});

const parsed = schema.safeParse(withoutBlanks(process.env));

if (!parsed.success) {
  const details = parsed.error.issues
    .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
    .join('\n');
  // Fail fast and loudly: a mis-configured process must never start and serve
  // traffic against the wrong database or with a weak signing key.
  throw new Error(`Invalid environment configuration:\n${details}`);
}

const raw = parsed.data;
const PERSISTENT_STORAGE = new Set(['DATABASE', 'S3', 'R2', 'SUPABASE']);
if (raw.NODE_ENV === 'production' && !PERSISTENT_STORAGE.has(raw.STORAGE_PROVIDER)) {
  throw new Error('Production document storage requires a persistent STORAGE_PROVIDER (DATABASE, S3, R2 or SUPABASE); LOCAL storage is not persistent on serverless hosts.');
}
// The S3-compatible providers sign their own URLs, so they need an endpoint and
// credentials. Failing at boot beats failing on the first upload.
if (['S3', 'R2', 'SUPABASE'].includes(raw.STORAGE_PROVIDER)) {
  const missing = ['STORAGE_ENDPOINT', 'STORAGE_ACCESS_KEY_ID', 'STORAGE_SECRET_ACCESS_KEY'].filter(
    (key) => !raw[key as keyof typeof raw],
  );
  if (missing.length > 0) {
    throw new Error(`STORAGE_PROVIDER=${raw.STORAGE_PROVIDER} requires ${missing.join(', ')}`);
  }
}
if (raw.NODE_ENV === 'production' && raw.STORAGE_PROVIDER === 'DATABASE' && !raw.STORAGE_PUBLIC_BASE_URL) {
  throw new Error('Production document storage requires STORAGE_PUBLIC_BASE_URL to generate signed file URLs for the deployed backend.');
}
if (onVercel && !/sslmode=/i.test(raw.DATABASE_URL)) {
  raw.DATABASE_URL += `${raw.DATABASE_URL.includes('?') ? '&' : '?'}sslmode=require`;
}

export const env = {
  brandName: raw.BRAND_NAME,
  brandCookiePrefix: raw.BRAND_COOKIE_PREFIX,
  brandSupportEmail: raw.BRAND_SUPPORT_EMAIL,
  ...raw,
  isProduction: raw.NODE_ENV === 'production',
  isTest: raw.NODE_ENV === 'test',
  isDevelopment: raw.NODE_ENV === 'development',
  /** Strict CORS allowlist. No wildcard is ever honoured. */
  corsOrigins: raw.CORS_ORIGIN.split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  corsVercelPreviewSuffix: raw.CORS_VERCEL_PREVIEW_SUFFIX.trim(),
};

export type Env = typeof env;
