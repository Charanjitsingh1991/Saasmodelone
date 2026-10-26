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

Status as of M0, stated in three parts:

- **True today.** `domain_event` (0001) carries the lease columns, status and per-tenant claim index added by 0011, and four `app` schema `SECURITY DEFINER` helpers claim, publish and fail events for one tenant at a time. A dedicated `saas_worker` role holds no table privilege at all and reaches the queue only through those helpers. `apps/worker` runs per-tenant passes and a polling loop with a lease, backoff, dead-letter state and an entitlement gate. Delivery is at-least-once, so handlers must be idempotent.
- **Machinery only.** No producer writes an event in its state-change transaction, so a freshly seeded and migrated `domain_event` is empty. Nothing starts the loop in any deployable process; no consumer is registered outside the test suite.
- **Waiting for M1.** The first real producer per module, a deployed worker process, webhooks, and the import/notification/export consumers named in §4's event list.

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
6. Authorize the action against the role permission policy for the module gate. M0 covers the two gated modules, People and Work. Step 7 then runs under scope policies: from `0012_people_scope.sql` the database narrows `person` and `employment` by the member's legal entity, org-unit subtree or self link whenever the transaction set `app.user_id`, and project and client scope are not modelled. The placement routes add one explicit helper call on top of that narrowing — `app.person_placement_in_scope`, the same definer the write policies use — so the scope verdict a member sees before a write is the verdict the policy will apply to it; no other route restates a scope rule.
7. Execute the module service.
8. Append audit events and domain events in the same transaction.
9. Commit.

`app.tenant_id` is transaction-local. Connection pooling must never leak it. The runtime role does not own tables and cannot bypass RLS. Tenant provisioning, invitation creation and scope authoring (`person.user_id` and `membership_scope`, through `packages/db/src/scope.ts` and the `db:scope` CLI) use an owner-only path that is not exposed to normal requests. Identity lookups and session storage use a separate `saas_auth` role, which has no access to tenant business data, the module catalog, entitlements or audit.

Current authentication shape:

- Email and password with Argon2id (19,456 KiB, time cost 2, parallelism 1), a tenant slug and a uniform failure response for every rejection.
- A 32-byte opaque session token in an `HttpOnly`, `SameSite=Strict`, `Path=/` cookie, `Secure` when configured, with a 12-hour absolute expiry. The database stores only its SHA-256 hash.
- A CSRF token returned to the client and required on logout; every state-changing request must carry an exact `Origin` match. There is no CORS configuration and no Referer fallback.
- One-time invitations created by the owner-only `db:invite` CLI: hashed at rest, 7-day default expiry, older unconsumed invitations revoked when a new one is issued. Acceptance activates the invited membership and creates a session in one transaction. A first-time invitee sets a password; an active user invited to a second tenant verifies its existing password instead, which is never replaced. Identity is global (`app_user.email` is unique) while memberships are per tenant, so one user can sign in to each of its tenants with the same password.
- Login is rate-limited in memory per process by source address and additionally per email; invitation acceptance is rate-limited per source address. The limiter keys on the observed socket address, so behind a proxy without `trustProxy` every client shares the proxy address. It is not a distributed limiter and not a substitute for edge/WAF controls.
- Auth responses (`/v1/auth/*`), including errors and logout, are sent with `Cache-Control: no-store`, as are `/v1/context`, every `/v1/people` response — denials and `400`s included — and the directory export.

