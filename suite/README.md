# SaaSModels One — Suite Engineering

This directory is the engineering project for **SaaSModels One**, the commercial product. It is deliberately separate from the marketing site at the repository root.

> Status: **M0 foundation, M1 started** · October 2026
> The database, access helpers, a minimal API/worker request layer, membership verification, audited provisioning/entitlements, email/password login, opaque server-side sessions, one-time invitation acceptance, server-side role authorization for People and Work, authenticated access-denial audit, and a streamed People directory CSV export with column-level runtime grants and pre-disclosure export audit exist. A React 19 + Vite signed-in shell with real sign-in and sign-out and entitlement-and-role-filtered module navigation exists, proved by one local Playwright browser journey. A working-tree secret scanner covering tracked and untracked non-ignored regular files, production dependency audit, schema/privilege inventory, CI workflow contract test, draft threat model and interim M0 evidence pack exist. M1's first slice is the **database half of scope authorization** (`0012_people_scope.sql`): `membership_scope`, the `person.user_id` link and restrictive scope policies on `person` and `employment`, tested by `tests/scope.test.ts` and recorded in [`docs/adr/0007-people-scope.md`](docs/adr/0007-people-scope.md). Its second slice is the **owner-only authoring path** (`packages/db/src/scope.ts` and `pnpm db:scope`), which writes the link and the scope rows from the owner connection, audits each change in the same transaction and is tested by `tests/scope-admin.test.ts`; it changes no schema, no policy and no grant. Its third slice is the **first request-layer consumer**: `GET /v1/people`, a paginated and searchable directory page whose rows are narrowed by those policies because the member transaction sets `app.user_id`, plus the People directory screen in `apps/web` that renders it, tested by `tests/people.test.ts` and by the browser journey. Its fourth slice is the **core-identity write path**: `POST /v1/people` and `PATCH /v1/people/:id`, CSRF-verified, gated by the People write permission, limited to the six identity fields, narrowed on the write side by the same 0012 policies, audited with field names only, with an inline add/edit panel in the directory screen, tested by `tests/people-write.test.ts` and covered by the browser journey, and recorded in [`docs/adr/0008-people-write-path.md`](docs/adr/0008-people-write-path.md). The CI workflow has never executed a step: a GitHub remote exists, but the account is annotated as locked for billing. Scope values in `/v1/context` or in any UI label, a scope read or administration API, any People delete, restore, status, placement, employment, compensation or user-linking write, People import, role administration, seat enforcement, employee self-scope as a usable permission, password reset, MFA, OAuth, email delivery, tenant switching, session rotation and device lists, further production module routes, queues, audit read APIs, an export button, invitation UI and other module screens are not implemented. M0 has not exited.

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
      0011_outbox.sql           domain_event lease columns, claim helpers and saas_worker grants
      0012_people_scope.sql     person/user link, membership_scope, scope helpers and policies
    seed/
      0001_modules.sql       idempotent module catalog and dependency seed
```

## Non-negotiable rules

1. **Tenant isolation is a database property.** Every tenant business table carries `tenant_id`, has RLS enabled and has a `tenant_isolation` policy; cross-tenant references are blocked by composite foreign keys. The identity tables `auth_session` and `invitation` are the only exceptions: they carry `tenant_id` but deliberately have no RLS, the runtime role has no privilege on either, and they are reached only through security-definer auth functions.
2. **Module access is an entitlement, checked on the server.** A licensed module is not a UI flag. Every module request resolves entitlement + role + scope in that order; M0 implements the first two, and M1's `0012_people_scope.sql` puts the third in the database as restrictive RLS policies rather than in the request layer — so a query that forgets a scope predicate cannot return out-of-scope rows, and only a transaction that set `app.user_id` is narrowed — which is how `GET /v1/people` and the directory export are narrowed today, with no scope predicate in application code. The database helpers `app.has_module_read('<code>')` and `app.has_module_write('<code>')` enforce tenancy and entitlement, not role; they are the second line of defence. `app.has_active_module('<code>')` remains as a compatibility delegate to the write helper.
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
# owner-only scope authoring (0012): needs an accepted invitation (active owner) and directory rows,
# so the freshly provisioned synthetic tenant above refuses it until a person and a member exist
pnpm db:scope link --tenant synthetic-co --person EMP001 --user staff@example.test --actor owner@example.test
pnpm db:scope set  --tenant synthetic-co --user manager@example.test --actor owner@example.test --org-unit <uuid>
pnpm db:scope show --tenant synthetic-co --user manager@example.test
```

