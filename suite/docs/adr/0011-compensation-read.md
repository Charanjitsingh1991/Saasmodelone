# ADR 0011 — Compensation is a separate disclosure: its own read permission, a scope policy that arrives with the grant, and an amount nothing in this build converts

Status: accepted · 27 October 2026 · M1 slice 7 (T22)

## Context

`0002_people.sql` created `compensation` as a child of `person`: `person_id` with a composite
`(tenant_id, person_id)` foreign key, `effective_from not null` and `effective_to` as `date`s with a
`CHECK` that a closing day cannot precede the opening one, `ctc_minor` as a `bigint` with
`CHECK (ctc_minor >= 0)`, `currency` as `char(3)`, `pay_frequency` as `text` defaulting to `monthly`
with a four-value `CHECK`, a `structure` `jsonb` for a pay breakdown, the columns the import path owns
(`source_system`, `source_id`, `import_batch_id`, `imported_at`), the two timestamps, `unique (tenant_id,
id)` for composite-key targets, and `unique (tenant_id, person_id, effective_from)` — one salary row per
person per opening day. It carried the permissive `tenant_isolation` policy like every tenant table and
`app.apply_module_policies()` gave it the `module_people_*` set. What it never had was a scope policy,
and `packages/db/sql/runtime-grants.sql` never named it: `saas_runtime` held no privilege on the table
at all, table-level or column-level. So the salary table was invisible twice over — no product surface
could reach it, and the scope layer had nothing to say about it.

That made the schema and the product disagree about a person. ADR 0008 gave a member the six identity
fields, ADR 0009 the placement, ADR 0010 the employment dates and status, and the employment panel's own
fine print closed with "compensation is not editable anywhere yet". Meanwhile the one question an HR or
finance user asks after *when were they employed* is *what did they cost*, and the answer was already
sitting in a table no route could read.

Four constraints shape the design, and the first is the reason this slice is a read and nothing more:

1. Salary is a stricter disclosure than the directory. `people.read` says a member may list their
   colleagues; it does not say they may see what each one costs. So compensation gets a permission of
   its own rather than riding on the read it sits beside, and the roles that hold the two sets are not
   the same roles.
2. Scope is a database property (ADR 0007). A salary route may not re-derive who can see a person; it
   asks the same oracle the person policies ask, and the rows it reads are narrowed by that oracle in
   the catalog, not in TypeScript.
3. The meaning of `ctc_minor` belongs to payroll. The column is a count of minor units of `currency`
   and the schema does not say whether it is an annual cost to company or a per-period amount;
   `pay_frequency` is stored data, not a rule for converting one into the other. Non-negotiable 7 says
   this product does not invent rules in application code, and a salary annualisation is exactly that.
4. A read-only slice must still be least-privilege-complete. The grant and the policy that bounds it
   land in the same change, for the reason §5 records.

## Decision

1. **Compensation has its own permission, and it is a read.** `PERMISSIONS` in
   `packages/contracts/src/authorization.ts` is now `people.read`, `people.write`,
   `people.compensation.read`, `work.read`, `work.write` — five entries, and the third one is this
   slice's whole product. There is no `people.compensation.write`: no route in this build writes a
   salary row, and a permission with no writer would be a promise the contract makes that the API
   cannot keep. The directory read, the placement reads and writes and the employment routes are all
   unchanged; a member whose only People permission is `people.read` cannot reach a compensation row
   any more easily than before, and the refusal happens in the gate, before the person id is looked at.
2. **Four roles hold it and three do not.** `owner`, `admin`, `hr` and `finance` gain
   `people.compensation.read`; `manager`, `auditor` and `employee` do not have it. The three that are
   excluded are excluded for different reasons and both reasons are recorded here rather than left to
   inference. `manager` holds `people.read` and `work.*` and sits at the wrong end of the question:
   a line manager sees the directory and their team's work, not the pay of the people in it. `auditor`
   holds `people.read` and `work.read` and is left out as **a policy choice, not a capability limit** —
   nothing about the role makes a named colleague's salary necessary to reconcile a period, and most
   audit work needs aggregates rather than rows. That is a judgement about how this product should be
   licensed, so it is recorded as a residual in the threat model and put to the reviewer as
   [review question 14](../security/m0-threat-model.md): should auditors see individual salary? Because
   `permissionsForRole` filters `PERMISSIONS`, ordering the list puts the new permission third in
   `/v1/context` for every role that holds it.
