# SaaSModels One — Suite Engineering

This directory is the engineering project for **SaaSModels One**, the commercial product. It is deliberately separate from the marketing site at the repository root.

> Status: **M0 foundation** · October 2026
> The database, access helpers, a minimal API/worker request layer, membership verification, audited provisioning/entitlements, email/password login, opaque server-side sessions, one-time invitation acceptance, server-side role authorization for People and Work, authenticated access-denial audit, and a streamed People directory CSV export with column-level runtime grants and pre-disclosure export audit exist. A React 19 + Vite signed-in shell with real sign-in and sign-out, entitlement-and-role-filtered module navigation and an empty People screen exists, proved by one local Playwright browser journey. A working-tree secret scanner covering tracked and untracked non-ignored regular files, production dependency audit, schema/privilege inventory, CI workflow contract test, draft threat model and interim M0 evidence pack exist. The CI workflow has never run because there is no Git remote. Scope authorization, role administration, employee self-scope, password reset, MFA, OAuth, email delivery, tenant switching, session rotation and device lists, further production module routes, queues, audit read APIs, People data entry/CRUD, an export button, invitation UI and other module screens are not implemented.

## First slice

**People + Switch.** HRIS and payroll with jurisdiction packs for 50–500 person service businesses, with a migration console that imports history, rehearses it, reconciles totals and only then promotes to production. The core does not assume a country; each legal entity selects its jurisdiction, currency, locale and timezone.

The product is an **organisation workspace with independently licensable modules**. Every tenant gets the platform core: organisation, legal entities, memberships, roles, audit, documents, search and export. A customer may license one module, several, or the full suite. The module catalog and entitlement model ship with the first slice, so adding CRM, Work, Money or Content later is a configuration change on the same schema — not a data migration or a second edition.

| Module | Status | First job | Licensed alone? |
| --- | --- | --- | --- |
| Core platform | In build | Organisation, identity, roles, audit, documents, export | Included with any module |
| Switch | In build | Migration, validation, rehearsal, reconciliation, rollback | Included, not sold separately |
| People | In build | Employee record, leave, attendance, payroll with reviewed jurisdiction packs, documents | Yes |
| CRM | In design | Accounts, contacts, pipeline, activity, forecast | Yes |
| Work | In design | Clients, projects, allocations, timesheets, margin | Yes |
| Money | In design | Proposals, contracts, invoices, payments, expenses | Yes |
| Content | Research | Documents, knowledge, client rooms, publishing | Yes |
| Procurement, Assets, Analytics | Planned | Not scoped for build | Not sold |

## What is in this foundation

```
suite/
  README.md
  docs/
    architecture.md          system shape, module catalog, entitlements, boundaries, deployment
    security.md              baseline controls, target controls, design-partner gate
    security/
      m0-threat-model.md     draft M0 threat model, not reviewed or approved
    release/
      m0-evidence.md         interim M0 evidence pack; M0 has not exited
    testing.md               non-negotiable suites and CI gates
    roadmap.md               M0–M4 with exit criteria
    adr/                     decisions that are costly to reverse
      0006-web-shell.md      React/Vite shell, same-origin proxy and browser boundary
  db/
    README.md                schema conventions and how to apply migrations
    migrations/
      0001_core.sql          tenancy, identity, audit, events, documents, approvals
      0002_people.sql        people, employment, leave, attendance, payroll
      0003_work.sql          clients, engagements, projects, time, cost
      0004_content.sql       content, versions, assets, document rooms
      0005_money.sql         proposals, contracts, invoices, payments, expenses
      0006_migration.sql     import batches, mapping, rows, issues, reconciliation
      0007_modules.sql       module catalog, dependencies, tenant entitlements
      0008_platform_access.sql  access helpers, read retention, module RLS policies
      0009_member_access.sql    active membership role helper
      0010_identity.sql         auth sessions, invitations and auth-role lookup functions
    seed/
      0001_modules.sql       idempotent module catalog and dependency seed
```

## Non-negotiable rules

