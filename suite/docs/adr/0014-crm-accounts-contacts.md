# ADR 0014 — Standalone CRM accounts and contacts on the shared client records

Status: accepted · 28 October 2026 · Batch 2 of the five-module build

## Context

The owner decided on 27 October 2026 that all five modules are built now, reviewed in batches of three
slices, each carrying one ADR, one doc pass and one gate run. Batch 1 built the Work, Money and Content
read surfaces (ADR 0013). Batch 2 is CRM, in three slices reviewed together: the account read surface,
the account create and update, and the shared-client contact read and write.

Three facts about the tree shaped the design, and none of them was visible from the request side:

1. **CRM has no tables of its own, and it does not need any.** The module's records are the shared
   platform-owned `client` and `client_contact` rows that `0003_work.sql` already ships, with their
   columns, their composite `(tenant_id, id)` unique keys and the partial unique index
   `client_contact_primary_uidx` that keeps one primary contact per account. A parallel CRM account
   table would have been a second identity for the same party — the thing rule 3 of `AGENTS.md` forbids
   and the thing the shared directory exists to prevent. So this batch writes **no migration**: no new
   table, no new column, no new policy, no new helper, no new index.
2. **The catalog said CRM could not be held by anyone.** `crm` was `planned`, and `planned` is refused
   to any tenant that is not internal with an internal-source entitlement
   (`packages/db/src/modules.ts`, `resolveModuleCatalog`). A route a real tenant cannot reach is not a
   module surface, so the catalog had to move before the routes meant anything.
3. **The shared tables have no module policy, and must not get one.** `client` and `client_contact`
   carry the permissive `tenant_isolation` policy only — exactly like `legal_entity` and `org_unit`.
   A module policy on `client` would narrow the rows a standalone Work or Money read joins to, and
   the standalone thesis this batch exists to prove is precisely that a Work or Money tenant without a
   CRM entitlement must still read its own projects and invoices. **The module gate on the route is
   the enforcement**; the schema stays shared.

## Decision

1. **The catalog moves CRM to `preview`, and nothing else moves.** In `suite/db/seed/0001_modules.sql`
   the `crm` row is inserted with status `preview`, and the idempotent convergence update
   `update platform_module set status = 'preview' where code in ('crm', 'work', 'money', 'content')
   and status = 'planned';` moves an already-seeded catalog to the same state. `procurement`, `assets`
   and `analytics` stay `planned`, so the planned-module proof in the governance suites still has a
   module to stand on and still fails for a public tenant. `preview` means exactly what ADR 0013 said it
   means: publicly licensable and pre-GA. It does not mean the module is complete — the catalog
   description still names "leads, pipeline and activities", none of which is built, exactly as the
   Work description still names allocations and timesheets. That gap is recorded in the residuals below
   rather than hidden by rewriting the catalog copy.
2. **The published permission set is nine names, and the two CRM names sit ahead of the module reads.**
   `packages/contracts/src/authorization.ts` publishes, in this order:

   ```
   people.read, people.write, people.compensation.read, people.compensation.write,
   crm.read, crm.write,
   work.read, money.read, content.read
   ```

   `permissionFor` derives from this list, so `permissionFor('crm', 'read')` and
   `permissionFor('crm', 'write')` resolve with no extra wiring and **no change to
   `apps/api/src/server.ts`**: the context already derives `canWrite` from the permission the module's
   operation maps to.
3. **The role map gives CRM to four readers and two writers.** Owner and admin hold all nine. Finance
   and manager hold `crm.read` and **not** `crm.write`: a client relationship is what both work against,
   and changing one is an administrative act rather than a reading of it. HR, employee and auditor hold
   neither — a People lead has no reason to see a customer list, and an auditor is built for aggregates
   and reconciliation, which a named contact list is not. Employee stays empty, unchanged.
   Two cells remain open questions and are carried into the threat model as residuals: **auditor
   without `crm.read`**, which is the same shape as the auditor exclusion ADR 0013 already recorded for
   `money.read`, and **whether HR should read CRM at all**.
