# ADR 0013 — Three module read surfaces at once, and a published permission set that no longer advertises a write nobody can perform

Status: accepted · 27 October 2026 · Batch 1 of the five-module build

## Context

The owner decided on 27 October 2026 that all five modules — People, CRM, Work, Money and Content — are
built now, rather than one at a time, and that the work is reviewed in batches of three slices, each
carrying one ADR, one doc pass and one gate run. CRM has no tables in the schema, so the first batch is
Work, Money and Content. This ADR records that batch.

Three facts about the tree shaped the design, and none of them was visible from the request side:

1. **The tables were already there.** `0003_work.sql`, `0005_money.sql` and `0004_content.sql` ship
   `project`, `invoice`, `content_item` and `client` with their columns, their constraints and their
   restrictive module policies already installed by `app.apply_module_policies()` — `module_work_read`,
   `module_money_read` and `module_content_read` are in the values allowlist in
   `suite/db/migrations/0008_platform_access.sql` and have been since M0. The batch therefore needed **no
   migration**: not one new table, policy, helper or index. The schema half of this slice was already
   written and untested, which is the whole reason the three modules could be read in one batch rather
   than one at a time.
2. **The catalog said the opposite.** All three modules were `planned`, and `planned` is refused to any
   tenant that is not internal with an internal-source entitlement
   (`packages/db/src/modules.ts`, `resolveModuleCatalog`). A read surface for a module no tenant can hold
   is a route nobody can reach, so the catalog had to move before the routes meant anything.
3. **The published permission set advertised a write nobody could perform.** `PERMISSIONS` held six names
   and the sixth was `work.write`. No route asked for it: the Work surface that existed was a M0 *proof*
   route, `/v1/proof/work/projects`, which is registered only under test enablement. While `work.write`
   stayed published, `permissionFor('work', 'write')` answered a name, `/v1/context` answered
   `canWrite: true` for Work to every role holding `work.read`, and the client would have rendered a
   write affordance for a module that cannot write.

## Decision

1. **The catalog moves three modules to `preview`, and `preview` means exactly one thing.** In
   `suite/db/seed/0001_modules.sql` the `work`, `money` and `content` rows are inserted with status
   `preview`, and an idempotent `update platform_module set status = 'preview' where code in ('work',
   'money', 'content') and status = 'planned';` moves an already-seeded catalog to the same state. The
   insert is `on conflict (code) do nothing`, so the update is what actually changes an existing
   database — both halves are needed, and both are idempotent, so `pnpm db:seed` twice changes nothing the
   second time. `crm`, `procurement`, `assets` and `analytics` stay `planned`.
   `preview` means: **publicly licensable and pre-GA.** A normal tenant can hold it on a `contract`
   entitlement, `app.has_module_read` accepts it, and its shipped read surfaces are served. It does not
   mean generally available, and it does not mean anything beyond the shipped surfaces works — Work has a
   project list, not allocations, timesheets or margin.
2. **There is no administrative path for catalog status, and that gap is recorded rather than papered
   over.** Nothing in this repository writes `platform_module.status` after the seed: moving a module
   between `planned`, `preview`, `available` and `retired` is still a reviewed seed change. The header
   comment in the seed file says so, and "no administrative path for catalog status" appears in the
   *Not built* list below and in the roadmap's still-not-built list. A product that can sell a module
   should be able to turn one on, and it cannot yet.
3. **The published permission set is seven names, and `work.write` is withdrawn.**
   `packages/contracts/src/authorization.ts` now publishes, in this order:

   ```
   people.read, people.write, people.compensation.read, people.compensation.write,
   work.read, money.read, content.read
   ```

   `work.write` is **withdrawn**, not re-purposed. The reason is specific and it is the only reason:
   it was the only published permission no route asked for, and while it was published `/v1/context`
   answered `canWrite: true` for Work — a capability the product cannot perform and no screen offers.
   Because `permissionFor` derives from `PERMISSIONS`, `permissionFor('work', 'write')` is now `null`, so
   `/v1/context` answers `canWrite: false` for Work **with no change to `apps/api/src/server.ts`**: the
   context derives `canWrite` from the permission the module's operation maps to, and there is no
   `work.write` to map to. `permissionFor('money', 'write')` and `permissionFor('content', 'write')` are
   `null` for the same reason. A write that is not built is not published; publishing one is how a
   client learns to offer a control the server will refuse.
