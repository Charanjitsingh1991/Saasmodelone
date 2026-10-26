# Database

Target: PostgreSQL 16+ (17 recommended), extensions `pgcrypto` and `citext`.

## Apply

Use the repository harness from the project root. It applies migrations in filename order and records checksums; do not apply files manually in development.

```bash
pnpm db:bootstrap
pnpm db:migrate
pnpm db:seed
pnpm db:provision --name "Synthetic Co" --slug synthetic-co --region test-region \
  --owner-email owner@example.test --owner-name "Synthetic Owner" --module people
pnpm db:invite --tenant synthetic-co --email owner@example.test --days 7
```

Every file is wrapped in a transaction. Do not edit an applied migration; add the next numbered file. The runner refuses an applied file whose checksum changed and records interrupted or failed migrations for manual resolution. A failed apply rolls its transaction back and writes a `failed` ledger row that the runner never retries, so after fixing the file the resolution is to delete exactly that row — `delete from infra.schema_migration where version = '<file>.sql' and status = 'failed';` as `saas_owner`, then re-run `pnpm db:migrate`. There is no CLI subcommand for it, and an `applied` row is never edited or deleted. If the failing file had already advanced the schema, a rebuild from the documented five-command path is safer than a hand-patched ledger; `tests/harness.test.ts` proves that a fresh apply of the checked-in files produces the intended schema, so a truncated or patched ledger cannot hide a broken baseline. Seeds are idempotent and may be rerun; they are not a substitute for the administrative path that changes module status.

The reproducible local developer database is all five commands above in that order: `db:bootstrap`, `db:migrate` and `db:seed` alone leave the database with **no tenant and no user**, so nobody can sign in and every business table is empty; `db:provision` and `db:invite` are what put a synthetic tenant, owner and entitlement in place.

`db:provision` is the only tenant-creation path in M0. It connects with `DB_OWNER_URL`, never the runtime URL, prints only the new tenant and owner IDs, and is not exposed by the API. It creates the tenant, owner user, owner membership, initial entitlements and the `tenant.provisioned` audit event in one transaction; a failure rolls all of it back.

`db:invite` creates a one-time invitation for a user with an invited membership in the tenant. It connects with `DB_OWNER_URL`, never the runtime URL, validates the tenant slug, email and expiry window (1–30 days, default 7), revokes older unconsumed invitations for the same membership, and prints the invitation ID, tenant ID, email, expiry and the raw token exactly once with an out-of-band delivery warning. It does not print a password or connection string and is not exposed by the API. The invited user may be a first-time invitee or an already-active user being added to a second tenant; an active user must already hold a password, since acceptance reuses the existing credential rather than setting one.

`db:scope` is the owner-only authoring path for the 0012 scope layer: it writes `person.user_id` and `membership_scope`, the two things nothing else can write. It connects with `DB_OWNER_URL`, never the runtime URL, and is not exposed by the API.

```bash
pnpm db:scope link   --tenant <slug> --person <employee-code|uuid> --user <email> --actor <email>
pnpm db:scope unlink --tenant <slug> --person <employee-code|uuid> --actor <email>
pnpm db:scope set    --tenant <slug> --user <email> --actor <email> \
  (--legal-entity <code|uuid> … | --org-unit <uuid> … | --tenant-wide)
pnpm db:scope show   --tenant <slug> --user <email>
```

`--actor` must resolve to a user holding an active `owner` membership in that tenant, and `set` is a full replacement of one membership's scope rows: the resulting set is written in one transaction, an identical set is a no-op, and `--tenant-wide` means "no rows" and cannot be combined with a scope list. Scope targets must exist inside the same tenant and not be soft-deleted; duplicates are refused; an `employee` membership is refused because a scope row can never widen self-scope. `show` is the read side used before and after a change and prints the membership role, status and each scope row with its label (legal-entity code and name, or org-unit name).

