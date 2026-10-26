# Roadmap — M0 to M4

Status: planning baseline · October 2026
The dates are deliberately absent. A date is published when a scope is real and a dependency is cleared.

---

## M0 — Foundation (now)

**Goal:** a repository and schema that a small team can build on without re-deciding the basics.

Deliverables:

- This engineering foundation, ADRs and data model.
- Module catalog, dependency declarations, tenant entitlements and organisation provisioning.
- Shared person and client directory, owned by the platform rather than a module.
- PostgreSQL schema applied to a local instance and reviewed by a second engineer.
- API/worker skeleton with tenant-context, entitlement and role checks; email/password login, opaque server-side sessions and one-time invitation acceptance; authenticated access-denial audit; a streaming People directory CSV export; plus a test harness.
- React 19 + Vite signed-in shell with real sign-in and sign-out, entitlement-and-role-filtered module navigation, an empty People screen and a local Playwright browser journey.
- Postgres outbox consumer machinery: 0011 adds lease columns, a per-tenant claim index and four `SECURITY DEFINER` claim helpers executed only by a `saas_worker` role that holds no table privilege; `apps/worker` runs per-tenant gated passes and a polling loop with backoff and dead-lettering. Delivery is at-least-once. No producer writes an event, no handler is registered outside tests and no worker process is deployed.
- CI workflow authored with type check, lint, boundary lint, tests, secret scan, dependency audit, Chromium install and the browser journey — whose Playwright webServer builds the web app before serving it — plus a PostgreSQL 16/17 matrix. A GitHub remote now exists — `Charanjitsingh1991/Saasmodelone`, connected private on 23 October 2026 and changed to **public** the same day at the owner's instruction — and the push of `f060bca` created Actions run `39903221917`, but no job has executed a step there: GitHub annotated the account as locked for billing, so attempt 1's four reruns ended in `startup_failure` with zero jobs and the post-public attempt 2 recorded both matrix jobs with `steps: []` and the annotation `The job was not started because your account is locked due to a billing issue.` Six further pushes have each created a run since — `39907647182` through `40267178007`, the last started on 26 October 2026 for `f683213` — and all seven end the same way: both matrix jobs `completed` about two seconds after starting with `runner_id: 0` and zero steps. Repository visibility made no difference — so no step has ever run and PostgreSQL 16 and the CI browser job remain unproven.
- Draft threat model and M0 evidence pack; human review pending. Design-partner gate drafted.

Exit criteria:

- A test proves that two tenants cannot read or write each other's rows through both SQL and the API.
- A test proves that a tenant without an active module cannot reach its data, routes, exports or background jobs.
- A test proves suspended, closed and deleted tenants are denied at both layers: `app.has_platform_access()` and the module RLS policies.
- A synthetic public tenant can be provisioned with People; an internal tenant can also receive the planned CRM module through an internal-source entitlement, without a schema change or data migration.
- Migrations and the module seed apply cleanly to an empty database and roll forward from the previous version.
- A signed-in user can reach an empty People screen and sees only the modules the tenant is entitled to.
- A test proves role authorization is enforced after entitlement: an entitled module with a role that lacks the permission returns `ROLE_DENIED`, and an unentitled module returns `MODULE_NOT_ENTITLED` without disclosing role policy.
- A test proves the People directory export returns only the session tenant's seven identity fields, rejects an unentitled or role-denied request without CSV bytes, and commits its export audit event before the first byte.

