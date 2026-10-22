# Database

Target: PostgreSQL 16+ (17 recommended), extensions `pgcrypto` and `citext`.

## Apply

Use the repository harness from the project root. It applies migrations in filename order and records checksums; do not apply files manually in development.

```bash
pnpm db:bootstrap
pnpm db:migrate
pnpm db:seed
```

Every file is wrapped in a transaction. Do not edit an applied migration; add the next numbered file. The runner refuses an applied file whose checksum changed and records interrupted or failed migrations for manual resolution. Seeds are idempotent and may be rerun; they are not a substitute for the administrative path that changes module status.

## Runtime role

`pnpm db:bootstrap` creates two roles:

- `saas_owner` owns the database, schemas and tables and runs migrations, seeds and provisioning. It is not the application role.
- `saas_runtime` is a login role that does not own tables and does not have `BYPASSRLS`.

The runtime grant allowlist is [packages/db/sql/runtime-grants.sql](../../packages/db/sql/runtime-grants.sql) and is reapplied after every migration. It grants:

- `USAGE` on `public` and `app`, but no `CREATE`.
- `SELECT` on the module catalog, dependencies and entitlements.
- Full `SELECT, INSERT, UPDATE, DELETE` on exactly two M0 proof tables: `employment` (People) and `project` (Work). Every other tenant table, including `person`, `client`, `legal_entity`, `tenant` and `app_user`, stays owner-only. Further tables gain grants per command as their API paths land.
- `EXECUTE` on `app.current_tenant_id()`, the four access helpers (`has_platform_access`, `has_module_read`, `has_module_write`, `has_switch_access`) and the `has_active_module` compatibility alias (an exact delegate to `has_module_write`). Administrative procedures (`enable_tenant_rls`, `add_updated_at`, `apply_module_policies`) and trigger functions are revoked.

There is no blanket `GRANT ON ALL TABLES` and no default privileges grant. The runtime cannot write the module catalog or its dependencies, cannot truncate, and cannot create objects.

Then, per transaction:

```sql
set local app.tenant_id = '<tenant-uuid>';
```

RLS denies all tenant rows when `app.tenant_id` is unset. The runtime role must not be the table owner and must not have `BYPASSRLS`.

Tenant creation and login-time membership lookup happen through a separate privileged path (a provisioning service or a minimal `security definer` function), never through a normal tenant-scoped request.

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
- Module entitlements are tenant data. The runtime may read them; changes come from the contract, billing or provisioning path and are audited. Module tables carry restrictive RLS policies built on `app.has_module_read(code)` / `app.has_module_write(code)`, which require an active, non-deleted tenant through `app.has_platform_access()`; `app.has_active_module(code)` is the write alias. These are a second line of defence, not a replacement for the API policy check.
- `person` and `client` are shared directory records. A module may extend them but may not create a competing person or client.
- `audit_event` is append-only; updates and deletes raise an error.
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

`person` is created in `0002_people.sql` and `client` in `0003_work.sql`, but both are shared directory records. Ownership is the architecture contract, not the migration filename.

## Reference data

No jurisdiction is seeded by the migrations, and no country has a default. Provisioning must load:

1. The module catalog and optional dependencies (`seed/0001_modules.sql`).
2. Approved jurisdictions (country and, where relevant, subdivision).
3. Statutory identifier types for each jurisdiction.
4. Payroll rule packs with effective dates, source references and local reviewer sign-off.

A tenant may hold entitlements to one module or many. The catalog status (`available`, `preview`, `planned`, `retired`) controls whether a module can be licensed; a planned module may exist in the catalog without being sellable.

A payroll run records the exact rule packs it used. Changing a rule means adding a new pack version; it never rewrites a finalised run.

## Not yet included

- Row-level partitioning for very large audit/event tables.
- Retention jobs and legal holds.
- Full-text search indexes (permission-aware search is a service concern).
- Reporting views and materialized margin views.
- Seeded jurisdiction content and reviewed rule-pack data. The tables exist; the statutory content does not yet.