4. **Six routes, three gates, and one shared-account rule.** The routes are:

   | Route | Gate | Answers |
   | --- | --- | --- |
   | `GET /v1/crm/accounts` | `{module:'crm', operation:'read'}` | `{items, total, page, pageSize}` |
   | `POST /v1/crm/accounts` | `{module:'crm', operation:'write'}` | `201` + the eight-key account |
   | `PATCH /v1/crm/accounts/:id` | `{module:'crm', operation:'write'}` | `200` + the eight-key account |
   | `GET /v1/crm/accounts/:accountId/contacts` | `{module:'crm', operation:'read'}` | `{items, total}` |
   | `POST /v1/crm/accounts/:accountId/contacts` | `{module:'crm', operation:'write'}` | `201` + the six-key contact |
   | `PATCH /v1/crm/accounts/:accountId/contacts/:contactId` | `{module:'crm', operation:'write'}` | `200` + the six-key contact |

   The account item has exactly eight keys — `id`, `name`, `code`, `status`, `billingEmail`, `phone`,
   `currency`, `paymentTermsDays` — and no `tenant_id`, no `owner_user_id`, no provenance column, no
   timestamp and no `deleted_at`. The contact item has exactly six — `id`, `name`, `email`, `phone`,
   `role`, `isPrimary`.
5. **The account list reads the shared `client` row with a soft-delete predicate and a literal search.**
   `deleted_at is null` excludes a retired account; `deleted_at` is granted to the runtime so the
   predicate can run, and it is never returned and never written. The search is
   `strpos(lower(col), lower($n)) > 0` over name, code and billing email — **never `LIKE`**, so `%` and
   `_` are data. The total is a `count(*)` over the same predicate, the order is `lower(c.name), c.id`
   with `limit`/`offset`, so paging is deterministic, and a malformed `page` or `pageSize` is
   `400 INVALID_QUERY` before any query runs. Every response is `Cache-Control: no-store`, and **a
   successful read writes no audit row**.
6. **The account write is a closed body, an explicit column list, a server-generated id and a
   read-back.** The create requires a non-empty name and a three-uppercase-ASCII-letter currency;
   `status` and `paymentTermsDays` take the database's own defaults when the caller leaves them out.
   The update requires at least one key and validates the merged record; only `code`, `billingEmail` and
   `phone` may be `null`. `status` is exactly one of `prospect`, `active`, `dormant`, `archived`, and
   `paymentTermsDays` is a nonnegative integer inside the PostgreSQL integer range. The currency is
   **a stored code and nothing else**: there is no registry, no conversion, no tax rule and no
   jurisdiction logic anywhere in the module.
   The insert names `tenant_id` explicitly as `app.current_tenant_id()`, never names `owner_user_id`,
   the provenance columns, the timestamps or `deleted_at`, and the answer is a fresh `select` of the
   same eight keys rather than a `RETURNING` clause, so the response shape cannot drift from the
   contract.
7. **There is no delete, and a status does not remove a row.** No route deletes an account or a
   contact, and there is no `DELETE` grant on either table. The account list excludes only a row whose
   `deleted_at` is set, and no runtime route can set it; a stored status of `archived` is still
   returned in the list. A soft-deleted account stays in the schema, because the invoices and projects
   that name it still do.
8. **One not-found answer per subject, and the account is settled first.** An unknown, malformed,
   cross-tenant or soft-deleted account id is `404 ACCOUNT_NOT_FOUND`. A contact that does not belong to
   the visible account is `404 CONTACT_NOT_FOUND` — and the account is settled **before** the contact is
   looked for, so a caller cannot learn that a contact exists under an account it may not see. A
   duplicate account code is `409 ACCOUNT_CODE_TAKEN` and a primary-contact conflict is
   `409 CONTACT_PRIMARY_TAKEN`; neither repeats the submitted value and no raw SQL error reaches a
   client.
9. **A write audits the field names it changed, in the same transaction, and never the values.**
   `crm.account.created`, `crm.account.updated`, `crm.contact.created` and `crm.contact.updated` are
   written with `metadata.fields` holding the sorted names of the fields the caller actually named. A
   name, an email, a phone or a currency stays on the row and out of the audit trail. A **patch that
   changes nothing writes no row and audits nothing** — a no-op is a true no-op, not a rewritten row
   with an empty diff. The audit row is written inside the member transaction, so a revoked audit grant
   rolls the write back and answers a sanitized `500`.
10. **One primary contact per account, and the demotion happens before the promotion.**
    `client_contact_primary_uidx` is a partial unique index over `(tenant_id, client_id) where
    is_primary`. When a create or an update sets `isPrimary`, the account's other primary contacts are
    demoted **in the same transaction, before** the new primary is written, so the index holds at every
    point another session can see the rows. The demoted contact is a row that moved without the caller
    naming it, so it is audited in its own right as `crm.contact.updated` with `fields: ['isPrimary']`.
    The `23505` that a concurrent writer can still provoke is caught and answered as a typed
    `409`, never as a raw database error.
