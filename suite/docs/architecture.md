# Architecture

Status: working baseline · October 2026
Scope: the first commercial release of SaaSModels One. This document describes the shape we are building toward, not a claim that every component exists.

---

## 1. Shape

SaaSModels One is one **organisation workspace** with a platform core and a catalog of independently licensable modules. A customer can buy one module or all of them. The modules share one directory, one permission model and one audit trail; buying a second module does not create a second copy of the customer's data or a new integration project.

```
browser / mobile
      │ HTTPS
      ▼
web (React 19 + Vite) + API (TypeScript, Fastify)
      │  same origin; tenant context, authz, module entitlement, validation
      ├── People (HRM)
      ├── CRM
      ├── Work (projects and delivery)
      ├── Money (finance and billing)
      ├── Content (CMS, knowledge, portal)
      └── platform core
            identity · organisation directory · roles · audit · events
            documents · approvals · search · notifications · export · Switch
      │
      ├── PostgreSQL (RLS, transactional writes, outbox)
      ├── object storage (documents, imports, exports)
      └── worker (outbox consumers, imports, notifications, exports, scans)
```

It starts as a **modular monolith**: one deployable web/API service, one background worker, one PostgreSQL database and one object store. Modules are separated by schema ownership and service boundaries, not by network hops.

Why a monolith first:

- Payroll, project cost and invoicing must be transactionally consistent. Distributed transactions would add failure modes before they add value.
- A 50–500 person company does not need independent scaling per module.
- One database makes shared directory access (the same person, the same client) cheap and correct.
- Module boundaries are enforced in code and by database ownership, so extraction remains possible.

An ADR record is in [`adr/0001-modular-monolith.md`](adr/0001-modular-monolith.md).

---

## 2. Organisation model

The organisation is the root of every commercial relationship. `tenant` is the organisation workspace; a tenant can contain more than one legal entity.

```
organisation (tenant)
  ├── membership (users and roles)
  ├── module entitlement (which modules are licensed and active)
  ├── legal entity (jurisdiction, currency, locale, timezone)
  │     ├── org units (department, division, team, cost centre)
  │     └── locations
  ├── shared directory
  │     ├── person identity
  │     └── client identity, contacts and tax registrations
  ├── module data
  └── audit, documents, approvals, events
```

Organisation setup is a product workflow, not a database script:

1. Create the organisation, its primary legal entity and data region.
2. Select the first module or the full suite.
3. Invite members and assign role presets.
4. Configure the directory: people, client organisations and documents.
5. Connect an incumbent system through Switch, or start clean.
6. Activate the module and begin the first real month.

A module can be added later. The platform already has the directory, identity, documents and audit data it needs, so activation is an entitlement change plus configuration — not a data migration or a second deployment.

**Shared directory rule.** Person identity and client identity are platform records, not module-private records. People extends a person with employment, compensation and payroll. CRM extends a client organisation with relationships, pipeline and activities. Work and Money read the same identities. A module may add fields it owns; it may not create a competing person or client record.

---

## 3. Modules, packaging and entitlements

### Module catalog

Every module is a row in the platform module catalog with a stable code, a lifecycle status, an ownership boundary and a seat unit. The catalog is reference data; adding a module is not a schema fork.

| Code | Product name | Category | Licensed separately | First scope |
| --- | --- | --- | --- | --- |
| `people` | People | HRM | Yes | Employee record, org, leave, attendance, payroll |
| `crm` | CRM | CRM | Yes | Accounts, contacts, leads, pipeline, activities |
| `work` | Work | Projects | Yes | Engagements, projects, allocations, timesheets, margin |
| `money` | Money | Finance / ERP foundation | Yes | Proposals, contracts, invoices, payments, expenses |
| `content` | Content | CMS and knowledge | Yes | Pages, assets, knowledge, client rooms |
| `procurement` | Procurement | Finance / ERP | Planned | Purchase requests, vendors, approvals |
| `assets` | Assets | Finance / ERP | Planned | Equipment, assignments, maintenance |
| `analytics` | Analytics | Platform | Planned | Cross-module reporting and warehouse |