Every accepted change appends `person.user.linked`, `person.user.unlinked` or `membership.scope.changed` in the same transaction as the write, so an audit failure rolls the change back; a refusal or a no-op writes nothing. Output is JSON with ids and labels only — no tokens, no passwords, no connection strings. Org units have no code, so `--org-unit` takes a uuid. The library behind it is `packages/db/src/scope.ts` and the tests are `tests/scope-admin.test.ts`.

## Database roles

`pnpm db:bootstrap` creates four roles:

- `saas_owner` owns the database, schemas and tables and runs migrations, seeds and provisioning. It is not the application role.
- `saas_runtime` is a login role that does not own tables and does not have `BYPASSRLS`. It serves tenant business data.
- `saas_auth` is a login role that does not own tables and does not have `BYPASSRLS`. It serves identity lookups and session storage only.
- `saas_worker` is a login role that does not own tables and does not have `BYPASSRLS`. It drains the `domain_event` outbox and holds no table or column privilege at all.

### Runtime role

The runtime grant allowlist is [packages/db/sql/runtime-grants.sql](../../packages/db/sql/runtime-grants.sql). It and the auth allowlist [packages/db/sql/auth-grants.sql](../../packages/db/sql/auth-grants.sql) are reapplied after every migration. The runtime grants:

- `USAGE` on `public` and `app`, but no `CREATE`.
- `SELECT` on the module catalog, dependencies and entitlements.
- Full `SELECT, INSERT, UPDATE, DELETE` on exactly two M0 proof tables: `employment` (People) and `project` (Work). `public.person` receives column-level privileges only: `SELECT` on `id, employee_code, first_name, last_name, display_name, work_email, phone, deleted_at`; `INSERT` on `id, tenant_id, employee_code, first_name, last_name, display_name, work_email, phone`; and `UPDATE` on the six identity fields alone. That is 8 + 8 + 6 = 22 column privileges and still no table-level privilege of any kind on `person`. `deleted_at` is read only to exclude soft-deleted rows and is never exported or written, `id` is insertable so a create can name the row it makes and is not updatable so no write can retarget a row, and every other person column — status, placement, `user_id`, the timestamps, the import columns, personal contact and demographics — stays owner-only. `client`, `legal_entity`, `tenant`, `app_user` and every other tenant table stay owner-only. Further tables gain grants per command as their API paths land.
- `INSERT` on `audit_event` only. The runtime can append audit rows through `appendAuditEvent`, including `authorization.denied` and `people.directory.exported` rows, but has no `SELECT`, `UPDATE` or `DELETE` on the audit trail. There is no grant on `membership`, `membership_scope`, `app_user` or `tenant`, and none on `auth_session` or `invitation`; those are auth-role objects.
- `EXECUTE` on `app.current_tenant_id()`, `app.current_member_role()`, the four access helpers (`has_platform_access`, `has_module_read`, `has_module_write`, `has_switch_access`) and the `has_active_module` compatibility alias (an exact delegate to `has_module_write`). From 0012 it also has `EXECUTE` on the five public scope helpers `app.current_user_id()`, `app.current_person_id()`, `app.person_visible(uuid)`, `app.person_in_scope(uuid)` and `app.person_placement_in_scope(uuid, uuid)`; the internal scope helpers (`current_active_membership_id`, `member_has_scope`, `org_unit_is_in_scope_subtree`, `member_placement_matches`) are called only by owner-owned functions and stay revoked from the runtime role. Administrative procedures (`enable_tenant_rls`, `add_updated_at`, `apply_module_policies`) and trigger functions are revoked.
- The person column grants are the only column-level business-data privileges. The export query selects the seven identity fields plus `deleted_at`, filters `deleted_at is null`, orders by `employee_code nulls last, id`, and passes no `tenant_id` predicate; RLS remains the tenant boundary. The export audit is a separate member transaction that commits before the route sends headers. The write path uses the same column set and nothing wider: a create names its own `id` and `tenant_id` in the `INSERT` (no `RETURNING`, because the restrictive `scope_read` policy cannot observe a row the same command made — see [ADR 0008](../docs/adr/0008-people-write-path.md)) and then reads the row back inside the same member transaction; an update sets only the six identity columns, leaving `id`, `tenant_id` and every other column untouched. The 0012 `scope_insert` and `scope_update` policies decide placement visibility for both, so a column grant is never an authorization decision on its own.

