# ADR 0009 — Placement is a separate, whole-pair write onto an existing person, decided by the scope helper

Status: accepted · October 2026 · M1 slice 5 (T20)

## Context

`0002_people.sql` gave `person` two placement columns, `legal_entity_id` and `org_unit_id`, and
composite `(tenant_id, …)` foreign keys to `legal_entity` and `org_unit`. Nothing in the product
could write either column: `packages/db/sql/runtime-grants.sql` granted no privilege on them, and
ADR 0008 recorded that as deliberate. `0012_people_scope.sql` then made placement the unit of
scope — a member's `membership_scope` row names a legal entity or an org unit, and
`app.person_placement_in_scope(uuid, uuid)` decides whether a placement is inside that member's
reach — but until this slice the only way to place anyone was an operator's own SQL against the
owner connection, so the policies guarded a column no application path could fill. The test
fixtures place people by inserting as `saas_owner`, which is how `tests/scope.test.ts` proves
narrowing without a product path.

That left the directory half-built. A member with `people.write` could add a person and edit six
identity fields, and the screen had to say that placement was not editable anywhere. Meanwhile
0012's rule — an unplaced person is visible only to a tenant-wide member — means placement is the
act that moves someone into or out of a scoped colleague's directory. It is the most consequential
column pair the People module has, and it is a directory attribute, not an employment record: the
employment table, `status`, dates of joining and exit, designation, manager, location and
compensation are separate columns on separate tables and none of them is in scope here.

Three constraints shape the design:

1. Scope is a database property (ADR 0007). A placement route may answer "where may this member
   put anyone?" only by asking the database, and may not re-derive the org-unit subtree in
   TypeScript.
2. The org structure itself is not administrable. There is no route, screen or CLI that creates,
   renames, moves or retires a legal entity or an org unit, so the placement route reads
   reference tables no application path writes.
3. The person row is the shared identity. A write to it must not become an employment event, a
   status change or a way to retarget someone else's record.

## Decision

1. **Placement is its own route with its own contract.** `PATCH /v1/people/:id/placement` writes
   it and `GET /v1/people/placement-options` supplies the choices. `PATCH /v1/people/:id` — the
   identity route — still accepts only the six identity fields, so `legalEntityId` and `orgUnitId`
   in that body remain a `400 INVALID_BODY`. Splitting the two keeps one honest surface per
   decision: an identity edit and a placement move are audited as different actions and refused
   with different codes.
2. **A placement is written as a whole pair, never as a patch.** `PeoplePlacementInput` requires
   both keys, each a UUID or `null`: `{"legalEntityId": "…", "orgUnitId": null}` means "this
   entity, no unit", and `{"legalEntityId": null, "orgUnitId": null}` means "unplaced". An absent
   key, an extra key, an empty object, an array, a non-string or a malformed UUID is one `400
   INVALID_BODY` with nothing echoed. There is deliberately no "omit it to keep it" semantics here
   — the column pair is one statement about where a person sits, and half a statement is a bug
   waiting to store an entity with an orphan unit.
3. **A person is created unplaced and placed afterwards.** The `INSERT` column list for `person`
   has no placement column, so `POST /v1/people` cannot place anybody; placement is reachable only
   through `UPDATE`, on a row that already exists. This is a grant-level rule, not a validation
   rule, and it keeps the ADR 0008 behaviour intact: a create still starts unplaced, so a scoped
   member is still refused with `403 SCOPE_DENIED` because `scope_insert` cannot approve an
   unplaced row. Making creates placeable would let one request both invent a person and choose
   who else can see them.
4. **Both new routes sit behind `people.write`, and the GET is not an exception.** A member whose
   role cannot write a placement has no reason to ask for the choice lists, so
   `/v1/people/placement-options` is gated `{ module: 'people', operation: 'write' }` and a
   `people.read` role is refused `403 ROLE_DENIED` with its `authorization.denied` row, exactly as
   on the write routes. The options route is a `GET`, so it takes no CSRF token, but it is still
   `no-store`. `PATCH` requires the session, the exact `Origin` and a matching `x-csrf-token`
   before any pool is touched, and parses the body only inside the gated transaction, after
   entitlement and role.