Not built: password reset, email delivery, MFA, OAuth/SSO, SCIM, tenant switching, session rotation, device lists, a distributed rate limiter, authentication-event audit, role administration and seat enforcement. Scope is in a partial state: the database half exists from M1's `0012_people_scope.sql` (see §"Authorization model") and can be written — the scope rows and the person/user link only by an operator through the owner-only `db:scope` CLI, audited in the same transaction, with no application surface. Its first request-layer consumer exists too: `GET /v1/people` and the directory export both run in a transaction that sets `app.user_id`, so their rows are narrowed by the policies. So does the first member write path: `POST /v1/people` and `PATCH /v1/people/:id` are gated by `people.write` and narrowed on the write side by `scope_insert` and `scope_update`, with no scope predicate in application code (see §"M1 People directory write path" and [ADR 0008](adr/0008-people-write-path.md)). So does the placement path, which goes one step further and asks the scope helper directly: `GET /v1/people/placement-options` and `PATCH /v1/people/:id/placement` take every verdict from `app.person_placement_in_scope`, the definer behind those same policies, so a member can move a colleague into or out of another member's visibility without any scope rule existing in the request layer (see §"M1 People placement" and [ADR 0009](adr/0009-people-placement.md)). What does not exist: scope values in `/v1/context` or in any UI label, a scope read or administration API, any People delete, status, employment or user-linking write, legal entity and org unit administration, People import, and project/client scope. There is no audit read surface for reviewing the grants the CLI produces. A valid session proves identity only; each member request resolves the role server-side and a gated module requires both its entitlement and the role permission.

The M0 web client is a React 19 + Vite single-page application with three History API routes: `/login`, `/app` and `/app/people`. Vite serves it on port 3000 with `strictPort` and proxies `/v1` and `/health` to the API on `127.0.0.1:3001` (overridable with `VITE_API_PROXY_TARGET`); production is expected to serve the static bundle and API from one origin behind an edge or reverse proxy that preserves `Origin` and falls back to `index.html` for application paths. The app loads the session and then `/v1/context`. It stores no session token in browser storage: the cookie is `HttpOnly`, and the CSRF token needed for logout and for the three People writes is held in module memory. Sign-in uses the generic failure response, a distinct rate-limit message and a retryable network state; the theme is the only persistent preference. Navigation is built only from effective modules. `/app/people` is the directory screen: it calls `GET /v1/people` through the same `request` helper, renders the returned rows in an accessible `People directory` table (Name, Employee code, Work email, Phone, Placement) with an `aria-live` result count, a search form, Previous/Next paging and loading, retryable error and empty states, and keeps the read/write badge derived from the context. A response is dropped once the search term or page has moved on, so a slow reply cannot overwrite a newer view. For a member whose context reports `canWrite` the toolbar adds **Add person** and each row an **Edit** action opening an inline panel — not a modal — with the six identity fields and `maxLength` from the same contract constants; `api.createPerson` and `api.updatePerson` post JSON through the same helper with the in-memory token in `x-csrf-token`, the controls disable while a request is in flight, and a success closes the panel, reloads the current query and page, and announces `Person created.` or `Person updated.` in a polite live region. Each typed failure code has its own copy, so no server message is displayed verbatim, and a `401` is left to the global handler that returns the app to sign-in. The same row also carries a **Place** action opening its own inline panel: it fetches `GET /v1/people/placement-options`, renders the server's org units as `optgroup`s under their legal entities and `Unplaced` only when `canUnplace` is true, pre-selects the stored pair only when the offer list contains it, keeps **Save placement** disabled until the choices loaded and the selection differs from what is stored, and announces `Placement updated.` on success, with a line stating that placement is a directory attribute rather than an employment record. A non-placeable entity appears as a group heading only, and when nothing is offered the copy says no legal entity or org unit is available yet and that they are created outside this screen today — which is true, because neither table has an administration route. The Placement cell shows the joined names, or an em dash when the person is unplaced or a referenced row was retired. There is no delete, status or employment control anywhere in the UI, and no bulk edit. It renders React text nodes only — no `dangerouslySetInnerHTML` — persists nothing but the theme, and shows no scope label; the rows arrive already narrowed by the database. A member without readable People who opens `/app/people` gets an access state listing their modules. Client routing and hiding are presentation only, never authorization, and the write routes repeat every check independently. One Playwright journey proves the shell against the built output, a disposable database and an in-process API; see `testing.md` §2.13 and [`adr/0006-web-shell.md`](adr/0006-web-shell.md).