1. **Tenant isolation is a database property.** Every tenant business table carries `tenant_id`, has RLS enabled and has a `tenant_isolation` policy; cross-tenant references are blocked by composite foreign keys. The identity tables `auth_session` and `invitation` are the only exceptions: they carry `tenant_id` but deliberately have no RLS, the runtime role has no privilege on either, and they are reached only through security-definer auth functions.
2. **Module access is an entitlement, checked on the server.** A licensed module is not a UI flag. Every module request resolves entitlement + role + scope in that order; M0 implements the first two and defers scope to M1. The database helpers `app.has_module_read('<code>')` and `app.has_module_write('<code>')` enforce tenancy and entitlement, not role; they are the second line of defence. `app.has_active_module('<code>')` remains as a compatibility delegate to the write helper.
3. **One shared directory.** Person and client identity live in the platform. Modules extend those records; none creates a parallel employee or client table.
4. **Money is integer minor units.** `bigint` plus currency. No floating point in payroll or billing.
5. **Payroll history is append-only.** Finalised runs are reversed, never edited. Audit events cannot be updated or deleted.
6. **Imports never write production directly.** Rows land in staging, carry provenance, and are promoted transactionally.
7. **No statutory rule is invented by a model.** Contribution, withholding and statutory-reporting rules are versioned data per jurisdiction, reviewed by a qualified local advisor and proven with golden test cases.
8. **Every portability export is complete.** When full data export ships, a tenant must be able to leave with its records and documents in open formats, module by module, and cancelling a module never destroys the data. The M0 `GET /v1/people/export` route is a scoped directory identity CSV, not that portability feature.

## Database

Target: PostgreSQL 16+ (17 recommended), `pgcrypto` and `citext`, in the data region selected for the tenant at provisioning.

```bash
pnpm db:bootstrap   # roles and database, once
pnpm db:migrate     # checksummed migrations; reapplies runtime and auth grants
pnpm db:seed        # idempotent module catalog
pnpm db:provision --name "Synthetic Co" --slug synthetic-co --region test-region \
  --owner-email owner@example.test --owner-name "Synthetic Owner" --module people
pnpm db:invite --tenant synthetic-co --email owner@example.test
```

The module catalog is reference data, seeded once and updated by migration. A tenant is then granted entitlements; the catalog itself is not writable by the runtime role. Provisioning and entitlement changes run through owner-only libraries and audit in the same transaction.

The migrations and seed are applied by the repository harness against a real local PostgreSQL 17 instance, with fresh-apply, checksum, role-privilege, access-helper, RLS policy, membership, provisioning, audit, authentication, People-directory-export and schema-inventory suites. The web unit tests and one Playwright browser journey run locally; the journey creates its own disposable database and runs the built client through Vite preview with an in-process API. `scripts/secret-scan.ts` scans tracked and untracked non-ignored regular files (not history, ignored files, packed objects or remote state), and `pnpm audit --prod --audit-level high` checks production dependencies. The CI workflow at the repository root declares a PostgreSQL 16/17 matrix and the browser job, but it has not run because there is no Git remote; PostgreSQL 16 and CI browser execution are unproven. A restore drill is still required before real data. See `db/README.md`, `docs/release/m0-evidence.md` and `docs/roadmap.md`.

The application connects as a role that does **not** own the tables. Tenant and user context are set per transaction:

```sql
set local app.tenant_id = '<tenant-uuid>';
set local app.user_id = '<user-uuid>';
```

RLS denies all rows when the tenant setting is absent. Request routes resolve membership through `withMemberTransaction`; the worker uses the system-only `withTenantTransaction`. Identity lookups and session storage use a separate `saas_auth` role that never sees tenant business data. Tenant provisioning and invitation creation are owner-only and never reachable from the API.

## Application skeleton