5. **Every scope answer comes from `app.person_placement_in_scope(legal_entity_id, org_unit_id)` —
   the same helper the write policies call.** The options route asks it four times over
   parameterised SQL and restates no rule: `select app.person_placement_in_scope(null, null)`
   becomes `canUnplace`, `app.person_placement_in_scope(le.id, null)` becomes an entity's
   `placeable` flag, and `app.person_placement_in_scope(ou.legal_entity_id, ou.id)` decides both
   which units are offered and whether their parent entity appears at all. The write route asks it
   once, for the pair the caller named, before the `UPDATE`. There is no scope predicate in SQL or
   TypeScript on either route and no `tenant_id` filter, because the member transaction sets
   `app.tenant_id` and `app.user_id`.
6. **The offered entity is decided by two branches, and that difference is surfaced as data.** An
   entity is listed when the member may place directly on it, **or** when it owns at least one
   offerable org unit; the second branch is what lets an org-unit-scoped member see the parent
   entity as a heading without being able to place anyone on it alone. Rather than flatten that,
   the response carries `placeable` per entity and the UI renders a non-placeable entity only as
   an `optgroup` label. A unit is always placeable when it is listed at all, because the pair
   checked for it is the pair the write stores, and the options query `join`s the unit to a live
   legal entity so a unit with no entity or a retired one drops out.
7. **Reference data became readable at the column level and nothing more.** `saas_runtime` now
   holds `SELECT` on exactly `legal_entity (id, name, code, deleted_at)` and `org_unit (id, name,
   legal_entity_id, deleted_at)` — eight column privileges, no table-level privilege, no `INSERT`,
   `UPDATE` or `DELETE`, and no grant on either table's `tenant_id`. `person` moves from 22 column
   privileges to 26: the placement columns join `SELECT` (10) and `UPDATE` (8), and `INSERT` stays
   at 8. Rationale for reading by id and not filtering on `tenant_id`: the join and every lookup
   addresses a globally unique UUID, the composite `(tenant_id, id)` foreign key from `person`
   makes a cross-tenant reference un-storable, and the reference table's own
   `tenant_isolation` policy makes a foreign row invisible to the pre-check. Adding a
   `tenant_id = app.current_tenant_id()` predicate would duplicate a guarantee the schema already
   provides, and `tests/schema-inventory.test.ts` pins the absence of the `tenant_id` grant so the
   read cannot quietly widen.
8. **The unit-belongs-to-this-entity rule is enforced by the route, because no constraint does.**
   `person` carries a composite foreign key to `org_unit (tenant_id, id)` and another to
   `legal_entity (tenant_id, id)`, but nothing ties `person.org_unit_id`'s own
   `legal_entity_id` to `person.legal_entity_id`. So a pair that names a real unit under a
   different real entity would store cleanly. The route looks the unit up and compares its
   `legal_entity_id` (case-folded, the same comparison used everywhere else for these ids) to the
   submitted entity; a mismatch is one `404 PLACEMENT_NOT_FOUND`. The alternative — a schema CHECK
   over two columns whose relationship is already expressible in the write path — would need a new
   migration, a policy re-review and a re-derived inventory for a rule this slice can enforce today
   at one query. It is recorded here as the place a reviewer should push back: a database
   constraint is the stronger answer if placement ever becomes writable from more than one path.
9. **An unreachable target answers as a miss; the one case with no id to hide answers as a
   refusal.** Out of scope, unknown, retired, cross-tenant or mismatched, a named entity or unit is
   `404 PLACEMENT_NOT_FOUND`, so a scoped member cannot use these calls to discover whether an org
   unit exists. A both-null unplace has no id to be opaque about, and the verdict is a pure access
   decision: that one is `403 SCOPE_DENIED`, with the UI copy "Only a workspace-wide role can
   remove a placement." The asymmetry is deliberate and is pinned by tests on both branches. The
   same shape argument holds for the person id: unknown, malformed, soft-deleted, cross-tenant or
   out of scope is one `404 PERSON_NOT_FOUND`, and the malformed-id guard runs inside the gated
   transaction so a role without `people.write` gets `ROLE_DENIED` first (unchanged from ADR 0008).
