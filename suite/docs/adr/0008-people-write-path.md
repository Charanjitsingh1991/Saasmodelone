# ADR 0008 — People writes are identity-only, CSRF-verified and read back in the same transaction

Status: accepted · October 2026 · M1 slice 4 (T19)

## Context

M0 gave `saas_runtime` eight column `SELECT` grants on `person` and nothing else: the
directory CSV export could read the identity fields, and every write stayed with the owner
role. M1's fourth slice puts the first member writes behind the People module — `POST
/v1/people` and `PATCH /v1/people/:id` — and a shared directory is not something a module
may redefine. The person row is the platform's employee identity, and the columns that
decide *who this person is* (names, display name, employee code, work email, phone) are
different in kind from the columns that decide *what they are to the business*: status,
legal entity, org unit, manager, location, designation, employment type, dates, the
`personal_email` column, demographics, and the `user_id` link that turns a directory row
into a signing-in
employee.

Three constraints shape the design:

1. The access model is entitlement → role → scope, and since 0012 the third step is a
   database property, not request code. A write path must be narrowed by the same
   restrictive policies that narrow reads, with no scope predicate re-implemented in SQL or
   TypeScript.
2. The tenant isolation and audit rules make an audit row part of the write, not a log line
   after it. `audit_event` is append-only, and the runtime role can only insert into it.
3. A session cookie proves identity. It does not prove the browser meant to send the
   request, so any state-changing route needs the CSRF check that logout already used.

## Decision

1. **Only the six core identity fields are writable.** `firstName`, `lastName`,
   `displayName`, `employeeCode`, `workEmail` and `phone`, with the length limits in
   `packages/contracts/src/people.ts`. `firstName` is required and can never become null or
   blank. `displayName` absent or blank derives from the names, and the combined name must
   itself fit the display-name limit. `status`, `legal_entity_id`, `org_unit_id`, `user_id`,
   `deleted_at`, the timestamps, the import columns, personal email, date of birth, gender,
   dates of joining and exit, designation, manager, and location are not writable by any
   member through any route. There is no delete, no restore, no soft-delete, no bulk edit
   and no import in this slice.
2. **The body is a closed object.** A non-object, an array, an empty object, or any key
   outside the six fields — including `id`, `status`, `legalEntityId`, `orgUnitId`,
   `userId`, `personalEmail` and `dateOfBirth` — is a `400 INVALID_BODY` that echoes none of
   it back. A client cannot ask for a column the grant does not cover and learn something
   from the error.
3. **Validation happens after the authorization gate, not before.** Both routes parse the
   body inside `withMemberTransaction` with `{ module: 'people', operation: 'write' }`, so
   entitlement, then role, then the RLS policies are settled first. A `manager` posting a
   deliberately malformed body receives `403 ROLE_DENIED`, not `400` — otherwise a role with
   no permission could use the validation errors to probe the shape of the directory. The
   `PATCH` malformed-id guard runs in the same place, inside the gated transaction, so
   entitlement and role precede the `404` and a caller without `people.write` cannot turn an
   unparseable id into a free verdict about the row.
4. **Two checks precede any database work.** The session check answers `401
   UNAUTHENTICATED`, and `x-csrf-token` must match the session's token under the same
   timing-safe comparison logout uses, which is now one `requireCsrfToken` helper shared by
   all three state-changing routes. A missing or wrong token answers `403 CSRF_INVALID`
   before the pool is touched, so a forged cross-site form costs the server nothing. The
   global `onRequest` origin hook still runs first and answers `403 ORIGIN_DENIED`, so a
   request from another origin never reaches either check.
5. **Creates are tenant-wide only, and that is stated as a typed answer.** A new person is
   inserted unplaced, and 0012 makes an unplaced person visible only to a member with no
   scope rows. So the route asks `app.person_placement_in_scope(null, null)` inside the
   gated transaction and answers `403 SCOPE_DENIED` when it is false, rather than letting
   the database raise `42501` from `scope_insert`. The database half of the rule is
   unchanged and still the boundary: `tests/scope.test.ts` shows a scoped member's unplaced
   insert refused by the `scope_insert` policy itself. The typed answer exists so the UI can
   say plainly that only a workspace-wide role can add an unplaced person, instead of
   reporting an internal failure. Placement is not editable anywhere in this build, and the
   copy must not imply that an operator could go and place someone.
6. **`INSERT ... RETURNING` is refused on `person`, and the route is built around it.** The
   restrictive `scope_read` policy is `using (app.person_visible(id))`, and
   `person_visible(id)` re-queries `person`. A `RETURNING` list is filtered by the SELECT
   quals of the policies in force, evaluated against the command's own snapshot, so it
   cannot observe the row the same command is creating. On a fresh migrated database with
   the real fixtures, an insert of `(tenant_id, first_name, display_name) values (...)
   returning id` by a tenant-wide member raises:

   ```text
   42501  new row violates row-level security policy "scope_read" for table "person"
   ```

   The identical insert without `RETURNING` succeeds, a `SELECT` for that id later in the
   same transaction returns the row, and `UPDATE ... RETURNING` works because the policy's
   USING clause sees a pre-existing row. This is not a grant gap — `saas_runtime` holds the
   column `INSERT` privileges — and it is not fixable by narrowing the policy without
   weakening it.

   The decision is to work with it, not around it: the API generates the new row's UUID with
   `randomUUID()`, names it in the `INSERT` together with `app.current_tenant_id()`, sends no
   `RETURNING`, and then reads the seven directory columns back by id inside the same member
   transaction. That read is what the `201` returns, so the client receives the authoritative
   row rather than an echo of its own input. If the read-back finds nothing, the invariant is
   already broken, and the route raises `500 INTERNAL_ERROR` — sanitized, with the insert and
   the audit row rolled back — instead of inventing a `201`. `id` is therefore in the `INSERT`
   grant list and is never taken from the client. Because the same transaction reads the row
   back, no second transaction and no extra `SELECT` privilege is needed, and the read still
   goes through `scope_read` rather than past it.
7. **Column privileges follow the fields, column by column.** `saas_runtime` now holds 8
   `SELECT` (the seven directory fields plus `deleted_at`), 8 `INSERT` (`id`, `tenant_id` and
   the six identity fields) and 6 `UPDATE` (the six identity fields) — 22 column privileges
   on `person`, and still no table-level privilege of any kind and no `DELETE`. `id` is
   insertable so a create can name its own row and is deliberately absent from `UPDATE`, so
   no write can retarget an existing row onto another identity. `tenant_id` is insertable
   only so the create can claim the tenant the GUC already pins; RLS and `tenant_isolation`
   decide what any statement can reach. `deleted_at` stays readable and unwritable, so no
   route can soft-delete through the update path. `tests/schema-inventory.test.ts` pins the
   full inventory as a list and as counts, plus the `id` insertable-not-updatable and
   no-`DELETE` facts, so the next grant change has to be a decision rather than a slip.
8. **Object misses answer one way.** An update reads the target row by `id` with
   `deleted_at is null` inside the gated transaction, and answers `404 PERSON_NOT_FOUND`
   whether the id is unknown, malformed, soft-deleted, in another tenant or outside the
   member's scope. The shape check itself runs inside the gated transaction, after
   entitlement and role have settled and before any statement that touches `person`, so no
   malformed UUID reaches SQL and no denied caller sees the `404` instead of its own denial.
   Nothing in that response distinguishes
   "does not exist" from "not yours", so a write route cannot be used to enumerate the
   directory a member cannot read, and no cross-tenant existence check is possible.
9. **A no-op writes nothing.** An update whose six effective values equal the stored row
   returns the current item with no `UPDATE` statement and no audit row. Change detection is
   case-insensitive on `workEmail` because the column is `citext`, so re-saving `ADA@X.TEST`
   over `ada@x.test` is honestly a no-op rather than a phantom edit.
10. **Uniqueness maps to typed codes without repeating the value.** `person_tenant_id_employee_code_key`
    → `409 PERSON_CODE_TAKEN`, `person_tenant_id_work_email_key` → `409 PERSON_EMAIL_TAKEN`,
    any other `23505` → `409 PERSON_CONFLICT`, on create and on update alike. The response
    body never contains the colliding code or email, so a 409 cannot be used to confirm a
    guess about someone else's record.
11. **Last write wins, and the row stays the source of truth.** There is no version column,
    no `updated_at`-based precondition and no optimistic-lock error. Two members editing the
    same person both succeed and the later commit decides the values; `person_set_updated_at`
    moves `updated_at` on the database side, which the runtime cannot set because it holds no
    grant on the column. This is deliberate for six identity fields edited by a small group:
    a conflict marker would need a schema change and a UI for resolving it, and neither is in
    scope. The consequence is recorded in Consequences and is a real one — an edit can
    silently overwrite a colleague's change.
12. **The audit row is part of the write transaction and carries field names only.**
    `person.created` and `person.updated` are appended through `appendAuditEvent` with
    `entityType: 'person'`, the id, the acting user, request IP and user agent, and metadata
    limited to `{ module: 'people', fields: [...] }` or `{ module: 'people', changedFields:
    [...] }`, sorted. No `before_state` and no `after_state`: the values are already in the
    directory, and copying a phone number or work email into the audit trail would widen the
    disclosure surface for no forensic gain. Because the append is in the same transaction as
    the write, an audit failure rolls the write back and the client receives a sanitized `500
    INTERNAL_ERROR` — proven by revoking `INSERT` on `audit_event` for the runtime role and
    checking that no person row and no change to the target row survive.
13. **Scope denials and object misses write no audit row.** `authorization.denied` is written
    by the gate when entitlement or role fails, and it keeps doing that. A `SCOPE_DENIED` is
    different: the verdict comes from a database policy evaluated inside a transaction that
    the request never got to use, and there is no access-control decision by the application
    to record. A `404` is worse to audit: the row was not found *for this member*, so an
    audit table of misses would become a map of the tenant's directory for anyone who can
    read it, and no read API for `audit_event` exists to constrain that. Both choices are
    recorded here so a reviewer can disagree with the reasoning rather than discover the gap.
14. **Caching is a path rule, not a per-route habit.** The `onSend` hook answers
    `Cache-Control: no-store` for every URL beginning `/v1/people`, so the two new routes,
    their denials, their `400`s and their `409`s are covered by prefix rather than by
    remembering to set a header on each one.
15. **The UI exposes the same six fields and nothing more.** The People screen shows **Add
    person** and a per-row **Edit** only when the context reports `canWrite`, which is a
    convenience, not an authorization: the routes repeat every check. The panel is inline
    rather than a modal, uses `maxLength` from the shared contract constants, sends the
    in-memory CSRF token in `x-csrf-token` with a JSON content type (so no request is a
    "simple" cross-site form post), disables its controls while a request is in flight,
    reloads the current query and page after a success, and announces the save in a polite
    live region. Each typed failure has its own copy, and no raw server message is displayed.

## Consequences

- The directory becomes writable by the members whose role already covers it, which is what
  the People module needs before payroll or CRM can hold anything. It does not make the
  platform multi-user correct on its own: last-write-wins means a stale edit silently
  overwrites, so any screen that edits the same row from two places needs a conflict strategy
  before it ships.
- The person write policies are exercised by real DML for the first time. ADR 0007's
  statement that they were pinned only through `pg_policy` and helper truth tables is
  amended, not rewritten.
- `randomUUID()` in the API rather than `gen_random_uuid()` in SQL means the row's identity is
  known before the insert. That is what makes the same-transaction read-back and the
  audit-with-write possible without `RETURNING`. The client supplies neither.
- **This is where the slice conflicts with a documented rule.** `architecture.md` §6 and
  `suite/db/README.md` state that identifiers are "application-generated UUIDv7" with
  `gen_random_uuid()` as fallback, and the stated reason is index locality. `node:crypto`'s
  `randomUUID()` emits a v4 UUID, so the person ids this route creates are random, not time
  ordered. `packages/db/src/provision.ts` already generates the tenant id the same way, so the
  route follows the code rather than the documentation, and the T19 brief specified
  `randomUUID()` explicitly. The conflict is recorded rather than resolved here: making the
  rule true needs one shared UUIDv7 helper used by provisioning and every app-generated id,
  which is a separate decision with its own migration-free diff, and inventing a
  monotonic-ordered variant just for `person` would leave the inconsistency in a new place.
  Until then, "time-ordered IDs keep indexes healthy" is a target, not a property of the
  person table.
- The `42501` on `INSERT ... RETURNING` will surprise the next module that adds a write path.
  The rule to carry forward is that on a table with a restrictive `scope_read` policy whose
  expression re-queries that table, `RETURNING` is unavailable on insert, and a route must
  name its own id and read the row back. The alternative — changing `person_visible()` to see
  same-command rows, or dropping `scope_read` from the insert path — would weaken scope for
  every read to make one response shape cheaper, and was rejected.
- 22 column privileges on `person` is more surface than M0 shipped with. It is still narrower
  than a table grant by every measure that matters: no `DELETE`, no `status`, no placement,
  no `user_id`, no timestamps, no personal or demographic column, and RLS unchanged on both
  sides. Any widening of this list should be a new ADR, not an edit to
  `packages/db/sql/runtime-grants.sql`.
- Scope remains enforced but invisible. `/v1/context` still returns entitlements and
  permissions only, so a member cannot tell from the UI why a create was refused beyond the
  copy this slice provides; the honest message says what to do rather than pretending to show
  a scope.

## Not built

No delete, restore or soft-delete route. No status change, no placement or legal-entity/org-unit
editor, no employment or compensation write, no person-to-user linking through the API, no
change to `/v1/context`, no scope labels, no bulk edit, no import, and no change to the CSV
export. There is no optimistic locking, no partial-success batch, no rate limit on the write
routes and no field-level redaction audit. The write path has never run in CI: the GitHub
account is locked for billing and no job has executed a step.