There is no blanket `GRANT ON ALL TABLES` and no default privileges grant. The runtime cannot write the module catalog or its dependencies, cannot truncate, and cannot create objects. Membership is resolved through the security-definer helper `app.current_member_role()`, not a table grant.

Then, per transaction:

```sql
set local app.tenant_id = '<tenant-uuid>';
set local app.user_id = '<user-uuid>';   -- request paths only
```

RLS denies all tenant rows when `app.tenant_id` is unset. Request routes use `withMemberTransaction`, which validates both UUIDs, sets both settings transaction-locally, resolves the active membership role first, then checks platform access, the module entitlement and the role permission on the same connection. A non-member or suspended member receives `MEMBERSHIP_DENIED` before the platform check, so tenant existence and status are not disclosed. A member of a suspended, closed or deleted tenant receives `PLATFORM_ACCESS_DENIED`. Role authorization is application-layer: grants and RLS enforce tenancy and module entitlement, not the membership role, so a route that skips `withMemberTransaction` loses role enforcement even when the database checks still pass. `withTenantTransaction` remains the system/background path; it does not check membership or role and must not be used by request routes. The runtime role must not be the table owner and must not have `BYPASSRLS`.

Scope authorization (0012) sits under that stack in the database, not in the transaction helper. A member transaction has set `app.user_id`, so the restrictive `scope_*` policies on `person` and `employment` apply; a system transaction has not, so it sees the whole tenant and scope narrows nothing. The resolution order inside the helpers is fixed: no `app.user_id` → no narrowing; no tenant or no active membership → denied; `employee` → own linked person for read, never for write; a role outside the six manageable roles → denied; zero `membership_scope` rows → tenant-wide; otherwise the placement must match the member's legal entity or their org unit or any descendant of it. An unplaced person is visible only to a tenant-wide member. The unset-`app.user_id` case is a deliberate, documented residual pinned by `tests/scope.test.ts`; see [`adr/0007-people-scope.md`](../adr/0007-people-scope.md).

Tenant creation runs through the owner-only `provisionTenant` library and `db:provision` CLI. It is never reachable from the API. Membership discovery for login is scoped by a tenant slug, not a global email lookup.

## Auth role

`saas_auth` receives no table privileges outside this allowlist:

- `SELECT (id, email, display_name, status, last_login_at)` and `UPDATE (password_hash, status, last_login_at)` on `app_user`. The role cannot read `password_hash` through a table grant; the hash is readable only through the security-definer `app.auth_credentials(uuid, citext)`.
- `SELECT, INSERT, UPDATE` on `auth_session`.
- `SELECT (id, tenant_id, user_id, token_hash, expires_at, accepted_at, revoked_at)` and `UPDATE (accepted_at)` on `invitation`.
- `EXECUTE` on `app.auth_tenant_by_slug(citext)`, `app.auth_tenant_by_id(uuid)`, `app.auth_credentials(uuid, citext)`, `app.auth_membership_status(uuid, uuid)` and `app.auth_activate_membership(uuid, uuid)`.

The auth role has no table privilege on `membership`: status is reachable only through `app.auth_membership_status(uuid, uuid)`, and activation only through `app.auth_activate_membership(uuid, uuid)`.

It has no privilege on `tenant`, the module catalog, entitlements, audit or any business table, and no DDL or `TRUNCATE`. The auth helper functions are security-definer, use an empty `search_path`, and are revoked from `PUBLIC` and `saas_runtime`; the lookup and status helpers are stable. `app_user`, `membership`, `auth_session` and `invitation` are revoked from `saas_runtime`.