Progress (October 2026): database and API tests prove tenant isolation, platform access, module entitlement, the auth-role boundary and the M0 role matrix with real sessions. Email/password login, session validation, logout, one-time invitation acceptance, role authorization for People and Work, authenticated access-denial audit and the streaming People directory CSV export exist. The React 19 + Vite shell has real sign-in and sign-out and entitlement-and-role-filtered navigation; its `/app/people` route now renders the read-only People directory from `GET /v1/people` with search, a live result count and paging (that screen and route arrived with M1's third slice, recorded below); one Playwright journey proves the signed-in criterion in a real browser against the built output and a disposable database. A working-tree secret scanner for tracked and untracked non-ignored regular files, a production dependency audit, a schema/privilege inventory over the tenant-id tables (67 since M1's 0012, 66 before it), a CI workflow contract test, the draft threat model in [`security/m0-threat-model.md`](security/m0-threat-model.md), the interim evidence pack in [`release/m0-evidence.md`](release/m0-evidence.md) and the per-criterion exit audit in [`release/m0-exit-audit.md`](release/m0-exit-audit.md) exist. M0 has **not** exited: there was no People data-entry route or screen and no scope write path in the application at M0's close, and there is still no scope value exposed to the client or payroll (M1's later slices have since added the directory read, the identity write and the placement path; recorded below); the Postgres outbox has its claim helpers, `saas_worker` role and polling loop but no producer, no registered production handler and no deployed consumer, so no event ever moves on a real system; the restore capability is a manually executed logical pg_dump/pg_restore drill (`pnpm drill:restore`) verified locally, on repeated runs, on PostgreSQL 17.9 against synthetic data — not a scheduled, encrypted backup regime, and not run in CI. The CI workflow has a remote now — private when connected on 23 October 2026, **public** the same day at the owner's instruction — and the push of `f060bca` created Actions run `39903221917`, but no job has executed a step: the account is annotated as locked for billing, attempt 1's reruns ended in `startup_failure` with zero jobs, and the post-public attempt 2 recorded both matrix jobs with `steps: []` under the same billing annotation; six further pushes have each created a run since — `39907647182` through `40267178007`, the last started on 26 October 2026 for `f683213` — and all seven end the same way, both matrix jobs `completed` about two seconds after starting with `runner_id: 0` and zero steps — so no step has ever run, and PostgreSQL 16 and the CI browser job are unproven; the threat model has no named owner or human review; and the design-partner gate remains open.

## M1 — Internal People payroll

**Goal:** run one payroll correctly for a synthetic 150-person company.

Scope:

- Scope authorization (legal entity, department, project, client) and employee self-scope on top of the M0 role policy; role administration and seat enforcement.
- Module-aware authorization: entitlement, then role, then scope.
- Person, employment, compensation, bank and jurisdiction-scoped identifiers.
- Salary structures and payroll inputs.
- Leave types, balances and requests; attendance import/punch.
- Payroll calculation, review, approval and finalisation.
- Payslip generation, bank file and statutory reports.
- Document upload and expiry reminders.

Exit criteria:

- Golden payroll cases pass for the first jurisdiction pack, including at least two sub-jurisdictions where the pack defines them, and multiple joining/exiting scenarios.
- A qualified local payroll advisor signs off the calculation sheet and reports.
- Finalised payroll is immutable; reversal works.
- A full export and re-import reproduces the same totals.
- A user without the People entitlement cannot reach a payroll route even with an admin role.
- No critical or high finding in an internal security review.