3. **`TenantGate` gained an optional `permission`, and the check order did not move.** A gate is now
   `{ module, operation, permission? }`. `assertGate` fails closed on an override: a string that is not
   in `PERMISSIONS`, or that does not start with `${gate.module}.`, throws
   `RoleAccessDeniedError` with `'Gate permission is not recognised'` before the transaction opens,
   because a gate naming a permission that exists nowhere is a programming error and `hasPermission`
   would otherwise report it to the caller as though it were a real thing a role could be granted.
   `withMemberTransaction` resolves the role question as `gate.permission ?? permissionFor(gate.module,
   gate.operation)` and its order is exactly as ADR 0005 and 0008 set it: membership, then platform
   access, then `has_module_read` / `has_module_write` for the module and operation the route named,
   then the role's permission. `MODULE_OPERATIONS` stays `['read', 'write']` — the entitlement layer has
   two verbs and compensation does not need a third. So the compensation route asks the module
   entitlement question as a `people` read and the role question as a narrower one, an unentitled
   tenant still answers `MODULE_NOT_ENTITLED` first and never learns which roles could read a salary,
   and the `ROLE_DENIED` denial names `people.compensation.read` — the permission actually asked, not
   the module default.
4. **`GET /v1/people/:id/compensations` is the only compensation route, and it hangs off a person.**
   There is no `/v1/compensations` collection, no cross-person salary list, no search and no per-record
   detail route, for the same reason ADR 0010 §1 gives: a salary history is read per person, from a
   person the caller can already reach, which makes the directory the enumeration boundary. Inside the
   route the order is fixed — session, then the gated member transaction, then the `UUID_TEXT_PATTERN`
   guard, then the person read, then the history. The person read is the visibility test and it is
   `DIRECTORY_SELECT`, the directory's own select, narrowed by `person`'s `scope_read`; unknown,
   malformed, soft-deleted, another tenant's or out of scope are one uniform `404 PERSON_NOT_FOUND`, so
   a salary path cannot be used to probe for a colleague the member may not list. **No scope predicate
   is restated in TypeScript and no scope helper is called.** That is the deliberate difference from
   ADR 0010 §8: the employment *writes* needed `app.person_in_scope` because a refusal there arrives as
   an unmapped `42501` or a silent zero-row `UPDATE`, while this is a read and `compensation`'s own
   `scope_read` answers the same `app.person_visible(person_id)` the person row was already read
   through — one oracle, one decision, nothing to map. `GET`, so no CSRF header; `no-store` from the
   existing `/v1/people` `onSend` rule; and no audit row on a successful read, because no read in this
   product is audited and a salary read is where that convention starts to matter (§6).
5. **The grant and the policy land together, because the invariant test discovers tables by read
   privilege.** `suite/db/migrations/0013_compensation_read.sql` adds exactly
   `create policy scope_read on public.compensation as restrictive for select using
   (app.person_visible(person_id));` and `packages/db/sql/runtime-grants.sql` adds exactly
   `grant select (id, person_id, effective_from, effective_to, ctc_minor, currency, pay_frequency) on
   table public.compensation to saas_runtime;`. Neither alone is safe and the suite enforces that:
   `tests/scope.test.ts` discovers every `public` table with a `person_id` column that `saas_runtime`
   can read — by a table-level **or** any column-level `SELECT` — and requires exactly one restrictive
   `r` policy naming `app.person_visible(person_id)`. Grant without the policy fails that test with
   `compensation` in the uncovered list, which is the failure the suite exists to produce. The policy
   list stops at a read on purpose: no `scope_insert`, `scope_update` or `scope_delete` here, because
   the runtime holds no write privilege on the table to test one against and an untestable policy is
   surface area. They arrive with the migration that grants the write. There is no new function, no
   change to an existing helper, no table-level privilege and no change to the twelve runtime
   table-level grants. The seven columns are exactly the ones the route names: no `tenant_id` (the
   composite foreign key and `tenant_isolation` do that work), no `structure` — that `jsonb` is where
   an unreviewed pay breakdown would live — and no source, import or timestamp columns, which stay
   owner-only for the same reason they do on `person`. Column-level grants do not appear in
   `information_schema.role_table_grants` and `has_table_privilege` is false for a table holding only
   column privileges, so `tests/people-compensation.test.ts` pins the seven by `aclexplode` and asserts
   all four table-level privileges are absent.