`auth_tenant_by_slug` and `auth_tenant_by_id` are the minimum needed to resolve a tenant before a session exists. `auth_credentials`, `auth_membership_status` and `auth_activate_membership` exist because the column grants deliberately exclude `password_hash`, and because reading membership status or activating an invited membership would otherwise require table privileges the auth role must not hold. EXECUTE on all five helpers is granted from `packages/db/sql/auth-grants.sql` after migrations, not from a migration, so the identity allowlist stays in one place.

Identity is global: `app_user.email` is unique across the platform, while memberships are per tenant. Login selects the user's membership by tenant slug, so the same email and password sign in to each tenant the user belongs to.

`auth_session` and `invitation` are deliberately not tenant-RLS-scoped. A session must be resolvable before `app.tenant_id` exists, and an invitation token is a pre-authentication credential. Forcing tenant RLS on either would require an owner-only or security-definer lookup keyed by tenant and token; no FORCE is enabled in a migration, and no such helper is tested. The auth role's grant allowlist and hashed random tokens are the boundary; tenant and membership checks still run in `withMemberTransaction` after session resolution.

## Worker role

`saas_worker` is created by `pnpm db:bootstrap` with `SAAS_WORKER_PASSWORD` and reached through `DB_WORKER_URL` (tests use `TEST_DB_WORKER_URL`). It is the narrowest role in the system:

- `CONNECT` on the database, `USAGE` on `public` and `app`, no `CREATE` anywhere, no table or column privilege on anything, including `domain_event`, and no DDL or `TRUNCATE`.
- `EXECUTE` on exactly four `0011_outbox.sql` helpers — `app.outbox_claimed_guard(integer, text, integer, integer)`, `app.outbox_claim(integer, text, integer, integer)`, `app.outbox_mark_published(uuid, text)` and `app.outbox_record_failure(uuid, text, integer, interval, text)` — plus the four access helpers the tenant transaction gate calls: `app.current_tenant_id()`, `app.has_platform_access()`, `app.has_module_read(text)` and `app.has_module_write(text)`. It has no `EXECUTE` on `app.current_member_role()`, `has_switch_access()`, `has_active_module()`, any `app.auth_*` helper, any administrative procedure, or any 0012 scope helper (`current_user_id`, `current_person_id`, `person_visible`, `person_in_scope`, `person_placement_in_scope` and the four internal ones); 0012 grants the worker nothing.

The four outbox helpers are owner-owned `SECURITY DEFINER` functions with `set search_path = ''`, fully qualified names, no dynamic SQL, argument range validation in one shared guard, and `EXECUTE` revoked from `PUBLIC`. Each one filters explicitly on `app.tenant_id` and raises when that setting is unset or not a valid UUID; because the owner bypasses RLS by table ownership, that filter — not a policy — is the tenant boundary, and a foreign event id raises rather than returning zero rows.

Unlike the runtime and auth allowlists, the worker grants live in the migration rather than in `packages/db/sql/*.sql`. The blanket revokes in `runtime-grants.sql` target only `public` and `saas_runtime`, so they do not touch `saas_worker` and the grants survive every re-apply. `tests/schema-inventory.test.ts` asserts the worker's executable-function list and its zero table privileges exactly, which is where any drift becomes a test failure.

Delivery is at-least-once: `attempts` increments at claim, an expired lease lets another worker re-claim, and `mark_published` and `record_failure` act only while the caller's lease timestamp is still live, so a late write from a lost lease is refused. `dead` after `max_attempts` is terminal. Handlers must be idempotent.

## Conventions