Progress (October 2026): M1 has started with its first slice — the **database half of scope authorization**, in `suite/db/migrations/0012_people_scope.sql` and [ADR 0007](adr/0007-people-scope.md). `person.user_id` links a directory record to the user who signs in as it; `membership_scope` records one legal entity or one org unit per row; five `SECURITY DEFINER` helpers resolve the fixed order (no user → no narrowing, no active membership → denied, employee → own row for read only, unmanaged role → denied, zero scope rows → tenant-wide, otherwise placement match), and eight `AS RESTRICTIVE` policies on `person` and `employment` make the decision a property of the tables. `tests/scope.test.ts` (21 tests) proves it, including the catalogue-derived invariant that every runtime-readable `person_id` table carries a `app.person_visible(person_id)` read policy, and `tests/schema-inventory.test.ts`, `tests/migration-rollforward.test.ts` and `tests/harness.test.ts` were re-derived for 0012 rather than relaxed. The second slice was its **owner-only authoring path**: `packages/db/src/scope.ts` and `pnpm db:scope` write `person.user_id` and `membership_scope` on the owner connection, require an active `owner` actor, re-check every id with tenant-scoped predicates rather than trusting caller input, refuse duplicates, unknown, cross-tenant and soft-deleted targets, `--tenant-wide` combined with scopes and any `employee` membership, and append `person.user.linked`, `person.user.unlinked` or `membership.scope.changed` in the same transaction so an audit failure rolls the change back. `tests/scope-admin.test.ts` (27 tests) proves it, and the slice adds no migration, no policy, no grant and no executable function — the 12 migrations, 75 base tables, 67 with `tenant_id`, 66 RLS-enabled, 274 policies, 12 runtime table grants, 12 runtime-executable helpers and 8 worker-executable helpers are unchanged and were re-derived. The third slice is the **first request-layer consumer of those policies**: `packages/contracts/src/people.ts` adds the `PeopleListResponse` contract, `GET /v1/people` in `apps/api/src/server.ts` returns a paginated, literally-searchable directory page from inside `withMemberTransaction` with the People read gate — so the transaction sets `app.user_id` and the restrictive policies, not application code, decide which rows and which total come back — and `apps/web` replaces the empty People state with a directory screen: an accessible `People directory` table, an `aria-live` result count, a search form, Previous/Next paging and loading, retryable error and empty states whose copy never claims the workspace holds nobody. `tests/people.test.ts` (14 tests) proves the unauthenticated refusal, the owner's tenant-wide page, tenant isolation, the role and entitlement denials with their audit rows, the retention-window pair, the manager-scoped-to-one-legal-entity regression against an unchanged tenant-wide owner in the same run, literal `%` and `_` handling, malformed-parameter `400 INVALID_QUERY`, deterministic paging past the end and `no-store` on success and denial; the Playwright journey now renders and searches real rows. That slice adds no migration, no policy, no grant, no seed and no schema change, touches no export, auth, context or proof route, and leaves scope undisplayed: `/v1/context` still returns entitlements and permissions only, so no screen can label a row with its scope. The fourth slice is the **core-identity write path**, recorded in [ADR 0008](adr/0008-people-write-path.md): `POST /v1/people` and `PATCH /v1/people/:id` in `apps/api/src/server.ts`, both session- and CSRF-verified, both inside `withMemberTransaction` under the People **write** gate so entitlement and role are checked before the body is parsed, and both limited to the six identity fields — `firstName`, `lastName`, `displayName`, `employeeCode`, `workEmail`, `phone` — with `packages/contracts/src/people.ts` holding the closed input contracts and the five length constants the browser's `maxLength` also uses. A create requires a non-empty first name, derives `displayName` from the names when absent, refuses an unplaced person for a member who has scope rows with `403 SCOPE_DENIED`, generates the person id in the API, inserts it explicitly with `tenant_id` and **no `RETURNING`** — the restrictive `scope_read` policy cannot observe a row the same command created, so a `RETURNING` insert fails `42501` — then reads the seven directory fields back in the same transaction and appends `person.created` with the sorted field names. An update reads the row first, writes only the columns whose effective value changed, commits nothing when nothing did, maps a `23505` to `PERSON_CODE_TAKEN` / `PERSON_EMAIL_TAKEN` / `PERSON_CONFLICT` without echoing the value, and answers one uniform `404 PERSON_NOT_FOUND` for an out-of-scope, cross-tenant, soft-deleted, malformed or unknown id. `packages/db/sql/runtime-grants.sql` now grants 8 `SELECT`, 8 `INSERT` and 6 `UPDATE` column privileges on `person` (22 in total, `id` insertable but not updatable, `deleted_at` read-only, no `DELETE` and no table-level privilege of any kind), which is the only grant change in the slice; the 12 migrations, 75 base tables, 67 with `tenant_id`, 66 RLS-enabled, 274 policies, 12 runtime table grants, 12 runtime-executable helpers and 8 worker-executable helpers are unchanged and were re-derived. `tests/people-write.test.ts` (18 tests) and the updated `tests/schema-inventory.test.ts` prove it, `tests/scope.test.ts` now drives `scope_insert` and `scope_update` as real runtime DML instead of asserting them from the catalogue, and the Playwright journey creates a person, edits it back, and exercises a duplicate-code refusal in the browser. The fifth slice is the **placement path**, recorded in [ADR 0009](adr/0009-people-placement.md): `GET /v1/people/placement-options` and `PATCH /v1/people/:id/placement` in `apps/api/src/server.ts`, both inside `withMemberTransaction` under the People **write** gate — the options route is a `GET` and is still gated as a write, so a `people.read` role cannot enumerate the tenant's structure — and both CSRF- and origin-verified where the request is unsafe. The directory read became a joined record: `PeopleListItem` now carries eleven keys, the seven identity fields plus `legalEntityId`, `legalEntityName`, `orgUnitId` and `orgUnitName`, and `tests/people.test.ts` and `tests/people-write.test.ts` were re-derived for that rather than relaxed. The placement body is exactly two keys — `legalEntityId` and `orgUnitId`, each a UUID or null, with an org unit never accepted without the entity it belongs to — and every verdict comes from `app.person_placement_in_scope`, so no scope rule is restated in SQL or TypeScript: an out-of-scope reference and a retired or foreign one are the same `404 PLACEMENT_NOT_FOUND`, an unseen person is `404 PERSON_NOT_FOUND`, and the only `403 SCOPE_DENIED` is the both-null unplace by a member with scope rows, because removing a placement leaves a person that member could neither see nor maintain. An unchanged pair writes nothing; `person.placement.changed` is appended in the same transaction with the pair before and after as **ids only**. `packages/db/sql/runtime-grants.sql` moves the two placement columns on `person` from owner-only to selectable and updatable — never insertable, so a new person always starts unplaced — and adds column-only `SELECT` on `legal_entity (id, name, code, deleted_at)` and `org_unit (id, name, legal_entity_id, deleted_at)`, which is 10 `SELECT` + 8 `INSERT` + 8 `UPDATE` = 26 person privileges with no table-level privilege on any of the three tables and no `DELETE` anywhere; the export still emits its seven columns, so a legal entity name reaches the screen and not the CSV. The screen gains a `Placement` column and a per-row Place panel whose choices come only from the server, which disables Save until they arrive and states that a placement is a directory attribute, not an employment record. `tests/people-placement.test.ts` (24 tests) proves all of it and the Playwright journey places a person on an org unit, reloads, and unplaces it again. The slice adds no migration, no policy, no helper, no seed and no schema change — the 12 migrations, 75 base tables, 67 with `tenant_id`, 66 RLS-enabled, 274 policies, 12 runtime table grants, 12 runtime-executable helpers and 8 worker-executable helpers are unchanged and were re-derived. **Nothing else in this milestone is built**: no People delete, restore, status change, employment, compensation or user-linking write, no legal entity or org unit administration route — every reference row in the placement tests and the browser journey was written on the owner connection — no bulk import, no CSV or export change, no `/v1/context` change, no scope value in `/v1/context` or in any UI label, no scope read or administration API, no placement history or approval surface, no project or client scope, no role administration or seat enforcement, no audit read surface for reviewing a grant, and M0 has not exited.