11. **The contact write cannot move a contact and cannot erase one.** `client_id` is granted for
    `INSERT` and deliberately absent from `UPDATE`, so no one can re-parent a contact onto another
    account. `id` and `tenant_id` are insert-only on both tables, so no one can move a row onto another
    identity or another tenant. **The shared `client_contact` table has no soft-delete column, and
    there is no delete route: a contact is corrected in place rather than removed.** That is a
    limitation of the shared record, stated here and on the screen rather than papered over with a
    route that would have to invent a deletion the schema cannot represent.
12. **Forty column privileges, and nothing else.** `packages/db/sql/runtime-grants.sql` adds no
    table-level privilege and no `DELETE` on either shared table. On `client` it widens the existing
    column-only `SELECT` to the nine columns the account surface names (`id`, `name`, `code`, `status`,
    `billing_email`, `phone`, `currency`, `payment_terms_days`, `deleted_at`) and adds
    `INSERT (id, tenant_id, name, code, status, billing_email, phone, currency, payment_terms_days)`
    and `UPDATE (name, code, status, billing_email, phone, currency, payment_terms_days)`. On
    `client_contact` it adds
    `SELECT (id, client_id, name, email, phone, role, is_primary)`,
    `INSERT (id, tenant_id, client_id, name, email, phone, role, is_primary)` and
    `UPDATE (name, email, phone, role, is_primary)`. The runtime holds **twenty-five** column
    privileges on `client` and **twenty** on `client_contact`, and `information_schema.role_table_grants`
    stays at its twelve rows over six tables, because a column-qualified grant is not a table
    privilege.
13. **There is no CRM scope model, and none is implied.** No route filters on `tenant_id`: the tenant
    boundary is RLS and `app.tenant_id`, and the account is reached by its globally unique id. There is
    no account-owner rule, no region rule, no visibility rule beyond "the tenant's own rows" and no
    project or client scope. That is the same residual ADR 0013 recorded for Work, Money and Content.
14. **One module-to-route map, one screen, and write controls that are presentation and never
    authorization.** `apps/web/src/lib/router.ts` gains `crm → /app/crm` in the same `MODULE_SCREENS`
    map the navigation and the landing path already read, so a module can never be a link in one place
    and a pending item in another. The CRM screen follows the list-screen conventions the Batch 1
    screens established: a heading, an accessible table, an `aria-live` count, a search form, paging,
    and loading, retryable-error and empty states. The empty copy never claims the workspace holds no
    records. **The write controls appear only when the member's own context says the module can be
    written** — `findModule(context, 'crm')?.canWrite` — so a `crm.read`-only member sees the accounts
    and the contacts and no write control at all. The server checks `crm.write` on every write
    regardless.
15. **The contacts panel belongs to one account and lives on the accounts screen.** Opening the contacts
    of a row reads `GET /v1/crm/accounts/:accountId/contacts`, carries its own loading, retry and empty
    states, and offers Add and Edit only to a writer. It needs **no People entitlement and no person or
    user lookup**: the contacts are shared client records, and a CRM-only tenant sees them without the
    People module existing in the workspace.
16. **The counts, re-derived from the live schema rather than from this brief.** The ledger holds
    **14** migrations. The policy inventory is **277** — 66 permissive, 211 restrictive — and the
    `scope_*` set is still **eleven** names over three tables, unchanged. `saas_runtime` still holds
    exactly **twelve** table-level grants over exactly six tables (`audit_event`, `employment`,
    `module_entitlement`, `platform_module`, `platform_module_dependency`, `project`), and still
    executes exactly **twelve** `app` functions while `saas_worker` executes exactly **eight**, both
    unchanged. Base tables remain **75**, of which **67** carry `tenant_id` and **66** have RLS
    enabled. `saas_runtime` holds **274** column privileges in total; this batch added **forty** of
    them, twenty on `client` and twenty on `client_contact`. **This batch changed no schema figure at
    all**: no migration, no policy, no helper, no table grant, no index.