- `id uuid` primary key, application-generated UUIDv7; `gen_random_uuid()` is a fallback.
- Every tenant business table has `tenant_id`, RLS enabled and a `tenant_isolation` policy. The identity tables `auth_session` and `invitation` are the only exceptions: they carry `tenant_id` but have no RLS, the runtime role has no privilege on either, and they are reached only through security-definer auth functions. Missing `app.tenant_id` means no rows for RLS tables.
- Cross-tenant parent references use composite `(tenant_id, id)` foreign keys. Parent tables expose `unique (tenant_id, id)`.
- Money: `bigint` minor units plus `currency char(3)`. Never `float`/`real`.
- Percentages: `numeric(7,4)`.
- Timestamps: `timestamptz`. Dates: `date`.
- Soft delete: `deleted_at timestamptz`, except append-only records.
- Sensitive identifiers: application-encrypted ciphertext plus a `last4` fragment. Never plaintext tax IDs, social-insurance numbers or bank account numbers.
- Money: `bigint` minor units plus a required ISO currency. Currency is never defaulted in the schema.
- Jurisdiction, statutory identifier types, payroll rule packs, their rules, the module catalog and module dependencies are global reference data. Give the runtime role `select` only; seed and change them through a reviewed administrative path.
- Module entitlements are tenant data. The runtime may read them; changes come from provisioning and the owner-only `grantEntitlement` / `cancelEntitlement` library, never from the API, and every change is audited. Module tables carry restrictive RLS policies built on `app.has_module_read(code)` / `app.has_module_write(code)`, which require an active, non-deleted tenant through `app.has_platform_access()`; `app.has_active_module(code)` is the write alias. These are a second line of defence, not a replacement for the API policy check.
- Public provisioning licenses `available` and `preview` modules with source `contract`. A `planned` module is licensed only to an internal tenant (`tenant.is_internal`) with source `internal`; `retired` modules are never newly licensed. Catalog status changes remain a reviewed administrative action, not a runtime write.
- Membership roles are constrained to `owner`, `admin`, `hr`, `finance`, `manager`, `employee` and `auditor`. `app.current_member_role()` returns the role only for an active membership in the current tenant; a suspended membership or no membership returns null. Role authorization is enforced in the application layer by `withMemberTransaction` against the shared policy in `@saasmodels/contracts`; no grant or RLS policy checks the role. Scope authorization is a database property since 0012: legal entity and org unit (with the whole descendant subtree) through `membership_scope`, plus employee self-scope, applied by restrictive `scope_*` policies on `person` and `employment`. Project and client scope, role administration and seat enforcement are not built.
- `membership_scope` holds one row per member per scope value, with `scope_type` constrained to `legal_entity` or `org_unit` and a CHECK forcing exactly the matching typed column. Composite `(tenant_id, …)` foreign keys require `unique (tenant_id, id)` on `membership`. Neither `saas_runtime` nor `saas_worker` has any privilege on it: a member's scope is readable only through the security-definer helpers.
- Every runtime-readable table with a `person_id` column must carry a restrictive read policy calling `app.person_visible(person_id)`. `tests/scope.test.ts` derives the table set from the catalogue and asserts the policy per table, so a new person-child table without a scope policy fails the suite instead of quietly reading the whole tenant. The set today is exactly `employment`.
- `person` and `client` are shared directory records. A module may extend them but may not create a competing person or client. The runtime holds 8 `SELECT`, 8 `INSERT` and 6 `UPDATE` column privileges on `person` and no table-level privilege on it. The eight readable columns are the seven directory fields plus `deleted_at`, which is read only to exclude soft-deleted rows and is never exported or written; the eight insertable columns are `id`, `tenant_id` and the six identity fields, and the six updatable columns are the identity fields alone. `id` is insertable because the API generates the new row's UUID and names it in the insert — the restrictive `scope_read` policy refuses `INSERT ... RETURNING` on `person` (see [ADR 0008](../docs/adr/0008-people-write-path.md)) — and `id` is deliberately not updatable, so no write can move a row onto another identity. `tenant_id` is insertable only so a create can claim the row for the tenant already pinned in `app.tenant_id`; RLS and the isolation policy still decide which tenant's rows any statement can reach. There is no `DELETE` grant, no grant on `status`, the placement columns, the timestamps, the import columns, personal contact or demographics: those stay owner-only. `person.user_id` (0012) links a directory record to the `app_user` that signs in as it, one link per tenant enforced by a partial unique index, `ON DELETE SET NULL` so removing an identity never removes the directory row. The runtime has no grant on the column, so linking is an owner-only administrative action, reached by `pnpm db:scope` and by no API route.
- `audit_event` is append-only; updates and deletes raise an error. Provisioning and entitlement changes append audit rows in the same transaction as the change. Authenticated access denials append in their own best-effort transaction because platform access or membership may be the failing check. The People directory export appends one `people.directory.exported` row and commits it before the first CSV byte; if that append fails, the export sends no bytes. The runtime can insert audit rows only; it cannot read, update or delete them.
- Passwords are hashed with Argon2id (19,456 KiB, time cost 2, parallelism 1, 32-byte output) and never stored, logged or returned in plaintext.
- `auth_session` stores only the SHA-256 hash of a 32-byte random token (64 lowercase hex), never the token itself. The CSRF token is a separate 32-byte base64url value stored as-is. Sessions have a 12-hour absolute expiry and no sliding renewal, rotation or device list.
- `invitation` stores only the SHA-256 hash of a 32-byte token, is single-use, and expires after 7 days by default (1–30 days allowed). Creating a new invitation revokes older unconsumed rows for the same membership in the same transaction; there is no partial unique index. Invitation creation is not yet audited. Acceptance activates the invited membership and creates a session in one transaction; a first-time invitee sets a password, while an active user invited to a second tenant verifies its existing password, which is never replaced.
- `auth_session` and `invitation` are not tenant-RLS-scoped; they are reachable only by `saas_auth` through hashed-token lookups. Tenant and membership checks run after session resolution.
- `source_system`, `source_id`, `import_batch_id`, `imported_at` on importable production tables.