The platform core is always included and is not sold as a module: identity, organisation directory, roles and scopes, audit, events, documents, approvals, search, notifications, export and Switch. **Switch is a platform capability, not an add-on.** It works with whichever module the customer licenses.

A full suite subscription is an entitlement to every licensed module. It is the same code, the same database and the same permission model as a single-module subscription. There is no separate "suite edition" to fork.

### Entitlement lifecycle

Each tenant has at most one entitlement per module:

- `trialing` — time-bound evaluation.
- `active` — licensed and usable.
- `suspended` — non-payment or administrative hold; reads and export remain available inside the original entitlement term, writes stop. After the term ends, retention must be expressed as `cancelled` with `read_until`.
- `cancelled` — no longer licensed; data is retained read-only for the contractual window, then exported and purged.

Entitlements carry a start date, an optional end date, a seat unit and a seat count. Contracts, trials and internal tenants are the only sources. The billing system produces entitlements; the product does not infer a licence from an invoice PDF.

The request path checks entitlement before it checks role permissions. Hiding a navigation item is not entitlement enforcement, and an API call that bypasses the UI still passes through the same check.

### Dependencies and standalone operation

Dependencies are declared in the catalog but are **optional by default**. The goal is that every module is useful alone, with the platform core:

- People works with the shared directory and no other domain module.
- CRM works with the shared directory and no other domain module.
- Work can link people and clients, but does not require People or CRM to create a project.
- Money can link clients, projects and people, but does not require those modules to raise an invoice.
- Content can attach to any directory record; it does not require a particular module.

A hard dependency is allowed only when the module cannot legally or mathematically operate without it. Payroll is part of People, not a standalone module, because it depends on employment and compensation data that People owns.

When an optional module is not licensed, dependent modules show a plain directory reference and an "add module" path instead of a broken link. No cross-module record is silently duplicated.

### Deactivation and portability

- Suspending a module stops writes and background jobs, not access to the customer's data.
- Cancelling a module keeps its data readable and exportable for the contractual retention window. M0 proves the read window for the People directory export.
- Target: export is per module and for the whole organisation. A customer can leave with one module's data without buying the others. M0 ships only a scoped People directory identity CSV; full module and organisation export, file objects and re-import are not built.
- Imported provenance and audit events survive module cancellation; they are not deleted to make a churn metric look better.

---

## 4. Module boundaries

Each module owns its tables and exposes a narrow application service. Other modules read through that service or through explicit cross-module read models, never by mutating another module's tables.

| Boundary | Owns | May read |
| --- | --- | --- |
| Platform core | tenant, user, membership, roles, module catalog, entitlements, jurisdiction, audit, domain events, documents, approvals, notifications, idempotency | none (it is the base) |
| Directory | person identity, client identity, contacts, tax registrations, org units, locations | nothing outside the core |
| People (HRM) | employment, compensation, person identifiers, bank accounts, leave, attendance, payroll, payslips | directory, approved rule packs, document metadata |
| CRM | leads, opportunities, activities, relationship health, pipeline | directory, document metadata |
| Work | engagement, project, milestone, task, allocation, timesheet, deliverable, project cost | directory, employment availability and cost, documents |
| Money (Finance) | proposal, contract, invoice, payment, credit note, expense, vendor bill, tax lines | directory, project milestones, timesheets, person cost, documents |
| Content | content item, version, asset, knowledge page, document room membership | directory, project reference, documents |
| Switch | import batch, file, mapping, row, issue, reconciliation | all target schemas through promotion services |
| Reference data | jurisdictions, statutory identifier types, payroll rule packs and rules | read-only to every module; changes go through a reviewed administrative path |

The physical migration files place some directory tables beside the module that first needed them. Ownership is the contract above, not the filename. The shared tables are read-only to other modules except through the directory service.

