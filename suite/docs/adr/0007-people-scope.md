# ADR 0007 — People scope is a database property on top of role

Status: accepted · October 2026 · database half (M1 slice 1), owner-only authoring path (slice 2) and first request-layer consumer (slice 3)

## Context

M0 answers two questions before it touches data: is the module licensed, and does
this member's role hold the permission. Neither answers *where*. A 200-person
organisation with three legal entities and a department tree cannot give every
manager the whole directory, and an employee who signs in must see exactly one
person row — their own.

The M0 role policy lives in `@saasmodels/contracts` and is applied by
`withMemberTransaction` in TypeScript. If scope lived only there, every future
query would have to remember to add a `where` clause, and a forgotten clause
would be invisible in review. M1's first requirement is scope authorization
(legal entity, department/org unit, employee self-scope) on top of that policy,
and this slice builds it where a missed predicate cannot leak rows: in the
database.

## Decision

1. **Scope narrows; it never widens.** Every policy added by
   `suite/db/migrations/0012_people_scope.sql` is `AS RESTRICTIVE`. The permissive
   `tenant_isolation` policy and the restrictive module policies from
   `app.apply_module_policies()` stay exactly as M0 shipped them. Postgres
   combines a permissive policy with `OR` and every restrictive policy with
   `AND`, so a scope policy can only remove rows an M0 member could already see.
   No `FORCE ROW LEVEL SECURITY` is enabled, and no existing policy is dropped or
   weakened.
2. **The person-to-user link lives on `person`.** `person.user_id uuid null`
   references `app_user (id)` with `ON DELETE SET NULL` and a partial unique
   index on `(tenant_id, user_id) WHERE user_id IS NOT NULL`. The FK is plain
   rather than composite because `app_user` is a global identity table with no
   `tenant_id`; the partial index is what keeps the link inside one tenant.
   Deleting the identity unlinks the record — it never deletes the shared
   directory row.
3. **`membership_scope` is one row per member per scope value.** `scope_type` is
   constrained to `legal_entity` or `org_unit`, and a CHECK forces exactly the
   matching typed column to be set, so a row cannot be ambiguous or empty. All
   three references are composite `(tenant_id, …)` foreign keys, which required
   adding the missing `unique (tenant_id, id)` to `membership`. The membership
   cascade is `ON DELETE CASCADE`: scope rows belong to the membership, not to
   the person. Uniqueness is `NULLS NOT DISTINCT` over
   `(tenant_id, membership_id, scope_type, legal_entity_id, org_unit_id)`, so the
   same scope cannot be granted twice. The table has RLS and `tenant_isolation`,
   and **no** grant to `saas_runtime` or `saas_worker`: a member's scope is read
   only through the helpers, never selected.
4. **The resolution order is fixed and single-sourced.** Each helper evaluates,
   in order: no `app.user_id` → no narrowing; no tenant or no active membership →
   false; role `employee` → own linked person for read, false for write; a role
   outside the six manageable roles → false; a membership with zero scope rows →
   tenant-wide; otherwise → placement match. Five owner-owned `SECURITY DEFINER`
   functions with `set search_path = ''`, revoked from `PUBLIC` and granted to
   `saas_runtime` through `packages/db/sql/runtime-grants.sql`:
   `app.current_user_id()`, `app.current_person_id()`, `app.person_visible(uuid)`,
   `app.person_in_scope(uuid)` and `app.person_placement_in_scope(uuid, uuid)`.
   `app.current_user_id()` is the only security-*invoker* helper, because it
   reads nothing but the GUC. Internal helpers (`current_active_membership_id`,
   `member_has_scope`, `org_unit_is_in_scope_subtree`, `member_placement_matches`)
   are called only by other owner-owned functions, so they keep the owner's
   implicit `EXECUTE` and stay revoked from `PUBLIC` — the same pattern as 0011's
   `outbox_claimed_guard`.
5. **A scoped org unit means its subtree.** `legal_entity` scope matches on
   equality. `org_unit` scope matches the named unit **and every descendant**, so
   scoping a manager to a department covers the teams inside it; ancestors and
   siblings stay out. The walk is a recursive CTE with a `CYCLE` guard, so a
   corrupted parent chain raises rather than looping.