`app.has_module_read('<code>')` and `app.has_module_write('<code>')` are the tenant-scoped, security-definer helpers for database checks, and module tables carry restrictive RLS policies built on them (installed idempotently by `app.apply_module_policies()`). `app.has_active_module('<code>')` remains only as an exact alias of the write helper. Application services must still enforce entitlement explicitly; the helpers are a second line of defence, not a replacement for the policy layer.

See [`adr/0002-postgres-rls-tenancy.md`](adr/0002-postgres-rls-tenancy.md), [`adr/0005-modules-and-entitlements.md`](adr/0005-modules-and-entitlements.md), [`adr/0007-people-scope.md`](adr/0007-people-scope.md), [`adr/0008-people-write-path.md`](adr/0008-people-write-path.md) and [`adr/0009-people-placement.md`](adr/0009-people-placement.md).

### Authorization model

Entitlement and role authorization shipped in M0. Scope authorization landed as M1's first slice in the database only.

- **Entitlement** answers whether the organisation has licensed the module at all. The request path checks it first, so an unentitled module never discloses role policy.
- **Role** answers what kind of action is allowed within an entitled module. The policy lives in `@saasmodels/contracts` and is applied by `withMemberTransaction`. The M0 roles are owner, admin, hr, finance, manager, employee and auditor. Owner and admin hold all four People/Work permissions; HR holds People read/write; finance and auditor hold People read and Work read; manager holds People read and Work read/write; employee still holds none, so an employee request denies at `ROLE_DENIED` before any scope policy is reached.
- **Scope** answers where: from `0012_people_scope.sql`, legal entity and org unit (the unit and its whole descendant subtree), plus employee self-scope on the `person.user_id` link. It is enforced by restrictive RLS policies on `person` and `employment` that call owner-owned, `SECURITY DEFINER` helpers, so a query that forgets a scope predicate cannot leak rows — the narrowing is a property of the table, not of the caller. A membership with no scope row is tenant-wide, which is why adopting 0012 changes nothing for existing tenants. Client and project scope are not modelled and have no placeholder columns. See [`adr/0007-people-scope.md`](adr/0007-people-scope.md).
- **Scope narrows and cannot widen.** Every policy 0012 adds is `AS RESTRICTIVE`, and a system transaction that never sets `app.user_id` is deliberately not narrowed at all. That fail-open case is the recorded residual, pinned by `tests/scope.test.ts` and recorded as threat T36.
- **Sensitive actions** (payroll finalise, bank change, data export, role change) require an explicit permission and are always audited. M0 audits its one data export, `GET /v1/people/export`, and gates it with `people.read`; from M1 the People write routes audit `person.created`, `person.updated` and `person.placement.changed` in the same transaction as the change, so an audit failure rolls the write back. A dedicated export permission, payroll finalise, bank change and role change are not built.
- A person's manager may see team leave and timesheets, but not salary, bank details or statutory identifiers. Target.
- Client contacts never use internal roles; they access only a document room through a separate principal type. Target.

Authorization is checked on the server for every request. Scope constrains the rows themselves, through restrictive policies, rather than relying on a service to add a predicate; client and project scope will still need the query-shape work when they land. UI hiding is not authorization. A gated route that skips `withMemberTransaction` loses the role check and, because it never sets `app.user_id`, the scope narrowing too; `withTenantTransaction` is system-only. Authenticated access denials are recorded as `authorization.denied` (see `security.md` §7).

### M0 People directory export

`GET /v1/people/export` is the first production data export and is always registered, independent of proof routes. It takes the tenant and user only from the session and opens a member transaction with the People read gate. A first transaction writes one `people.directory.exported` audit row and commits before any response header is sent; a failure there returns a sanitized 500 and no CSV. A second member transaction rechecks the gate and streams a `NO SCROLL` cursor in validated batches, honouring backpressure and rolling back if the client closes. The response is RFC 4180 CSV with exactly seven identity columns: `person_id`, `employee_code`, `first_name`, `last_name`, `display_name`, `work_email` and `phone`. It carries `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`, omits `Content-Length` and stores no artifact.

