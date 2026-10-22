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
```

Every file is wrapped in a transaction. Do not edit an applied migration; add the next numbered file. The runner refuses an applied file whose checksum changed and records interrupted or failed migrations for manual resolution. Seeds are idempotent and may be rerun; they are not a substitute for the administrative path that changes module status.

`db:provision` is the only tenant-creation path in M0. It connects with `DB_OWNER_URL`, never the runtime URL, prints only the new tenant and owner IDs, and is not exposed by the API. It creates the tenant, owner user, owner membership, initial entitlements and the `tenant.provisioned` audit event in one transaction; a failure rolls all of it back.

## Runtime role

`pnpm db:bootstrap` creates two roles:

- `saas_owner` owns the database, schemas and tables and runs migrations, seeds and provisioning. It is not the application role.
- `saas_runtime` is a login role that does not own tables and does not have `BYPASSRLS`.

The runtime grant allowlist is [packages/db/sql/runtime-grants.sql](../../packages/db/sql/runtime-grants.sql) and is reapplied after every migration. It grants:

- `USAGE` on `public` and `app`, but no `CREATE`.
- `SELECT` on the module catalog, dependencies and entitlements.
- Full `SELECT, INSERT, UPDATE, DELETE` on exactly two M0 proof tables: `employment` (People) and `project` (Work). Every other tenant table, including `person`, `client`, `legal_entity`, `tenant` and `app_user`, stays owner-only. Further tables gain grants per command as their API paths land.
- `INSERT` on `audit_event` only. The runtime can append audit rows through `appendAuditEvent` but has no `SELECT`, `UPDATE` or `DELETE` on the audit trail. There is no grant on `membership`, `app_user` or `tenant`.
- `EXECUTE` on `app.current_tenant_id()`, `app.current_member_role()`, the four access helpers (`has_platform_access`, `has_module_read`, `has_module_write`, `has_switch_access`) and the `has_active_module` compatibility alias (an exact delegate to `has_module_write`). Administrative procedures (`enable_tenant_rls`, `add_updated_at`, `apply_module_policies`) and trigger functions are revoked.

There is no blanket `GRANT ON ALL TABLES` and no default privileges grant. The runtime cannot write the module catalog or its dependencies, cannot truncate, and cannot create objects. Membership is resolved through the security-definer helper `app.current_member_role()`, not a table grant.

Then, per transaction:

```sql
set local app.tenant_id = '<tenant-uuid>';
set local app.user_id = '<user-uuid>';   -- request paths only
```

RLS denies all tenant rows when `app.tenant_id` is unset. Request routes use `withMemberTransaction`, which validates both UUIDs, sets both settings transaction-locally, resolves the active membership role first, then checks platform access and the module gate on the same connection. A non-member or suspended member receives `MEMBERSHIP_DENIED` before the platform check, so tenant existence and status are not disclosed. A member of a suspended, closed or deleted tenant receives `PLATFORM_ACCESS_DENIED`. `withTenantTransaction` remains the system/background path; it does not check membership and must not be used by request routes. The runtime role must not be the table owner and must not have `BYPASSRLS`.

Tenant creation runs through the owner-only `provisionTenant` library and `db:provision` CLI. It is never reachable from the API. Identity, login and pre-tenant membership discovery are not implemented yet; a request principal is still injected by the caller, and the only membership lookup is the helper for an already-resolved tenant and user.

## Conventions

- `id uuid` primary key, application-generated UUIDv7; `gen_random_uuid()` is a fallback.
- Every tenant table has `tenant_id`, RLS enabled and a `tenant_isolation` policy.
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
- Membership roles are constrained to `owner`, `admin`, `hr`, `finance`, `manager`, `employee` and `auditor`. `app.current_member_role()` returns the role only for an active membership in the current tenant; a suspended membership or no membership returns null. There is no role or scope enforcement in M0.
- `person` and `client` are shared directory records. A module may extend them but may not create a competing person or client.
- `audit_event` is append-only; updates and deletes raise an error. Provisioning and entitlement changes append audit rows in the same transaction. The runtime can insert audit rows only; it cannot read, update or delete them.
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
- Identity, sessions, passwords, invitation acceptance and login-time tenant discovery.
- Role and scope enforcement. `withMemberTransaction` returns the resolved role but does not authorize actions from it.
- Denied-request auditing, an audit read API or UI, and an entitlement administration UI.
- `FORCE ROW LEVEL SECURITY` by default. Provisioning is tested under FORCE on `tenant`; the table is not forced in a migration.