6. **Zero scope rows means tenant-wide, for the six manageable roles.** `owner`,
   `admin`, `hr`, `finance`, `manager` and `auditor` with no `membership_scope`
   row see the whole tenant, exactly as in M0. This keeps the existing suites
   honest: scope is opt-in per membership, so adopting 0012 changes no current
   tenant's behaviour until someone writes a scope row.
7. **Employee is self-only and never writes.** `person_visible` returns true for
   exactly the person row whose `user_id` is the session user; `person_in_scope`
   and `person_placement_in_scope` are false for that role. A scope row attached
   to an employee membership is ignored — self-scope is a ceiling, not a widening
   grant, and the test that pins it is explicit about that fixture. The `employee`
   role's permission set in `@saasmodels/contracts` is unchanged, so an employee
   still denies at `ROLE_DENIED` before any SQL runs; the self-read path becomes
   reachable only when M1 gives employee a permission.
8. **An unplaced person is visible only to a tenant-wide member.** A person with
   both `legal_entity_id` and `org_unit_id` null cannot be matched by any scope
   row, so a scoped member cannot read or write it. Choosing "no placement"
   therefore restricts rather than exposes.
9. **A system transaction is not narrowed.** When `app.user_id` is unset — the
   `withTenantTransaction` path, intended for imports and background work —
   scope helpers return true and the tenant predicate alone decides. This is
   deliberate and it is a documented residual, not an oversight: Postgres cannot
   distinguish an unset GUC from an empty one more cheaply than this, and the
   alternative would break every system path that legitimately spans a tenant.
   The People directory export and the `GET /v1/people` read route are not among
   those paths: both run through `withMemberTransaction`, so both are narrowed like
   any other member request.
   `tests/scope.test.ts` pins it, so any change to that behaviour is a visible
   test failure rather than a quiet widening.
10. **Project and client scope are deferred, with no dead schema.** The `CHECK`
    list holds only what the helpers can evaluate. There are no `project_id` or
    `client_id` placeholder columns and no `scope_type` value that returns a
    constant.
11. **`employment` inherits scope through its person.** Read is
    `app.person_visible(person_id)`; insert, update (both `USING` and
    `WITH CHECK`) and delete are `app.person_in_scope(person_id)`. `person` read
    is `app.person_visible(id)`, insert is
    `app.person_placement_in_scope(legal_entity_id, org_unit_id)`, update is
    `person_in_scope(id)` with `person_placement_in_scope(...)` as the check, and
    delete is `person_in_scope(id)`. A catalogue-derived invariant test asserts
    that every runtime-readable table with a `person_id` column carries a
    restrictive read policy calling `app.person_visible(person_id)`, so a future
    person-child table that forgets the policy fails CI rather than shipping a
    hole. Today that set is exactly `['employment']`.

## Consequences

- **The database decides, the caller does not.** `permissionsForRole` is untouched and `withMemberTransaction`
  still checks membership → platform → entitlement → role and knows nothing about
  scope rows. The scope decision happens underneath that check, in the policies,
  on any transaction that set `app.user_id` — which `withMemberTransaction`
  already does. So the existing member paths, including the People directory
  export, are already subject to scope; they change behaviour only for a
  membership that has a `membership_scope` row, and none can be written through
  the product yet.
- **Slice 3 adds the first request-layer consumer, and it adds no scope code.**
  `GET /v1/people` and the People directory screen are the first member path built
  to be narrowed by these policies rather than merely being subject to them. The
  route opens a People-read member transaction, selects only the granted directory
  columns with `deleted_at is null`, and contains no scope predicate in SQL or
  TypeScript; `tests/people.test.ts` pins the regression where a manager scoped to
  one legal entity reads exactly one row through the route while the tenant owner
  reads the whole tenant in the same run — which is the proof that the transaction
  really does set `app.user_id`. The `count(*)` behind `total` runs under the same
  policies in the same transaction, so a scoped member's total is their total, not
  the tenant's.
