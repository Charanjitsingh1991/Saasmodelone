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

Every file is wrapped in a transaction. Do not edit an applied migration; add the next numbered file. The runner refuses an applied file whose checksum changed and records interrupted or failed migrations for manual resolution. Seeds are idempotent and may be rerun; they are not a substitute for the administrative path that changes module status.

`db:provision` is the only tenant-creation path in M0. It connects with `DB_OWNER_URL`, never the runtime URL, prints only the new tenant and owner IDs, and is not exposed by the API. It creates the tenant, owner user, owner membership, initial entitlements and the `tenant.provisioned` audit event in one transaction; a failure rolls all of it back.

`db:invite` creates a one-time invitation for a user with an invited membership in the tenant. It connects with `DB_OWNER_URL`, never the runtime URL, validates the tenant slug, email and expiry window (1–30 days, default 7), revokes older unconsumed invitations for the same membership, and prints the invitation ID, tenant ID, email, expiry and the raw token exactly once with an out-of-band delivery warning. It does not print a password or connection string and is not exposed by the API. The invited user may be a first-time invitee or an already-active user being added to a second tenant; an active user must already hold a password, since acceptance reuses the existing credential rather than setting one.

## Database roles

`pnpm db:bootstrap` creates three roles:

- `saas_owner` owns the database, schemas and tables and runs migrations, seeds and provisioning. It is not the application role.
- `saas_runtime` is a login role that does not own tables and does not have `BYPASSRLS`. It serves tenant business data.
- `saas_auth` is a login role that does not own tables and does not have `BYPASSRLS`. It serves identity lookups and session storage only.

### Runtime role

The runtime grant allowlist is [packages/db/sql/runtime-grants.sql](../../packages/db/sql/runtime-grants.sql). It and the auth allowlist [packages/db/sql/auth-grants.sql](../../packages/db/sql/auth-grants.sql) are reapplied after every migration. The runtime grants:

- `USAGE` on `public` and `app`, but no `CREATE`.
- `SELECT` on the module catalog, dependencies and entitlements.
- Full `SELECT, INSERT, UPDATE, DELETE` on exactly two M0 proof tables: `employment` (People) and `project` (Work). `public.person` receives column-level `SELECT` on `id, employee_code, first_name, last_name, display_name, work_email, phone, deleted_at` for the People directory export; there is no table-level `SELECT`, `deleted_at` is used only to exclude soft-deleted rows, and every other person column stays owner-only. `client`, `legal_entity`, `tenant`, `app_user` and every other tenant table stay owner-only. Further tables gain grants per command as their API paths land.
- `INSERT` on `audit_event` only. The runtime can append audit rows through `appendAuditEvent`, including `authorization.denied` and `people.directory.exported` rows, but has no `SELECT`, `UPDATE` or `DELETE` on the audit trail. There is no grant on `membership`, `app_user` or `tenant`, and none on `auth_session` or `invitation`; those are auth-role objects.
- `EXECUTE` on `app.current_tenant_id()`, `app.current_member_role()`, the four access helpers (`has_platform_access`, `has_module_read`, `has_module_write`, `has_switch_access`) and the `has_active_module` compatibility alias (an exact delegate to `has_module_write`). Administrative procedures (`enable_tenant_rls`, `add_updated_at`, `apply_module_policies`) and trigger functions are revoked.
- The person column grant is the only column-level business-data grant. The export query selects the seven identity fields plus `deleted_at`, filters `deleted_at is null`, orders by `employee_code nulls last, id`, and passes no `tenant_id` predicate; RLS remains the tenant boundary. The export audit is a separate member transaction that commits before the route sends headers.

There is no blanket `GRANT ON ALL TABLES` and no default privileges grant. The runtime cannot write the module catalog or its dependencies, cannot truncate, and cannot create objects. Membership is resolved through the security-definer helper `app.current_member_role()`, not a table grant.

Then, per transaction:

```sql
set local app.tenant_id = '<tenant-uuid>';
set local app.user_id = '<user-uuid>';   -- request paths only
```

RLS denies all tenant rows when `app.tenant_id` is unset. Request routes use `withMemberTransaction`, which validates both UUIDs, sets both settings transaction-locally, resolves the active membership role first, then checks platform access, the module entitlement and the role permission on the same connection. A non-member or suspended member receives `MEMBERSHIP_DENIED` before the platform check, so tenant existence and status are not disclosed. A member of a suspended, closed or deleted tenant receives `PLATFORM_ACCESS_DENIED`. Role authorization is application-layer: grants and RLS enforce tenancy and module entitlement, not the membership role, so a route that skips `withMemberTransaction` loses role enforcement even when the database checks still pass. `withTenantTransaction` remains the system/background path; it does not check membership or role and must not be used by request routes. The runtime role must not be the table owner and must not have `BYPASSRLS`.

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
- Membership roles are constrained to `owner`, `admin`, `hr`, `finance`, `manager`, `employee` and `auditor`. `app.current_member_role()` returns the role only for an active membership in the current tenant; a suspended membership or no membership returns null. Role authorization is enforced in the application layer by `withMemberTransaction` against the shared policy in `@saasmodels/contracts`; no grant or RLS policy checks the role. Scope authorization is not built.
- `person` and `client` are shared directory records. A module may extend them but may not create a competing person or client. The runtime may read only the eight granted person columns and only through the export route; personal contact, demographics, status, employment and statutory data stay owner-only.
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
- Retention jobs and legal holds.
- Full-text search indexes (permission-aware search is a service concern).
- Reporting views and materialized margin views.
- Seeded jurisdiction content and reviewed rule-pack data. The tables exist; the statutory content does not yet.
- Password reset, email delivery, MFA, OAuth/SSO, SCIM, tenant switching, session rotation, device lists and distributed rate limiting. Login by tenant slug, session validation, CSRF checks and one-time invitation acceptance exist; the web shell has sign-in and sign-out, but there is no invitation, password-reset or session-management UI.
- People data entry, CRUD, import or export UI, and screens for modules other than the empty People state. The web shell reads `/v1/context` and performs no People query; it needs no schema or grant change.
- Authentication-event audit. Provisioning, entitlement changes, authenticated access denials and People directory exports are audited; login, failed login, logout, invitation creation and invitation acceptance are not.
- Scope authorization (legal entity, department, project, client), employee self-scope, role administration and seat enforcement. Role authorization for People and Work exists in the application layer only; grants and RLS do not know the membership role.
- An audit read API or UI and an entitlement administration UI. Authenticated access denials and export events are written, but there is no read surface for them.
- Full data export and portability. M0 has one production export: the People directory identity CSV (`GET /v1/people/export`) with seven fields, the `people.read` gate, a column-level grant, a server-side cursor and a pre-disclosure audit row. There is no Client or Work export; no employment, payroll, tax-identifier, bank or personal-contact export; no filter, column selection or date range; no asynchronous or background export, signed URL, storage bucket, export history, dedicated export permission or export rate limit; and no full-suite export/re-import.
- `FORCE ROW LEVEL SECURITY` by default. Provisioning is tested under FORCE on `tenant`; the table is not forced in a migration.