## Entity ownership

| File | Tables |
| --- | --- |
| `0001_core.sql` | tenant, app_user, membership, jurisdiction, legal_entity, org_unit, location, tax_registration, audit_event, domain_event, idempotency_key, document, approval_request |
| `0002_people.sql` | person, employment, statutory_identifier_type, person_identifier, bank_account, compensation, salary_component, salary_structure, salary_structure_line, payroll_rule_pack, payroll_rule, payroll_run, payroll_run_rule_pack, payslip, payslip_line, payroll_adjustment, leave_type, leave_balance, leave_request, attendance_day, holiday |
| `0003_work.sql` | client, client_contact, engagement, project, milestone, task, allocation, timesheet, timesheet_entry, deliverable, project_cost |
| `0004_content.sql` | content_item, content_version, asset, content_asset, document_room, document_room_member |
| `0005_money.sql` | proposal, proposal_line, contract, invoice, invoice_line, tax_line, payment, payment_allocation, credit_note, expense, vendor, vendor_bill |
| `0006_migration.sql` | import_batch, import_file, mapping_profile, import_row, import_issue, reconciliation |
| `0007_modules.sql` | platform_module, platform_module_dependency, module_entitlement |
| `0008_platform_access.sql` | tenant.is_internal, module_entitlement.read_until, app.has_platform_access(), app.has_module_read(), app.has_module_write(), app.has_switch_access(), app.has_active_module() (alias), app.apply_module_policies() and the module RLS policies |
| `0009_member_access.sql` | app.current_member_role() |
| `0010_identity.sql` | auth_session, invitation, app.auth_tenant_by_slug(), app.auth_tenant_by_id(), app.auth_credentials(), app.auth_membership_status(), app.auth_activate_membership() |
| `0011_outbox.sql` | domain_event lease columns (`status`, `lease_owner`, `lease_expires_at`, `next_attempt_at`), `domain_event_claim_idx`, app.outbox_claimed_guard(), app.outbox_claim(), app.outbox_mark_published(), app.outbox_record_failure() and the `saas_worker` grants |
| `0012_people_scope.sql` | person.user_id plus `person_user_uidx`, `unique (tenant_id, id)` on membership, membership_scope and its indexes, app.current_user_id(), app.current_person_id(), app.member_has_scope(), app.current_active_membership_id(), app.org_unit_is_in_scope_subtree(), app.member_placement_matches(), app.person_visible(), app.person_in_scope(), app.person_placement_in_scope() and the eight restrictive `scope_*` policies on `person` and `employment` |