6. **A stored amount is presented as stored, and a figure too large for a JavaScript number is
   refused.** `ctc_minor` is a `bigint`, so the select reads `c.ctc_minor::text` and
   `compensationItemFromRow` converts with `Number.parseInt` and checks `Number.isSafeInteger`;
   outside it the route answers `500 INTERNAL_ERROR` with the write of nothing, because a rounded
   money figure is a lie a caller cannot detect. There is no `::float8` anywhere. Nothing computes,
   annualises, prorates or relabels: `CompensationItem` carries `ctcMinor`, `currency` and
   `payFrequency` as three independent stored values, the column header is **Amount** rather than
   "monthly salary" or "annual CTC", and the only exported helper is the pure
   `formatCompensationAmount(1234567, 'INR') === '12,345.67 INR'`. It groups thousands by regex rather
   than `Intl.NumberFormat` so the separators do not depend on the locale data of whichever machine
   renders, and it assumes two fractional digits because the table records no decimal exponent — a
   display convention with a real limitation, recorded in §7. Payroll defines the relationship between
   the amount and the frequency; this slice refuses to guess it.
7. **One contract, seven keys, no envelope.** `COMPENSATION_PAY_FREQUENCIES` is
   `['monthly', 'semi_monthly', 'biweekly', 'weekly']` restated from the `CHECK` so a screen labels a
   stored value without inventing a vocabulary, and `CompensationItem` is `id`, `personId`,
   `effectiveFrom`, `effectiveTo`, `ctcMinor`, `currency`, `payFrequency` — and nothing else. No create
   or update input type exists in `packages/contracts/src/people.ts`, so a future write slice has to add
   one rather than reuse a shape built for a read. Dates are `to_char(..., 'YYYY-MM-DD')` in SQL for the
   same reason the employment rows are: a wire shape of one calendar day, not a timestamp a session
   timezone can shift. The response is `{ items, total }` with `total` the length of `items`, ordered
   `effective_from desc, c.id`.
8. **A history is one row per opening day, so the tie-breaker the ordering names is unreachable
   through this route.** `unique (tenant_id, person_id, effective_from)` means two of a person's rows
   can never share an `effective_from`, so `c.id` never resolves a tie and no test can make it. It is
   kept because it costs nothing and because a route that reads across people — the export, or a future
   aggregate — would need it; the test says so plainly rather than claiming coverage of a branch that
   cannot be taken.
9. **The screen offers the action only where the server's own permission list says so, and it writes
   nothing.** `canReadCompensation(context)` reads `context.permissions`, not what the panel would like
   to show, and when it is false the directory row carries **no** Compensation action at all — not a
   disabled one, since a control the route would refuse is a question the product should not invite.
   When true, every row gets one, including rows the member cannot edit, because this is a read. The
   panel shows a loading line, a retryable error with **Try again**, the empty copy "No compensation is
   recorded for this person yet.", or a four-column table of effective from, effective to
   (`—` when null), the amount with its stored currency code inside that same cell, and pay
   frequency inside the same horizontally-scrollable container the directory and the
   employment history use. There is no Add, Edit or Save and no input, select or textarea anywhere in
   it — read-only by construction, not read-only by a disabled attribute. The fine print states that
   compensation is read-only in this build, that no route can add, change or remove a record, and that
   payroll, payslips and statutory deductions are not built, so each row is a stored amount in its own
   currency with its stored frequency beside it rather than a salary worked out from it. Every
   reachable failure code has its own copy, including `ROLE_DENIED` — "Your role can open the directory
   but not salary history. Reading pay needs the compensation read permission." — and the raw server
   message is never shown. History is fetched when the panel opens and a late response is dropped, so a
   slow answer cannot be displayed against a different colleague. **Scope stays invisible**: no scope
   value or label, no `/v1/context` shape change beyond the longer `permissions` array, and no signal
   to a member about which people their scope covers — the only thing a member may infer from this
   route is what the uniform 404 already permits.
10. **Nothing else moved.** The CSV export, the directory contract and its eleven-key row assertions,
    the placement routes, the three employment routes, the 26 `person` column privileges and the twelve
    runtime table-level grants are untouched; `tests/people-export.test.ts` passes unchanged and the
    test pins that the export bytes are byte-identical after compensation rows exist, so a salary read
    cannot leak through the directory export by accident. The migration ledger ends at
    `0013_compensation_read.sql` (13 files), the policy inventory is 275 (66 permissive, 209
    restrictive) and the scope-policy set is nine names across three tables.

## Consequences

- **A fourth privilege surface now decides People reads.** Before this slice the runtime's reach into
  People was `person`'s 26 column privileges and whole-table DML on `employment`; `compensation` is now
  the second table the scope layer narrows for a read and the third table whose privileges the suite
  inventories. It is also the first table whose *entire* runtime reach is column-level — no table
  privilege at all — so `has_table_privilege('saas_runtime','compensation','select')` is false while
  seven named columns are readable, which is exactly the asymmetry that surprised reviewers on `person`
  and is now the documented pattern.
