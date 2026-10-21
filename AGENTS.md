# SaaSModels One — agent rules

Read before planning or editing, in this order:
1. docs/product-blueprint.md
2. suite/README.md
3. suite/docs/architecture.md
4. suite/docs/security.md
5. suite/docs/testing.md
6. suite/docs/roadmap.md
7. suite/db/README.md, suite/db/migrations/*.sql, suite/db/seed/0001_modules.sql
8. suite/docs/adr/*.md

## Non-negotiable
1. Tenant isolation is a database property. Every tenant table has tenant_id,
   RLS, and composite (tenant_id, id) foreign keys. Missing app.tenant_id means
   no rows. The runtime role does not own tables and cannot bypass RLS.
2. Module access is an entitlement checked on the server, in this order:
   entitlement -> role -> scope. UI hiding is not authorization.
3. One shared directory. Person and client identity live in the platform.
   Modules extend them; no module creates a parallel employee or client table.
4. Money is bigint minor units plus an explicit ISO currency. No floats.
5. Payroll history and audit are append-only. Finalised runs are reversed,
   never edited. Audit rows cannot be updated or deleted.
6. Imports never write production directly. Rows land in staging with
   provenance and are promoted transactionally.
7. No statutory rule is invented by a model or hard-coded in application code.
   Rules are versioned jurisdiction packs with effective dates and reviewer
   sign-off. Do not claim coverage for a jurisdiction that has no reviewed pack.
8. Every export is complete. Cancelling a module never deletes its data.

## Working rules
- Migrations in suite/db are reviewed baseline artifacts. Change them with new
  forward migrations, never by rewriting an applied file, unless I explicitly
  approve a rewrite.
- No ORM that owns the schema. RLS, set local app.tenant_id and explicit SQL
  stay visible.
- No secrets, customer data, production configuration, signing keys or
  design-partner documents in Git.
- Do not claim certifications, customers, integrations or jurisdiction coverage
  that is not true. The product is pre-launch.
- Definition of done is the roadmap exit criterion proven by a test in CI, not
  code that compiles.
- Keep the marketing site out of this repository.

## Current milestone
M0 only, per suite/docs/roadmap.md. Payroll calculation, statutory packs,
CRM/Work/Money/Content domain screens and Switch import are out of scope until
their milestone.