## M2 — First design partner and repeatable Switch

**Goal:** one real 50–500 person company migrates from its incumbent HR/payroll system, runs one parallel payroll, and the next migration reuses the same machinery.

Scope:

- CSV import first, then the first native connector.
- Switch: connect, map, validate, rehearse, reconcile, promote, with a target module per batch.
- Sandbox tenant and read-only source access.
- Parallel run alongside the incumbent.
- Rollback until the first production payroll is finalised.
- Reusable mapping profiles and reconciliation templates.
- Connectors for Keka and Zoho People; BambooHR next.
- Design-partner cohort 01 (up to 10 companies).
- DPA, subprocessor register and access review completed.

Exit criteria:

- ≥ 99.5% of source rows imported or explicitly parked.
- Headcount, gross, net, leave balances and documents reconcile, or differences have named sign-off.
- The customer's designated owner signs the reconciliation.
- One parallel payroll matches the incumbent within an agreed tolerance.
- Cutover, rollback and export rehearsed with the customer.
- Zero unresolved P1 data issues at cutover.
- A routine migration is completed in under 10 working days; a prepared one in a weekend.
- The second and third customers reuse mapping profiles without engineer intervention.
- No migration requires direct database access.

## M3 — CRM and Work

**Goal:** prove a module can be bought and used alone, and that a second module extends the same client record rather than duplicating it.