The module catalog is reference data, seeded once and updated by migration. A tenant is then granted entitlements; the catalog itself is not writable by the runtime role. Provisioning, entitlement changes and scope authoring run through owner-only libraries on `DB_OWNER_URL` and audit in the same transaction; none of them is reachable from the API. `db:scope` prints ids and labels only, never a token or a connection string, and refuses any actor without an active `owner` membership in that tenant. See [`db/README.md`](db/README.md).

The migrations and seed are applied by the repository harness against a real local PostgreSQL 17 instance, with fresh-apply, checksum, role-privilege, access-helper, RLS policy, people-scope, scope-administration, membership, provisioning, audit, authentication, People-directory-export, People-directory read-path and schema-inventory suites. The web unit tests and one Playwright browser journey run locally; the journey creates its own disposable database and runs the built client through Vite preview with an in-process API. `scripts/secret-scan.ts` scans tracked and untracked non-ignored regular files (not history, ignored files, packed objects or remote state), and `pnpm audit --prod --audit-level high` checks production dependencies. The CI workflow at the repository root declares a PostgreSQL 16/17 matrix and the browser job, but no job has executed a step: the GitHub remote exists, and the account is annotated as locked for billing, so PostgreSQL 16 and CI browser execution are unproven. A restore drill is still required before real data. See `db/README.md`, `docs/release/m0-evidence.md` and `docs/roadmap.md`.

The application connects as a role that does **not** own the tables. Tenant and user context are set per transaction:

```sql
set local app.tenant_id = '<tenant-uuid>';
set local app.user_id = '<user-uuid>';
```

RLS denies all rows when the tenant setting is absent. Request routes resolve membership through `withMemberTransaction`; the worker uses the system-only `withTenantTransaction`. Identity lookups and session storage use a separate `saas_auth` role that never sees tenant business data. Tenant provisioning and invitation creation are owner-only and never reachable from the API.

## Application skeleton

`apps/api` and `apps/worker` contain the first request layer. `POST /v1/auth/login` verifies an email and password with Argon2id, resolves the tenant by slug through the auth role, and issues an opaque `saas_session` cookie plus a CSRF token. Identity is global (`app_user.email` is unique) and memberships are per tenant, so the same password signs a user in to each tenant it belongs to. `POST /v1/auth/invitations/accept` consumes a one-time invitation, activates the invited membership and signs the user in; a first-time invitee sets a password, while an active user invited to a second tenant verifies its existing one. Protected routes read the session cookie only, verify the hashed session server-side, then call `withMemberTransaction` from `@saasmodels/db` with the session's tenant and user: both IDs are validated, the active membership role resolves first, then platform access, the module entitlement and the role permission run through the runtime role, and the caller's query runs in the same transaction. The context route returns the resolved role, its canonical permissions and only the modules effective under both entitlement and role, each with its catalog name and sort order, and is sent `Cache-Control: no-store`. State-changing requests require an exact Origin match, logout and both People write routes require the session CSRF token, login is rate-limited per source address and per email, and every `/v1/auth/*` response is `Cache-Control: no-store`. The worker exports `runTenantJob` on the system-only `withTenantTransaction` without a queue or polling loop.

`GET /v1/people/export` is the first production module route and is available without proof-route enablement. It is gated by `withMemberTransaction` with `{ module: 'people', operation: 'read' }`, streams the seven identity fields `person_id`, `employee_code`, `first_name`, `last_name`, `display_name`, `work_email` and `phone` from a server-side cursor in batches, and commits a `people.directory.exported` audit row before the first byte. Tenant scope is RLS; no `tenant_id` filter is passed, and query or header overrides are ignored. Since 0012 the same transaction also sets `app.user_id`, so a scoped member's export is narrowed by the restrictive policies; the CSV carries no scope label. The runtime role has column-level `SELECT` on exactly those fields plus `deleted_at`, and no table-level `SELECT` on `person`. CSV output is RFC 4180 with CRLF and formula-prefix mitigation; the response is `text/csv; charset=utf-8` with `no-store`, `nosniff` and no `Content-Length`.

