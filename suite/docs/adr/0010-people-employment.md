# ADR 0010 — Employment is a person's own history: entity copied from placement, status chosen by the database, writes decided by the write predicate

Status: accepted · 26 October 2026 · M1 slice 6 (T21)

## Context

`0002_people.sql` created `employment` as a child of `person`: `person_id` with a composite
`(tenant_id, person_id)` foreign key, `legal_entity_id` with a composite `(tenant_id, id)` foreign
key, `employment_type` and `status` as `text` columns with `CHECK` lists, `start_date`, `end_date`,
`probation_end_date`, `notice_days`, plus the columns the import path owns (`work_jurisdiction_id`,
`source_system`, `source_id`, `import_batch_id`) and `unique (tenant_id, id)` for the composite-key
target. It is a **history** table: there is no unique constraint on `person_id`, no overlap rule and
no "current row" column, so a person legitimately holds several records and the product decides what
they mean. `0012_people_scope.sql` then put restrictive policies on it — `scope_read` uses
`app.person_visible(person_id)` and `scope_insert` / `scope_update` / `scope_delete` use
`app.person_in_scope(person_id)` — and `packages/db/sql/runtime-grants.sql` gave `saas_runtime`
whole-table `SELECT, INSERT, UPDATE, DELETE` on it, because the M0 RLS proof suite must fail on a
policy and not on a missing privilege. So the table was reachable by the runtime role and narrowed by
the scope layer long before anything could read it: `tests/scope.test.ts` drives employment inserts
and updates as `saas_runtime` DML, and ADR 0009's own fine print had to tell users that placement is
"not an employment record" because no product surface could make one.

That left the People module half-a-person. A member could create an identity, edit six identity
fields and place the person on an entity, and the directory could say where someone sits — but the
one question an HR user asks first, *when were they employed and on what entity*, had no answer.
Meanwhile the schema already made three promises the routes must not quietly break: employment is
separate from placement, employment rows are immutable in their entity, and employment status is a
lifecycle rather than a free-text field.

Four constraints shape the design:

1. Employment is not payroll. `0005_money.sql` owns compensation, and no rate, salary, bank or tax
   column may be reachable from this screen. This slice writes only the five columns the contract
   names, plus the entity copied from placement and the status the database supplies.
2. Scope is a database property (ADR 0007). A history route may not re-derive who can see or change a
   person; it asks the same oracles the policies ask.
3. A record is a statement about the past. Nothing in this slice may rewrite an entity that history
   was written against, close a record retrospectively into a different lifecycle state, or delete
   one.
4. The reviewer's rule from ADR 0008 and 0009 stands: an unreachable target is a miss, a refusal to
   act is a typed denial, and neither echoes the body.

## Decision

1. **Employment hangs off a person, and the URL says so.** Three routes, all under the person:
   `GET /v1/people/:id/employments`, `POST /v1/people/:id/employments` and
   `PATCH /v1/people/:id/employments/:employmentId`. There is no list-everybody route, no
   `/v1/employments` collection and no employment id search: a history is read per person, from a
   person the caller can already reach. That choice makes the directory the enumeration boundary —
   see §9.
2. **One ten-key item, shared by all three routes.** `EmploymentItem` is `id`, `personId`,
   `legalEntityId`, `legalEntityName`, `employmentType`, `startDate`, `endDate`, `probationEndDate`,
   `noticeDays`, `status` — and nothing else. The list response is `{ items, total }` with `total` the
   length of `items`, in no page-sized envelope. `EMPLOYMENT_SELECT` / `EMPLOYMENT_FROM` is the single
   read used by the list, the create read-back, the update read-back and the update's pre-read, so a
   created row, an edited row and a listed row are the same shape by construction, not by three
   serializers agreeing.
3. **The legal entity is copied from the person's placement at insert time and never taken from the
   caller.** `POST` accepts no `legalEntityId`; it reads the person through `DIRECTORY_SELECT` and
   uses `person.legal_entity_id`. A person with no placement is `409 EMPLOYMENT_ENTITY_REQUIRED`, and
   a person whose entity is soft-deleted is the same `409` with the same fix, because a retired
   entity is no place to start a record either. `legal_entity_id` is not in `EMPLOYMENT_WRITE_FIELDS`,
   so no route in the product can move a stored record to another entity, and a later placement move
   therefore cannot rewrite history already recorded under the old one. `tests/people-employment.test.ts`
   proves both halves: a placement move leaves the stored `legal_entity_id` where it was, and a *new*
   record made after the move names the new entity. This is also the honest answer to the asymmetry
   ADR 0009 recorded — placement and employment are separate columns and nothing reconciles them.
   Copying at insert time is a one-way door by route design, not a database constraint.