Scope:

- CRM: accounts, contacts, leads, pipelines, activities, relationship health, forecast.
- Work: clients, engagements, projects, allocations, timesheets, milestones, deliverables.
- Shared client directory; optional CRM↔Work dependency with graceful degradation.
- Project cost from approved time and payroll.
- Client portal: progress, deliverables, approvals, documents, invoices.
- Cross-module reporting: utilization, realization, project margin.
- CRM import path for accounts, contacts and pipeline.

Exit criteria:

- A CRM-only tenant completes a lead-to-account-to-pipeline cycle without People or Work.
- Enabling Work on that tenant links the existing client rows; no re-import or manual merge.
- A project's margin reconciles to payroll cost and approved time for a full quarter.
- A client can access only its own room and invoices.
- Disabling CRM does not break Work's core project journey; the dependent feature explains why it is unavailable.
- Export includes the full commercial record for the modules the tenant owns.

## M4 — Money, Content and Suite GA

**Goal:** complete the commercial record and prove the suite without forcing every customer to buy it.

Scope:

- Proposals, contracts, invoices, tax lines, payments and expenses.
- CMS, knowledge, digital assets and client document rooms.
- SSO/SCIM, SOC 2 Type II, partner programme and deeper connectors.
- Procurement, assets and analytics only against signed customer demand; they remain catalog entries until then.
- Module attach, standalone retention and entitlement-use reporting.

Exit criteria:

- An invoice can be traced to a signed contract, approved time and a deliverable.
- Invoice-to-payment is live for paying customers; a client sees only its own invoices.
- At least one customer runs four of the five modules on one tenant without a migration between editions.
- A single-module customer can renew without buying a bundle.
- 50+ customers, NRR > 110%, support cost target met.

---

## Sequencing rule

Do not start a module because it is easier to demo. Start it when the platform core and the shared directory have a referenceable customer, and the identifiers it depends on are stable. A suite built on an unstable record is just more integration debt.

The second module must be **CRM**, not another back-office module, because it is the cleanest test of standalone licensing: a CRM buyer has clients but no employees, and must still get a complete product. If CRM cannot stand alone, the modular thesis is not proven and no other module should be sold individually.

---

## Team assumptions

The honest shape for this scope:

| Role | M0–M1 | M2–M3 | M4 |
| --- | --- | --- | --- |
| Product/engineering lead | 1 | 1 | 1 |
| Backend engineer | 1–2 | 2–3 | 3–4 |
| Frontend engineer | 1 | 2 | 2–3 |
| QA/automation | shared | 1 | 1 |
| Payroll/local statutory reviewer | contract | contract | contract |
| Module product owner (CRM/Work) | — | 1 | 1–2 |
| Design | contract | contract | 1 |
| Security reviewer | contract | contract | contract |

A single generalist cannot deliver compliant payroll, a migration console and a standalone CRM on a credible timeline. The fastest path is a small team with a real payroll reviewer, not a larger team without one.

---

## Risks and kill criteria

| Risk | Early signal | Response |
| --- | --- | --- |
| Payroll edge cases overwhelm v1 | Golden cases keep growing without converging | Narrow to one jurisdiction and one pay cycle; hire local payroll expertise |
| Migration takes longer than sales | Every import needs custom code | Stop adding connectors; fix mapping and validation foundations |
| Design partners do not trust a new vendor | Security review stalls | Invest in DPA, pen test and transparency; do not argue |
| Scope expands to ERP parity | Work/Money pulled forward | Return to the one-record wedge and the M2 exit criteria |
| Module sprawl | Every new module adds support, billing and migration load | Only build a module that can pass standalone acceptance and cover its support cost |
| Standalone module is not viable | A module needs another module to complete its core journey | Merge it into the parent module's packaging; do not sell it alone |
| Entitlement complexity leaks into the product | Users see disabled features they cannot understand | Show modules in the workspace with a clear reason; never hide a data-loss consequence |
| Statutory rules change | Rule version drift | Versioned packs with effective dates and local reviewer sign-off |

If after two design partners migration still requires an engineer per customer, the wedge is not working and the connector strategy must change before scaling sales.