### Cross-module events

Domain events are written to an outbox in the same transaction as the state change. A worker delivers them to in-process handlers and later to webhooks. Every event carries the module code and the tenant.

Examples:

- `payroll.finalised` → project cost read model, audit, notifications.
- `timesheet.approved` → project margin, invoice draft suggestions.
- `invoice.paid` → client portal, project profitability, notification.
- `opportunity.won` → client onboarding, project draft.
- `document.uploaded` → virus scan, search index, expiry reminders.
- `import.promoted` → reconciliation closure, audit, tenant onboarding checklist.

Events carry identifiers, not large payloads. Consumers must be idempotent, and a consumer for an unlicensed module does not run.

---

## 5. Request path and tenancy

1. Authenticate the request. In M0 the browser presents an opaque `saas_session` cookie; the API hashes the token and checks expiry, revocation and an active user through the auth role. API keys, OAuth and SSO are target state.
2. Take the organisation from the authenticated session record. No header, query string, body or other cookie can choose the tenant.
3. Verify an active membership for that user/organisation.
4. Open a transaction and run `set local app.tenant_id = '<uuid>'`.
5. Check that the module is entitled and active for the tenant.
6. Authorize the action against the role permission policy for the module gate. M0 covers the two gated modules, People and Work; scope (legal entity, department, project, client) is M1.
7. Execute the module service.
8. Append audit events and domain events in the same transaction.
9. Commit.

`app.tenant_id` is transaction-local. Connection pooling must never leak it. The runtime role does not own tables and cannot bypass RLS. Tenant provisioning and invitation creation use an owner-only path that is not exposed to normal requests. Identity lookups and session storage use a separate `saas_auth` role, which has no access to tenant business data, the module catalog, entitlements or audit.

Current authentication shape:

- Email and password with Argon2id (19,456 KiB, time cost 2, parallelism 1), a tenant slug and a uniform failure response for every rejection.
- A 32-byte opaque session token in an `HttpOnly`, `SameSite=Strict`, `Path=/` cookie, `Secure` when configured, with a 12-hour absolute expiry. The database stores only its SHA-256 hash.
- A CSRF token returned to the client and required on logout; every state-changing request must carry an exact `Origin` match. There is no CORS configuration and no Referer fallback.
- One-time invitations created by the owner-only `db:invite` CLI: hashed at rest, 7-day default expiry, older unconsumed invitations revoked when a new one is issued. Acceptance activates the invited membership and creates a session in one transaction. A first-time invitee sets a password; an active user invited to a second tenant verifies its existing password instead, which is never replaced. Identity is global (`app_user.email` is unique) while memberships are per tenant, so one user can sign in to each of its tenants with the same password.
- Login is rate-limited in memory per process by source address and additionally per email; invitation acceptance is rate-limited per source address. The limiter keys on the observed socket address, so behind a proxy without `trustProxy` every client shares the proxy address. It is not a distributed limiter and not a substitute for edge/WAF controls.
- Auth responses (`/v1/auth/*`), including errors and logout, are sent with `Cache-Control: no-store`.

Not built: password reset, email delivery, MFA, OAuth/SSO, SCIM, tenant switching, session rotation, device lists, a distributed rate limiter, authentication-event audit, scope authorization, role administration and seat enforcement. A valid session proves identity only; each member request resolves the role server-side and a gated module requires both its entitlement and the role permission.