`GET /v1/people` is the first route to read the directory for a screen. It is gated the same way and returns exactly the `PeopleListResponse` contract — `items` of seven directory fields, a JSON-number `total`, and the effective `page` and `pageSize` — ordered by `lower(display_name), id` so paging is deterministic. `q` is a trimmed, literal, case-insensitive substring over `display_name`, `employee_code` and `work_email` through `strpos(lower(...), lower($n))`, so `%` and `_` are data, not wildcards, and no SQL is built dynamically. `page` defaults to 1 and `pageSize` to 20 with a 50 ceiling; a repeated, non-integer, out-of-range or over-length parameter is a `400 INVALID_QUERY` before any query runs, and a page past the end returns an empty `items` array with the true `total`. Scope narrowing is left entirely to RLS: the route sets no scope predicate in SQL or TypeScript. Every response, including denials and `400`s, is `Cache-Control: no-store`, and a successful read writes no audit row.

`POST /v1/people` and `PATCH /v1/people/:id` are the first routes that change stored data, and they are gated by `withMemberTransaction` with `{ module: 'people', operation: 'write' }`, so `people.write` is required before the body is parsed — a malformed body from a role that cannot write is a `ROLE_DENIED`, not a `400`. Both first require a valid session and a matching `x-csrf-token`, checked with the same timing-safe comparison as logout, and the `onRequest` origin hook still refuses another origin ahead of them. Both accept only the six identity fields — `firstName`, `lastName`, `displayName`, `employeeCode`, `workEmail`, `phone` — through the closed `PeopleCreateInput` / `PeopleUpdateInput` contracts in `packages/contracts/src/people.ts`, and build their column list from a server-side map, so any other key, including `id`, `tenantId`, `status`, `legalEntityId`, `orgUnitId`, `userId`, `deletedAt`, `personalEmail` and `dateOfBirth`, is a `400 INVALID_BODY` with nothing echoed. Create requires a non-empty first name, derives `displayName` from the trimmed names when absent, and refuses a new unplaced person for a member who has scope rows with `403 SCOPE_DENIED`, because a fresh record has no placement for `scope_insert` to approve. The API generates the person UUID; the insert carries `id` and `tenant_id` (from `app.current_tenant_id()`) and **no `RETURNING`** — the restrictive `scope_read` policy cannot observe a row the same command created, so `INSERT ... RETURNING` fails `42501` — and the route then reads the seven directory fields back inside the same transaction, answers `201`, and fails closed with the sanitized `500` if that read returns nothing. Update reads the row first, writes only the columns whose effective value differs, returns the stored row with no `UPDATE` and no audit when nothing changed, and answers one uniform `404 PERSON_NOT_FOUND` for an unknown, malformed, cross-tenant, soft-deleted or out-of-scope id. A `23505` becomes `PERSON_CODE_TAKEN`, `PERSON_EMAIL_TAKEN` or `PERSON_CONFLICT` on either route, without repeating the value. `person.created` / `person.updated` are appended in the same transaction with sorted field names only in metadata, and an audit failure rolls the write back to a sanitized `500`. Concurrent edits are last-write-wins; there is no version column, no delete, no restore and no status change. `saas_runtime` holds 8 `SELECT`, 8 `INSERT` and 6 `UPDATE` column privileges on `person` (22 in total, `id` insertable but not updatable), no table-level privilege and no `DELETE`. Every response is `Cache-Control: no-store`; scope and role denials audit as `authorization.denied`, a `SCOPE_DENIED` or a `404` does not. See [ADR 0008](docs/adr/0008-people-write-path.md).