4. **The role map is a deliberately minimal first cut, and the two debatable cells are review questions
   rather than decisions.** Owner and admin hold all seven. HR holds the four People permissions. Finance
   holds `people.read`, `people.compensation.read`, `people.compensation.write`, `work.read` and
   `money.read` — it writes pay without `people.write` for the reason ADR 0012 recorded, and it reads
   Money because invoices are what it reconciles. Manager holds `people.read` and `work.read` — **it
   loses `work.write`**, because no Work write exists. Auditor holds `people.read` and `work.read` and
   **no `money.read` and no `content.read`**. Employee holds nothing, unchanged.
   Two cells are open questions and are recorded as such:
   - **Auditor without `money.read`.** An audit role that cannot read an invoice list cannot reconcile
     against one. ADR 0011 recorded the analogous exclusion of `auditor` from the compensation
     permissions as a policy choice rather than a capability limit, and this is the same shape. It is
     carried into the threat model as a residual and asked as a review question.
   - **HR without `content.read`.** Not a decision this slice makes. The map is a minimal first cut:
     nobody asked for HR to read the CMS, so nobody gave it that permission.
   The map is the smallest set that lets each shipped read surface be reached by a role that needs it.
5. **Three column-only `SELECT` grants, and nothing else.** `packages/db/sql/runtime-grants.sql` adds
   exactly three grants:

   ```sql
   grant select (
     id, client_id, number, status, issue_date, due_date, currency,
     subtotal_minor, tax_minor, total_minor, amount_paid_minor
   ) on table public.invoice to saas_runtime;

   grant select (
     id, kind, slug, title, locale, status, published_at, updated_at, deleted_at
   ) on table public.content_item to saas_runtime;

   grant select (
     id, name, code, status, deleted_at
   ) on table public.client to saas_runtime;
   ```

   There is no table-level privilege on any of the three, and no `INSERT`, `UPDATE` or `DELETE` on
   `invoice`, `content_item` or `client`: the three new grants are column-only `SELECT`, so on those
   three tables the runtime role has no path that could create, change or remove a row.
   `project` is the exception and it is deliberate — it keeps its M0 table-level `SELECT`, `INSERT`,
   `UPDATE` and `DELETE` grant, as decision 6 records. What Work, Money and Content do not have is a
   product write surface: no route and no screen creates, changes or removes a project, an invoice or a
   content item.
   `information_schema.role_table_grants` stays at its twelve rows over six tables, because
   `information_schema.role_table_grants` lists only table-level grants; a column-qualified grant
   appears in `information_schema.column_privileges` instead, and `has_table_privilege` is false for all
   four commands on all three of these tables. `tests/schema-inventory.test.ts` pins the twenty-five new
   column privileges by column and by command.
6. **`public.project` keeps its M0 table-level grant, and the Work route is written around it.**
   `project` already carried `SELECT`, `INSERT`, `UPDATE` and `DELETE` at table level from M0, and
   **two tests in `tests/module-rls.test.ts` depend on it through real DML as the runtime role**:
   *"tenant A insert into project is denied by row-level security, not table privilege"* and
   *"tenant A update and delete of its project row affect zero rows"*. They prove the M0 module denial
   and the cross-tenant denial on `project`, and they must fail on the restrictive RLS policy rather
   than on a missing table privilege — the first asserts the error text matches `/row-level security/`
   and does **not** match `/permission denied for table project/`, and the second asserts the update
   and the delete affected zero rows rather than raising. Narrowing that grant would turn a policy
   proof into a privilege error and change what those two tests prove, so the narrowing is
   **deferred to the Work write slice** and recorded here rather than done now.
   The consequence for this slice is a discipline, not a privilege: because `project` is table-level
   granted, the Work route names **only the columns it returns**, and never selects
   `source_system`, `source_id`, `import_batch_id`, `imported_at`, `budget_hours`, `manager_user_id` or
   `tenant_id`. `PROJECT_SELECT` is the list, in full: `id`, `code`, `name`, `client_id`, the joined
   `client.name`, `status`, `currency`, `start_date`, `end_date` and `budget_minor`.