17. **The three suites and three journeys.** `tests/crm-accounts.test.ts` (17 tests),
    `tests/crm-account-write.test.ts` (26) and `tests/crm-contacts.test.ts` (34) provision real
    tenants through the real path, hold real sessions, and run against the runtime database role in a
    disposable database. They cover the CRM-only owner journey with no People entitlement at all, the
    unauthenticated and bad-session refusals, entitlement-before-role ordering, every role decision
    with its denial audit row, cross-tenant non-disclosure, the exact response keys, the literal
    search, deterministic pages and malformed paging, soft-deleted account exclusion, `no-store` and
    the absent read audit, the CSRF and Origin refusals, the closed bodies and the nullable fields,
    invalid merged patches, the safe integer and the code conflict, the uniform not-found answers, the
    no-op writes, the primary demotion, the audit contents and the rollback, the grant and policy
    inventory, and the absence of any `DELETE` route. `tests/e2e/crm.spec.ts` adds three browser
    journeys: a CRM-only owner who creates an account, edits it, adds two contacts and watches the
    first one demoted after a reload; a `crm.read`-only member who sees the accounts and the contacts
    and no write control; and an `hr` member of the same CRM-entitled tenant, whose role holds no CRM
    permission and who gets no CRM navigation, no CRM data and **no CRM request at all**, with a direct
    `/app/crm` landing rendering an access state. The suites that pinned the old permission count were
    re-derived to nine, not relaxed.

## Consequences

- **A tenant can now buy CRM on its own.** A tenant provisioned with `modules: ['crm']` holds CRM on a
  `contract` entitlement, signs in, lands on the CRM screen, and manages accounts and contacts. The
  standalone thesis is now exercised by a browser journey and not only by a unit test — and it is
  exercised **without** People, Work or Money in the workspace.
- **The same client row is now named by three modules.** A CRM account is the `client` row that Work
  names as the project client and Money names as the invoice client. That is the point of the shared
  directory, and it is also a new source of confusion: a member who holds two of those modules sees the
  same record in two places. The CRM screen says so in its own note.
- **The shared tables are now writable by the runtime role.** Before this batch the runtime could only
  read a client name. It can now create and amend an account and a contact — but only through the six
  module-gated routes, only on the named columns, and never on `tenant_id`, `client_id`, `id`,
  `owner_user_id`, the provenance columns, the timestamps or `deleted_at` after the insert. The grant
  file is the boundary, and the route is the only thing that reaches it.
- **The catalog description now promises more than the module delivers.** The CRM row still reads
  "Accounts, contacts, leads, pipeline and activities". Leads, pipeline and activities do not exist in
  this build, and the same is true of the Work and Money descriptions that ADR 0013 accepted. A
  licensing reader can be misled. The honest fix is either a per-status description or a
  "what this build includes" field, and neither exists; that is recorded here as a gap in the
  catalog, not as a feature of it.
- **A successful CRM read leaves no trail.** The audit gap ADR 0013 recorded is now three surfaces
  wider, and it covers client and contact names — a customer list. No successful read writes an audit
  row; only the writes do. This is a residual in the threat model and a review question, not a
  settled decision.
- **A contact cannot be removed.** The shared table has no soft-delete column and there is no delete
  route, so a wrong contact is corrected in place and stays visible. The screen and the ADR say so.
  An account, by contrast, is never removed by its status: all four stored statuses, including
  `archived`, remain listed. Only an owner-side soft deletion sets `deleted_at`, and that is the one
  thing that takes an account out of the list while the row stays for the invoices and projects that
  name it.
- **Nothing here has run in CI.** The GitHub account is annotated as locked for billing and every run a
  push creates ends with zero steps executed; that is recorded push-stably in T29 rather than as a
  count. The local suites and the browser journeys are the only evidence. **M0 has not exited, and this
  batch does not exit it.**

## Not built

No lead, pipeline, activity, task, note, quote, opportunity or forecast surface: the CRM catalog row
names them and none of them exists. No account merge, no duplicate detection, no conversion of a
person into an account and no account ownership rule. No account delete and no contact delete — the
shared record has no soft-delete column, so a contact is corrected in place. No bulk import, no
export, no field selection, no filter builder and no date range: the only search is the literal
`strpos` over name, code and billing email. No account scope, no contact scope and no region or
visibility rule. No role administration for CRM — the role map is the contract, and there is no route
that changes it. No activity timeline, no email or calendar integration, and no attachment. No CRM
payroll relevance of any kind: compensation belongs to People, and this batch does not touch it. No
`crm.export`, and **the CRM module is not complete and the standalone sale is not ready**: export and
lead→pipeline remain unbuilt, and this ADR does not claim otherwise. No administrative path for
catalog status — moving a module between `planned`, `preview`, `available` and `retired` is still a
reviewed seed change.
