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
The standalone-CRM thesis survives as a requirement on the CRM slice, and
Batches 2 and 3 carry that proof: a CRM-only tenant with no People entitlement
manages accounts, contacts and leads without reaching into a module it does not
hold.

State as of this batch (Batch 3 - CRM leads, stage movement and conversion, suite/docs/adr/0015-crm-leads-pipeline.md):

- **M0 has not exited.** No batch exits it on its own, and nothing in this
  repository may claim it has.
- **CRM ships accounts and contacts on the shared `client` and `client_contact`
  rows, and leads on `crm_lead`.** `crm_lead` is the first table this product
  owns for one module only: 0015 gives it three restrictive policies -
  `crm_read`, `crm_write_insert`, `crm_write_update` - that the module policy
  installer cannot drop, no delete policy, and 26 column privileges over nine
  columns with no table-level privilege and no DELETE. Accounts and contacts
  remain shared rows with no CRM module policy. CRM has no scope: a member
  holding `crm.write` may change every lead in the tenant.
- **CRM is a preview module with read and write surfaces** - GET, POST and
  PATCH /v1/crm/accounts, GET and POST and PATCH
  /v1/crm/accounts/:accountId/contacts, and GET and POST /v1/crm/leads,
  PATCH /v1/crm/leads/:id and POST /v1/crm/leads/:id/convert, plus the accounts
  screen, its contacts panel and the Accounts | Leads tab strip. A lead is
  admitted only on an open stage, a converted or disqualified lead cannot
  change, and conversion writes a shared account, its primary contact and the
  terminal lead in one transaction. Pipeline analytics, activities, forecast
  and export are not built, so the CRM module is not complete and the
  standalone sale is not ready. There is no lead delete or re-open and no
  contact delete, because neither table has a soft-delete column and the
  runtime holds no DELETE privilege on either.
- **No new permission in Batch 3.** The published permission set stays at nine
  names; every lead route asks `crm.read` or `crm.write`.
- **Work, Money and Content have read surfaces only** - GET /v1/work/projects,
  GET /v1/money/invoices and GET /v1/content/items, plus three read-only
  screens. There is no write surface in any of those three modules.
- **Switch import is still out of scope.**
- **Payroll calculation and statutory packs remain out of scope**, because
  there is no reviewed jurisdiction pack. Do not invent a statutory rule, a
  tax rate, a currency conversion or a payroll formula.
- The module catalog is at 'preview' for People, CRM, Work, Money and Content
  and 'planned' for Procurement, Assets and Analytics. There is no
  administrative path for catalog status: the seed file and its idempotent
  update are the only writers of platform_module.status.