7. **`public.client` is platform-owned shared directory data, and its grant follows that precedent.**
   `client` carries only the permissive `tenant_isolation` policy and **no module policy of its own**,
   exactly like `legal_entity` and `org_unit`, which is what the placement path already relies on. Its
   rows are reached by their globally unique id and are never filtered on `tenant_id` in the route; the
   composite `(tenant_id, id)` foreign keys from `project` and `invoice` make a cross-tenant reference
   un-storable, and the reference table's own policy hides any other tenant's row from the lookup. The
   column grant follows the `legal_entity` / `org_unit` precedent — five columns, no table-level
   privilege, no write, no grant on `tenant_id`. **Its exposure is bounded by the route that reads it,
   and the only two routes that will read a client name are module-gated**: `GET /v1/work/projects`
   behind `{ module: 'work', operation: 'read' }` and `GET /v1/money/invoices` behind
   `{ module: 'money', operation: 'read' }`. A member without either entitlement reaches neither.
8. **Three routes, one shape, three gates.** `GET /v1/work/projects`, `GET /v1/money/invoices` and
   `GET /v1/content/items`, gated `{ module: 'work', operation: 'read' }`,
   `{ module: 'money', operation: 'read' }` and `{ module: 'content', operation: 'read' }`. Each route:
   the session is checked first and answers `401` before anything else; the query parameters are parsed
   with the same helpers the People route uses, so a malformed `page` or `pageSize` is
   `400 INVALID_QUERY` before any query runs; then `withMemberTransaction` opens the member transaction
   and settles entitlement, then role, then the rows; the search is a literal
   `strpos(lower(col), lower($n)) > 0` — **never `LIKE`**, so `%` and `_` are data and cannot widen the
   match; the total is a `count(*)` over the same predicate; the order is
   `lower(<name>), <id>` with `limit`/`offset`, which makes paging deterministic; the body is
   `{ items, total, page, pageSize }`; every response is `Cache-Control: no-store`; **no CSRF token is
   required** (all three are `GET`s that change nothing); and **a successful read writes no audit row**.
   The Money route searches `number` and the joined client name; the Work route searches the project
   name, the project code and the joined client name; the Content route searches title, slug and kind.
   Work and Money join `client` for the client name; `content_item` has no client column, so the
   Content route joins nothing and the client grant does not reach it.
9. **No scope rule is restated in TypeScript.** The restrictive policies `module_work_read`,
   `module_money_read` and `module_content_read` narrow the rows, and the routes filter on
   `deleted_at is null` only. None of the three routes filters on `tenant_id`: tenant scope comes from
   `app.tenant_id` and RLS, and the client join addresses a row by its globally unique id. There is no
   module scope model for Work, Money or Content in this build — project and client scope do not exist
   yet, which is the same residual T36 already records for the People tables.
10. **Money is displayed as stored, and a figure a JavaScript number cannot hold is refused rather than
    rounded.** `subtotal_minor`, `tax_minor`, `total_minor`, `amount_paid_minor` and `budget_minor` are
    `bigint` minor units with an explicit ISO currency on the row. The route selects each as `::text`,
    parses it with `Number.parseInt`, and **a value outside `Number.isSafeInteger` answers
    `500 INTERNAL_ERROR`** — the same convention the compensation read adopted in ADR 0011 and
    `tests/people-compensation.test.ts` pins. The screen shows the stored figures beside their stored
    currency code and computes nothing: no totals across rows, no currency conversion, no overdue
    calculation, no proration, no annualisation. The tax column is labelled **Tax** and is a stored
    amount — never a rate, never a jurisdiction-derived rule, and never "VAT", "GST" or any other
    jurisdiction-specific word, because no jurisdiction pack exists to justify one. The stored status is
    shown as stored.
