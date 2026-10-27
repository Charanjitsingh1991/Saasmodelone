# ADR 0012 — Compensation is writable, under a permission of its own and a scope oracle of its own, and a row is superseded rather than erased

Status: accepted · 27 October 2026 · M1 slice 8 (T23)

## Context

ADR 0011 gave `compensation` a read: one restrictive `scope_read` policy in
`0013_compensation_read.sql`, seven column `SELECT` privileges, one route, one panel and the sentence
"no `scope_insert`, `scope_update` or `scope_delete` here, because the runtime holds no write privilege
on the table to test one against… They arrive with the migration that grants the write." That sentence is
this slice's brief. It also left the product with an asymmetry its own screen advertised: the compensation
panel's fine print said compensation "is not editable anywhere yet", while the panel one row above it —
employment, ADR 0010 — had been adding and amending rows for one slice.

The table itself was already shaped for this. `0002_people.sql` gives `compensation` a `default
gen_random_uuid()` id, `not null` columns for `effective_from`, `ctc_minor`, `currency` and
`pay_frequency`, a nullable `effective_to` with `CHECK (effective_to is null or effective_to >=
effective_from)`, `CHECK (ctc_minor >= 0)`, the four-value frequency `CHECK`, the composite
`(tenant_id, person_id)` foreign key onto `person`, `unique (tenant_id, id)` and `unique (tenant_id,
person_id, effective_from)`, and no `deleted_at`. Nothing in that list had to change to let a member
write a row, which is why this migration contains two statements and no DDL.

Four constraints shape the design, and the first two are the reason the slice is bigger than "add the
missing verb":

1. **Reading pay and writing pay are different decisions.** ADR 0011's whole argument was that
   `people.read` does not imply a salary read. The same argument runs the other way: a role that may list
   salaries has not thereby been given the right to change one, and a role that administers pay has not
   been given the right to see the history of every person in the tenant. So the write gets its own
   published name rather than reusing the read, and the two are checked separately.
2. **A write privilege without a write policy is the hole, not the missing policy.** Before this slice
   `saas_runtime` could not touch `compensation` at all, so `scope_read` was a complete answer. Granting
   `INSERT` and `UPDATE` beside a read-only policy would leave RLS with nothing to say about which person
   a member may hang a salary row on: the command would be bounded by tenant and entitlement only. That is
   why the two policies and the two grants are one change, and why `tests/schema-inventory.test.ts` and
   `tests/scope.test.ts` pin the pair together rather than trusting a comment.
3. **The write oracle is not the read oracle.** `app.person_visible(person_id)` carries a self exception —
   a member whose linked person row they are reading is always allowed — and `app.person_in_scope` is the
   same rule without it, and always false for `employee`. ADR 0007 put that asymmetry in the catalog and
   ADR 0010 made it a route rule (T42): what a member may see is not what they may maintain. A compensation
   write uses the second one.
4. **Payroll still owns the meaning of `ctc_minor`.** ADR 0011 §6 recorded that the schema does not say
   whether the column is an annual cost or a period amount. A read can live with that ambiguity by printing
   the stored figure beside its stored currency; a write cannot, because a member now puts a number in that
   no one has defined. This slice therefore refuses to invent a rule — no annualisation, no proration, no
   period arithmetic, no component breakdown — and states the ambiguity on the panel that collects the
   figure.

## Decision

1. **The write is its own permission, and it is the sixth published name.** `PERMISSIONS` in
   `packages/contracts/src/authorization.ts` is now `people.read`, `people.write`,
   `people.compensation.read`, `people.compensation.write`, `work.read`, `work.write`. The write sits
   immediately after the read it belongs to, and because `permissionsForRole` filters `PERMISSIONS`, that
   order is the order `/v1/context` answers in for every role holding both. Nothing about a gate's
   behaviour is inherited from position — `assertGate` fails closed on a name outside the list — so the
   ordering is legibility, not logic.