- **The scope invariant test got a third table by discovery, not by edit.** That is the intended
  behaviour of a rule with no exceptions list: a later slice that grants a `person_id` table without a
  scope policy fails, and the failure names the table. `tests/scope.test.ts` needed no change to cover
  `compensation`.
- **A real defect in the denial audit path was found by this slice.** `recordAccessDenial` in
  `packages/db/src/denials.ts` validated `permission` against `/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/`,
  which allows exactly one dot, so `people.compensation.read` threw `TypeError` — and the caller
  (`accessError`) swallows audit failures into `request.log.error`. The visible symptom was that the
  `ROLE_DENIED` refusals this slice exists to produce wrote **no** `authorization.denied` row at all: a
  silent audit hole opened by adding a three-part permission, not by the change to the auditor matrix.
  The validator now checks membership in the published `PERMISSIONS` list rather than a shape, so an
  unrecognised string is refused against the same source of truth the gate uses, and a new test calls
  `recordAccessDenial` directly with `people.compensation.read` and asserts the row. Any future
  permission whose name has more than one dot was already going to be unrecorded; that class of bug is
  closed for this table, and the general rule — an audit write that can fail must be exercised by a
  test that can see the row — belongs to the next slice that adds a denial reason.
- **Three of the seven roles cannot see pay, and two of them are the roles a customer may expect to.**
  A `manager` cannot answer "what does this report cost" from the product, and an `auditor` cannot
  answer it either while holding the rest of the People and Work reads. Until an aggregate or a
  structure-level surface exists, the answer for both is a manual query on the owner connection.
- **`currency` is `char(3)` with no `CHECK`**, so the list can carry a code the money module's own
  validation would reject; this slice reads the column as stored and neither verifies nor normalises it,
  and the amount label inherits whatever three characters are in it.
- **The two-decimal display assumption is a real limitation.** `formatCompensationAmount` renders every
  currency with two fractional digits because `compensation` records no decimal exponent, so a
  zero-decimal or three-decimal currency would be misread on screen — `1234567` in `JPY` shows as
  `12,345.67 JPY`. The figure stays beside its own currency code rather than being called a period
  salary, and the fix belongs to the slice that decides what `ctc_minor` means.
- **The Amount cell carries the currency code, so the panel prints it once.** The table first shipped a
  separate Currency column that repeated the same three characters the helper had already appended to the
  amount; review removed it, and the four columns are effective from, effective to, amount and pay
  frequency. `currency` stays a key of `CompensationItem` and a column of the `compensation` table —
  the response and the database are unchanged, and only the duplicated cell left the screen.
- **A salary read leaves no trail.** `person.created`, `employment.updated` and the denial rows are
  written; reading who earns what is not. `tests/people-compensation.test.ts` asserts that a successful
  history read adds no audit row, which pins today's behaviour and makes the omission a deliberate,
  testable one rather than an accident — but the first design partner with real salary data should treat
  an audited compensation read as a gate item, and review question 13 already asks the same question of
  the employment history read.
- **A history is unpaginated and unbounded**, exactly as ADR 0010 §"Consequences" records for
  employment. It is acceptable while no import path fills the table; the Switch milestone is the first
  thing that will put many salary rows on one person, and this read must be revisited before then.
- **Nothing here has run in CI.** The GitHub account is annotated as locked for billing and no job has
  executed a step; the local suite (29 files, 417 tests) and the two Chromium journeys are the only
  evidence. M0 is not exited and this slice does not change that.

## Not built

No compensation write path of any kind: no `people.compensation.write`, no POST, PATCH, DELETE or
detail route, no form, no `CompensationCreateInput`, no salary structure or component table, no rate,
allowance, bonus, bank, account, tax, statutory-identifier or payslip column reachable from this
screen, and no read of `compensation.structure`. No payroll run, no journal, no gross-to-net, no
jurisdiction or statutory rule, no annualisation or proration, no aggregate or report across people, no
search or paging over a history, no export column, no audit of a successful read, no approval on
anything, no employee-facing or manager-facing read, and no cross-person list. `structure`,
`source_system`, `source_id`, `import_batch_id`, `imported_at`, `created_at`, `updated_at` and
`tenant_id` are never named by a route or granted to `saas_runtime`. The only migration is the one
restrictive read policy in `0013_compensation_read.sql`; no helper, no function, no table-level grant
and no existing policy changed.