11. **One money formatter, and the compensation panel now delegates to it.**
    `apps/web/src/lib/money.ts` exports `formatMinorAmount(minorUnits, currency)`, carrying the existing
    `formatCompensationAmount` behaviour and its comment: two fractional digits for every currency,
    because no table records a decimal exponent; a display convention, not a conversion; the currency
    code beside the figure. `formatCompensationAmount` in `apps/web/src/lib/model.ts` is now a delegate to
    it, so there is exactly one implementation. `apps/web/test/model.test.ts` is re-derived for the
    delegate rather than relaxed.
12. **One module-to-route map, used by navigation and by the landing path.**
    `apps/web/src/lib/router.ts` holds `MODULE_SCREENS` — `people → /app/people`,
    `work → /app/work`, `money → /app/money`, `content → /app/content` — and `moduleScreenPath(code)`
    reads it. Both the navigation (`apps/web/src/components/AppShell.tsx`) and the landing path
    (`landingPath` in `apps/web/src/lib/model.ts`) read that one map, so a module can never be a link in
    one place and a pending item in another, and a route can never exist for a module the navigation does
    not offer. A module with a screen becomes a link; a module without one stays the `nav-item--pending`
    item with its **Soon** tag; **a module with a screen never shows the Soon tag.**
13. **The landing rule: the first navigation module, in catalog order, that has a screen.** Before this
    slice `landingPath` sent a member who could read People to `/app/people` and everyone else to
    `/app`, so a member whose only module was Work landed on a home page that only lists modules. The
    rule now walks the effective modules in catalog order (`core` 0, `switch` 1, `people` 10, `crm` 20,
    `work` 30, `money` 40, `content` 50, …) and lands on the first one that has a screen. A member with
    no module that has a screen lands on `/app`, which is where the module roster is.
14. **Three screens, in a new file.** `apps/web/src/components/ModuleScreens.tsx` holds the Work, Money
    and Content screens — `Screens.tsx` is already 2288 lines. Each screen has a heading, an accessible
    table, an `aria-live` result count, a search form, Previous/Next paging, and loading, retryable-error
    and empty states. **The empty copy never claims the workspace holds no records**: the Money screen
    does not say that no invoices were issued, the Work screen does not say that no projects exist, and
    the Content screen does not say that there is no content. Each says the view is limited to what the
    member's role and the workspace's records make visible. The Work screen shows project name, code,
    client, status, currency, start and end dates and the budget figure beside its currency; the Money
    screen shows the invoice number, client, status, issue and due dates, the stored subtotal, tax, total
    and amount paid, each with its currency code, and the **Tax** column header; the Content screen shows
    kind, title, slug, locale, status and the updated date.
15. **`/v1/proof/work/projects` is now a duplicate of `GET /v1/work/projects`, and it is kept only as M0
    evidence.** The proof route is registered only under test enablement and was the M0 proof that the
    Work module's RLS answers a module denial. The product route is the same read with a real gate, a
    real contract and a real screen. The proof route is unchanged and stays; it is duplicated on purpose
    and the duplication is recorded here rather than left to look like an accident.
16. **The counts, re-derived from the live catalog rather than from this brief.** The ledger holds **14**
    migrations. The policy inventory is **277** — 66 permissive, 211 restrictive — and the `scope_*` set
    is still **eleven** names over three tables, unchanged. `saas_runtime` still holds exactly **twelve**
    table-level grants over exactly six tables (`audit_event`, `employment`, `module_entitlement`,
    `platform_module`, `platform_module_dependency`, `project`), and the three new grants are
    column-qualified so they do not appear in that view. `saas_runtime` still executes exactly **twelve**
    `app` functions and `saas_worker` exactly **eight**, both unchanged. Base tables remain **75**, of
    which **67** carry `tenant_id` and **66** have RLS enabled, and the nine tables without RLS are the
    same nine. **This batch changed no schema figure at all**: no migration, no policy, no helper, no
    table grant. The only grant change is twenty-five column privileges.

## Consequences

- **Three modules are reachable by a real tenant for the first time.** A tenant provisioned with
  `['people', 'work', 'money', 'content']` can now hold all four on `contract` entitlements and read
  three of them through the product. That is the first time the suite proves more than one independently
  licensed module in one tenant, and it is the first time the "modules are configuration, not editions"
  claim is exercised against a normal rather than an internal tenant.