The M0 web client is a React 19 + Vite single-page application with three History API routes: `/login`, `/app` and `/app/people`. Vite serves it on port 3000 with `strictPort` and proxies `/v1` and `/health` to the API on `127.0.0.1:3001` (overridable with `VITE_API_PROXY_TARGET`); production is expected to serve the static bundle and API from one origin behind an edge or reverse proxy that preserves `Origin` and falls back to `index.html` for application paths. The app loads the session and then `/v1/context`. It stores no session token in browser storage: the cookie is `HttpOnly`, and the CSRF token needed for logout is held in module memory. Sign-in uses the generic failure response, a distinct rate-limit message and a retryable network state; the theme is the only persistent preference. Navigation is built only from effective modules, and the People screen is an empty state with a read/write badge and no data entry, import, export or fake rows. A member without readable People who opens `/app/people` gets an access state listing their modules. Client routing and hiding are presentation only, never authorization. One Playwright journey proves the shell against the built output, a disposable database and an in-process API; see `testing.md` §2.13 and [`adr/0006-web-shell.md`](adr/0006-web-shell.md).

`app.has_module_read('<code>')` and `app.has_module_write('<code>')` are the tenant-scoped, security-definer helpers for database checks, and module tables carry restrictive RLS policies built on them (installed idempotently by `app.apply_module_policies()`). `app.has_active_module('<code>')` remains only as an exact alias of the write helper. Application services must still enforce entitlement explicitly; the helpers are a second line of defence, not a replacement for the policy layer.

See [`adr/0002-postgres-rls-tenancy.md`](adr/0002-postgres-rls-tenancy.md) and [`adr/0005-modules-and-entitlements.md`](adr/0005-modules-and-entitlements.md).

### Authorization model

M0 implements entitlement and role authorization; scope is M1.

- **Entitlement** answers whether the organisation has licensed the module at all. The request path checks it first, so an unentitled module never discloses role policy.
- **Role** answers what kind of action is allowed within an entitled module. The policy lives in `@saasmodels/contracts` and is applied by `withMemberTransaction`. The M0 roles are owner, admin, hr, finance, manager, employee and auditor. Owner and admin hold all four People/Work permissions; HR holds People read/write; finance and auditor hold People read and Work read; manager holds People read and Work read/write; employee holds none until self-scope is designed in M1.
- **Scope** answers where: legal entity, department, client, project. Not built.
- **Sensitive actions** (payroll finalise, bank change, data export, role change) require an explicit permission and are always audited. M0 audits its one data export, `GET /v1/people/export`, and gates it with `people.read`; a dedicated export permission, payroll finalise, bank change and role change are not built.
- A person's manager may see team leave and timesheets, but not salary, bank details or statutory identifiers. Target.
- Client contacts never use internal roles; they access only a document room through a separate principal type. Target.

Authorization is checked on the server for every request; when scope authorization lands it will also constrain the query shape (for example, filtering by permitted project IDs). UI hiding is not authorization. A gated route that skips `withMemberTransaction` loses the role check; `withTenantTransaction` is system-only. Authenticated access denials are recorded as `authorization.denied` (see `security.md` §7).

### M0 People directory export

`GET /v1/people/export` is the first production data export and is always registered, independent of proof routes. It takes the tenant and user only from the session and opens a member transaction with the People read gate. A first transaction writes one `people.directory.exported` audit row and commits before any response header is sent; a failure there returns a sanitized 500 and no CSV. A second member transaction rechecks the gate and streams a `NO SCROLL` cursor in validated batches, honouring backpressure and rolling back if the client closes. The response is RFC 4180 CSV with exactly seven identity columns: `person_id`, `employee_code`, `first_name`, `last_name`, `display_name`, `work_email` and `phone`. It carries `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`, omits `Content-Length` and stores no artifact.

Tenant scope comes from RLS, not from a caller value. The runtime role has column-level `SELECT` on those seven columns plus `deleted_at`, which is used only to exclude soft-deleted rows and is never exported; every other person column, including personal contact, date of birth, gender, status, designation and employment data, remains owner-only. There is no UI, filter, column selection, date range, background job, signed URL, export history, dedicated export permission or export rate limit. See `security.md` §6 and `testing.md` §2.12.

---

## 6. Data rules