4. **`status` is never a client choice on create.** The `INSERT` column list omits `status`
   entirely, so `employment.status`'s `default 'active'` is the only source of a new row's status and
   a body that names `status` on `POST` is `400 INVALID_BODY` before anything is read. The client
   cannot invent `ended` to make a record look historical, and cannot invent a value outside the
   `CHECK` list because it never reaches the column.
5. **Status is a one-way lifecycle, decided by comparison against the stored row.** `PATCH` may name
   `status`, and `checkEmploymentTransition` allows exactly two shapes: the status already stored
   (which is not a change) and leaving `active` for `ended` or `cancelled`. `ended → active`,
   `cancelled → active`, `ended → cancelled` and `cancelled → ended` are `409
   EMPLOYMENT_STATUS_TRANSITION_INVALID`. A record that has left `active` is a fact about the past and
   this product does not let anyone re-litigate it, correct a misclicked status, or resurrect it —
   those would need an append-only reversal, which is the payroll rule (non-negotiable 5) and this
   slice does not pretend to implement it. Because the offer is derived from the stored status, the
   panel's status `select` lists three options for an active row and exactly one — the stored value —
   for a row that has ended or been cancelled, so a member is never shown a transition the server
   would refuse.
6. **A record's dates are validated as values, and the check that ends a record is decided against
   the merged row.** `employmentDate` accepts `YYYY-MM-DD` *and* a real calendar day — `2026-02-30`
   and `2025-02-29` are `400 INVALID_BODY`, `2024-02-29` is not — because the body is a string and the
   column is a `date`: an impossible day would otherwise arrive as an unmapped database error rather
   than as the refusal the caller can act on. `notice_days` is an integer 0–3650. On `PATCH`, absent
   keys keep the
   stored value and, for `endDate`, `probationEndDate` and `noticeDays`, an explicit `null` clears
   them; `employmentType` and `startDate` may never be null. Every value rule is then evaluated on
   the *merged* row: `end_date >= start_date`, `probation_end_date >= start_date`, and a row that is
   `ended` must have an end date. So `PATCH { status: 'ended' }` alone is `400`, the same patch with
   `endDate` is `200`, and a patch that moves `startDate` after the stored `end_date` is `400` — the
   database's own `CHECK` never sees a request the route could not have predicted.
7. **A history may hold any number of rows for one person.** There is no uniqueness rule and no
   overlap rule, because the table has neither and inventing one in application code would make the
   product's model of employment diverge from the schema's. Two `full_time` rows with overlapping
   dates store and list cleanly, newest `start_date` first then `id`. Ordering by `start_date desc,
   id` is deterministic without a created-at column in the response, which matters because the screen
   pages nothing and a stable list is the difference between a usable row action and a jumping one.
8. **The read uses the directory's read predicate and nothing else; the writes use the write
   predicate.** This is the finding of the slice. `GET` runs inside the gated member transaction,
   reads the person through `DIRECTORY_SELECT` (which is narrowed by `person`'s `scope_read`, i.e. by
   `app.person_visible`) and then selects the employment rows, which their own `scope_read` narrows by
   that same `app.person_visible(person_id)`. A read-only member therefore sees the history of every
   person they can see, including their own. The write routes must not stop there, and initially did:
   `app.person_in_scope` is **not** identical to `app.person_visible`. It grants no self exception —
   the person linked to your own user account is visible to you but not yours to maintain — and it is
   always false for `employee`. So a scoped HR member whose scope is entity B, whose own person row is
   linked and placed on entity A, passes the directory read and then reaches SQL: the `INSERT` is
   refused by `scope_insert` with `42501`, and the `UPDATE` is silently filtered by `scope_update`'s
   USING clause so `rowCount` is 0. Neither is mapped, so both became `500 INTERNAL_ERROR` for what is
   a scope decision. Both write routes now ask `select app.person_in_scope($1) as allowed` for the
   person id after the person read succeeds and before any employment `INSERT` or `UPDATE`, and answer
   `403 SCOPE_DENIED` when it is false. The helper answers first; `scope_insert` and `scope_update`
   stay the database half of the same rule. No scope predicate is restated in TypeScript, and no grant
   was added — `runtime-grants.sql` already grants `EXECUTE` on `app.person_in_scope(uuid)` to
   `saas_runtime` because the policies need it inside the same transaction.
