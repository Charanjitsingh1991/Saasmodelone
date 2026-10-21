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

1. `db:bootstrap` creates `saas_owner` and `saas_runtime`, creates the `saasmodels` database owned by `saas_owner`, and removes PUBLIC creation rights.
2. `db:migrate` applies `suite/db/migrations/*.sql` in order as `saas_owner`, records SHA-256 checksums in `infra.schema_migration`, and applies the runtime grant allowlist.
3. `db:seed` applies the idempotent module catalog.

The migration runner refuses to continue when an applied file's checksum changes, when a migration was interrupted, or when it previously failed. Reviewed migrations are never rewritten; add a forward migration instead.

## Roles

| URL | Role | Use |
| --- | --- | --- |
| `DB_ADMIN_URL` | PostgreSQL superuser | Local bootstrap only |
| `DB_OWNER_URL` | `saas_owner` | Migrations, seeds, provisioning |
| `DB_RUNTIME_URL` | `saas_runtime` | Application and tests |

`saas_runtime` is not the table owner, does not have `BYPASSRLS`, cannot create schemas or tables, cannot write the module catalog, and cannot execute administrative procedures. Its table and function grants are an explicit allowlist in [packages/db/sql/runtime-grants.sql](packages/db/sql/runtime-grants.sql), reapplied after every migration.

The harness refuses any database URL that does not point at localhost, `127.0.0.1`, `[::1]` or a Unix socket. It will not connect to a remote database.

## Tests

```bash
pnpm lint
pnpm lint:boundaries
pnpm typecheck
pnpm test
```

`pnpm test` uses disposable local databases created through `packages/testkit`. Integration tests assert every baseline migration applies, re-application is a no-op, the seed is idempotent, a tampered migration checksum is rejected, remote URLs are rejected, and the runtime role cannot perform administrative or catalog writes. Boundary tests prove that `pnpm lint:boundaries` rejects a forbidden `apps/web` to `packages/db` import.

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