Tenant scope comes from RLS, not from a caller value, and since `0012_people_scope.sql` the member transaction behind this route also sets `app.user_id`, so a scoped member's CSV is narrowed by the restrictive policies exactly as the directory page is. The runtime role has column-level `SELECT` on those seven columns plus `deleted_at` and the two placement ids, which is used only to exclude soft-deleted rows and is never exported; the only other person privileges are the write path's `INSERT` on `id, tenant_id` and the six identity fields and `UPDATE` on the six identity fields plus `legal_entity_id` and `org_unit_id` (see §"M1 People directory write path" and §"M1 People placement"), so personal contact, date of birth, gender, status, designation and all employment data remain owner-only for reading and writing alike. Neither placement column is insertable, so a person the API creates is always unplaced. The export itself did not change with the placement work: it still emits seven columns, so a legal entity name appears on the directory screen and not in the CSV. There is no UI, filter, column selection, date range, background job, signed URL, export history, dedicated export permission or export rate limit. See `security.md` §6 and `testing.md` §2.12.

### M1 People directory read path

`GET /v1/people` is the first route written for a screen rather than a file download, and the first member data route narrowed by the 0012 scope policies. It requires a session and runs both its queries inside one `withMemberTransaction` with `{ module: 'people', operation: 'read' }`, so entitlement, then role, then the restrictive scope policies apply in that order; denials return the existing typed codes and write the existing `authorization.denied` row, and a successful read writes no audit row at all.

The route selects only the columns the runtime role is granted on `person` — `id`, `employee_code`, `first_name`, `last_name`, `display_name`, `work_email::text`, `phone`, `legal_entity_id`, `org_unit_id` — with `deleted_at is null`, and maps them plus the two names it joins — `legal_entity` and `org_unit`, each through a `left join` that also guards on `deleted_at is null` — to the `PeopleListResponse` contract (`items` of eleven keys, a JSON-number `total`, `page`, `pageSize`). A null name therefore never means a null id: it means the referenced row was retired. Neither join carries a `tenant_id` predicate. Ordering is `lower(display_name), id` with `limit`/`offset`, and the `count(*)` that produces `total` runs under the same policies in the same transaction, so the total is the member's total rather than the tenant's. A page past the end returns an empty `items` array with the true total.

Filtering and paging are parsed by hand rather than by a schema, and every rejection is `400 INVALID_QUERY` before any query runs: `q` must appear at most once and be at most 100 characters after trimming (an empty or whitespace-only term means no filter), `page` must be an integer from 1 to 1,000,000 (default 1) and `pageSize` an integer from 1 to 50 (default 20). A repeated parameter arrives as an array and is refused rather than silently resolved. The search itself is a literal, case-insensitive substring test — `strpos(lower(column), lower($n)) > 0` over `display_name`, `employee_code` and `work_email` — so `%` and `_` are data, not wildcards, and no SQL string is ever built from the term.

Scope narrowing is left entirely to the database: the route contains no scope predicate in SQL or TypeScript, and `tests/people.test.ts` pins the regression where a manager scoped to one legal entity sees a single row through this route while the tenant owner still sees four in the same run. Every `/v1/people` response, including denials and `400`s, is sent `Cache-Control: no-store`. What is not built: a per-person detail route, and any exposure of the scope itself — `/v1/context` still returns entitlements and permissions only, so the client cannot distinguish a tenant-wide member from a scoped one. See `testing.md` §2.18.

### M1 People directory write path