10. **The directory item is eleven keys, and one shared read feeds every answer.** `DIRECTORY_SELECT`
    / `DIRECTORY_FROM` — `person` left-joined to `legal_entity` and `org_unit`, each join guarded by
    `deleted_at is null` — is used by the list, the create read-back, the identity-patch read-back
    and the placement read-back, so all four answer with the same `PeopleListItem`: the seven
    directory fields plus `legalEntityId`, `legalEntityName`, `orgUnitId`, `orgUnitName`. **The
    names are read from the reference row, not copied from anything the caller sent.** An id is the
    stored fact and stays on the person; a name is the live label and is null when the person is
    unplaced or when the referenced row is soft-deleted, so a retired legal entity never keeps a
    name in the directory while its id remains on the row, and the screen prints `—` when both
    names are null. The screen's placement copy is `[legalEntityName, orgUnitName]` with the nulls
    dropped and the remainder joined by ` · `, falling back to `—` when both are null, so each name
    disappears on its own: a person placed on a live unit under a **retired** legal entity is shown
    as that unit's live name alone, and a person on a retired unit under a live entity is shown as
    the entity name alone. The ids stay on the row and in the response in every case.
    `tests/people-placement.test.ts` proves both halves with a retired unit and, separately, a
    retired entity — including that the retired row's name is absent from the serialised item while
    the surviving name is present.
11. **`UPDATE … RETURNING` no longer carries these responses.** ADR 0008 recorded that
    `RETURNING` works on update because `scope_read`'s USING clause can see a pre-existing row; that
    is still true, and it is still why the create path is the awkward one. But a `RETURNING` list
    cannot contain a joined column. Both the identity patch and the placement patch therefore run
    the `UPDATE` for its row count, then read the row back with the shared eleven-key select in the
    same transaction. `rowCount !== 1` is a sanitized `500 INTERNAL_ERROR` that rolls back the
    write and its audit row — a statement that succeeded but returned nothing would mean the
    policy moved under the transaction.
12. **An unchanged placement writes nothing.** When both stored ids already equal the submitted
    pair, the route returns the current item with no `UPDATE` and no audit row, which is what
    allows the panel to keep **Save placement** disabled until the selection actually differs from
    what is stored.
13. **The audit action is `person.placement.changed` and it carries ids only.** Metadata is
    `{ module, legalEntityId, orgUnitId, previousLegalEntityId, previousOrgUnitId }` — both sides
    of the move, because a placement is the one directory change that alters who else can see the
    row, so "from where" is the forensically useful half — and no name, code, email or phone. This
    is a deliberate departure from ADR 0008's field-names-only rule for identity writes: those
    fields' values are already in the directory, whereas the previous placement is gone from the
    row the moment the update commits and is nowhere else in the database. It is appended in the
    same member transaction as the write, so a failed append rolls the placement back to a
    sanitized `500`; `tests/people-placement.test.ts` proves that with a revoked `INSERT` on
    `audit_event` and asserts the target row still holds its old pair.
14. **Misses and scope denials still write no audit row**, for the reasons ADR 0008 §13 gives, and
    they apply unchanged to `PLACEMENT_NOT_FOUND`, to the both-null `SCOPE_DENIED`, and to the
    `404 PERSON_NOT_FOUND`. Entitlement and role denials audit as `authorization.denied` as before.
    Every `/v1/people` response, both new routes included, is `Cache-Control: no-store` because the
    `onSend` rule matches the path prefix.