- **Scope is enforced, never displayed.** `/v1/context` is unchanged and still
  returns entitlements, the resolved role and its canonical permissions only, so no
  client can tell a tenant-wide member from a scoped one. The directory screen
  therefore prints no scope label: it has no way to know what narrowed its rows,
  and inventing one would be a guess. Its fine print says only that the view is
  limited by the member's role and scope, and its empty copy never claims the
  workspace holds nobody.
- **The employee self-read is still unreachable, and so is any write.** The
  `employee` permission set in `@saasmodels/contracts` is unchanged by all three
  slices, so an employee request still denies at `ROLE_DENIED` before a policy is
  consulted and `app.person_visible` has no caller for that role. `saas_runtime`
  still holds no `INSERT`, `UPDATE` or `DELETE` on `person` and there is no People
  write route, so the write-side policies stay exercised by the database tests
  rather than by the product.
- **Role-first ordering is preserved and observable.** An unentitled module or a
  role without the permission is refused before scope matters, so scope cannot
  disclose that a module exists or what a role could have seen. The test suite
  asserts the combination rather than assuming it.
- **Person writes are proven by catalogue pin plus helper truth table, not by
  runtime DML.** `saas_runtime` has no `INSERT`, `UPDATE` or `DELETE` on `person`
  (only the eight directory column `SELECT` grants), so a person write attempt
  fails the privilege check with `42501` before RLS is consulted. The four
  `person` policies are therefore asserted in `pg_policy` and through helper
  results; `employment`, which the runtime can write, is exercised end to end
  with real zero-row and `42501` outcomes. The scope suite asserts both, so
  nobody misreads the source of a denial.
- **`person.user_id` is owner-written, out of band.** The runtime has no `UPDATE`
  on the column and provisioning does not set it. The authoring surface is
  `packages/db/src/scope.ts` (`linkPersonUser`, `unlinkPersonUser`) behind
  `pnpm db:scope`, which takes `DB_OWNER_URL`, requires the actor to hold an
  active `owner` membership in that tenant, validates tenant, person and user
  with tenant-scoped queries rather than trusting the caller, and appends
  `person.user.linked` / `person.user.unlinked` in the same transaction so an
  audit failure rolls the link back. Re-linking the same pair is a no-op with no
  second audit row; a conflicting link refuses with `PERSON_ALREADY_LINKED` or
  `USER_ALREADY_LINKED` and writes nothing.
- **Scope rows have an owner-only authoring surface, not an application one.**
  `setMembershipScope` replaces one membership's rows in a single transaction —
  refuses duplicates, an empty list without `--tenant-wide`, a tenant-wide
  request that also names scopes, targets that are unknown, cross-tenant or
  soft-deleted, and any `employee` membership, because a scope row can never
  widen self-scope and would only be dead data. `getMembershipScope` is the read
  side used by `show`. There is still no API, UI or runtime grant for any of it:
  `saas_runtime` and `saas_worker` cannot read or write `membership_scope` or
  `person.user_id`, which is why these four functions take an owner `Pool` and
  why the checks are hand-written — the owner role bypasses RLS by ownership.
  Role administration and seat enforcement are still absent.
- **The fail-open residual needs a decision before real data.** A route that
  serves member requests through `withTenantTransaction` would silently skip
  scope. `tests/scope.test.ts` pins the behaviour, threat model row T36 records
  it, and the review question is who guarantees that no member path takes the
  system helper — today that guarantee is import boundaries and code review.
- **The authoring path is itself a threat surface.** Threat model row T37 records
  it: whoever holds `DB_OWNER_URL` can link the wrong person or grant an
  over-broad scope, and the only detective control is the audit row, which has no
  read API or UI yet. Grant review today means a query on the owner connection.
- **Schema counts move**, and the pinned inventory, roll-forward and harness
  tests were re-derived rather than hand-adjusted: 75 public base tables, 67 with
  `tenant_id`, 66 RLS-enabled public tables (65 of them carrying `tenant_id`),
  274 policies (66 permissive, 208 restrictive), 12 migrations, and 12
  runtime-executable `app` functions. The `saas_worker` surface is unchanged at
  zero table privileges and exactly eight executable functions. The owner-only
  scope administration slice adds no migration, no policy, no grant and no
  function to either surface, and neither does the read-only directory route and
  the screen that consume it, so all of these figures are unchanged by both and
  were re-derived from the live database to confirm that.