9. **Unreachable answers are uniform, and the order of the questions is fixed.** For the person: unknown,
   malformed, soft-deleted, another tenant's or out of scope is one `404 PERSON_NOT_FOUND` on all three
   routes, so a history path cannot enumerate the directory. For the row: unknown, malformed, another
   tenant's, out of scope, or **a real employment id addressed under a different person** is one `404
   EMPLOYMENT_NOT_FOUND`, and the `PATCH` reads and writes the row by `id` *and* `person_id` together,
   so the path cannot be used to probe whether an id belongs to a colleague. The person is always
   asked before the row, so a member who may not see the person never learns whether the row exists.
   Entitlement precedes role, the gate precedes the malformed id, and the gate precedes the body: a
   `people.read`-only `manager` posting to the create route is `403 ROLE_DENIED` naming `people.write`,
   exactly as on the placement patch. `GET` is gated `{ module: 'people', operation: 'read' }`, so a
   member who may read People may read a history — the write gate is not a condition of reading.
10. **Misses and scope denials write no audit row; the two writes audit field names only.**
    `employment.created` carries `{ module: 'people', fields: [...present keys].sort() }` and
    `employment.updated` carries `{ module: 'people', changedFields: [...] }` — the names that moved,
    never a date, never a notice period, never a status, because all of it is still readable on the
    row and the audit trail is append-only and readable by whoever holds the owner connection. Both
    appends happen inside the same member transaction as the write, so a revoked `INSERT` on
    `audit_event` turns a valid employment write into a sanitized `500 INTERNAL_ERROR` with the row
    rolled back, which `tests/people-employment.test.ts` proves and then restores in a `finally`.
    `authorization.denied` rows keep using the route template, so the trail records
    `/v1/people/:id/employments` rather than a caller-supplied path.
11. **A change-free update writes nothing.** `changed` is computed from the merged values against the
    stored row, including `status`; if it is empty the route returns the stored item with no `UPDATE`
    and no audit row. That is what lets the panel keep **Save changes** disabled while every field
    still matches what was loaded, and it means a double-clicked submit is a read.
12. **`UPDATE` and `INSERT` answers come from a read-back, not `RETURNING`, and the failure between
    them is a sanitized 500.** The employment item carries a joined column, so a `RETURNING` list
    cannot produce it; the create uses an application-generated `randomUUID()` id (the reason ADR 0008
    gives for person: the row must be read back in the same transaction and the audit entry needs the
    id before the answer is sent), then reads it with the shared select. `rowCount !== 1` on the update
    and a read-back that returns nothing are `500 INTERNAL_ERROR` with the write and its audit rolled
    back — a statement that succeeded but matched nothing would mean the policy moved under the
    transaction, and the route has no business guessing what the caller should see instead. No SQL
    text, no `permission denied`, no `saas_runtime` and no `PostgreSQL` appears in the body.
13. **Nothing moved in the database.** No migration, no policy, no helper, no grant. `employment` keeps
    the whole-table `SELECT, INSERT, UPDATE, DELETE` it has had since the M0 proof suite needed it, the
    runtime's twelve table grants are unchanged, and `infra.schema_migration` still ends at
    `0012_people_scope.sql`. The routes are new consumers of a privilege that already existed, which is
    the point of §8's residual rather than a hidden expansion.
14. **The screen reads a history for anyone who can read People, and writes only where the context
    says it may.** Every directory row carries an **Employment** action regardless of `canWrite`,
    because a history is a read; the panel then shows a loading state, a retryable error state with
    **Try again**, the empty copy "No employment is recorded for this person yet.", or a table of the
    ten-key rows — entity name, type, `start – end` period, probation end, notice days, status badge —
    wrapped in the same horizontally-scrollable container the directory uses, so the panel folds on a
    phone instead of widening the page. **Add employment** and the per-row **Edit** appear only when
    the context reports `canWrite`; the columns disappear with them rather than rendering disabled.
    Create offers five fields and no status; update offers six, because status is the sixth, and opens
    on the stored values. Save is disabled while a request is in flight, while a create has no start
    date, and while an update names nothing that differs from the stored row. Every failure code the
    three routes can return has its own copy, including `SCOPE_DENIED` — "You can see this person, but
    your scope does not cover where they are placed, so their employment is not yours to change." — so
    a member whose own record is visible-but-unwritable is told the truth rather than shown a fallback.
    A success closes the form, announces `Employment added.` / `Employment updated.` in the same polite
    live region the identity and placement panels use, and refetches the history. The fine print states
    that each record keeps the entity the person was placed on when it was made and that compensation
    and payroll are not built here.
15. **This slice amends ADR 0009 §15's panel copy.** That item had the placement panel say "Status,
    employment and compensation are not editable here yet." Employment and status are now editable, in
    their own panel on the same row, so leaving that sentence up would have been a false claim in the
    product's own words. The placement fine print now states that a placement is a directory attribute
    rather than an employment record, points the reader at **Employment** on that row for dates and
    status, and keeps the honest remainder — compensation is not editable anywhere yet. ADR 0009 stays
    as written as the decision record for placement itself; the copy change belongs here because this
    slice is what made the old sentence untrue.

## Consequences

- **The People screen now writes to a second table.** `person` and `employment` are both member-writable
  from one page, and they are not kept in step: placing a person on entity A, recording employment
  there, then moving the person to entity B leaves the history on A and future records on B. That is
  the documented behaviour of this slice, not an accident, and the directory cell and the history table
  will disagree on screen. Anyone who needs "which entity employs this person now" must read the
  placement, not the newest history row.
- **`employment` is the one People-surface table the runtime may write at table level, not column
  level.** The person grant is 26 column privileges with no table privilege at all; `employment` has
  `SELECT, INSERT, UPDATE, DELETE` on the whole table, which means `saas_runtime` *could* write
  `status`, `work_jurisdiction_id`, `source_system`, `source_id` and `import_batch_id` — columns no
  route names. Nothing in the database distinguishes the five columns this slice writes from the nine
  it does not, so the boundary here is the route's column list plus `tests/schema-inventory.test.ts`,
  not a privilege. It stays because the M0 proof suite needs policy refusals rather than privilege
  refusals; narrowing it to column-level DML is a real, deferred choice with a test to re-derive.
- **`DELETE` is granted and unused.** `saas_runtime` can delete an employment row and no route does.
  A member cannot remove a record through the product, so a miscancelled or junk row stays until an
  operator acts on the owner connection; that is deliberate (history is not a member's to destroy) but
  it is enforced by the absence of a route rather than by a privilege.
- **Employee self-scope still has no product path.** `app.person_visible`'s self exception is what makes
  a linked employee see its own row, and `employment`'s `scope_read` inherits it, so the database half
  works and `tests/scope.test.ts` proves it. The API half does not: `employee` holds no permissions in
  the M0 role matrix, so `GET /v1/people/:id/employments` is `403 ROLE_DENIED` for that member before
  any policy runs. An employee-facing history needs a `self` permission and a gate that knows about it,
  which is a contract change and not this slice.
- **A history is unpaginated and unbounded.** The list returns every row for one person and `total` is
  its length. For a person with a decade of contracts that is a large response and a large table, and
  the panel has no paging affordance. It is acceptable while no import path fills the table — the
  Switch milestone is the first thing that will make a person hold many rows, and this read needs to be
  revisited before then.
- **Nothing here has run in CI.** The GitHub account is annotated as locked for billing and no job has
  executed a step; the local suite and the browser journey are the only evidence.

## Not built

No compensation, salary, rate, bank or tax column is reachable — this slice writes five employment
columns and reads ten. No payroll, no jurisdiction or statutory rule, no effective-dated reconciliation
between `person.legal_entity_id` and `employment.legal_entity_id`, no "current employment" derivation,
no transfer or secondment flow, no employment delete, archive or restore, no employment list across
people, no search or paging over a history, no approval on a status change, no reversal of a
cancelled row, no audit read surface, no employee-facing read, no per-record detail route. `status`,
`source_system`, `source_id`, `work_jurisdiction_id` and `import_batch_id` are never written by a
route. No migration, no policy, no grant and no helper changed.
