# SaaSModels One — Suite Engineering

This directory is the engineering project for **SaaSModels One**, the commercial product. It is deliberately separate from the marketing site at the repository root.

> Status: **M0 foundation** · October 2026
> The database, access helpers, a minimal API/worker request layer, membership verification and audited provisioning/entitlements exist. Identity, sessions, role/scope enforcement, production routes, queues, audit read APIs and UI are not implemented.

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
    security.md              threat model, baseline controls, design-partner gate
    testing.md               non-negotiable suites and CI gates
    roadmap.md               M0–M4 with exit criteria
    adr/                     decisions that are costly to reverse
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
    seed/
      0001_modules.sql       idempotent module catalog and dependency seed
```

## Non-negotiable rules

1. **Tenant isolation is a database property.** Every tenant table carries `tenant_id`, has RLS enabled, and cross-tenant references are blocked by composite foreign keys.
2. **Module access is an entitlement, checked on the server.** A licensed module is not a UI flag. Every module request resolves entitlement + role + scope; the database helpers `app.has_module_read('<code>')` and `app.has_module_write('<code>')` are the second line of defence. `app.has_active_module('<code>')` remains as a compatibility delegate to the write helper.
3. **One shared directory.** Person and client identity live in the platform. Modules extend those records; none creates a parallel employee or client table.
4. **Money is integer minor units.** `bigint` plus currency. No floating point in payroll or billing.
5. **Payroll history is append-only.** Finalised runs are reversed, never edited. Audit events cannot be updated or deleted.
6. **Imports never write production directly.** Rows land in staging, carry provenance, and are promoted transactionally.
7. **No statutory rule is invented by a model.** Contribution, withholding and statutory-reporting rules are versioned data per jurisdiction, reviewed by a qualified local advisor and proven with golden test cases.
8. **Every export is complete.** A tenant can leave with its records and documents in open formats, module by module. Cancelling a module never destroys the data.

## Database

Target: PostgreSQL 16+ (17 recommended), `pgcrypto` and `citext`, in the data region selected for the tenant at provisioning.

```bash
pnpm db:bootstrap   # roles and database, once
pnpm db:migrate     # checksummed migrations; reapplies the runtime grants
pnpm db:seed        # idempotent module catalog
pnpm db:provision --name "Synthetic Co" --slug synthetic-co --region test-region \
  --owner-email owner@example.test --owner-name "Synthetic Owner" --module people
```

The module catalog is reference data, seeded once and updated by migration. A tenant is then granted entitlements; the catalog itself is not writable by the runtime role. Provisioning and entitlement changes run through owner-only libraries and audit in the same transaction.

The migrations and seed are applied by the repository harness against a real local PostgreSQL 17 instance, with fresh-apply, checksum, role-privilege, access-helper, RLS policy, membership, provisioning and audit suites. PostgreSQL 16 in CI is planned for T10, and a restore drill is still required before real data — see `db/README.md` and `docs/roadmap.md`.

The application connects as a role that does **not** own the tables. Tenant and user context are set per transaction:

```sql
set local app.tenant_id = '<tenant-uuid>';
set local app.user_id = '<user-uuid>';
```

RLS denies all rows when the tenant setting is absent. Request routes resolve membership through `withMemberTransaction`; the worker uses the system-only `withTenantTransaction`. Tenant provisioning is owner-only and never reachable from the API.

## Application skeleton

`apps/api` and `apps/worker` contain the first request layer. API routes use `withMemberTransaction` from `@saasmodels/db`: the tenant and user come only from the injected principal, both IDs are validated, the active membership role resolves first, then platform access and the module gate run through the runtime role, and the caller's query runs in the same transaction. The context route returns the resolved role. The worker exports `runTenantJob` on the system-only `withTenantTransaction` without a queue or polling loop.

Proof routes are disabled by default and enabled only by tests. The executable API authenticator returns no principal and logs that identity is not configured, so `/health` is the only route that can succeed until real identity lands. Authentication, sessions, invitations, role/scope enforcement and denied-request auditing are not implemented; do not treat this skeleton as a production authentication layer.

Provisioning and entitlement changes are owner-only libraries used by the `db:provision` CLI. They are not routed through the API.

## What comes next

1. Replace the API's null authenticator with real identity, invitation acceptance and sessions; then add role/scope authorization and denied-request audit.
2. Build the People vertical: person, employment, salary structure, payroll run, payslip.
3. Build Switch against CSV first, then greytHR; prove reconciliation before adding a second connector.
4. Put one design partner's migrated history through a sandbox rehearsal.
5. Prove second-module enablement on a public tenant once CRM leaves `planned`; M0 proves the same configuration path on an internal tenant with an internal-source entitlement.

## Related documents

- [`../docs/product-blueprint.md`](../docs/product-blueprint.md) — market, product scope, pricing, roadmap.
- [`../docs/migration-blueprint.md`](../docs/migration-blueprint.md) — migration stages, staging model, error contract, rollback.

## Not in this repository

Credentials, customer data, production configuration, signing keys and design-partner documents. None of those belong in Git.