15. **The UI places from the row, in its own panel, and never blind.** Each directory row gets a
    **Place** action when the context reports `canWrite` — presentation only; the routes repeat
    every check. Opening it fetches the options and shows a loading state, a retryable error state,
    or one `select` whose options come from the server: **Unplaced** only when `canUnplace`,
    placeable entities as plain options, and units grouped in an `optgroup` labelled with their
    entity. The panel pre-selects the stored placement **only if that placement is in the offered
    list**; a person placed somewhere this member was not offered shows an empty selection and
    **Save placement** stays disabled, so the screen cannot submit a change it never displayed.
    Save is disabled while a request is in flight and while the choice equals the stored pair. A
    success closes the panel, announces `Placement updated.` in the same polite live region the
    identity form uses and reloads the current query and page. Each placement failure code has its
    own copy and no raw server message is rendered; the fine print states that placement is a
    directory attribute, not an employment record, and that status, employment and compensation
    are not editable here yet.

## Consequences

- **The directory page becomes the product's only writer of placement.** Before this slice, only an
  operator's own SQL placed anyone; now a member with `people.write` can, within their scope. That
  makes 0012's placement rules observable from the application for the first time, and it makes
  `app.person_placement_in_scope` a hot path rather than a policy footnote.
- **Placement is a visibility action.** Moving a person out of an org unit's subtree removes them
  from every member scoped to that subtree; unplacing one hides them from every scoped member and
  leaves them visible only tenant-wide. That is the documented behaviour of 0012, not a new rule,
  but this slice is the first place a user can cause it — with no approval, no preview of who will
  lose the row, and no undo beyond reading `previousLegalEntityId` / `previousOrgUnitId` from the
  audit trail on the owner connection.
- **Reference names are now disclosed to whoever can write a placement.** The options list is a new
  read surface over organisation structure: entity names and codes, and unit names, for everything
  in the member's reach. That is what a picker needs and nothing in the product previously returned
  it. Threat row T39 records it, with the residual that a member can learn the shape of the part
  of the org chart they can place into.
- **`UPDATE … RETURNING` stops being the directory's read mechanism.** ADR 0008 §6's sentence about
  updates using `RETURNING` is amended by this slice: the eleven-key shape costs one extra
  same-transaction `SELECT` on every write response. `tests/scope.test.ts` still proves
  `INSERT … RETURNING` raises `42501`.
- **Screen and export disagree on placement, and that is now the honest state.** The CSV export
  still emits exactly the seven identity columns it was built for; placement appears on screen and
  not in the file. Anyone reading the export as "the directory" gets a directory without an org
  structure in it. It is not fixed by adding two columns here — an export change is a portability
  decision with its own reconciliation questions — but the divergence should be closed deliberately
  rather than discovered.
- **26 person column privileges plus 8 reference column privileges is more standing surface than
  ADR 0008 shipped.** `tests/schema-inventory.test.ts` pins all of it as exact lists and counts,
  including that both placement columns are selectable and updatable but **not** insertable, that
  neither reference table has a table-level privilege or a write path, and that no `DELETE` grant
  exists anywhere on this surface. Any further widening should be a new ADR.
- **Placement stays invisible as a scope.** Scope rows are still unreadable by the runtime, so the
  screen can show where a person sits but still cannot say why a colleague sees a shorter list, and
  `/v1/context` still reports entitlements and permissions only.

## Not built

No legal entity or org unit administration — no route, screen or CLI that creates, renames, moves
or retires either, which is why the panel's empty state says they are created outside this screen
today. No org-tree or descendant view, no bulk placement or re-parenting, no placement in the CSV
export, no per-person detail route, no placement history read, no approval on a move, no undo. No
write to `status`, `location_id`, `manager_person_id`, `designation`, `employment_type`, either
date column, `personal_email`, the demographic or import columns or `user_id`; no employment,
compensation or bank write; no delete, restore or soft-delete. Legal-entity-scoped placement of a
person into an entity that is not the member's own remains impossible by policy, not by
validation. Nothing in this slice has run in CI: the GitHub account is annotated as locked for
billing and no job has executed a step.
