# Deployment

The backend is a standalone Node.js service. It shares no build or deploy pipeline with
the frontend and can be hosted anywhere that runs Node 20+ with network access to
PostgreSQL 14+.

## 1. Environment variables

Copy `.env.example` to `.env` and fill it in. **Never commit `.env`.**

| Variable | Required | Notes |
|---|---|---|
| `NODE_ENV` | yes | `development` \| `test` \| `production` |
| `PORT` | | Default `5000`. macOS AirPlay Receiver occupies 5000 |
| `API_BASE_PATH` | | Default `/api/v1` |
| `DATABASE_URL` | **yes** | Must start `postgresql://` — startup fails otherwise |
| `TEST_DATABASE_URL` | tests only | Must differ from `DATABASE_URL` |
| `JWT_SECRET` | **yes** | 32+ chars. `openssl rand -base64 48` |
| `JWT_EXPIRES_IN` | | Default `15m` |
| `REFRESH_TOKEN_SECRET` | **yes** | 32+ chars, distinct from `JWT_SECRET` |
| `REFRESH_TOKEN_EXPIRES_IN` | | Default `7d` |
| `COOKIE_SECURE` | | `true` in production (HTTPS) |
| `COOKIE_DOMAIN` | | Set when API and frontend share a parent domain |
| `CORS_ORIGIN` | **yes** | Comma-separated allowlist. No wildcards |
| `RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX` / `AUTH_RATE_LIMIT_MAX` | | Defaults 15min / 300 / 10 |
| `JSON_BODY_LIMIT` | | Default `1mb` |
| `MAX_PAGE_SIZE` / `DEFAULT_PAGE_SIZE` | | Defaults 100 / 25 |
| `LOG_LEVEL` | | Default `info` |
| `STORAGE_PROVIDER` | | `LOCAL` for development; `DATABASE` is required in production and stores document bytes in PostgreSQL |
| `STORAGE_BUCKET` | | Logical namespace for FileObject keys |
| `STORAGE_PUBLIC_BASE_URL` | production | Public deployed backend `/files` base URL used for signed document URLs |
| `SIGNED_URL_TTL_SECONDS` | | Default 900 |
| `APP_URL` | production | Frontend origin; used to build links in verification and reset e-mails |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_SECURE` / `MAIL_FROM` | production | Outbound mail. Without `SMTP_HOST` mail is logged (development) and **production refuses to start sending** |
| `BRAND_NAME` / `BRAND_COOKIE_PREFIX` / `BRAND_SUPPORT_EMAIL` | | White-label identity. Cookie prefix must match the frontend |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | | Optional billing. `rzp_test_` keys = test mode; unset = billing disabled (503) |
| `CRON_SECRET` | for reminders | 16+ chars (`openssl rand -hex 32`). Vercel Cron sends it as a bearer token to `/api/v1/internal/cron/reminders` (scheduled daily in `vercel.json`). Unset = the endpoint answers 404 and no reminder is ever sent |
| `SEED_*` | | Bootstrap only |
| `SEED_DEMO_DATA` | | **Refused in production** |

Configuration is validated by Zod at startup (`src/config/env.ts`). A missing secret, a
short key or a non-PostgreSQL `DATABASE_URL` aborts the process rather than letting it
serve traffic mis-configured.

## 2. First deployment

```bash
npm ci
npx prisma migrate deploy     # applies migrations; never resets
npx prisma generate
npm run build
npm run seed                  # permissions, roles, admin, reference data
npm start
```

Sign in with `SEED_ADMIN_EMAIL` and change the password immediately.

### Releases that add database tables or permissions

- `npx prisma migrate deploy` must run against the production database **before** the new code serves traffic: the quote engine adds tables and columns (migrations `20261024120000_quote_engine` and `20261024121000_quote_item_inclusions`), and queries on existing tables (quotations, organisation settings) fail until they are applied.
- New permission keys (`CATALOG_*`, `BOOKING_SETUP_MANAGE`) reach existing studios' system roles automatically: each new serverless instance checks the catalogue once at start (one read when nothing changed), and `npm run permissions:sync` does the same on demand. Custom roles are never changed: grant the new permissions to them from *Roles & Permissions*.

## 3. Subsequent deployments

```bash
npm ci
npx prisma migrate deploy
npx prisma generate
npm run build
npm start
```

**Use `migrate deploy` in production — never `migrate dev`, and never
`db push --force-reset`.** `migrate deploy` only applies pending migrations; it does not
generate, reset or drop anything.

The seed is idempotent (every write is an upsert on a natural key) and safe to re-run —
useful after adding permissions, since it re-asserts each system role's bundle so new keys
reach existing roles.

## 4. Schema changes

```bash
# development
npx prisma migrate dev --name descriptive_change

