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
1. Tenant isolation is a database property. Every tenant business table has
   tenant_id, RLS and a tenant_isolation policy, and cross-tenant references use
   composite (tenant_id, id) foreign keys. The identity tables auth_session and
   invitation carry tenant_id but deliberately have no RLS: the runtime role has
   no privilege on either, and they are reached only through security-definer
   auth functions. Missing app.tenant_id means no rows for RLS tables. The
   runtime role does not own tables and cannot bypass RLS.
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
8. Every portability export is complete when it ships. Cancelling a module
   never deletes its data. The M0 People directory identity CSV is a scoped
   directory export, not the portability feature.

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
All five modules are being built now, by the owner's decision of 27 October
2026, reviewed in batches of three slices each carrying one ADR, one doc pass
and one gate run. This is a departure from the sequencing rule in
suite/docs/roadmap.md, which is amended and dated there rather than deleted.
The standalone-CRM thesis survives as a requirement on the CRM slice.

State as of this batch (Batch 1 - Work, Money and Content, suite/docs/adr/0013-work-money-content-read.md):

- **M0 has not exited.** No batch exits it on its own, and nothing in this
  repository may claim it has.
- **CRM has no tables in the schema yet.** It is a batch of its own.
- **Work, Money and Content have read surfaces only** - GET /v1/work/projects,
  GET /v1/money/invoices and GET /v1/content/items, plus three read-only
  screens. There is no write surface in any of the three modules.
- **Switch import is still out of scope.**
- **Payroll calculation and statutory packs remain out of scope**, because
  there is no reviewed jurisdiction pack. Do not invent a statutory rule, a
  tax rate, a currency conversion or a payroll formula.
- The module catalog is at 'preview' for People, Work, Money and Content and
  'planned' for CRM, Procurement, Assets and Analytics. There is no
  administrative path for catalog status: the seed file and its idempotent
  update are the only writers of platform_module.status.