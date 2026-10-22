# SaaSModels One

Modular SaaS suite for service businesses. This repository is the product; the marketing site is not part of it.

Current milestone: **M0**. Payroll calculation, statutory packs, CRM/Work/Money/Content domain screens and Switch import are out of scope until their roadmap milestone. See [AGENTS.md](AGENTS.md) and [suite/docs/roadmap.md](suite/docs/roadmap.md).

## Prerequisites

- Node.js 22.11+ (tested on 22.18)
- pnpm 10.18
- PostgreSQL 17 locally. `compose.yaml` is the canonical harness; any local PostgreSQL 17 on port 54329 can be used instead.

## Local setup

```bash
cp .env.example .env
docker compose up -d
pnpm install
pnpm db:setup
pnpm test
```

`pnpm db:setup` runs three separate privileged steps:

1. `db:bootstrap` creates `saas_owner`, `saas_runtime` and `saas_auth`, creates the `saasmodels` database owned by `saas_owner`, and removes PUBLIC creation rights.
2. `db:migrate` applies `suite/db/migrations/*.sql` in order as `saas_owner`, records SHA-256 checksums in `infra.schema_migration`, and reapplies the runtime and auth grant allowlists.
3. `db:seed` applies the idempotent module catalog.

The migration runner refuses to continue when an applied file's checksum changes, when a migration was interrupted, or when it previously failed. Reviewed migrations are never rewritten; add a forward migration instead.

## Roles

| URL | Role | Use |
| --- | --- | --- |
| `DB_ADMIN_URL` | PostgreSQL superuser | Local bootstrap only |
| `DB_OWNER_URL` | `saas_owner` | Migrations, seeds, provisioning, invitations |
| `DB_RUNTIME_URL` | `saas_runtime` | Tenant business data through the application |
| `DB_AUTH_URL` | `saas_auth` | Identity lookups and session storage |

`saas_runtime` is not the table owner, does not have `BYPASSRLS`, cannot create schemas or tables, cannot write the module catalog, and cannot execute administrative procedures. `saas_auth` is a separate login role for identity only: it can read and update the identity columns it needs, manage `auth_session` and `invitation`, and has no access to tenant business data, the module catalog or audit. Its table and function grants are an explicit allowlist in [packages/db/sql/auth-grants.sql](packages/db/sql/auth-grants.sql), reapplied after every migration alongside the runtime allowlist.

The harness refuses any database URL that does not point at localhost, `127.0.0.1`, `[::1]` or a Unix socket. It will not connect to a remote database.

## Authentication configuration

The API requires `DB_RUNTIME_URL`, `DB_AUTH_URL` and `APP_ORIGIN`. `APP_ORIGIN` is the exact browser origin allowed to send state-changing requests; there is no wildcard and no proxy-header trust. `COOKIE_SECURE` defaults to true when `NODE_ENV=production` and can be overridden for local HTTP. `SAAS_AUTH_PASSWORD` is required by `db:bootstrap`; `TEST_DB_AUTH_URL` supplies the same role to the test harness.

Email/password login uses Argon2id, and the browser holds only an opaque `saas_session` cookie whose SHA-256 hash is stored server-side. Identity is global (`app_user.email` is unique) while memberships are per tenant, so one user can sign in to several tenants with the same password. Invitations are created by the owner-only `pnpm db:invite` command and accepted once through the API; a first-time invitee sets a password, and an active user invited to a second tenant verifies its existing one. Login is rate-limited per source address and per email in memory, and auth responses are sent `Cache-Control: no-store`. There is no web login UI, password reset, MFA, OAuth, email delivery, tenant switching, device list, session rotation or distributed rate limiting yet. These are target behaviours, not shipping features.

## Tests

```bash
pnpm lint
pnpm lint:boundaries
pnpm typecheck
pnpm test
```

`pnpm test` uses disposable local databases created through `packages/testkit`. Integration tests assert every baseline migration applies, re-application is a no-op, the seed is idempotent, a tampered migration checksum is rejected, remote URLs are rejected, and the runtime and auth roles each stay inside their privilege allowlist. Boundary tests prove that `pnpm lint:boundaries` rejects a forbidden `apps/web` to `packages/db` import.

PostgreSQL 16 is part of the CI matrix when the GitHub Actions workflow lands; local development targets 17.

## Layout

```
apps/api      Fastify HTTP surface
apps/worker   PostgreSQL outbox worker
apps/web      React + Vite client
packages/db   pg client, migration runner, repositories, SQL
packages/contracts  shared DTOs and Zod schemas
packages/testkit    disposable local databases and test fixtures
```

Import boundaries: `web -> contracts`, `api -> db + contracts`, `worker -> db + contracts`, `db -> contracts`, `testkit -> db + contracts`. Production code never imports `testkit`; apps never import each other. Rules live in [eslint.config.js](eslint.config.js).