`POST /v1/people` and `PATCH /v1/people/:id` are the first member writes anywhere in the suite, and they keep the same order of checks the reads established: session, then CSRF, then entitlement, then role, then the database's own scope policies. `requireCsrfToken` is one timing-safe helper shared by logout and both writes, and it runs before any pool is touched, so a wrong or missing `x-csrf-token` answers `403 CSRF_INVALID` at zero database cost; the global `onRequest` origin hook still refuses another origin's `POST`/`PATCH` with `403 ORIGIN_DENIED` before that. The body is parsed inside the gated `withMemberTransaction` with `{ module: 'people', operation: 'write' }`, deliberately after the gate, so a role without `people.write` gets `ROLE_DENIED` even for a malformed body.

Only the six core identity fields are accepted — `firstName`, `lastName`, `displayName`, `employeeCode`, `workEmail`, `phone` — validated by hand against the contract's length constants, trimmed, with a blank optional read as null and any unknown key (`status`, `id`, `legalEntityId`, `orgUnitId`, `userId`, `personalEmail`, `dateOfBirth`, …) refused as `400 INVALID_BODY` with nothing echoed back. `firstName` can never be cleared; a blank display name re-derives from the names; `work_email` is `citext`, so uniqueness and change detection ignore case.

Create asks `app.person_placement_in_scope(null, null)` first and answers `403 SCOPE_DENIED` when it is false: a new person starts unplaced, and an unplaced row is invisible to a scoped member afterwards, so only a tenant-wide member may make one. The database half of that rule is 0012's `scope_insert` policy, unchanged and proven by real DML in `tests/scope.test.ts`. The route then generates the id with `randomUUID()`, inserts `(id, tenant_id, employee_code, first_name, last_name, display_name, work_email, phone)` with `tenant_id` from `app.current_tenant_id()` and **no `RETURNING`**, and reads the directory row back by id inside the same transaction. `RETURNING` is not a style choice here: the restrictive `scope_read` policy evaluates `app.person_visible(id)` against a snapshot that cannot see a row the same command created, so every `person INSERT ... RETURNING` raises `42501` naming `scope_read`. If the read-back returns nothing the invariant is broken, and the route raises a sanitized `500` and rolls the insert back rather than returning a `201` it cannot prove. [ADR 0008](adr/0008-people-write-path.md) carries the reproduction and the rejected alternatives.

Update reads the target row by `id` with `deleted_at is null` inside the gated transaction and answers `404 PERSON_NOT_FOUND` for an unknown, malformed, soft-deleted, cross-tenant or out-of-scope id alike, so no response distinguishes "does not exist" from "not yours to see". It computes the six effective values, compares them to the stored row (case-insensitively for `workEmail`) and, when nothing changed, returns the current item with no `UPDATE` and no audit row. Otherwise it sets only the changed columns — `id`, `tenant_id` and every owner-only column stay out of the statement — and reads the row back through the same directory select the list uses, because the answer must carry the joined placement names and `UPDATE ... RETURNING` cannot. A `23505` maps to `409 PERSON_CODE_TAKEN`, `PERSON_EMAIL_TAKEN` or `PERSON_CONFLICT` on both routes, and none of those bodies repeats the colliding value. Concurrency is last-write-wins: no version column, no precondition, no conflict code.

`person.created` and `person.updated` are appended by `appendAuditEvent` in the same transaction as the write, with the person id, the acting user, request IP and user agent, and metadata limited to sorted field names (`fields` / `changedFields`) — never before or after values, so the audit trail does not accumulate copies of phone numbers and work emails. A failed append rolls the write back and answers `500 INTERNAL_ERROR`, which `tests/people-write.test.ts` proves by revoking the runtime's `INSERT` on `audit_event`. Scope denials and `404` misses write no audit row: the first is a database policy verdict rather than an application access decision, and an audit of misses would become a map of the tenant for anyone who could read it. Entitlement and role denials still write `authorization.denied` exactly as before. See `testing.md` §2.19 and `security.md` §5.1, §6.

### M1 People placement