- UUIDs are generated by the application as UUIDv7; the database default (`gen_random_uuid()`) is a fallback. Time-ordered IDs keep indexes healthy.
- Every tenant business table has `tenant_id`, RLS and a `tenant_isolation` policy, plus timestamps and, where relevant, `deleted_at`. The identity tables `auth_session` and `invitation` carry `tenant_id` but deliberately have no RLS; the runtime role has no privilege on either, and security-definer auth functions are the only access path.
- Money is `bigint` minor units plus a required ISO currency. Percentages use `numeric`, never floats. The schema never defaults a currency.
- Every legal entity carries a jurisdiction, currency, locale and timezone. No country is a schema default; provisioning chooses them explicitly.
- Statutory identifiers, bank account numbers and similar sensitive values are stored encrypted at the application layer with a KMS-backed key. Only a last-four fragment is stored in clear for display and matching.
- Payroll, audit, approvals and finalised documents are append-only. Reversal creates a new record.
- Imported rows carry `source_system`, `source_id`, `import_batch_id` and `imported_at`.
- Statutory rules live in versioned, jurisdiction-scoped packs with effective dates, source references and reviewer sign-off. They are not calculated from free text or an LLM.
- Module entitlements are the only source of truth for what is licensed. Contract metadata, not an invoice line, drives them.

---

## 7. Documents

Documents are content-addressed objects with metadata in Postgres:

- Upload → quarantine bucket → virus scan → clean bucket.
- Metadata: entity type/id, filename, MIME, size, checksum, version, retention date, scan status.
- Access is through short-lived signed URLs after an authorization check, never a public bucket.
- A document can attach to a person, client, project, contract, invoice or payroll run without duplication.
- A full export (target, not built) includes metadata and file objects in an open archive, even when only one module is licensed. The M0 People directory export includes no documents.

---

## 8. Switch (migration)

Switch is a platform capability available with any licensed module. The detailed pipeline is in [`../../docs/migration-blueprint.md`](../../docs/migration-blueprint.md).

```
source → import_batch → import_file → mapping_profile
       → import_row → import_issue → validation/dedupe
       → rehearsal tenant → reconciliation → sign-off
       → transactional promotion with provenance → rollback window
```

Key properties:

- Source credentials are read-only and stored encrypted.
- Every source row is either imported or parked with a reason.
- Promotion is idempotent by `(tenant_id, source_system, source_id)`.
- Reconciliation compares control totals, not just row counts.
- Cutover is reversible until the first production payroll is finalised.
- Export is always available, including after a failed migration. Target; M0 provides only the scoped People directory export.
- The migration plan names its target module. Importing people does not require buying CRM, and importing clients does not require buying People.

See [`adr/0003-migration-staging-and-promotion.md`](adr/0003-migration-staging-and-promotion.md).

---

## 9. Jurisdictions and payroll rule packs

Payroll is local by law. The platform is not local by design.

- A **jurisdiction** is a country or a subdivision (state, province, canton). Jurisdictions form a hierarchy in global reference data. No country is seeded or privileged by the schema.
- A **legal entity** selects its jurisdiction, currency, locale and timezone. Those values are required and never defaulted.
- A **payroll run** belongs to one legal entity, one jurisdiction, one currency and one period. Cross-border employment is modelled explicitly on the employment record and does not silently mix jurisdictions in one run.
- A **payroll rule pack** is versioned reference data for a jurisdiction: effective dates, source references, reviewer sign-off and a checksum. A run records every pack it used; a finalised run is never recalculated with a newer pack.
- More than one pack may apply to a run (for example a national pack plus a subnational pack). The run-to-pack link is a table, not a single column.
- The calculation engine implements deterministic mechanics: gross-to-net, ceilings, eligibility, rounding, proration, arrears and adjustments. Rates, thresholds and report definitions come from pack data, never from hard-coded constants.
- Statutory reports and bank-file formats are pack-defined output adapters. A new jurisdiction does not fork the core; it adds reviewed data, adapters and golden tests.
- Adding a jurisdiction is a content and validation programme, not a schema change. The product does not claim coverage for a jurisdiction until its pack has been reviewed and tested against real cases.