`apps/web` is a React 19 + Vite single-page app. It has `/login`, `/app` and `/app/people`, a small History API router with no redirect parameter, and no routing library. In development and preview, Vite serves it on port 3000 and proxies `/v1` and `/health` to the API on 127.0.0.1:3001; production is expected to serve the bundle and API from one origin behind an edge or reverse proxy, with SPA fallback for application paths. The browser holds only the HttpOnly session cookie; the CSRF token lives in module memory for sign-out, and the theme is the only persistent preference. Navigation is built from the server's effective modules: People is a screen, while other effective modules are labelled as not yet shipped and are not clickable. `/app/people` is the directory screen: it keeps the `People` heading and the read/write badge derived from `canWrite`, and adds the fetch of `GET /v1/people`, renders the accessible `People directory` table of Name, Employee code, Work email and Phone, an `aria-live` result count, a search form that resets to page 1, Previous/Next paging and loading, retryable error and empty states, with copy that never claims the workspace holds nobody and one line stating that the view is limited to the member's role and scope. When the context reports `canWrite`, the toolbar gains an **Add person** control and each row an **Edit** action that opens an inline panel — not a modal — with the six identity fields, `maxLength` taken from the same contract constants, Save and Cancel disabled while a request is in flight, edit pre-filled from the row, and a polite live region announcing `Person created.` or `Person updated.` after a successful save reloads the current query and page. Each typed API failure (`PERSON_CODE_TAKEN`, `PERSON_EMAIL_TAKEN`, `SCOPE_DENIED`, `INVALID_BODY`, `CSRF_INVALID`, network) has its own copy, so no raw server message reaches the page, and a `401` is still handled globally by returning to sign-in. Writes go through the same `request` helper with a JSON body and the in-memory CSRF token in `x-csrf-token`. There is no delete, restore, status, placement or employment control, no import, no export button, no bulk edit and no fake rows. It shows no scope label, because the runtime cannot read `membership_scope`. Rows arrive already narrowed by the database; the client filters nothing. A member without readable People sees an access state instead. Every value is rendered as a React text node, nothing is written to browser storage beyond the theme, and the document has no horizontal overflow at 390, 768 or 1440 px — the table wrapper scrolls instead and the form grid folds to one column. Client rendering is not an authorization boundary. One Playwright/Chromium journey runs against the built output, a disposable PostgreSQL database and an in-process API; it is declared in CI but the workflow has never run.

Proof routes are disabled by default and enabled only by tests. There is no People delete, restore, status, placement, employment or bulk-edit screen, no import, no export button, no invitation or password-reset UI, and no screen for any module other than the People directory. The write path covers core identity only: there is no per-person detail route, no route that writes `status`, either placement column, `user_id`, `personal_email`, `date_of_birth`, `gender` or any employment, compensation or statutory column, and no delete or restore counterpart to create. The export has no filters, column selection, date range, Client or Work variant, asynchronous/background mode, signed URL, storage, export history, dedicated export permission or rate limit; full-suite export and re-import are not built. Scope values are not exposed in `/v1/context`, in any UI label or through any read API — the database narrows rows and the client only sees the result — and project and client scope, employee self-scope as a usable permission, scope or role administration in the application, seat enforcement, password reset, MFA, OAuth, email delivery, tenant switching, device list, session rotation and distributed rate limiting are not implemented. Authenticated access denials on gated routes are audited as `authorization.denied`; unauthenticated requests and non-access failures are not. Do not treat this skeleton as a production authentication layer or the directory export as a complete portability feature.

Provisioning and entitlement changes are owner-only libraries used by the `db:provision` CLI; invitations are created by the owner-only `db:invite` CLI; the person/user link and a membership's scope rows are written by the owner-only `db:scope` CLI (`packages/db/src/scope.ts`), which audits each change in its transaction. None is routed through the API, and none takes a runtime or auth connection.

## What comes next

1. Finish what 0012 started: the request-layer read is done, and so is the first write — `POST /v1/people` and `PATCH /v1/people/:id` put core identity behind `people.write`, narrowed and refused by the same scope policies. The next steps are the rest of the directory lifecycle that this slice deliberately left out — placement onto a legal entity or org unit, status and soft-delete with an approval in front of them, and the person/user link and scope administration as an application surface rather than only the owner-only `db:scope` CLI — plus scope values in `/v1/context` with an honest UI label and an audit read surface for grant review. Then role administration and seat enforcement, employee permissions, and project or client scope. After that, password reset with email delivery, MFA, session rotation/device lists and distributed rate limiting.
2. Build the People vertical: person, employment, salary structure, payroll run, payslip.
3. Build Switch against CSV first, then greytHR; prove reconciliation before adding a second connector.
4. Put one design partner's migrated history through a sandbox rehearsal.
5. Prove second-module enablement on a public tenant once CRM leaves `planned`; M0 proves the same configuration path on an internal tenant with an internal-source entitlement.

## Related documents

- [`../docs/product-blueprint.md`](../docs/product-blueprint.md) — market, product scope, pricing, roadmap.
- [`../docs/migration-blueprint.md`](../docs/migration-blueprint.md) — migration stages, staging model, error contract, rollback.

## Not in this repository

Credentials, customer data, production configuration, signing keys and design-partner documents. None of those belong in Git.