- **The catalogue status of a module is still a code change.** Moving a module from `preview` to
  `available`, or back to `planned`, is a reviewed seed edit and a migration-review conversation. A
  customer cannot be onboarded onto a module that has not been published in the catalog, and the
  licensing team cannot turn a module off without a deployment. This is the honest cost of the slice
  being three reads rather than three reads plus a licensing surface, and it is recorded as a gap.
- **`canWrite` for Work is now `false` everywhere, and one published name disappeared.** Anything that
  read `/v1/context` expecting `canWrite: true` for a Work-holding member now sees `false`. That is the
  point — but it is a change in an API's answer, and the suites that pin the context shape were
  re-derived rather than relaxed.
- **The audit gap is real and it is wider now.** A successful module read leaves no trail. That was
  already true for the People directory, the export, the placement options and the employment and
  compensation histories; it is now true for three more read surfaces, two of which disclose **money**
  and one of which discloses **client names**. Nobody can be told who looked at an invoice list. This
  is recorded as a residual in the threat model and as a review question, not glossed over.
- **The auditor exclusion is now sharp enough to name.** Before this slice an auditor without
  compensation was defensible as "aggregates, not named colleagues". An auditor without `money.read`
  cannot reconcile against an invoice, which is the job. The exclusion stands for this slice because it
  is a deliberate first cut, and it is asked as a review question rather than settled by the implementer.
- **`project` still has whole-table `DELETE` in the runtime's hands.** Nothing in the product calls it,
  but the grant is wider than the Work route needs and wider than the column-only grants beside it. It
  stays because two M0 proofs depend on it, and it is named here as deferred work for the Work write
  slice rather than left as an unexplained asymmetry in the grant file.
- **The client grant exposes the shared directory to two module routes.** `client` is platform-owned and
  has no module policy, so its only boundary is `tenant_isolation` plus the routes that reach it. The
  two routes that read a client name are module-gated, which means the exposure follows the Work and
  Money entitlements. A third route that joined `client` for a different module would widen it, and
  nothing in the schema would stop that — the grant boundary is the route boundary, which is a review
  discipline rather than a database constraint.
- **Nothing here has run in CI.** The GitHub account is annotated as locked for billing, every run a push
  creates ends with zero steps executed, and that is recorded push-stably in T29 rather than as a count.
  The local suite and the browser journeys are the only evidence. **M0 has not exited, and this batch
  does not exit it.**
- **The module screens are read-only by construction, and the copy says so.** Each screen states what it
  shows and what it does not compute. There is no "coming soon" or "arrives in a later milestone" claim
  for anything this batch ships — a module with a screen is a link, and a module without one is the
  pending item with its **Soon** tag, which is what the catalog's `planned` modules still are.

## Not built

No write surface in any of the three modules: no route, no policy and no panel creates, amends or
deletes a project, an invoice, a content item or a client. The runtime role holds no write privilege on
`invoice`, `content_item` or `client` — the three new grants are column-only `SELECT` — and `project`
deliberately keeps its M0 table-level grant, which decision 6 records and the residuals below name. No
`work.write`, `money.write` or `content.write` permission is published, so `permissionFor` answers `null`
for all three. No
administrative path for catalog status — moving a module between `planned`, `preview`, `available` and
`retired` is still a reviewed seed change. No CRM: the module has no tables, no route, no screen and no
grant. No project scope, no client scope, no module scope of any kind for Work, Money or Content — the
restrictive module policies narrow the rows, and no scope model narrows them further. No allocation,
timesheet, milestone, task, deliverable or project-cost surface; no proposal, contract, payment, credit
note, expense or vendor-bill surface; no content version, asset, knowledge page or document-room
surface. No invoice creation, no status transition, no due-date or overdue computation, no tax rate, no
jurisdiction rule and no currency conversion anywhere. No currency registry: `currency` is `char(3)`
with no `CHECK`, so a stored code is printed as stored, exactly as ADR 0011 recorded for compensation.
No audit row on a successful module read and no audit read surface of any kind. No export, import,
filter, column selection or date range for any of the three modules. No total, aggregate, chart or
cross-module report. No employee-facing or self-service path in any of the three.