# for CHECK constraints or partial indexes, generate the SQL first, edit it, then apply
npx prisma migrate dev --name descriptive_change --create-only
$EDITOR prisma/migrations/*/migration.sql
npx prisma migrate dev
```

Prisma cannot express CHECK constraints or partial indexes, so they are appended by hand
to the migration SQL. Keep that pattern — the constraints are load-bearing.

## 5. Migrating from another database

This service was built PostgreSQL-first, so there is no in-place engine migration path. To
import data from an earlier system:

1. Export the source data (CSV or JSON)
2. Apply this schema to an empty PostgreSQL database: `npx prisma migrate deploy`
3. Write a transformation script mapping legacy rows to these models — expect to split
   denormalised fields (crew name strings become `ShootAssignment` rows; JSON event blobs
   become `Event` rows) and to convert every `FLOAT` amount to `numeric(14,2)`
4. Load inside a transaction, ordered by dependency: organization → branches → roles and
   users → clients → projects → events → shoots → assignments → invoices → payments →
   allocations → expenses
5. Validate before switching over:
   - row counts per table against the source
   - no orphaned foreign keys
   - `SUM(payments.amount)` and `SUM(expenses.amount)` match the source totals to the paisa
   - `SELECT * FROM invoices WHERE amount_due <> total - amount_paid` returns zero rows
   - every `shoot_assignments` row has exactly one assignee (the CHECK constraint enforces
     this, so a violating import fails loudly rather than landing corrupt)

Never point `migrate deploy` at a database whose contents you have not inspected.

## 6. Operations

**Health checks** — point the load balancer at `/health` for liveness and `/health/ready`
for readiness. `/health/ready` executes `SELECT 1` and returns 503 when PostgreSQL is
unreachable, so a process that cannot serve is removed from rotation.

**Graceful shutdown** — `SIGTERM`/`SIGINT` stop accepting connections, drain in-flight
requests, disconnect Prisma, then exit; a 15-second timer prevents hanging forever.

**Logging** — structured JSON via pino, with `authorization`, `cookie`, `set-cookie`,
passwords, tokens, `DATABASE_URL` and storage secrets redacted. Every request carries a
correlation id, echoed as `X-Request-Id` and stored on audit rows.

**Behind a proxy** — `trust proxy` is enabled, so `X-Forwarded-For` and
`X-Forwarded-Proto` must be set correctly by the load balancer for client IPs and Secure
cookies to work.

**Connection pooling** — for serverless or high-concurrency hosting, put PgBouncer (or
your provider's pooler) in front and append `?pgbouncer=true&connection_limit=1` to
`DATABASE_URL`.

**Backups** — the database is the single source of truth. Enable point-in-time recovery
and test a restore. `audit_logs`, `payments` and `payment_allocations` are the tables you
cannot reconstruct.

**Housekeeping** — `idempotency_keys` rows carry `expires_at` (24h). Schedule a periodic
`DELETE FROM idempotency_keys WHERE expires_at < now()`. Expired sessions can be pruned
the same way.

## 7. Container

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npx prisma generate && npm run build
EXPOSE 5000
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server.js"]
```

## 8. Pre-flight checklist

- [ ] `DATABASE_URL` points at the intended PostgreSQL instance
- [ ] `JWT_SECRET` and `REFRESH_TOKEN_SECRET` are freshly generated and distinct
- [ ] `CORS_ORIGIN` lists exactly the frontend origins
- [ ] `COOKIE_SECURE=true` and the API is served over HTTPS
- [ ] `SEED_DEMO_DATA` is `false`
- [ ] `NODE_ENV=production`
- [ ] The seeded admin password has been changed
- [ ] `CRON_SECRET` is set (payment and quote reminders depend on it) and the Vercel Cron job shows up under the project's *Settings → Cron Jobs*
- [ ] SMTP works: send yourself a quote by email from *Quotes* (customers' quote links and enquiry alerts use it)
- [ ] The quote and invoice PDFs render the ₹ sign: the bundled `assets/fonts` folder is listed in `vercel.json` `includeFiles`
- [ ] `/health/ready` returns 200 from inside the network
- [ ] Backups and point-in-time recovery are enabled