## Amendment — T19 adds the People write path (M1 slice 4)

The bullet above that says `saas_runtime` holds "no `INSERT`, `UPDATE` or `DELETE` on
`person` (only the eight directory column `SELECT` grants)" and that person writes are
therefore proven by catalogue pin plus helper truth table describes the tree as this ADR
was written, and it is superseded by
[ADR 0008](0008-people-write-path.md). The People write path grants the runtime role
column-level `INSERT` on `id, tenant_id` and the six identity fields and column-level
`UPDATE` on the six identity fields, so the person write-side policies are no longer
asserted only through `pg_policy` and helper results: `tests/scope.test.ts` now exercises
them with real DML — a scoped member's unplaced insert fails `42501` naming
`scope_insert`, and a tenant-wide member's unplaced insert commits and reads back inside
the same transaction. Nothing else in this ADR changes. No policy, no helper and no
permissive rule was weakened, no migration was added, and scope stays a database property
that only narrows: the write grants cover the identity columns alone, `id` is insertable
but never updatable, `deleted_at`, `status`, the placement columns, `user_id`, the
timestamps, `personal_email` and the demographic columns stay owner-only, and there is still no
table-level privilege and no `DELETE` on `person`. The person column privilege inventory
moves from 8 to 22 (8 `SELECT` + 8 `INSERT` + 6 `UPDATE`); 12 migrations, 75 public base
tables, 67 with `tenant_id`, 66 RLS-enabled and 274 policies are unchanged, and the
`saas_worker` surface stays at zero table and column privileges with exactly eight
executable functions. `person.user_id` remains owner-written and out of band — the write
path cannot set it, and no API route links a person to a user.

## Amendment — T20 adds the placement path (M1 slice 5)

The paragraph above lists the placement columns among the person columns that "stay
owner-only". That was accurate for the identity write path and is superseded by
[ADR 0009](0009-people-placement.md): `legal_entity_id` and `org_unit_id` now carry
column-level `SELECT` and `UPDATE`, and nothing else. The person column privilege inventory
moves from 22 to 26 (10 `SELECT` + 8 `INSERT` + 8 `UPDATE`), with neither placement column
insertable — so a person created through the API still always starts unplaced, and the
decision that paragraph describes is unchanged in kind, only in width. The same slice adds
column-only `SELECT` on `legal_entity (id, name, code, deleted_at)` and
`org_unit (id, name, legal_entity_id, deleted_at)` for the directory join and the options
list, which is where the eight readable reference columns come from; the runtime table-grant
allowlist stays at twelve rows, both reference tables keep `has_table_privilege` false for
all four privileges, and neither has a write path.

What this ADR decides is untouched by it. No migration was added — 12 migrations, 75 public
base tables, 67 with `tenant_id`, 66 RLS-enabled and 274 policies are the same figures,
re-derived from the live database — and no policy, helper, permissive rule or restrictive
rule was widened, so scope still only narrows and the system-transaction fail-open residual
still stands exactly as pinned by `tests/scope.test.ts`. One thing does change in character
rather than in width: placement was a property only an operator could set, through
`pnpm db:scope` or direct SQL, and it is now a member-facing action. `PATCH /v1/people/:id/placement`
moves a colleague into or out of a member's visibility, and every one of its verdicts comes
from `app.person_placement_in_scope(uuid, uuid)` — the same definer helper `scope_insert` and
`scope_update` call — rather than from a predicate restated in the request layer, which is
this ADR's central decision operating as designed rather than a new one. `person.user_id`
still has no runtime grant and no API route.

The Consequences bullet above that ends "... so all of these figures are unchanged by both and
were re-derived from the live database to confirm that" describes the
scope-administration and directory-read slices, and it stands for them. This slice is
the one that moves a privilege figure rather than only adding a route, so read that
bullet together with the paragraph above rather than as a claim about the write path.