2. **The same four roles hold it, and the reason finance holds it is recorded rather than left to
   inference.** `owner`, `admin`, `hr` and `finance` gain `people.compensation.write`; `manager`,
   `auditor` and `employee` hold neither compensation permission. Three facts here are worth stating
   explicitly because they look like mistakes:
   - **Finance writes pay without holding `people.write`.** Maintaining a salary row touches
     `compensation` only — it needs no say over a colleague's name, email or placement — and a pay
     administrator who could also rename people would hold more of the directory than the job needs. This
     is the case that makes the compensation axis separate from the directory axis meaningful rather than
     decorative: `tests/authorization.test.ts` pins
     `hasPermission('finance', COMPENSATION_WRITE) === true` beside
     `hasPermission('finance', 'people.write') === false`.
   - **HR holds both writes** because it maintains the person *and* the pay.
   - **Admin holds every published permission** because it is the role that administers the tenant's own
     access and configuration, and the owner's delegate everywhere except the owner-only scope authoring
     (ADR 0007).
   - **The write never implies the read and the read never implies the write.** No role today holds one
     compensation permission without the other; the suite pins that as a property of the matrix rather
     than as an accident of it, so a future role that reads pay without writing it is a deliberate row
     change and not a typo in a list.
   `auditor` remains excluded for the reason ADR 0011 §2 recorded — a policy choice, not a capability
   limit — and `permissionFor('people', 'write')` still answers `people.write`, so no directory write route
   can widen into a salary write by forgetting to name its permission.
3. **`0014_compensation_write.sql` is two statements and no DDL.** Its executable body, in full:

   ```sql
   create policy scope_insert on public.compensation
     as restrictive for insert
     with check (app.person_in_scope(person_id));

   create policy scope_update on public.compensation
     as restrictive for update
     using (app.person_in_scope(person_id))
     with check (app.person_in_scope(person_id));
   ```

   There is no `scope_delete`, and the reason is the same one 0013 gave for having no write policies: the
   runtime gets no `DELETE` privilege on this table, so a delete policy would govern a command no role can
   execute. `scope_insert` has no `USING` clause because an `INSERT` has no pre-image to test. The
   `WITH CHECK` on `scope_update` is not decoration: `USING` asks whether the member may touch the row that
   exists, `WITH CHECK` asks whether the row that would result is one they may own, and the second question
   is the only thing that refuses an `UPDATE` that leaves the row readable and moves `person_id` to someone
   outside the member's scope. The employment pair in 0012 is spelled identically, and
   `tests/scope.test.ts` now pins all six insert/update clauses across the three tables as one set, so a
   future person-child table that spells its predicate differently fails on the difference. Both halves are
   restrictive, so they narrow `tenant_isolation` and the `module_people_*` set rather than replacing them,
   and the `scope_*` prefix keeps them out of `app.apply_module_policies()`, which manages only
   `module_*_read` and `module_*_write_*`.
4. **The grants are two column lists, and the update list is deliberately narrower than the insert list.**
   `packages/db/sql/runtime-grants.sql` keeps 0013's seven-column `SELECT` untouched and adds:

   ```sql
   grant insert (
     id, tenant_id, person_id, effective_from, effective_to, ctc_minor, currency,
     pay_frequency
   ) on table public.compensation to saas_runtime;

   grant update (
     effective_from, effective_to, ctc_minor, currency, pay_frequency
   ) on table public.compensation to saas_runtime;
   ```

   Still no table-level privilege, still no `DELETE`, and the compensation ACL is now 20 column privileges
   over 8 distinct columns (7 `SELECT`, 8 `INSERT`, 5 `UPDATE`) while `information_schema.role_table_grants`
   is unchanged at its twelve rows over six tables. `id` and `tenant_id` are insertable because a create
   names its own row and its own tenant; neither is updatable because neither is a fact a member may change
   after the row exists. `person_id` is insertable and *not* updatable: re-parenting a salary row across the
   directory is not a feature of this product, and the column grant is the first line of that rule, with
   `scope_update`'s `WITH CHECK` the second. `structure`, `source_system`, `source_id`,
   `import_batch_id`, `imported_at` and both timestamps stay ungranted for exactly the reason 0011 gave —
   the `jsonb` is where an unreviewed pay breakdown would live, and provenance and clock columns belong to
   the import path and the owner, not to a route.