`apps/api` and `apps/worker` contain the first request layer. `POST /v1/auth/login` verifies an email and password with Argon2id, resolves the tenant by slug through the auth role, and issues an opaque `saas_session` cookie plus a CSRF token. Identity is global (`app_user.email` is unique) and memberships are per tenant, so the same password signs a user in to each tenant it belongs to. `POST /v1/auth/invitations/accept` consumes a one-time invitation, activates the invited membership and signs the user in; a first-time invitee sets a password, while an active user invited to a second tenant verifies its existing one. Protected routes read the session cookie only, verify the hashed session server-side, then call `withMemberTransaction` from `@saasmodels/db` with the session's tenant and user: both IDs are validated, the active membership role resolves first, then platform access, the module entitlement and the role permission run through the runtime role, and the caller's query runs in the same transaction. The context route returns the resolved role, its canonical permissions and only the modules effective under both entitlement and role, each with its catalog name and sort order, and is sent `Cache-Control: no-store`. State-changing requests require an exact Origin match, logout requires the session CSRF token, login is rate-limited per source address and per email, and every `/v1/auth/*` response is `Cache-Control: no-store`. The worker exports `runTenantJob` on the system-only `withTenantTransaction` without a queue or polling loop.

`GET /v1/people/export` is the first production module route and is available without proof-route enablement. It is gated by `withMemberTransaction` with `{ module: 'people', operation: 'read' }`, streams the seven identity fields `person_id`, `employee_code`, `first_name`, `last_name`, `display_name`, `work_email` and `phone` from a server-side cursor in batches, and commits a `people.directory.exported` audit row before the first byte. Tenant scope is RLS; no `tenant_id` filter is passed, and query or header overrides are ignored. The runtime role has column-level `SELECT` on exactly those fields plus `deleted_at`, and no table-level `SELECT` on `person`. CSV output is RFC 4180 with CRLF and formula-prefix mitigation; the response is `text/csv; charset=utf-8` with `no-store`, `nosniff` and no `Content-Length`.

`apps/web` is a React 19 + Vite single-page app. It has `/login`, `/app` and `/app/people`, a small History API router with no redirect parameter, and no routing library. In development and preview, Vite serves it on port 3000 and proxies `/v1` and `/health` to the API on 127.0.0.1:3001; production is expected to serve the bundle and API from one origin behind an edge or reverse proxy, with SPA fallback for application paths. The browser holds only the HttpOnly session cookie; the CSRF token lives in module memory for sign-out, and the theme is the only persistent preference. Navigation is built from the server's effective modules: People is a screen, while other effective modules are labelled as not yet shipped and are not clickable. `/app/people` is an empty state with a read/write badge, no People fetch, no data entry, no import/export and no fake rows; a member without readable People sees an access state instead. Client rendering is not an authorization boundary. One Playwright/Chromium journey runs against the built output, a disposable PostgreSQL database and an in-process API; it is declared in CI but the workflow has never run.

Proof routes are disabled by default and enabled only by tests. There is no People data-entry/CRUD screen, export button, invitation or password-reset UI, or screen for any module other than the empty People state. The export has no filters, column selection, date range, Client or Work variant, asynchronous/background mode, signed URL, storage, export history, dedicated export permission or rate limit; full-suite export and re-import are not built. Scope enforcement, employee self-scope, role administration, seat enforcement, password reset, MFA, OAuth, email delivery, tenant switching, device list, session rotation and distributed rate limiting are not implemented. Authenticated access denials on gated routes are audited as `authorization.denied`; unauthenticated requests and non-access failures are not. Do not treat this skeleton as a production authentication layer or the directory export as a complete portability feature.

Provisioning and entitlement changes are owner-only libraries used by the `db:provision` CLI; invitations are created by the owner-only `db:invite` CLI. None is routed through the API.

## What comes next

1. Add scope authorization and employee self-scope, plus role administration and seat enforcement, on top of the M0 role policy; then password reset with email delivery, MFA, session rotation/device lists and distributed rate limiting.
2. Build the People vertical: person, employment, salary structure, payroll run, payslip.
3. Build Switch against CSV first, then greytHR; prove reconciliation before adding a second connector.
4. Put one design partner's migrated history through a sandbox rehearsal.
5. Prove second-module enablement on a public tenant once CRM leaves `planned`; M0 proves the same configuration path on an internal tenant with an internal-source entitlement.

## Related documents

- [`../docs/product-blueprint.md`](../docs/product-blueprint.md) — market, product scope, pricing, roadmap.
- [`../docs/migration-blueprint.md`](../docs/migration-blueprint.md) — migration stages, staging model, error contract, rollback.

## Not in this repository

Credentials, customer data, production configuration, signing keys and design-partner documents. None of those belong in Git.