`person` is created in `0002_people.sql` and `client` in `0003_work.sql`, but both are shared directory records. Ownership is the architecture contract, not the migration filename.

## Reference data

No jurisdiction is seeded by the migrations, and no country has a default. Provisioning must load:

1. The module catalog and optional dependencies (`seed/0001_modules.sql`).
2. Approved jurisdictions (country and, where relevant, subdivision).
3. Statutory identifier types for each jurisdiction.
4. Payroll rule packs with effective dates, source references and local reviewer sign-off.

A tenant may hold entitlements to one module or many. The catalog status (`available`, `preview`, `planned`, `retired`) controls whether a module can be licensed; a planned module may exist in the catalog without being sellable. In M0 only `people` is `available`/`preview`; the other licensable modules are `planned` and can be proved on an internal tenant with an internal-source entitlement.

A payroll run records the exact rule packs it used. Changing a rule means adding a new pack version; it never rewrites a finalised run.

## Not yet included

- Row-level partitioning for very large audit/event tables.
- Outbox producers and deployed consumers. 0011 gives the queue its claim mechanics and `saas_worker` its helpers, and `apps/worker` has the pass and polling loop, but no M0 write path inserts a `domain_event` row in its own transaction, no production handler is registered and no worker process is started by any deployable. There is also no purge or retention policy for `published` and `dead` rows and no dead-letter read surface.
- Retention jobs and legal holds.
- Full-text search indexes (permission-aware search is a service concern).
- Reporting views and materialized margin views.
- Seeded jurisdiction content and reviewed rule-pack data. The tables exist; the statutory content does not yet.
- Password reset, email delivery, MFA, OAuth/SSO, SCIM, tenant switching, session rotation, device lists and distributed rate limiting. Login by tenant slug, session validation, CSRF checks and one-time invitation acceptance exist; the web shell has sign-in and sign-out, but there is no invitation, password-reset or session-management UI.
- The parts of the People lifecycle the write path did not open. `POST /v1/people` and `PATCH /v1/people/:id` move six identity fields and nothing else, so there is still no placement, status, soft-delete, restore, employment, compensation or user-linking write, no bulk import and no per-person detail route. The directory screen is a real `GET /v1/people` consumer with an inline add/edit panel; there is no export button and no screen for any other module. Any of the omitted writes needs its own column grants — none exist today for `status`, either placement column, `user_id` or `deleted_at` — and its own policy review.
- Authentication-event audit. Provisioning, entitlement changes, authenticated access denials and People directory exports are audited; login, failed login, logout, invitation creation and invitation acceptance are not.
- Scope administration. 0012 builds the database half of scope authorization — the person/user link, `membership_scope`, the helpers and the restrictive policies for legal entity, org unit and employee self-scope — and the owner-only `packages/db/src/scope.ts` library plus `pnpm db:scope` now write both, each change audited in its own transaction. What is still absent: any API, UI or request-layer use of scope, a runtime grant on `membership_scope` or `person.user_id`, a scope-aware export or search, project and client scope, and role and seat administration. Employee self-scope is enforced in SQL, but the `employee` role still holds no permission in `@saasmodels/contracts`, so an employee request denies at `ROLE_DENIED` before the policy is reached; `db:scope` therefore refuses to put scope rows on an employee membership.
- An audit read API or UI and an entitlement administration UI. Authenticated access denials and export events are written, but there is no read surface for them.
- Full data export and portability. M0 has one production export: the People directory identity CSV (`GET /v1/people/export`) with seven fields, the `people.read` gate, a column-level grant, a server-side cursor and a pre-disclosure audit row. There is no Client or Work export; no employment, payroll, tax-identifier, bank or personal-contact export; no filter, column selection or date range; no asynchronous or background export, signed URL, storage bucket, export history, dedicated export permission or export rate limit; and no full-suite export/re-import.
- `FORCE ROW LEVEL SECURITY` by default. Provisioning is tested under FORCE on `tenant`; the table is not forced in a migration.