5. **Two routes, hung off a person, with one gate.** `POST /v1/people/:id/compensations` and
   `PATCH /v1/people/:id/compensations/:compensationId`, both gated
   `{ module: 'people', operation: 'write', permission: 'people.compensation.write' }`, both requiring the
   session, the exact `Origin` and the timing-safe CSRF token, both `no-store`, both answering the module
   entitlement question as a `people` write so an unentitled tenant still hears `MODULE_NOT_ENTITLED`
   before it learns anything about salaries. There is no `DELETE` route and no collection route, for the
   same reason ADR 0011 §4 gives for the read: the person is the enumeration boundary.
6. **The order inside the route is a decision, and it is the same one ADR 0010 §8 reached after T42.** For
   the create: the `UUID_TEXT_PATTERN` guard, then the person read through `DIRECTORY_SELECT` (the
   directory's own select, narrowed by `person.scope_read`), then
   `select app.person_in_scope($1)`, then the body, then the `INSERT`. For the patch: both id guards, then
   the person read, then the row read by `where c.id = $1 and c.person_id = $2`, then the scope helper, then
   the body, then the `UPDATE`. Three consequences follow and all three are tested. A member whose role
   lacks the permission is refused before a person id is looked at, so the gate cannot be used to probe the
   directory. A person the member may not reach answers the uniform `404 PERSON_NOT_FOUND` — unknown,
   malformed, soft-deleted, another tenant's or out of scope are one answer — which means the answer about
   *visibility* comes from the read oracle, correctly, because a person you cannot list is not a person you
   can be told anything about. And a refusal that arrives before the body is parsed tells a caller who has
   no rights over this person nothing about what a valid salary row looks like. **No scope predicate is
   restated in a `WHERE` clause anywhere.** The helper is consulted only to turn a policy refusal into a
   typed answer; `scope_insert` and `scope_update` remain the database's last word, and a route that
   dropped the helper call would still write nothing out of scope.
7. **`403 SCOPE_DENIED` is observable only where the two oracles disagree, and the suite says so.**
   For every fixture shape where a member's scope does not cover a person, the directory read fails first
   and the answer is the 404, not the 403. The one shape where the read oracle is wider than the write
   oracle is the member's **own linked person row sitting outside their own scope**: `person_visible` says
   yes through the self exception, `person_in_scope` says no. That is the case the tests drive
   deliberately (`hrSelfOutside` over `selfOutsidePerson()`), and the entity-scoped write tests were
   rewritten to assert the 404 with a comment naming the reason, rather than the 403 this brief expected.
   An `employee` is refused at the gate — the role holds no permissions at all — so its absence of a self
   write exception is proven at the SQL boundary in `tests/scope.test.ts`, not through a route.
8. **A create names its own id and there is no `RETURNING` on either write — but not for the reason this
   brief states.** The brief's premise was that 0013's restrictive `scope_read` refuses
   `INSERT ... RETURNING` on `compensation`, as `person`'s does on the directory. **That premise is false,
   and the tree now records the truth.** `person.scope_read` is
   `using (app.person_visible(id))`, so the new row's own `id` is evaluated by a policy that reads it, and
   ADR 0008's read-back is a database requirement. `compensation.scope_read` is
   `using (app.person_visible(person_id))`, and `person_id` names a person that already exists and is
   already visible, so the just-inserted row passes its own read policy and `RETURNING` would succeed. That
   was not asserted from reading the predicate: it was probed as `saas_runtime` through a real
   `INSERT ... RETURNING`, and `tests/people-compensation-write.test.ts` keeps that probe as a test —
   `answers INSERT ... RETURNING here, unlike on the directory` — so the asymmetry between the two tables
   is pinned rather than remembered. The route still generates the id with `randomUUID()`, names its
   columns, and reads the row back through the same `COMPENSATION_SELECT` / `COMPENSATION_FROM` fragments
   the list uses, for a design reason rather than a permission one: a write answer and a list answer cannot
   diverge in date formatting or in the `bigint` cast, because they are produced by one select. The
   generated id also lets the audit entry name the row before the answer is sent. A read-back that returns
   nothing, or an `UPDATE` whose `rowCount` is not 1, is a policy that moved under the transaction: both
   roll the write and its audit row back to a sanitized `500 INTERNAL_ERROR`.
9. **Validation is a closed shape, and a bad value is refused rather than repaired.** Both bodies go
   through `peopleWriteObject` and `parseCompensationWrite`, and every refusal is `400 INVALID_BODY`: an
   unknown key (including `id`, `personId`, `tenantId`, `structure` and every import column — the contract
   has no way to name them and the grant has no way to write them); on a create, any missing one of
   `effectiveFrom`, `ctcMinor`, `currency`, `payFrequency`; on a patch, a body that names none of the five
   known fields. Then per field: `effectiveFrom` must be a real `YYYY-MM-DD` calendar day (the same
   `employmentDate` rule — the month, day and the day-in-month must all exist); `effectiveTo` is `null` or
   absent or a real date, and after the merge with the stored row it must not precede `effectiveFrom`
   (which is the route restating the table's own `CHECK`, so a caller gets a 400 rather than a 23514);
   `currency` must be exactly three ASCII `A-Z` letters and is never upper-cased for the caller, so `"inr"`
   is refused and `"INR"` is stored; `payFrequency` must be one of the four published values; and
   `ctcMinor` crosses as a JSON number, must be an integer, and must sit in `0 … Number.MAX_SAFE_INTEGER` —
   above that bound it is refused, never rounded, because a silently rounded salary is a figure the caller
   cannot detect as wrong. `COMPENSATION_CTC_MINOR_MAX` is exported from the contracts so the screen gates
   the same bound it will be refused by.
10. **One row per person per opening day is the only period rule this slice enforces, and overlap is
    recorded as a residual rather than invented.** `unique (tenant_id, person_id, effective_from)` is the
    database's rule; a create that collides with it, and a patch that would move a row onto a day the
    person already uses, both surface SQLSTATE `23505` and both answer
    `409 COMPENSATION_PERIOD_EXISTS`. The constraint name is never echoed, and neither is the amount. Two
    rows whose periods overlap — `2024-01-01 … 2024-12-31` and `2024-06-01 … null` — are accepted, because
    deciding what an overlap *means* is payroll's job: it may be a mid-period revision, a retroactive
    correction, an allowance on a separate structure, or a data-entry error, and non-negotiable 7 says this
    product does not invent rules in application code. The screen's copy states the convention a correction
    follows (add a row opening later; the row it corrects stays) without asserting that anything enforces
    it, and the gap is [T44's residual](../security/m0-threat-model.md) and
    [review question 15](../security/m0-threat-model.md): does M1 need an overlap rule, or is "one row per
    opening day, overlaps permitted" the licensed behaviour? Nothing here reads, writes or names
    `structure`, so no component-level period rule is implied either.
11. **The audit row names fields and nothing else.** `compensation.created` and `compensation.updated`,
    `entity_type: 'compensation'`, `entity_id` the row id, actor the session's user, and metadata
    `{ fields: [...] }` — the sorted names present on a create, the names that actually changed on a
    patch. No amount, currency, date or frequency value is copied into the trail, so the audit table is not
    a second place a salary has to be protected; and because no before-image is kept, an in-place amendment
    is not reconstructable from the trail, which is recorded in Consequences rather than glossed. The audit
    write is in the same member transaction as the DML, so a failing audit insert rolls the row back and the
    caller gets a sanitized `500 INTERNAL_ERROR` with `no-store` and no database text — the same
    fail-closed shape the employment and placement writes use, proven by revoking the runtime's `INSERT` on
    `audit_event` and asserting the stored row is untouched afterwards. One honest divergence: employment
    writes `{ module: 'people', fields: [...] }` on create and `{ module: 'people', changedFields: [...] }`
    on update, while these two write `{ fields: [...] }` for both, as this slice specified. The key set is
    therefore not uniform across People audit metadata, and reconciling it is an owner decision, not a
    detail an implementation should have chosen silently.
12. **A patch that changes nothing writes nothing.** The five merged values are compared against the stored
    row, and an empty change list returns the stored item with no `UPDATE`, no audit row and no
    `updated_at` movement. The screen reflects the same rule by keeping **Save changes** disabled until a
    prefilled field actually differs.
13. **The screen branches on the permission, and the panel's wording branches with it.**
    `canWriteCompensation(context)` tests `context.permissions` for the write name — not the module's
    `canWrite`, so finance's pay-only surface is not widened into a directory editor. The **Actions**
    column, the per-row **Edit** button and the **Add compensation** button all appear only when it is
    true; without it the panel is the four-column table 0011 shipped, with one control: **Close**. The
    fine print is now two texts rather than one, because a single sentence could not be true for both
    audiences: writers are told a record can be added for a person in their scope and one of that person's
    records amended, that no record can be deleted, that a correction is a later row, and that payroll,
    payslips and statutory deductions are not built; a member without the write is told the panel is
    read-only *for them* and that a member whose role also holds the pay write can add and amend, because
    after this slice "there is no way to add, change or remove a salary record anywhere in the product" —
    the sentence 0011 shipped — is simply no longer true. The form carries the
    minor-units hint, the upper-case currency hint and the create/update notes that say nothing is
    annualised or prorated. Every reachable refusal has its own copy, including `SCOPE_DENIED` ("You can
    see this person, but your scope does not cover where they are placed, so their pay is not yours to
    change.") and `COMPENSATION_PERIOD_EXISTS`, and no server message is echoed. Hiding these controls is
    presentation only: each of the three Playwright journeys that touch the panel checks the server, not the
    DOM, for authority, and the write refusals are proven in `tests/people-compensation-write.test.ts`.
14. **The counts, re-derived from the live catalog rather than from this brief.** The ledger holds 14
    migrations ending `0014_compensation_write.sql`. The policy inventory is 277 — 66 permissive, 211
    restrictive — and the `scope_*` set is eleven names over three tables: `compensation`
    `scope_insert` / `scope_read` / `scope_update`, `employment` and `person` four each, every one of them
    restrictive. `saas_runtime` still holds exactly twelve table-level grants over exactly six tables
    (`audit_event`, `employment`, `module_entitlement`, `platform_module`, `platform_module_dependency`,
    `project`), and `compensation` is absent from that view because all of its privileges are
    column-qualified: 7 `SELECT`, 8 `INSERT`, 5 `UPDATE`, 20 rows over 8 columns. `has_table_privilege` is
    false for all four commands on `compensation`, `has_column_privilege(... 'DELETE')` is not even a legal
    question — it raises, which is itself the proof that a column grant cannot carry `DELETE` — and
    `structure` remains unreadable and unwritable. The 26 `person` column privileges, the four
    `employment` table privileges and the placement grants are untouched, and so is the whole read path.
15. **Nothing else moved.** The `GET`, its `people.compensation.read` gate and its seven-column select are
    unchanged; the directory contract, its eleven-key row assertions, the placement routes, the three
    employment routes, the CSV export and `/v1/context`'s shape are unchanged except for one longer entry
    in `permissions`. `tests/people-export.test.ts` passes byte for byte, and
    `tests/people-compensation-write.test.ts` asserts a create and an amend leave the exported CSV
    identical — a salary figure has no path into a directory export.

## Consequences

- **`compensation` is the third table `saas_runtime` can write, and the second it can write by column.**
  The runtime's People reach is now `person` (26 column privileges, no table privilege), `employment`
  (whole-table DML including `DELETE`) and `compensation` (20 column privileges, no table privilege, no
  `DELETE`). It is also the first table where the *absence of a column* is the write rule: `person_id` is
  insertable but not updatable, so the grant, not a route convention, is what stops a re-parent.
- **The scope invariant discovered nothing here, and that is worth saying out loud.**
  `tests/scope.test.ts` finds every runtime-readable table with a `person_id` column and requires a
  restrictive read policy; there is no equivalent discovery for *write* privileges, so a future slice that
  grants `INSERT` on a person-child table without a `scope_insert` policy would not be caught by that rule.
  What caught this one is the pinned catalogue in `tests/schema-inventory.test.ts` (the eleven names, the
  277-policy split) and the column-grant inventory beside it. Adding the write half of the discovery rule —
  "any table with a runtime `INSERT` or `UPDATE` privilege and a `person_id` column carries a restrictive
  policy for that command" — is a harness task the next write slice should start with, not a documentation
  note.
- **A wrong salary row is now permanent, in a specific sense.** There is no `DELETE` route, no `deleted_at`
  on the table and no soft-retire, so the only correction a member has is an in-place patch or a later
  row. The panel tells them to use a later row; the route lets them patch the stored one. Non-negotiable 5
  reserves "append-only, reversed never edited" for finalised payroll runs and audit rows, and neither is
  in play here yet, so this is permitted — but it is a decision with a cost, because no before-image is
  kept (see the audit consequence below) and no member can undo a change they did not mean to make.
- **An amendment is therefore not reconstructable.** `compensation.updated` records that the fields
  `ctcMinor` and `currency` changed, on this row, by this user, at this time — and not what they were
  changed from or to. Recovering the previous figure needs a backup restore or a read that happened before
  the write. This is the same shape ADR 0008 §"audit rows carry field names only" accepted for `person` and
  ADR 0010 for `employment`, and it is now accepted for the most sensitive column in People. If the first
  design partner treats a salary value history as a requirement, the answer is a compensation history
  table or a before/after payload — either way a new slice, not a flag on this one.
- **`currency` became a write hazard, not only a display one.** It is still `char(3)` with no `CHECK`, so
  the route will store any three upper-case ASCII letters a member types — `ZZZ`, `XX1` — and the amount
  label will print the invented code beside a real-looking figure. The route validates the *shape* ADR 0011
  could observe; only the money module's currency list can validate the *value*, and that module does not
  exist yet.
- **The figure a member stores still has no defined meaning, and now it has an author.** `ctc_minor` is
  whatever the writer believed. Nothing in this slice constrains plausibility — no band, no currency-rate
  sanity check, no comparison with the person's previous row — because every one of those is a payroll rule
  and non-negotiable 7 forbids inventing one. The panel states the absence in the same breath as the add
  button. This is the point where the M0 rule "no real customer data" has a second reason: a synthetic
  salary table is now writable by four roles.
- **`people.compensation.write` is a large grant to hand out.** A finance membership can put a number on
  any person's pay row inside its scope, with no approval, no four-eyes check, no rate limit, no reason
  field and no read-back of who last touched it — and there is no audit read surface, so noticing means a
  query on the owner connection. That is the same class of accepted residual T38 and T40 record for the
  directory and placement writes; the difference is the asset.
- **Overlap is permitted, so a history can be internally contradictory.** Two open rows on one person are
  both "current". The route orders `effective_from desc, c.id`, the panel shows both, and only payroll —
  with a jurisdiction pack and a rule — can decide which one means anything. `unique (tenant_id, person_id,
  effective_from)` prevents the trivially ambiguous case (two rows opening the same day) and nothing else.
- **The `23505`-to-409 mapping is the only collision surface, and it is constraint-shaped.** A future
  unique key on this table would answer `409 COMPENSATION_PERIOD_EXISTS` too, because the route maps the
  SQLSTATE rather than the constraint name; the tests pin the current constraint, and a slice that adds
  another key on `compensation` must revisit the mapping.
- **Three journeys now cover the panel, and one of them is presentation evidence by construction.** No
  built-in role holds `people.compensation.read` without the write, so the read-only shape of the panel
  cannot be reached through the real matrix; the third Chromium journey reaches it by removing that one
  permission from the owner's own `/v1/context` answer. It proves the branch in the screen and nothing
  about the gate, and the file says so in its own comment. The authorization evidence is the 41-test
  server suite.
- **Nothing here has run in CI.** The GitHub account is annotated as locked for billing, every run a push
  creates ends with zero steps executed, and that is recorded push-stably in T29 rather than as a count. The
  local suite (30 files, 462 tests) and the three Chromium journeys are the only evidence. M0 is not
  exited, and this slice does not change that.

## Not built

No delete of any kind: no `DELETE` route, no `DELETE` grant, no `scope_delete` policy, no retire flag, and
no restore. No re-parenting: `person_id` and `tenant_id` are not updatable, and no route names them in an
`UPDATE`. No change to the read route, the read permission, the directory contract or the export. No salary
component, structure, breakdown, rate, allowance, bonus, deduction, bank account, tax identifier, statutory
identifier or payslip field — `compensation.structure` is still neither granted nor read nor written. No
payroll run, journal, gross-to-net, proration, annualisation, exchange rate, period arithmetic or
jurisdiction rule, and no effective-date logic beyond the table's own `CHECK`. No overlap rule, no
"current row" rule, no supersede workflow, no approval, no undo, no before/after value in the audit
trail. No pagination, row cap, rate limit or per-person consent on either write. No employee-facing or
manager-facing write, and no self-service of any kind. No `people.compensation.admin` or any finer
permission, and no per-field permission. No cross-person list, search, aggregate or report of pay, and no
scope label, scope read or scope write anywhere in the application surface.
