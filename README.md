# Yowflow — Backend

Production backend for Yowflow. Standalone and independently
deployable: it shares no code, build or deploy pipeline with the Next.js frontend.

| | |
|---|---|
| Runtime | Node.js 20+ · TypeScript (strict) |
| Framework | Express 4 |
| ORM | Prisma 6 |
| Database | **PostgreSQL 14+** — the single source of truth |
| Validation | Zod |
| Docs | OpenAPI 3.0 at `/docs` |
| Tests | Vitest + Supertest against a real PostgreSQL database |

PostgreSQL is the only supported engine. There is no MySQL support, no dual-engine
configuration, and no code path that targets anything else.

## Quick start

```bash
cp .env.example .env          # then fill in DATABASE_URL and the two secrets
npm install
createdb wedding_photo_planet
createdb wedding_photo_planet_test    # only needed to run the test suite

npx prisma migrate deploy     # apply the schema
npx prisma generate           # generate the typed client
npm run seed                  # permissions, roles, admin user, reference data

npm run dev                   # http://localhost:5000
```

Then open http://localhost:5000/docs for the full API reference, and sign in with
the `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` from your `.env`.

> **macOS:** Control Center's AirPlay Receiver occupies port 5000. Either disable it
> under *System Settings → General → AirDrop & Handoff*, or set `PORT` to something
> else (this repo's local `.env` uses 5050).

## Scripts

| Script | Purpose |
|---|---|
| `npm run dev` | Watch-mode development server |
| `npm run build` | Compile to `dist/` |
| `npm start` | Run the compiled server |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm test` | Integration suite against `TEST_DATABASE_URL` |
| `npm run seed` | Idempotent seed |
| `npm run prisma:migrate` | Create + apply a migration (development) |
| `npm run prisma:deploy` | Apply pending migrations (production) |
| `npm run db:setup` | `migrate deploy` + `generate` + `seed` |

## Layout

```text
prisma/
├── schema.prisma          51 models, 41 enums
├── migrations/            versioned SQL, including CHECK constraints
└── seed.ts                idempotent; demo data is development-only

src/
├── config/                env (Zod-validated), Prisma client, logger
├── controllers/           HTTP shape only — no business logic
├── docs/                  OpenAPI document
├── middleware/            auth, RBAC, validation, idempotency, errors, limits
├── repositories/          shared query/pagination/tenant-scoping helpers
├── routes/                route tables; every route names its permission
├── services/              business logic and transactions
├── types/                 permission catalogue, request augmentation
├── utils/                 money, dates, JWT, document numbers, transactions
├── app.ts                 Express assembly
└── server.ts              bootstrap and graceful shutdown

tests/integration/         72 tests
docs/                      architecture and deployment references
```

## Documentation

- [`docs/DATABASE_ARCHITECTURE.md`](docs/DATABASE_ARCHITECTURE.md) — schema, keys, money, constraints, indexes
- [`docs/API_ARCHITECTURE.md`](docs/API_ARCHITECTURE.md) — layering, auth, RBAC, envelopes, idempotency
- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — environments, migrations, operations
- `/docs` (running server) — interactive OpenAPI reference

## Design commitments

**Money is never a float.** Every monetary column is `numeric(14,2)`; arithmetic uses
Prisma's `Decimal`; JSON carries exact decimal strings.

**The database enforces business rules.** 39 CHECK constraints and 126 foreign keys
hold even if the service layer is bypassed — a shoot assignment cannot name both an
employee and a freelancer, an invoice cannot be over-settled, an approved expense
cannot lack an approver.

**Authorization is server-side.** Authentication establishes identity; every route
separately names a permission that is re-read from PostgreSQL on each request. A
revoked role takes effect on the very next call, not at token expiry.

**Financial records are append-only.** Payments are never deleted — a reversal writes
a linked counter-entry. Business records use soft deletion with `deletedAt`/`deletedBy`.

**Retries are safe.** Payments, refunds and payouts require an `Idempotency-Key`; a
repeat replays the original response instead of booking the money twice.

**Lists are always bounded.** `limit` is clamped server-side; an unbounded read is not
expressible through the API.