`GET /v1/people/placement-options` and `PATCH /v1/people/:id/placement` put a person onto a legal entity, onto an org unit inside one, or back to unplaced, and they are the first member-facing action that changes who can see a row. `person.legal_entity_id` and `person.org_unit_id` shipped in `0002_people.sql` and 0012 made placement the unit of People scope, but until this slice only an operator with the owner connection could set them. A placement is a directory attribute: `status`, the employment and compensation columns, `location_id`, `manager_person_id`, `designation` and the date columns stay untouched, and no `employment` row is created or changed.

Both routes run inside one `withMemberTransaction` with `{ module: 'people', operation: 'write' }`, so entitlement, then role, then the 0012 policies are settled before anything else happens — including for the options `GET`, which is a read behind the write gate on purpose: a member who cannot place anybody has no reason to enumerate the org structure. `PATCH` additionally requires the timing-safe CSRF token, and the global `onRequest` hook refuses another origin for it as it does for every state-changing method; the options `GET` needs neither, because it changes nothing. The body is the closed `PeoplePlacementInput` — exactly `legalEntityId` and `orgUnitId`, each a UUID string or `null` — and it is always the whole statement, so there is no omit-to-keep and a unit named under a null entity is refused as `400 INVALID_BODY` before any query, because a unit always sits inside an entity.

No scope rule is restated in the request layer. Every verdict comes from `app.person_placement_in_scope(legal_entity_id, org_unit_id)`, the same `SECURITY DEFINER` helper `scope_insert` and `scope_update` call: `canUnplace` is the both-null call, an entity's `placeable` flag is the entity-only call, an org unit is listed only when its own `(entity, unit)` pair is approved, and an entity is also listed when it owns at least one approved unit — which is how an org-unit-scoped member gets their units grouped under a parent they cannot place on, and why the flag exists rather than an invented rule. The patch calls it once for the pair it is about to store. Reference rows are read by their globally unique id with no `tenant_id` predicate; each reference table's own `tenant_isolation` policy is the tenant boundary, and `has_table_privilege` is false on both tables, so the only readable columns are the eight the allowlist names.

Refusals hide existence. An unknown, malformed or soft-deleted person id, and one in another tenant or outside the member's scope, is the same `404 PERSON_NOT_FOUND` the identity patch gives. An unknown, retired, cross-tenant, wrong-entity or simply out-of-scope reference is `404 PLACEMENT_NOT_FOUND`, so these routes cannot be used to discover whether an org unit exists. The one case with no id to conceal — the both-null unplace, which only a tenant-wide member may perform — answers `403 SCOPE_DENIED` instead. A unit named under a different but real entity is refused by the route, because `person` carries a composite `(tenant_id, id)` foreign key to each reference table and nothing ties the unit's entity to the entity on the row.

The success response is the eleven-key directory item, read back through the same select the list uses; a `rowCount` other than one on the update is a sanitized `500` that rolls the write and its audit back. An unchanged placement issues no `UPDATE` and writes no audit row. A change appends `person.placement.changed` in the same transaction with `{ module, legalEntityId, orgUnitId, previousLegalEntityId, previousOrgUnitId }` — ids only, no names or values — and it is the first People audit row that carries an object reference rather than field names, because a placement is the change that moves which colleagues can see the person, so the before pair is the load-bearing fact. `Scope` and `404` refusals write nothing, and every response on both routes is `Cache-Control: no-store`.

On the screen, the row's **Place** action opens its own inline panel over one `select` with `optgroup`s, offering `Unplaced` only when the server said `canUnplace`, pre-selecting the stored pair only when it appears in the offered list, and keeping **Save placement** disabled until the choices loaded and the selection differs — so no change is ever submitted that the member was not shown. Placement is absent from the CSV, which still emits the seven identity columns; the deliberate divergence between what a member sees on screen and what the export carries is recorded in [ADR 0009](adr/0009-people-placement.md). See `testing.md` §2.20. Legal entity and org unit administration, the org tree, bulk placement, placement history in the UI and any approval step on a move are not built.

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
