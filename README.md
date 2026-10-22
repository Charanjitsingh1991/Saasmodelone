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

## Authorization

Role authorization is server-side and shared. `@saasmodels/contracts` defines the seven membership roles, the four M0 permissions (`people.read`, `people.write`, `work.read`, `work.write`) and the role matrix. `withMemberTransaction` checks membership, platform access, the module entitlement and then the role permission, in that order, so an unentitled module never discloses role policy. Owner and admin hold all four permissions; HR holds People read/write; finance and auditor hold People read and Work read; manager holds People read and Work read/write; employee holds none until employee self-scope lands in M1. `/v1/context` returns canonical permissions and only the modules effective under both entitlement and role. Authenticated access denials are appended as `authorization.denied` with reason, method, registered route template and, where known, module/operation/permission; raw URLs, tokens, cookies and headers are not recorded. The audit is best-effort, so a failed audit write is logged and the denial is still returned. Scope authorization (legal entity, department, project, client), role administration and seat enforcement are not built.

## People directory export

`GET /v1/people/export` is the first production module route and is registered whether or not proof routes are enabled. It requires a valid session and is gated by `withMemberTransaction` with `{ module: 'people', operation: 'read' }`: the tenant must hold a People entitlement with read access (including a cancelled entitlement inside `read_until`), and the member role must hold `people.read`. The response is a streamed RFC 4180 CSV of seven directory identity fields — `person_id`, `employee_code`, `first_name`, `last_name`, `display_name`, `work_email`, `phone` — for every non-deleted person in the session tenant, ordered by `employee_code nulls last, id`. Tenant scope comes from `app.tenant_id` and RLS, never from a caller value; `tenant_id` query parameters and `x-tenant-id` are ignored.

The runtime role has column-level `SELECT` on exactly those seven fields plus `deleted_at`, which is used only to exclude soft-deleted rows and is never exported. It has no table-level `SELECT` on `person`, and every other person column — including personal email, date of birth, gender, status, designation, employment type and legal entity — remains owner-only. The route declares a server-side cursor and fetches batches of at most 1,000 rows (default 200), honours response backpressure, and rolls back the read transaction if the client disconnects. Before the first CSV byte is sent, a separate member transaction commits a `people.directory.exported` audit row with the tenant, actor, request IP and user agent; metadata is limited to module, format and the seven column names, with no row count or row data. A failure to write that audit row returns a sanitized 500 and no CSV. Fields are minimally quoted with doubled quotes and CRLF line endings; a value whose first character is `=`, `+`, `-`, `@`, tab or carriage return is prefixed with a single quote before quoting to reduce spreadsheet formula injection.

This is a scoped directory export, not the complete export and portability feature. There is no dedicated export permission (M1), export rate limit, UI or download button, filter, column selection or date range, Client or Work export, asynchronous or background export, signed URL, storage bucket or export history, and no full-suite export/re-import. M0 has not exited.

## Tests

```bash
pnpm lint
pnpm lint:boundaries
pnpm typecheck
pnpm secret-scan
pnpm audit --prod --audit-level high
pnpm test
```

`pnpm ci:verify` runs typecheck, lint, boundary lint, secret scan, the production audit and the test suite in one command. `pnpm secret-scan` lists tracked and untracked non-ignored paths with `git ls-files --cached --others --exclude-standard` and scans tracked and untracked non-ignored regular files for private-key blocks, common cloud/token formats, literal session-cookie values and sensitive paths. It does not scan Git history, ignored files, packed objects or remote state, and it cannot prove absence.

`pnpm test` uses disposable local databases created through `packages/testkit`. Integration tests assert every baseline migration applies, re-application is a no-op, the seed is idempotent, a tampered migration checksum is rejected, remote URLs are rejected, and the runtime and auth roles each stay inside their privilege allowlist. The schema-inventory suite pins 66 public tables with `tenant_id`, 64 RLS tables, exactly the two identity exceptions (`auth_session`, `invitation`) without RLS, no forced RLS, the exact runtime table grants and exactly eight person column grants. The authorization suite proves the exact seven-role policy, entitlement-before-role ordering, role denial with no callback, and the audit rows for authenticated denials, including route-template-only paths and an audit-write failure. The export suite proves exact seven-column CSV output with RFC 4180 quoting and formula guarding, multi-batch cursor streaming, tenant isolation through RLS and the column grant, role/module/unauthenticated denials with no CSV bytes, retention-window read access, soft-deleted exclusion, one export audit row before disclosure, and fail-closed behavior when the audit grant is revoked. Boundary tests prove that `pnpm lint:boundaries` rejects a forbidden `apps/web` to `packages/db` import. A workflow contract test asserts the CI file's triggers, read-only permissions, action allowlist, PostgreSQL versions and command order; it does not prove GitHub executed it.

The GitHub Actions workflow at [.github/workflows/ci.yml](.github/workflows/ci.yml) declares push and pull-request runs on PostgreSQL 16 and 17 with read-only repository permissions and localhost-only dummy credentials. There is no Git remote, so it has never run; PostgreSQL 16 is unproven. The M0 threat model is a draft without a named reviewer, and [suite/docs/release/m0-evidence.md](suite/docs/release/m0-evidence.md) records criterion-level status, exact results and the do-not-claim list. M0 has not exited.

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