Localisation follows the entity, not the deployment: currency, date format, number format, timezone, fiscal year and week start. The interface is English in v1; content locales are stored independently.

Data residency is selected at organisation provisioning and is separate from jurisdiction. A tenant can operate in one jurisdiction while storing data in another region, subject to its legal and contractual constraints.

---

## 10. Payroll

Payroll is the highest-risk workflow. The architecture treats it as a state machine:

```
draft → inputs_locked → calculated → in_review → approved → finalised → paid
                                                             └→ reversed
```

- Inputs are snapshotted before calculation. A later salary change does not alter a finalised run.
- Every calculation stores the rule version and the input hash used.
- Calculations are deterministic and replayable.
- Four-eyes approval is required for finalisation above a configurable threshold.
- Bank file generation is a separate, audited step.
- Statutory outputs are generated from the approved packs for the run's jurisdiction, reviewed by a qualified local advisor.
- Corrections are new adjustment records tied to the original run, never in-place edits.
- A run cannot span jurisdictions or currencies. Consolidation is a reporting concern, not a payroll run.

See [`adr/0004-statutory-rules-as-versioned-data.md`](adr/0004-statutory-rules-as-versioned-data.md).

---

## 11. Deployment

Initial topology (single region, selected at organisation provisioning):

| Component | Choice | Notes |
| --- | --- | --- |
| Runtime | Containerised Node.js web/API + worker | Separate processes, same image |
| Database | Managed PostgreSQL 16+ in the tenant's selected region | PITR, encrypted, private network |
| Objects | S3-compatible storage in the tenant's selected region | Versioning, lifecycle, no public access |
| Cache/queue | Managed Redis (optional at first) | Outbox can run without it |
| Edge | CDN + WAF + TLS | Static assets, rate limiting, `/v1` proxy, SPA fallback for application paths |
| Secrets | Managed secret store / KMS | No secrets in environment files committed to Git |
| Observability | Structured logs, metrics, traces, error tracking | PII redaction before export |

Backups: point-in-time recovery with a documented RPO of 15 minutes and RTO of 4 hours for the first cohort. Restore drills are scheduled, not assumed. **Target, not built:** M0 has no WAL archiving, PITR or schedule. What exists is a manually executed logical `pg_dump`/`pg_restore` drill (`pnpm drill:restore`) verified once on local PostgreSQL 17.9 against synthetic data, with no encryption, no retained or offsite copies and no RPO/RTO guarantee.

The first data region is chosen with the first design partner. Additional regions are added only when a real residency requirement exists; the product does not claim multi-region operation before it is deployed.

Scaling path, only when measured: read replicas for reporting, a separate worker pool for imports/exports, then extraction of the noisiest module. No service split before the bottleneck is real.

---

## 12. Explicitly deferred

- Microservices and a service mesh.
- Event streaming beyond a Postgres outbox.
- A public plugin marketplace. The module catalog is internal; third-party modules are not a v1 commitment.
- Per-entity module licensing. Entitlements are organisation-wide in v1; multi-entity groups can choose modules for the group.
- Usage-based module metering. Seat and employee units are explicit before a module is sold.
- Payroll packs for jurisdictions that have not been reviewed and tested. The model supports them; each pack is a content and validation programme, not a schema fork.
- A universal statutory filing engine that submits to every authority. Pack-defined reports and exports come first.
- A full general ledger, procurement or inventory. Money is an ERP foundation for service businesses, not a replacement for a manufacturing ERP.
- Real-time collaborative editing.
- AI-generated payroll decisions.
- Server-side rendering, route-level code splitting, a shared component design system and a production Content-Security-Policy. The M0 client is a small static bundle with a system font stack; production headers must be authored and verified with the deployment, not claimed from the repository.

Deferring these is a design decision, not an oversight.
