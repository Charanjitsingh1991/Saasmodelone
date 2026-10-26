# Test Strategy

Status: baseline · October 2026
The goal is not coverage theatre. It is confidence that payroll is correct, tenants cannot see each other, migrations do not lose rows, and a finalised record cannot be quietly changed.

---

## 1. Test layers

| Layer | What it proves | Runs |
| --- | --- | --- |
| Unit | Pure payroll and money calculations, date/statutory helpers, mapping transforms | Every commit |
| Contract | Module service contracts and event payloads | Every commit |
| Integration | Real Postgres, RLS, transactions, constraints, outbox | Every commit |
| Entitlement | Module gating, expiry, cancellation, dependency degradation | Every commit |
| Migration fixture | Source sample → staging → reconciliation → promotion → export | Every commit for fixtures; nightly for large fixtures |
| End-to-end | Critical user journeys in a browser | One Playwright journey locally against the built shell, disposable PostgreSQL and an in-process API; declared in CI, never executed there |
| Security regression | Cross-tenant access, role matrix, scope narrowing on reads and writes, export and write authorization | Every commit |
| Restore drill | Logical dump and restore parity (`pnpm drill:restore`) | Executed manually against the local developer database; the target RPO of 15 minutes and RTO of 4 hours recorded in [`architecture.md`](architecture.md) and a monthly schedule are not built |

No mocks for the database in isolation or migration tests. A mocked tenant filter has already passed in systems that later leaked.

---

## 2. Non-negotiable suites

### 2.1 Tenant isolation

For every RLS tenant business table (currently 65; `auth_session` and `invitation` are the two no-RLS identity exceptions and are covered by §2.11 instead):

1. Create tenants A and B with one row each.
2. Set `app.tenant_id = A`.
3. Assert reads return only A.
4. Attempt update/delete of B's row by ID; assert zero rows affected.
5. Attempt insert with B's `tenant_id`; assert RLS rejects it.
6. Repeat through the API, not only SQL.

Also test:

- Missing tenant setting returns no rows, not all rows.
- A pooled connection does not leak tenant context between requests.
- A composite foreign key cannot point at another tenant's parent.
- Search, exports, scheduled reports and background jobs are tenant-scoped.
- The M0 People directory export returns only the session tenant's rows; a `tenant_id` query parameter or `x-tenant-id` header cannot change the result. Direct SQL under the column-level runtime grant returns only A rows with tenant A context, only B rows with tenant B, and none when the tenant setting is unset.

### 2.2 Module entitlements

Entitlements are a security boundary, not a billing detail.

1. Tenant A has People and CRM active; Work is not entitled.
2. Every Work route, API endpoint, search result, export and background job denies Tenant A.
3. A direct SQL call to a Work table under `app.tenant_id = A` is denied by the module policy even if the role would otherwise allow it.
4. Set the Content entitlement to `trialing` with an end date in the past; assert `app.has_module_read('content')` and `app.has_module_write('content')` are false (`app.has_active_module` is the write alias) and every Content request is denied.
5. Set a module to `cancelled`; assert access is denied but records remain in the database and are exportable under the retention rule.
6. Attempt a cross-tenant entitlement update or insert; assert zero rows and an RLS error.
7. Attempt to write the module catalog as the runtime role; assert permission denied.
8. Retire a module in the catalog; assert it cannot be newly entitled but existing entitlements follow the documented migration path.
9. Turn off an optional dependency (for example CRM while Work is active); assert the dependent feature is hidden or degrades with an explanation, and does not read unlicensed data.
10. Repeat through the API and the UI, not only SQL.

For the M0 People directory export: a Work-only tenant receives `MODULE_NOT_ENTITLED`, an employee in a People-entitled tenant receives `ROLE_DENIED`, and neither response contains a CSV header or row. A cancelled People entitlement inside its `read_until` window still exports for a role holding `people.read`.

Test the catalog seed twice: it must be idempotent and must not overwrite reviewed metadata.

### 2.3 Authorization matrix

Implemented in M0 for People and Work, against the real database:

- The policy unit suite asserts the exact permission list and order for all seven roles; owner and admin hold all four; employee is empty; seven role codes with no duplicates; `hasPermission` and `permissionFor` fail closed for an unknown role, permission or module/operation pair.
- A role with the entitlement but without the permission receives `ROLE_DENIED` and the callback never runs: employee on People read/write, HR on Work read/write.
- The entitlement is checked first: a cancelled HR tenant, an owner without Work and an admin without People receive `MODULE_NOT_ENTITLED`, not a role error.
- `/v1/context` returns the role's permissions independently of licensing, and only the effective modules where the database entitlement and the role permission both allow the operation.
- An ungated member transaction still resolves and returns the role; every route that touches module data must pass a gate.

Target matrix per role × scope × action. 0012 put legal entity, org-unit-subtree and employee self-scope in the database and they are tested in §2.16; the per-role behaviour below is still target state, because no route asks for a scope and the `employee` permission set is unchanged:

- Employee: own profile, own payslips, own leave; no salary visibility for others.
- Manager: team leave/timesheets; no bank or statutory identifiers.
- HR: employee records and payroll inputs; no billing or tenant ownership changes.
- Finance: invoices, payments, payroll cost; no salary edits unless explicitly granted.
- Admin: configuration and users; payroll finalise still requires the explicit permission.
- Auditor: read-only audit and records, no mutations.
- Client contact: only their document room, no directory or internal search.

Denied authenticated access must produce one `authorization.denied` audit event, not a generic 500. Unauthenticated requests and non-access failures are not recorded by that path.

### 2.4 Payroll golden cases

Maintain a versioned fixture set for each covered jurisdiction pack, with expected results reviewed by a qualified local advisor. A pack must cover, at minimum:

- Regular earnings, allowances, employer contributions and taxable benefits the pack defines.
- Contribution ceilings, eligibility thresholds and employee/employer splits.
- Income tax or withholding, including declarations, prior-employer income and multiple employers.
- Subnational or local taxes where the pack defines them.
- Statutory leave, service pay, termination or gratuity rules where the pack defines them.
- Leave encashment, loss of pay, half days and arrears.
- Mid-month joining, exit, salary revision and retro pay.
- Reimbursements, loans/advances and recovery.
- Negative net pay guard.
- Rounding at the line and total level.
- Pack-defined statutory report totals and control figures.

Rules:

- Every calculation stores the rule pack versions and input hash.
- A failed golden case blocks release. Expectations are never adjusted to match an implementation without local reviewer sign-off.
- Statutory rates are fixtures with effective dates. No hard-coded constants in application code.
- A new jurisdiction starts with an empty fixture set and cannot ship until its pack passes review.
- Property tests assert invariant totals (gross = sum of earnings; net = gross − deductions; employer cost = gross + employer contributions).

### 2.5 Migration and reconciliation

For each connector and for CSV:

1. Import a fixture with known counts and totals.
2. Every source row is imported or parked with a reason.
3. Headcount, gross, net, leave balances and documents reconcile exactly, or differences are explained and signed off.
4. Duplicate and malformed rows produce stable error codes.
5. Re-running the batch is idempotent.
6. Promotion is transactional: a failure leaves staging intact and production unchanged.
7. Rollback restores the pre-cutover state before the first finalised payroll.
8. Export after migration contains all records and documents.

Test the ugly cases: blank rows, duplicate tax-ID/email, Unicode names, Excel dates, currency symbols and mixed currencies, leading zeros in employee codes, merged cells, missing salary components and split legal entities.

### 2.6 Append-only and audit

- `audit_event` update/delete attempts raise an error for both the owner and the runtime role.
- The runtime role can append an audit row for its own tenant only, and can never read, update or delete the audit trail.
- The audit writer takes the tenant from `app.tenant_id`; an insert for another tenant is rejected by RLS.
- Provisioning and entitlement grant/cancellation append before/after audit rows in the same transaction.
- Every authenticated access denial appends exactly one `authorization.denied` row with the session actor, IP, user agent, reason, registered route template and any known module/operation/permission. The raw query string, role, email, tenant slug, headers, cookies, tokens and bodies are absent. A missing or random session, an unknown error and a successful request append no denial row.
- Denial audit is best-effort: a failing audit write is logged and the original 403 denial is still returned. Privileged business actions remain fail-closed: an audit failure rolls back the action, tested for an employment insert.
- A finalised payroll run cannot be edited; reversal produces new records.
- A successful People directory export appends exactly one `people.directory.exported` row before the first CSV byte, with the session actor, tenant entity, request IP and user agent, and metadata limited to module, format and columns. No CSV is sent when that audit insert fails: the request returns a sanitized 500.
- Role changes, login success/failure, logout, invitation events, imports, payroll events and connector credential changes are target audit events, not yet implemented. Other export paths do not exist.
- Domain events are delivered at least once and consumers are idempotent.

### 2.7 Request layer

The API and worker share one tenant transaction helper, and the same suites prove both surfaces:

- The principal comes only from a valid `saas_session` cookie resolved server-side. Missing, malformed, expired, revoked or tampered cookies fail with 401 before data is read. No header, query string, body or other cookie can supply a tenant; `x-tenant-id` and a `tenant_id` parameter are ignored.
- Request routes resolve an active membership before platform access. A non-member or suspended member receives `MEMBERSHIP_DENIED` even when the tenant is suspended, so tenant state is not disclosed. A member of a suspended, closed or deleted tenant receives `PLATFORM_ACCESS_DENIED`.
- A user with a valid membership in tenant A cannot use that user ID with tenant B.
- The resolved role is passed to the route callback and returned by `/v1/context`. An unknown stored role is a data-integrity error, never a permissive default. A gate checks membership, platform access, module entitlement and role permission in that order; an entitled module with a role lacking the permission returns `ROLE_DENIED` with the permission name and no rows. Scope is not a request-layer check: because the helper sets `app.user_id` on the same connection, the 0012 policies narrow the rows underneath the callback (§2.16), and `tests/scope.test.ts` proves the order is entitlement → role → scope by asserting a role without `people.read` is denied before any scoped row count is taken.
- Tenant and user context are transaction-local. The membership check, platform check, module gate, role check and caller's query run on the same client and in the same transaction.
- Every module route and job declares a read or write gate; an unentitled operation returns a stable denial code and no rows.
- Attempts to override the tenant with `x-tenant-id` or a `tenant_id` parameter return only the principal's records.
- Reusing one pool for sequential tenants and users does not leak `app.tenant_id`, `app.user_id` or the resolved role.
- A denied gate or a failed callback rolls back; a callback error persists nothing.
- Each authenticated access denial appends exactly one `authorization.denied` row. The registered route template is stored, never a query string; metadata contains no role, email, tenant slug, header, cookie, token, body or stack. A denial is still returned when the audit write fails.
- `GET /v1/people/export` is registered in production even when proof routes are disabled. It takes the principal only from the session, applies the People read gate in the member transaction and streams through a server-side cursor. It sends `Cache-Control: no-store`, `X-Content-Type-Options: nosniff` and no `Content-Length`; a gate denial returns the typed code with no CSV; `x-tenant-id` and a `tenant_id` parameter are ignored.

These suites use the real database, the runtime and auth roles, real Argon2 verification and real cookies, not mocks. They sit above the table-level denial suite. Employee self-scope, role administration and seat enforcement have no request path yet: 0012 enforces scope in the database (§2.16), but the `employee` permission set is unchanged, no route reads or writes `membership_scope` and no runtime grant reaches it.

### 2.8 Provisioning, membership and entitlements

- Provisioning is owner-only. It creates the tenant, owner user, owner membership, initial entitlements and audit event in one transaction.
- Input validation rejects empty or malformed names, slugs, regions, emails, module lists and duplicate module codes.
- A duplicate slug returns `TENANT_SLUG_TAKEN` and leaves no second tenant, user or audit row.
- Module rules: unknown codes, non-licensable modules, retired modules and planned modules for public tenants are rejected. An internal tenant can receive a planned module only with an internal-source entitlement.
- An existing invited or active user is reused without changing its status or display name; a disabled or suspended user cannot become an owner.
- A failed provisioning attempt rolls back the whole transaction, including the tenant row.
- Provisioning succeeds while `tenant` has `FORCE ROW LEVEL SECURITY`, proving that `app.tenant_id` is set before the tenant insert. The test resets FORCE in a `finally` block; no migration enables it.
- The membership matrix covers owner, admin and employee roles; no membership; suspended membership; cross-tenant user; unset tenant or user; and a member of a suspended, closed or deleted tenant.
- The runtime role cannot read or write `membership`, cannot read or write `tenant` (including `is_internal`), and cannot read `app_user`.
- Entitlement grant, cancellation, reactivation and retention extension are tested with before/after audit snapshots. Contract references never enter audit rows; cancellation reasons appear only in audit metadata.
- Entitlement errors are stable: missing tenant, ineligible actor, invalid dates, missing entitlement, unknown module, non-licensable module and unavailable module.

### 2.9 Export and portability

Target behaviour, not built:

- A full export includes every entitled module, document metadata and file objects.
- A per-module export includes exactly that module plus the shared directory records it needs, and nothing from an unentitled module.
- A cancelled module's records can still be exported for the contracted retention window.
- Re-importing the export into a clean tenant reproduces the same control totals.
- An export cannot include data from another tenant.
- Expired signed URLs fail.

Implemented in M0: `GET /v1/people/export` streams a seven-field People directory CSV for the session tenant, gated by `people.read`, with a column-level runtime grant and a pre-disclosure audit event. It has no filters, column selection, date ranges or other query parameters; no client or Work data; no employment, salary, tax-identifier, bank or personal-contact fields; no stored artifact, background job, signed URL or export history; no re-import; no dedicated export permission; and no export rate limit. It is a scoped directory export, not a complete data export or portability feature.

### 2.10 Standalone module acceptance

Every licensable module must pass the same test before it is sold alone:

1. A fresh tenant is provisioned with only that module.
2. The tenant can create its core records without a second module: clients for CRM/Work/Money, people for People/Work, documents for Content.
3. The module's primary journey completes without a feature that belongs to an unlicensed module.
4. The shared directory is populated and visible to the licensed module; no duplicate client or person table is created.
5. Adding a second module on the same tenant links the existing records; no re-import or manual merge is required.
6. The per-module export is complete and re-importable.

If a module cannot pass this, it is a feature of another module and must not be priced alone.

### 2.11 Authentication, sessions and invitations

Covered by `tests/authentication.test.ts` against disposable PostgreSQL with the real auth role, real Argon2 hashing and real cookies:

- Hash/verify roundtrip; wrong password and malformed hash return false without throwing; password boundaries at 11, 12, 128 and 129 characters; no trimming.
- Argon2id parameters and hash prefix; no plaintext password stored.
- Session tokens are random, returned once and stored only as a SHA-256 hash. CSRF tokens are independent.
- Cookie attributes: `HttpOnly`, `SameSite=Strict`, `Path=/`, 12-hour `Max-Age`, and `Secure` when configured.
- Login success updates `last_login_at` and creates one session. Wrong password, unknown email, non-member, suspended membership, invited, disabled user, suspended user, wrong tenant and deleted tenant all return the same 401 with no session.
- A session for tenant A cannot read tenant B; `x-tenant-id` is ignored.
- Invitation creation hashes the token, expires by default in 7 days, and a newer invitation revokes the older one. Acceptance activates the user and membership exactly once; reuse, expiry, revocation, an unknown token, a weak password, a suspended or disabled user and a deleted tenant fail without changes. An active user invited to a second tenant accepts with its existing password, which is unchanged, and can then sign in to both tenants; a wrong password leaves the membership invited and creates no session. An active user with no password cannot be invited.
- Expired, revoked, tampered and disabled-user sessions fail with 401. A suspended membership fails with 403 `MEMBERSHIP_DENIED`; a suspended tenant fails with 403 `PLATFORM_ACCESS_DENIED`. A suspended tenant can still authenticate, and is denied on the protected route.
- Logout without or with a wrong CSRF token returns 403 and leaves the session valid; the correct token returns 204, clears the cookie and revokes only that session.
- State-changing requests without an exact Origin return 403. Malformed JSON and schema violations return 400; an unsupported content type returns 415; an oversized body returns 413.
- Rate limits are enforced per bucket (`2` → third login for the same email, or second invitation acceptance from the same address, returns 429); a per-address login limit also trips across different emails from one address.
- Every `/v1/auth/*` response, including 401 errors and the 204 logout, carries `Cache-Control: no-store`.
- No response contains a password hash, a raw session token or SQL text.
- The auth-role privilege matrix is asserted in `tests/harness.test.ts`: identity column grants only, membership status reachable only through `app.auth_membership_status` (no direct `membership` grant and no `app.current_tenant_id()` execute), no access to business data, catalog, entitlements or audit, no DDL or `TRUNCATE`; the runtime role cannot read or write `auth_session` or `invitation`.

Not covered yet by this API suite: the browser journey covers sign-in and sign-out, but there is no invitation-acceptance, password-reset or session-management screen. Email delivery, password reset, MFA, OAuth, session rotation, device lists, distributed rate limiting and authentication-event audit remain unbuilt; §2.13 covers the browser shell itself.

### 2.12 People directory export (M0)

`tests/csv.test.ts`, `tests/csv-stream.test.ts` and `tests/people-export.test.ts` cover:

- The CSV helper: exact header, null and empty values, commas, quotes, LF and CRLF newlines, Unicode, all six formula-leading characters (`=`, `+`, `-`, `@`, tab, CR), prefixing only at the start of a field, doubled quotes and CRLF records.
- The streaming writer: immediate write, waiting for `drain`, and rejection when the response is closed, destroyed or errored.
- A successful export with `exportBatchSize: 2`: 200, exact headers and exact ordered body for multiple people across multiple `FETCH` batches, with comma, quote, newline and formula-like values; no BOM and no `Content-Length`.
- Tenant isolation: tenant B's person and a soft-deleted person never appear; `?tenant_id=B` and `x-tenant-id: B` are ignored; direct SQL under the column-level runtime grant returns only A rows under tenant A, only B rows under tenant B, and none with the tenant setting unset.
- Denials: employee `ROLE_DENIED`, Work-only tenant `MODULE_NOT_ENTITLED`, and unauthenticated 401; none carries a CSV header or row, and a denial writes no export audit event.
- A cancelled People entitlement inside `read_until` with the HR role returns 200.
- Forbidden fields: a person carrying `personal_email`, `date_of_birth`, `gender`, `designation`, `status`, `employment_type` and `legal_entity_id` exports only the seven identity fields, and none of those values appears in the CSV.
- Audit: exactly one `people.directory.exported` row per success, with actor, IP, user agent and metadata limited to `{ module, format, columns }`; no query string, header, cookie, token, tenant slug, role, email address or person data. Revoking runtime `INSERT` on `audit_event` produces a sanitized 500 with no CSV and no additional audit row.
- Runtime privileges: `has_table_privilege` for `SELECT` on `person` is false and `select * from person` raises `42501`; a `has_column_privilege` sweep over every column in `information_schema.columns` returns true for exactly ten — the seven exported identity fields plus `id`, `deleted_at` and the two placement ids §2.20 added — and false for `tenant_id`, `personal_email`, date of birth, gender, status, designation, employment type, `location_id`, `manager_person_id`, both timestamps and the four import columns. The export itself still emits seven columns: a legal entity name appears on the directory screen, never in the CSV.
- The route works with proof routes disabled, and invalid `exportBatchSize` values are rejected.

### 2.13 Web shell and browser journey (M0)

`apps/web/test` contains pure unit tests for the client logic:

- Module ordering by catalog `sortOrder` then `code`, without mutating the input; navigation filtering by `canRead || canWrite`; People gating on `canRead`; read/write badge labels; role labels with a safe fallback; the module names listed in the People access state.
- Login error mapping: the exact generic `401` message, a distinct `429` message, a retryable network state and a non-generic unknown state.
- The History API router: `/login`, `/app`, `/app/people`, trailing slashes, unknown paths that must not become module screens, and document titles.

`tests/e2e/people.spec.ts` is one Playwright/Chromium journey against `pnpm build:web` output served by Vite preview on `http://localhost:3000`, with an in-process API on `127.0.0.1:3001` and a disposable database created by `packages/testkit`. It uses real HTTP, real session cookies and real Argon2 hashes; fetch, the session and the database are not mocked. It covers:

- An anonymous request to `/app/people` redirects to `/login`.
- An invalid password returns exactly `Email, password or workspace is incorrect.`
- A successful People owner sign-in reaches the directory, shows `Read and write` and `4 people` in the live region, and the navigation contains People with `aria-current="page"` but not Work.
- The `People directory` table renders all four active persons, including `Ada, "Countess"` with cell `EXP-001`, and the soft-deleted person appears nowhere. `Page 1 of 1` shows with Previous and Next both disabled.
- Searching `Grace` narrows the live region to `1 person` and the table to one row; clearing the search restores four rows, and the term never reaches the URL.
- Local storage and session storage remain empty of credentials and session state; the URL contains no token.
- The light and dark layouts have no horizontal overflow at 390, 768 and 1440 px — measured on the sign-in page, again with the Add-person form open, again with the Place panel open, again after the placement leg, and again in both themes after the writes and the reload.
- The theme toggle survives a reload and is the only persisted key, and after the reload the directory still reports the five persons the journey wrote, including `Nadia Kaur`.
- Sign-out returns to `/login` and removes the session cookie.
- A keyboard-only sign-in reaches a Work-only workspace, shows Work but not People, and opening `/app/people` shows the access state with no directory table, search box, result count or write control in the DOM.

The write leg (§2.19) runs in the same journey, after the search cycle and before the placement leg: Add person opens the `Add a person` form with its six fields and the note `A new person is added unplaced. Only a workspace-wide owner, admin or HR can add people; use Place afterwards.`; submitting Nadia Kaur with code `E2E-001`, an email and a phone announces `Person created.` in the `aria-live` status region, closes the form, moves the count to `5 people` and puts the row and its cells in the table. Edit on that row opens `Edit this person` pre-filled with the stored values and the note `These are the identity fields only. Use Place to change the legal entity or org unit.`; changing the phone announces `Person updated.` and shows the new value. Attempting to give a second person the code `E2E-001` shows `That employee code already belongs to someone in this workspace.`, leaves the count at 5, and Cancel closes the panel. Searching `Nadia` then returns one row and clearing returns five.

The placement leg (§2.20) runs in the same journey, after the write leg's search cycle and before the storage checks. The directory table now carries a `Placement` column, and the newly created Nadia row shows `—` in it. `Place Nadia Kaur` opens the panel, whose heading repeats the person's name and whose single `#people-placement` select offers exactly `Unplaced`, `Legal a` and `E2E placement unit` — the last two grouped under a `Legal a` optgroup — because those choices came from `GET /v1/people/placement-options` and the fixture's one org unit was written owner-side; Save is disabled until they arrive. The fine print states that a placement is not an employment record. Choosing the unit and saving announces `Placement updated.`, closes the panel and rewrites the cell as `Legal a · E2E placement unit`. A reload reproduces that cell from the database rather than from component state. Reopening the panel starts on the stored unit with Save disabled again, and choosing `Unplaced` returns the cell to `—`.

The journey is one test, not a full regression suite. It does not cover the distinct `429` sign-in message (covered only by the login-mapping unit tests), the post-sign-in `401` that clears in-memory state (no test; code inspection only), the `PERSON_EMAIL_TAKEN`, `SCOPE_DENIED`, `ROLE_DENIED`, `PLACEMENT_NOT_FOUND` or network-failure copy in either panel (the API paths are proven in §2.19 and §2.20, the browser strings are not), an edit or placement conflict between two members, a scoped member's shorter options list in the browser (proven at the route in §2.20, not in Chromium), invitation acceptance, password reset, session expiry while a request is in flight, export UI (none exists), other module screens (none exist), real proxy/edge deployment, CSP or assistive-technology testing. The screen's own logic is not unit-tested either: `apps/web/test` still covers only the pure module/role/error mapping and routing listed above, not the write panel's or the placement panel's open, prefill, submit or announcement behaviour, which the browser journey is the only proof of.

### 2.14 Backup and restore drill (M0)

`pnpm drill:restore` (`scripts/restore-drill.ts`) is run manually against the local developer database and needs the PostgreSQL 17 client binaries (default `D:/tools/pg17/pgsql/bin`, overridable with `PG_BIN_DIR`). It takes a `pg_dump --format=custom` backup into the gitignored `var/backups` with a timestamped filename, records the dump's byte size and SHA-256, creates a throwaway `saasmodels_drill_<timestamp>` database, restores the dump into it with `pg_restore`, and compares source and restored on: public base-table count; row counts of the load-bearing tenant, identity, membership, entitlement, catalog, directory, employment, project, session, invitation, audit and event tables; RLS-enabled table and policy counts; the exact runtime table-grant and person-column-grant inventory that `tests/schema-inventory.test.ts` asserts; and a runtime-role query under a set `app.tenant_id` that must return the same counts on both sides. Any mismatch fails loudly; the drill database is always dropped and the source database is never a restore target — the script refuses to run if the target would equal the source name. `tests/restore-drill.test.ts` exercises the comparison logic against a real disposable database: two collections of the same database report no differences, and inserting one tenant row makes the check fail with the exact divergent count, without re-running pg_dump.

What the drill proves: one logical dump of the current schema and synthetic data restores with full parity on the local PostgreSQL 17.9 developer database. What it does not prove: WAL archiving, point-in-time recovery, encryption at rest or in transit, retained or offsite copies, any schedule or RPO/RTO, and anything on PostgreSQL 16 or in CI. It is not part of `pnpm test` or the CI workflow.

### 2.15 Outbox claim and worker delivery (M0)

`tests/outbox.test.ts` (13 tests) runs the 0011 helpers and the `apps/worker` loop against one real disposable database with the real `saas_worker` role, created by `packages/testkit` from `TEST_DB_WORKER_URL`; events are inserted as `saas_owner` because no producer exists yet, and the queue is drained between tests so per-tenant claim counts stay exact. It covers:

- `app.outbox_claim` refuses when `app.tenant_id` is unset or not a valid UUID, and rejects out-of-range batch, lease and attempt arguments.
- `saas_worker` cannot `SELECT`, `INSERT`, `UPDATE` or `DELETE` `domain_event` directly (each rejected with `42501`).
- `mark_published` and `record_failure` raise "not in this tenant" for a foreign event id under both tenant GUCs, the rolled-back transactions leave both rows untouched, and the following sweeps publish them.
- An expired lease is re-claimable by a second worker (`attempts` 2) while the lost lease's mark is refused (`false`) and its failure record is refused (`refused`); the live lease publishes once.
- Tenant A's pass claims exactly its own event, never observes tenant B's, and leaves B's row `pending` with `attempts` 0.
- A handler that always throws is retried with backoff, reaches `dead` at `maxAttempts`, and is not claimed again; a failed attempt is not claimable before `next_attempt_at`, is left unowned (`lease_owner` and `lease_expires_at` both null), and is claimed and published once the owner moves it due.
- Duplicate delivery through an idempotent handler produces one net effect; a handler slower than its lease delivers twice but publishes once, with exactly one `refused` mark.
- An unentitled tenant's pass returns `skipped: 'entitlement_denied'` and touches nothing while the entitled gate publishes the same event; a suspended tenant returns `platform_denied` and runs no handler.
- `startOutboxWorker` polls on its interval, publishes the pending event, and stops cleanly (`stop()` halts delivery and `attempts` stays 1); malformed `workerId`, `batchSize` and `pollIntervalMs` are rejected before any query runs.

`tests/worker.test.ts` keeps covering `runTenantJob` (tenant-scoped job, unentitled and suspended denial, rollback). `tests/harness.test.ts` adds the `saas_worker` identity matrix, the "no table privileges anywhere, helpers only" assertion and the refusal of catalog writes, DDL, `TRUNCATE` and self-granting. `tests/schema-inventory.test.ts` asserts the worker's exact privilege inventory: zero rows in `information_schema.role_table_grants` and `column_privileges`, and precisely the four outbox helpers plus `current_tenant_id`, `has_platform_access`, `has_module_read`, `has_module_write` as the only executable `app` functions, with the four helpers `prosecdef`.

What this does not prove: no production producer emits events, so end-to-end delivery from a real state change to a real consumer is untested; the loop is not run under concurrency or across multiple worker processes; there is no queue-depth, latency or throughput measurement; no webhook or notification consumer exists.

### 2.16 People scope (M1, database half)

`tests/scope.test.ts` (21 tests) is the first M1 suite. It builds its own fixtures as `saas_owner` in disposable databases — three tenants (two People-entitled, one not), four legal entities (two in the scoped tenant), an org-unit tree `parent → mid → leaf` plus a `sibling`, eleven people (ten with employments), one person linked to a user, and memberships for a tenant-wide manager, an entity-scoped manager, a mid-unit manager, a root-unit manager, a linked employee, an unlinked employee, a suspended member and a non-member — then reads through the runtime role with both GUCs set, exactly as a request path does. It asserts, in four groups:

- **Schema and privileges.** `person.user_id` is nullable, FK'd `ON DELETE SET NULL` and has a partial unique index on `(tenant_id, user_id)`; a duplicate link raises `23505`. `membership_scope` is tenant-isolated with the three composite foreign keys, the exactly-one-typed-column CHECK (`23514` for both-null, both-set and an unknown `scope_type`), the `NULLS NOT DISTINCT` unique (`23505` on a repeat) and its lookup indexes, including the partial ones. `membership` gained the `unique (tenant_id, id)` its child key needs. The eight `scope_*` policies exist as restrictive, on the right commands, with the right `USING`/`WITH CHECK` expressions, and every M0 policy is still there. Each helper is owner-owned with `search_path = ''`; the five public ones are `EXECUTE` for `saas_runtime` and the four internals are refused; `saas_worker` keeps zero table privileges, zero column privileges and exactly its eight functions. `saas_runtime` has no privilege at all on `membership_scope` and cannot read `person.user_id`.
- **The scope invariant, derived from the catalogue.** Every runtime-readable table with a `person_id` column must carry a restrictive read policy calling `app.person_visible(person_id)`. The table set is queried, not hardcoded — today it is exactly `employment` — so a new person-child table without a policy fails rather than reading the whole tenant.
- **Read semantics.** A tenant-wide manager with no scope rows still sees everything, which is the M0 regression guard. An entity-scoped manager sees only that entity. An org-unit manager sees the unit and its descendants and not the sibling, and widening the scope to the root widens to the whole subtree. An unplaced person is visible only to a tenant-wide member. An employee sees exactly the one linked row, and a `legal_entity` scope row attached to that employee membership does not widen it. A suspended or absent membership sees nothing, in any tenant, and scope rows never cross tenants. A tenant-only system context is not narrowed — the documented fail-open, pinned here, including that an unentitled tenant can read `person` through that path but not `employment`.
- **Write semantics and the gate path.** A scoped manager updates and deletes in-scope employment rows and gets zero rows out of scope; an out-of-scope employment insert fails `42501` on the RLS policy, with the error naming `employment` rather than a privilege. An employee cannot write even its own person row. Since §2.19 the runtime role holds column-level `INSERT` and `UPDATE` on the person identity columns and, since §2.20, `UPDATE` on both placement columns too, so this suite drives real `person` writes through the policies: an out-of-scope insert fails `42501` naming `scope_insert`; a tenant-wide member inserts an explicitly identified person and reads it back in the same transaction — no `RETURNING`, because the restrictive `scope_read` policy cannot see a row its own command created (ADR 0008); that same member moves a person between entities and units and the row reads back with the new pair; an entity-scoped member's move inside the entity writes, and the identical statement aimed at another entity fails `42501` naming `scope_update`. The distinction this test pins is that the grant now covers the column and the policy decides the row, so a placement refusal is always an RLS message, never `permission denied for column`. An org-unit-scoped member can move a person within its subtree but not onto the bare legal entity — a null unit never matches an `org_unit` scope row — and that too fails `42501` naming `scope_update`, while `app.person_placement_in_scope` answers false for the same pair. Through `withMemberTransaction`, entitlement and role are decided first: a role without `people.read` is refused with `ROLE_DENIED` before the scoped row set is read, a non-member with `MEMBERSHIP_DENIED`, and an entitled manager's callback receives exactly the scoped ids.

What this does not prove: no application path writes `membership_scope` or `person.user_id` — the authoring path is the owner-only library and CLI in §2.17, so scope remains unwritable through the API and the web shell; that gap is why §2.18 was needed to show the policies actually narrowing a route's reads from the request layer, which this suite proves at the database boundary only; project and client scope do not exist; the fail-open system context stays open by design and is closed only by route discipline; `person` deletes remain unpinned by execution because the runtime role has no `DELETE` grant on the table and none is planned while no member-facing delete exists; and no payroll, leave or timesheet surface consumes scope yet.

### 2.17 Scope administration (M1, owner-only authoring path)

`tests/scope-admin.test.ts` (27 tests) covers `packages/db/src/scope.ts` — `linkPersonUser`, `unlinkPersonUser`, `setMembershipScope` and `getMembershipScope` — against one real disposable database through the owner connection, and then re-reads the effect of each write through the runtime role with both GUCs set, which is how a real request path would see it. Its fixtures are four tenants plus a deleted one: a linking tenant with owner/admin/manager/employee memberships, a suspended membership, a suspended user, a cross-tenant outsider, two persons and a soft-deleted person; a second tenant holding a person and a legal entity used only for cross-tenant refusals; a dedicated narrowing tenant with five persons placed across two legal entities and three org units so a manager's visible row set moves measurably; and a deleted tenant. It asserts, in five groups:

- **Linking.** A link writes `person.user_id` and one `person.user.linked` row whose before/after is `{ user_id }` only, and the linked employee then reads exactly its own row through runtime RLS. The same pair again returns `changed: false` with no second audit row. Relinking an already-linked person to another user refuses `PERSON_ALREADY_LINKED`, and linking a user who already holds another person in the tenant refuses `USER_ALREADY_LINKED` — including through the `NULLS NOT DISTINCT` unique index, caught as `23505` and mapped — with nothing written either way. A soft-deleted person, a cross-tenant person, an absent user, a membership that is not active, a suspended user and a deleted tenant each refuse with their own code.
- **Actor checks.** An `admin`, `manager`, `employee`, a suspended owner, an owner whose user is suspended and a non-member are all refused with `ACTOR_NOT_OWNER`, on both the link and the scope path, and the refusal writes nothing.
- **Unlinking.** An unlink nulls the column and appends `person.user.unlinked` with the previous `user_id` in `before_state`; already unlinked is `changed: false` with no audit row.
- **Scope replacement.** A full replacement commits in one transaction and appends `membership.scope.changed` with `before_state`/`after_state` as sorted `{ scope_type, id }` arrays carrying no name or email; the same set in another order is `changed: false` with no row; an explicit tenant-wide clear empties the rows and restores the tenant-wide read. Refusals: `SCOPE_DUPLICATE`, `SCOPE_LIST_EMPTY` without `tenantWide`, `TENANT_WIDE_WITH_SCOPES`, `SCOPE_TARGET_NOT_FOUND` for an unknown, cross-tenant or soft-deleted legal entity or org unit, `MEMBERSHIP_NOT_FOUND` for a membership in another tenant, `MEMBERSHIP_NOT_ACTIVE`, and `MEMBERSHIP_IS_EMPLOYEE` because a scope row can never widen self-scope and would only be dead data. `getMembershipScope` returns the role, the membership status and each row with its label (legal-entity code and name, or org-unit name) and refuses a cross-tenant membership or a deleted tenant.
- **Narrowing and rollback.** After an entity scope, the manager's runtime reads over `person` and `employment` drop to the two placed in that entity; after an org-unit scope they become that subtree and exclude another tree and the unplaced person; after the tenant-wide clear all five return. Two tests force a real audit failure — they redirect the `insert into audit_event` statement to a row whose `tenant_id` does not exist, so PostgreSQL raises the genuine `23503` — and assert that neither the link nor the delete/insert survived and that no audit row of any kind was left behind.
- **Grant surface.** `membership_scope` is still `42501` for `saas_runtime` and for `saas_worker`, `person.user_id` is still unreadable by the runtime role, and the whole surface is unchanged by this slice: 12 runtime table grants, exactly the 12 reviewed executable `app` functions, and zero table and column privileges for the worker. (The table-grant and function counts above are not the person column list, which is pinned by `tests/schema-inventory.test.ts` and has moved twice since: §2.19 expanded it from eight to 22 privileges — 8 `SELECT`, 8 `INSERT`, 6 `UPDATE` — and §2.20 to 26 — 10 `SELECT`, 8 `INSERT`, 8 `UPDATE`.)

The suite exercises the library, not the CLI: `pnpm db:scope` argument parsing and its email/slug/code resolution were run manually against a disposable database and against the local developer database, and are not covered by a CI test. No test asserts that a valid grant was the *intended* grant — there is no approval, dry run or grant-review surface, which is the T37 residual in [`security/m0-threat-model.md`](security/m0-threat-model.md).

`tests/migration-rollforward.test.ts` — the T15 suite that applies 0011 into a truncated migration directory, populates rows and then upgrades to the full set — is extended rather than replaced: it now also proves that pre-upgrade persons arrive unlinked, that `membership_scope` is created empty, that a pre-upgrade person is still readable by a tenant-wide member and by a system context, and that the helpers and all eight policies land on the upgraded database. `tests/schema-inventory.test.ts` re-derives the counts (67 tables with `tenant_id`, 65 RLS, 274 policies split 66 permissive isolation / 208 restrictive, one isolation policy per RLS table, the eight `scope_*` names) and adds the nine new helpers to the list the worker is denied.

### 2.18 People directory read path (M1)

`tests/people.test.ts` (14 tests) is the first suite over a route narrowed by the 0012 scope policies. It builds one disposable database with the real migrations and seed, the real `saas_runtime` and `saas_auth` pools, the shared `createAccessFixtures` tenants and real session rows created through `createSessionFixture`, and drives the route through `app.inject` with proof routes disabled — so nothing here goes through a mock, a stubbed RLS layer or a hand-set GUC. Its tests, in order:

- `rejects requests without a valid session` — no cookie and an unknown token each return 401 `UNAUTHENTICATED`, `no-store`, and no directory value, so an anonymous request is never a 403.
- `returns the tenant-wide owner page with only the granted columns` — 200, exactly the four `PeopleListResponse` keys, a `typeof`-checked JSON-number `total` of 4, and every item carrying exactly the eleven `PeopleListItem` keys — the seven identity fields, the two placement ids and the two names the route joins. Since §2.20 the item is a joined record, so the test asserts the pairing rule rather than an absence: a null `legalEntityId` must come with a null `legalEntityName`, and every fixture row in this view has a null org-unit pair. `EXP-001` matches its full expected object — the quoted display name, the `+1 555 0100` phone, its tenant's legal entity id with that entity's name read separately on the owner connection, and null for both org-unit fields; the soft-deleted person's id, name and code, the fixture personal emails, date of birth and gender values, and the field names and camel-case spellings of `tenant_id`, `user_id`, `personal_email`, `date_of_birth`, `gender`, `designation` and `employment_type` appear nowhere in the body.
- `never discloses another tenant directory rows` — a People-and-Work tenant holding one person of its own receives exactly that row, with the whole tenant-A id set and `EXP-001` absent from the body.
- `denies a permissionless employee with one ROLE_DENIED audit row` and `denies an unentitled tenant with one MODULE_NOT_ENTITLED audit row` — 403 with the typed body, `no-store`, no directory value, and exactly one new `authorization.denied` row whose metadata carries reason, `GET`, the registered route template `/v1/people`, module, operation and (for the role denial) permission.
- `reads inside read_until after the entitlement is cancelled` and `denies a cancelled entitlement once read_until has passed` — the retention pair for a cancelled People entitlement: 200 while `read_until` is in the future, and after moving `read_until` an hour into the past the same session gets 403 plus one denial row, with the fixture restored in a `finally` and the 200 re-asserted.
- `narrows a scoped manager through the route while the owner stays tenant-wide` — the regression this slice exists for. A second active user with a `manager` membership is created in tenant A and scoped to `a.legalEntityId` through the owner-only `setMembershipScope`, which reports `{ changed: true }`; through the route that manager receives exactly `EXP-001` with `total` 1, with the other three person ids absent from the body, and searching for the out-of-scope `Person a` returns `total` 0 — while the owner in the same run still receives all four. No scope predicate appears in the route, so this is the request-layer proof that `withMemberTransaction` sets `app.user_id`.
- `matches name, code and work email literally and case-insensitively` — `CouNtEsS`, `exp-003` and `EXPORT_GRACE` each match exactly one expected person; a decoded `q` of `%`, and one of `EXP%001`, return an empty page with `total` 0, so a percent sign is search text rather than a wildcard; an empty and a three-space `q` both return all four; a non-matching term returns no items and `total` 0.
- `pages deterministically and reports the true total past the end` — `pageSize=2` yields two, then two, then an empty third page, with `total` 4 and the requested `page`/`pageSize` echoed throughout, the four ids unique across the first two pages, and `page=999999` a 200 with an empty `items` array rather than an error.
- `rejects malformed paging and search parameters with 400` — ten queries (`page=0`, `page=abc`, `page=1.5`, a repeated `page`, `pageSize=0`, `pageSize=51`, `pageSize=abc`, a repeated `pageSize`, a 101-character `q` and a repeated `q`) each return 400 `INVALID_QUERY` with `no-store` and no directory value, while a 100-character `q` is accepted and simply matches nothing.
- `marks every directory response uncacheable` — `cache-control: no-store` on a 200 and on a 403; the 401, the denial and the `400` paths assert the same header inside their own tests.
- `writes no audit row for a successful directory read` — three successful reads (unfiltered, `?q=countess` and `?page=2&pageSize=2`) leave the tenant's audit-event count exactly where it started, so a directory read is not silently logged as an export.
- `leaves the export route and unknown subpaths unchanged` — `/v1/people/export` still answers `text/csv; charset=utf-8` with `no-store` and its rows, and `/v1/people/unknown` is still a 404.

The screen side is covered by the browser journey in §2.13 (render, search, clear, live count, paging controls and the access-state branch) rather than by new client unit tests; `apps/web/test` still covers only the pure module/role/error mapping and routing logic.

What this does not prove: nothing here writes — the write routes, their scope refusals and their audit rows are §2.19, and the read suite would not notice a route that could read a row it could not write; no test asserts a *scope label*, because none exists and `/v1/context` reports no scope; the search is proven against the seeded fixture names, not against a full payload matrix (§2.13, T23); a page-size and page ceiling is proven for the values above, not for concurrent modification between the count and the page query; and the route's behaviour under load, caching proxies or a real edge is untested because no deployment exists.

### 2.19 People directory write path (M1)

`tests/people-write.test.ts` (18 tests) is the first suite over a route that changes stored data. It reuses the shape of §2.18 — one disposable database from the real migrations and seed, the real `saas_runtime` and `saas_auth` pools, `createAccessFixtures`, real sessions through `createSessionFixture`, proof routes disabled, requests through `app.inject` — and adds what a write needs: an `hr` membership scoped to one legal entity (`hrScoped`), a tenant-wide `admin`, and a read-back helper on the **owner** connection, because `status`, `user_id`, `deleted_at`, `personal_email`, `date_of_birth`, `gender`, `designation` and `updated_at` are columns the runtime role cannot read at all, so only the owner connection can prove what the database stored across the whole row. Its tests, in order:

- `rejects both routes without a valid session` — 401 `UNAUTHENTICATED` on `POST /v1/people` and on `PATCH /v1/people/:id`, `no-store`, no row written.
- `refuses a cross-origin write before any session or database work` — the `onRequest` origin hook answers 403 `ORIGIN_DENIED` for another origin even with a valid cookie and CSRF token, so the hook ordering is proven rather than assumed.
- `refuses a missing or wrong CSRF token on both routes with no write` — 403 `CSRF_INVALID` when the header is absent and when it is wrong, on create and on update, with the person count and the write-audit count unmoved: a stolen cookie in a cross-site form changes nothing.
- `creates a full record, stores the directory defaults and audits field names` — 201 with exactly the eleven `PeopleListItem` keys and an id matching the UUID shape, and with all four placement fields null because a create writes identity only and the person `INSERT` grant names no placement column; the owner read-back shows `tenant_id` from the session, `status = 'active'`, both placement columns null, `user_id` null, not deleted, and both timestamps set; one new `person.created` row whose `entity_type` is `person`, `entity_id` is the generated id, actor is the session user, `before_state`/`after_state` are null and metadata is `{ module: 'people', fields }` with the six names sorted — and the test then serialises that metadata and asserts none of the submitted values appear in it.
- `derives the display name, trims values and treats a blank field as absent` — a one-field create stores `firstName` with the other five columns NULL and the derived `displayName` equal to the single name; a create padded on every side is stored trimmed; and a whitespace-only display name, a whitespace-only code, an empty work email and a padded phone come back as `Ada Lovelace`, NULL, NULL and `+1 555 0122`, so a blank never becomes stored empty text and a blank display name is always derived.
- `refuses a duplicate employee code or work email on create and update with a typed 409` — both collisions on both routes: `PERSON_CODE_TAKEN` and `PERSON_EMAIL_TAKEN` with `no-store` on the refusal, the submitted value absent from the body, the upper-cased address caught by the same `citext` unique as the stored lower-case one, the pre-existing row's code and email unchanged on the owner read-back, the person count unmoved and no audit row written.
- `rejects malformed create and update bodies with INVALID_BODY and no write` — 31 create bodies and 17 update bodies, each 400 `INVALID_BODY` with `no-store` and the tenant's legal-entity id absent from the response: no body at all, `null`, a JSON string, a number, a boolean, an array and an array of objects, an empty object, a missing, empty, whitespace-only, null or non-string first name, an over-length first name, display name, employee code, phone or work email, five malformed emails (`no-at-sign`, `two@@at.example.test`, `spaces in@example.test`, `local@nodotdomain`, `a@b.`), two at-limit names whose derived display name would overflow the display limit, and every key the product has not opened — `status`, `id`, `legalEntityId`, `orgUnitId`, `userId`, `deletedAt`, `personalEmail`, `dateOfBirth`. Values at exactly each contract limit are accepted instead, and the test proves the whole matrix wrote nothing: the person count moves by the one accepted at-limit create and the owner read-back of that row still holds its own submitted values with status active, both placement columns null, `user_id` null and `deleted_at` null after all the rejected patches.
- `updates identity fields, advances updated_at and audits only what changed` — 200 with the new values, `updated_at` strictly later, `created_at` unchanged, no unlisted column touched, and one `person.updated` row whose `changedFields` lists exactly the fields that differ — `['displayName', 'lastName', 'phone']` when the first name and code are resent unchanged — so resubmitting a value does not claim a change, and whose serialised metadata contains none of the new values.
- `answers a no-change update with the stored row and no audit row` — resending every current value returns 200 with the item byte-equal to the create response, leaves `updated_at` exactly where it was and adds no audit event, so a browser that re-submits a form does not fabricate history.
- `treats an absent key as unchanged and a null or blank key as cleared` — a patch carrying only `firstName` leaves the last name, code, work email, phone and the already-stored display name verbatim; a patch with `lastName: ''`, `displayName: null`, `employeeCode: '   '` and `phone: null` clears all of them and re-derives the display name from what remains, which the owner read-back confirms column by column; and the resulting `person.updated` metadata is exactly `{ module: 'people', changedFields: ['displayName', 'employeeCode', 'lastName', 'phone'] }`. Null, blank and omitted are therefore three distinct, well-defined operations, and clearing a code is the only way the product can remove one while no delete route exists.
- `answers 404 for unknown, malformed, cross-tenant and soft-deleted ids` — for a member who does hold `people.write`, a syntactically valid but unknown UUID, the string `not-a-uuid`, a person inserted into tenant B by the owner, and the seeded soft-deleted person each return the same indistinguishable `404 PERSON_NOT_FOUND` with `no-store`, and after all four the tenant-A target row still holds its old phone and `updated_at` with the tenant's audit count unchanged: the response never tells a member whether a person exists somewhere they cannot reach. A caller the gate already refused never reaches this answer (the `ROLE_DENIED` and `MODULE_NOT_ENTITLED` tests each send `not-a-uuid`).
- `lets a scoped member edit in scope, and answers 404 or 403 outside it` — the request-layer proof that `scope_update` and `scope_insert` are real: an `hr` member scoped to one legal entity updates a phone on a person placed in that entity (200), gets `404 PERSON_NOT_FOUND` for a person in the same tenant outside that entity with the owner read-back showing the row and `updated_at` untouched, and is refused `403 SCOPE_DENIED` for a create — which always starts unplaced — with the person count unmoved. The audit count grows by exactly one, for the in-scope update: the 404 and the 403 write no row.
- `lets a tenant-wide admin create where the owner can` — a 201 with a derived display name and, on the owner read-back, `status = 'active'` and null placement.
- `denies a people.read-only role with ROLE_DENIED before reading the body` — a `manager` session (which holds `people.read` but not `people.write`) gets 403 `ROLE_DENIED` naming `people.write` on a create, on a create whose body is deliberately malformed, on an update and on an update of the malformed id `not-a-uuid`, which is the proof that the gate is older than every request-shaped answer: a broken body or an unparseable id from a role that cannot write is a role denial, never a 400 and never the `404` the writable roles get. Four `authorization.denied` rows appear, each with module `people`, operation `write`, permission `people.write` and methods `POST`, `POST`, `PATCH`, `PATCH`, and the owner read-back of the targeted row is byte-identical to before the denials.
- `denies an unentitled tenant with MODULE_NOT_ENTITLED and a denial audit` — a create, an update of a real person id and an update of `not-a-uuid` in a tenant with no People entitlement each return 403 naming module `people` and operation `write`, with one `authorization.denied` row each (`POST` then `PATCH` then `PATCH`) and `no-store` on all three, so entitlement is decided before role, before parsing and before the id shape.
- `fails closed with a sanitized 500 when the audit write fails` — with `INSERT` on `audit_event` revoked from `saas_runtime`, both a create and an update return 500 `INTERNAL_ERROR` whose body contains no `permission denied`, `audit_event`, `insert into`, `saas_runtime` or `PostgreSQL` text, the person count is unchanged and the targeted row still holds its old phone and `updated_at`: the write rolled back with its audit. The grant is restored in a `finally`.
- `marks every write response uncacheable` — `cache-control: no-store` on all eight outcomes collected in one run: 201, 200, 400, 401 with no cookie, 403 `MODULE_NOT_ENTITLED`, 403 `SCOPE_DENIED`, 404 and 409.
- `keeps the directory listing and paging consistent with the writes` — the row a create returns is byte-equal to the row `GET /v1/people?q=<code>` returns, `total` moves by exactly one, and the scoped member's page still does not list it, because it is unplaced.

Two suites were updated rather than extended. `tests/schema-inventory.test.ts` now pins the person grant as 26 column privileges — 10 `SELECT`, 8 `INSERT`, 8 `UPDATE` — from a real `information_schema.column_privileges` inventory, with `id` insertable but not updatable, `tenant_id` insertable and never readable back as a column, `deleted_at` read-only, no insert grant on `status`, either placement column, `user_id`, either timestamp or `personal_email`, and `has_table_privilege` false for all four table-level privileges; §2.20 describes the full inventory it asserts for the two reference tables. `tests/scope.test.ts` stops asserting the now-false premise that the runtime role cannot write `person` and drives `scope_insert` and `scope_update` as real DML instead (§2.16).

The screen side is the Playwright journey in §2.13: it opens the Add-person panel, submits a new person, sees it in the table and in the count, reopens it for editing, changes the phone, then hits the duplicate-code refusal and reads the honest failure copy — all in Chromium against the built output and a disposable database, with the overflow checks taken again while the form is open.

What this does not prove: nothing here is a concurrency test — two members editing the same person at once is last-write-wins behaviour that no suite exercises, and the ADR records it as accepted rather than tested; no test deletes or restores a person, because no route can; the `RETURNING` limitation that forced the explicit-id insert-then-read design (ADR 0008) is proven by `tests/scope.test.ts` at the SQL boundary, and the route's fail-closed 500 for a read-back that returns nothing has no deterministic trigger, so that branch is covered by construction rather than by a test; the write path has never run in CI — the GitHub account is locked for billing and no job has executed a step (§4, T29).

### 2.20 People placement path (M1)

`tests/people-placement.test.ts` (24 tests, in two groups) is the first suite over a route that changes *where* a person sits, and therefore over one that changes who can read them. It reuses the shape of §2.19 — one disposable database from the real migrations and seed, the real `saas_runtime` and `saas_auth` pools, `createAccessFixtures`, real sessions through `createSessionFixture`, proof routes disabled, requests through `app.inject` — and adds an org structure and a set of scoped memberships, because a placement route is only interesting once scope can refuse it. The decision record is [ADR 0009](adr/0009-people-placement.md).

The structure is created on the **owner** connection: a second live legal entity, a soft-deleted entity, and `Placement unit root → child → grandchild` plus a `sibling` under the tenant's first entity, a unit under the second entity, a soft-deleted unit, and a unit with no legal entity at all. Four identities sit on top of it: the tenant-A owner (no scope rows), a tenant-B owner, a `manager` (holds `people.read`, not `people.write`), an `hr` member scoped to the first entity, an `hr` member scoped to `child` (so its subtree is `child` + `grandchild`) and an `hr` member scoped to the ownerless unit — a member with a scope and nothing inside it to place anyone on. Every scope row goes through the owner-only `setMembershipScope` from §2.17; no test inserts into `membership_scope` itself. Each test creates its own person with `newSubject(entity, unit)`, so no assertion depends on execution order, and every write is checked against a full owner-side `select *` of the row with the two placement columns and `updated_at` stripped out, which is how "nothing else moved" is proven rather than asserted.

**Options group (8 tests).** `GET /v1/people/placement-options`:

- 401 `UNAUTHENTICATED` with no cookie and with an unknown token, `no-store`, no entity or unit in the body.
- The tenant-wide owner gets every live entity and unit, sorted, all `placeable: true`, `canUnplace: true` — asserted as the exact whole object, including the `Legal a` name and each unit's `legalEntityId` — while the retired entity, the retired unit, the ownerless unit and the *other tenant's* entity are absent by id and by name. The audit count for the tenant is identical before and after: the read authorizes but never audits.
- The entity-scoped member sees exactly its own entity and its four live units, `canUnplace: false`, with the second entity and its unit absent — the same server-side narrowing, not a UI filter.
- The org-unit-scoped member sees only `child` and `grandchild`, and sees the parent entity with `placeable: false`: it is offered so the panel can group the units under a heading, and the flag tells the client that an entity-only placement is not available to this member. The ancestor unit and the sibling unit are absent.
- The member whose scope holds a unit with nothing under it gets `200` with two empty arrays and `canUnplace: false` — an honest empty list rather than a denial that would confirm the tenant has entities at all.
- A `manager` gets `403 ROLE_DENIED` naming `people.write` on a **GET**, with exactly one new `authorization.denied` row whose metadata carries module `people`, operation `write`, method `GET` and the route template `/v1/people/placement-options`; a tenant with no People entitlement gets `MODULE_NOT_ENTITLED` on the same route, proving entitlement still runs before role.
- The GET needs no CSRF token and answers `200`, and a cross-origin GET is served too: the `onRequest` hook guards unsafe methods only, so this test pins the deliberate asymmetry — the caller's own choices, which that caller could already read, are not a state change.

**Write group (16 tests).** `PATCH /v1/people/:id/placement`:

- No session → 401; absent token and wrong token → 403 `CSRF_INVALID`; foreign origin → 403 `ORIGIN_DENIED` — each `no-store`, and after all three the owner-side row is byte-identical to before and no `person.placement.changed` row exists.
- A tenant-wide owner places a person on entity + unit: 200, exactly the eleven `PeopleListItem` keys, `legalEntityName: 'Legal a'` and `orgUnitName` present; the stored row has the new pair with a strictly later `updated_at` and nothing else changed — not the identity, not `status`, not `user_id`, not `deleted_at`. One `person.placement.changed` row with `entity_type = 'person'`, the person's own id, actor `user`, null before/after state and metadata `{ module, legalEntityId, orgUnitId, previousLegalEntityId: null, previousOrgUnitId: null }`; the serialised row contains none of the person's display name, the entity name, the unit name, the phone or the string `work_email`.
- Placing on a legal entity alone clears the unit, and a tenant-wide unplace (`null`, `null`) empties both columns and both names and writes the row with the previous pair in metadata — the ids are the only history the product keeps.
- Sixteen bodies that are not exactly the two-key pair are one `400 INVALID_BODY`: no body at all, `null`, a string, a number, an array, an array of objects, `{}`, a single key each way, a third key (`firstName: 'Sneak'`), a misnamed key (`orgUnit`), an empty-string and a non-UUID entity, number and boolean unit values, and `{ legalEntityId: null, orgUnitId: <unit> }` — an org unit never arrives without the entity it belongs to, so that shape is refused rather than resolved. The row and the audit count are unmoved.
- One `404 PLACEMENT_NOT_FOUND` for seven reference misses: an unknown entity, a soft-deleted entity, another tenant's entity, an unknown unit, a soft-deleted unit, a unit that belongs to a *different* entity than the one in the same body, and the ownerless unit. Nothing distinguishes them, so the answer cannot enumerate the tenant's structure.
- One `404 PERSON_NOT_FOUND` for five person misses: a valid unknown UUID, `not-a-uuid`, an org-unit id used as a person id, another tenant's person, and the seeded soft-deleted person — with no audit row for any of them.
- The gate is older than the id and the body: a `manager` targeting `not-a-uuid`, and the same role targeting a legal-entity id with an empty body, both get `ROLE_DENIED`; an unentitled tenant targeting `not-a-uuid` gets `MODULE_NOT_ENTITLED`.
- The entity-scoped member: a move to another unit of its own entity is 200 and writes exactly one audit row with that member as actor; the second entity is `404 PLACEMENT_NOT_FOUND`, not a disclosure that it exists; an unplace is the suite's one `403 SCOPE_DENIED`, because removing a placement leaves a person that member could neither see nor maintain; and a currently-unplaced person is `404 PERSON_NOT_FOUND` with the stored pair still `null, null` — the write never reached them.
- The org-unit-scoped member moves a person deeper into its subtree (200) and is refused `404 PLACEMENT_NOT_FOUND` for the ancestor unit, the sibling unit and the entity alone, plus `403 SCOPE_DENIED` for an unplace, with the stored pair left at the grandchild.
- An unchanged placement is a no-op: the second response is equal to the first, the owner row is byte-identical including `updated_at` — the clock is the proof that no `UPDATE` ran, since the trigger would have advanced it — and no audit row appears, including when the same no-op comes from a scoped member.
- Revoking `INSERT` on `audit_event` from `saas_runtime` turns a valid placement into `500 INTERNAL_ERROR` containing none of `permission denied`, `audit_event`, `insert into`, `saas_runtime` or `PostgreSQL`; the grant is restored in a `finally` and the owner row is exactly what it was, so the placement rolled back with its audit.
- `no-store` on every outcome, collected in one run as `[200, 400, 404, 403, 403]`.
- `GET /v1/people` then shows the placed row with `legalEntityName` and `orgUnitName` populated and never another tenant's person; and `PATCH /v1/people/:id` still refuses three bodies that mix identity text with `legalEntityId` or `orgUnitId` as `400 INVALID_BODY` with the row unmoved — the identity patch cannot place, and the placement route cannot edit identity.

The grant surface moved with this slice, and `tests/schema-inventory.test.ts` re-derived it. `saas_runtime` now holds 26 column privileges on `person` — 10 `SELECT` (the seven directory fields, `deleted_at`, `legal_entity_id`, `org_unit_id`), 8 `INSERT` and 8 `UPDATE`, the last two being the identity set plus, for `UPDATE` only, both placement columns: selectable and updatable but **not** insertable, which is what makes "a new person starts unplaced" a database fact rather than a UI convention. `id` stays insertable and never updatable, `deleted_at` read-only, and `status`, `user_id`, both timestamps and `personal_email` hold no write grant at all; table-level `SELECT`/`INSERT`/`UPDATE`/`DELETE` on `person` are all false and there is no `DELETE` anywhere. A new test pins the reference-table surface: exactly eight column-only `SELECT` grants — `legal_entity (id, name, code, deleted_at)` and `org_unit (id, name, legal_entity_id, deleted_at)` — with `has_table_privilege` false for all four table-level privileges on both tables and no `SELECT` on either `tenant_id` column. The runtime table-grant allowlist is unchanged at 12 rows, and so are the runtime's twelve executable `app` functions and the worker's zero table and column privileges with exactly eight executable functions — byte-for-byte what §2.16 reviewed — while `legal_entity` and `org_unit` keep their permissive `tenant_isolation` policies with no new restrictive policy: no migration, no policy and no helper changed in this slice, and the routes ask `app.person_placement_in_scope` for every verdict instead of restating a scope rule in SQL or TypeScript.

What this does not prove: no route creates or edits a legal entity or an org unit, so every reference row here was written owner-side — the suite proves a member can place onto structure that exists, not that an operator can build that structure through the product; there is no placement history, approval, undo or dry-run surface, so `person.placement.changed` rows are the only trail and no test asserts more than their existence and shape; two members placing the same person at once is last-write-wins with no version column and no concurrency test, as in §2.19; the browser leg in §2.13 exercises the happy path for a tenant-wide member only, so a scoped member's shorter list is proven at the route and not in Chromium; `app.person_placement_in_scope`'s own semantics belong to §2.16, and this suite consumes its verdicts rather than re-testing them; and nothing here has executed in CI — the account is billing-locked and no job has run a step (§4, T29).

---

## 3. Test data

- Only synthetic data in development and CI.
- Design-partner data only in the designated production tenant, never copied to staging.
- If a production issue must be reproduced, use a redacted subset with written approval and a defined deletion date.
- Fixtures are generated by scripts, not copied from real customers.
- No secrets in fixtures.

---

## 4. CI gates

The workflow at [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) is authored to run these gates on push to `main` and on pull requests, against PostgreSQL 16 and 17, with read-only repository permissions, no repository secrets and a frozen lockfile. **A GitHub remote now exists — `Charanjitsingh1991/Saasmodelone`, connected private on 23 October 2026 and changed to public the same day at the owner's instruction — and the push of `f060bca` created Actions run `39903221917`, but no job has executed a step there: GitHub annotated the account as locked for billing, attempt 1's four reruns ended in `startup_failure` with zero jobs, and the post-public attempt 2 recorded both matrix jobs with `steps: []` under the annotation `The job was not started because your account is locked due to a billing issue.` Seven further pushes have each created a run since — `39907647182`, `39908929526`, `39915369049`, `39946060551`, `39960638291`, `40267178007` and `40287816132`, the last started on 26 October 2026 for `83dc951` — and all eight end the same way: both matrix jobs `completed` about two seconds after starting with `runner_id: 0` and zero steps.** Repository visibility made no difference, so no step has ever run, no merge has been blocked by it, and PostgreSQL 16 is unproven. Local results are recorded in [`release/m0-evidence.md`](release/m0-evidence.md).

- Type check, lint and import-boundary lint.
- Unit, contract and integration tests.
- Tenant isolation suite over the RLS tenant business tables, plus the explicit identity-table privilege tests.
- Schema inventory: 67 tables with `tenant_id`, 65 RLS tables, exactly two no-RLS identity exceptions, no forced RLS, 274 policies (66 permissive isolation, one per RLS table, and 208 restrictive), the exact runtime table grants (12 rows), the 26 person column privileges (10 `SELECT`, 8 `INSERT`, 8 `UPDATE`, with `id` insertable but not updatable, both placement columns selectable and updatable but never insertable, `deleted_at` read-only and no table-level privilege), the eight column-only `SELECT` grants on `legal_entity` and `org_unit` with no table-level privilege on either, and the `saas_worker` surface (zero table and column privileges, exactly eight executable `app` functions, four of them security definer).
- People scope suite (§2.16): the membership_scope constraints, the eight restrictive policies, the helper grant surface, the derived `person_id` scope invariant, read and write narrowing for entity, org-unit subtree and employee self-scope, the `person` insert and update policies driven as real runtime DML, the pinned fail-open system context, and scope applied after entitlement and role.
- People directory write path suite (§2.19): session, origin and CSRF refusal with nothing written, the full create with its owner-read-back defaults and field-name audit, derived display name and trimming, the 48-body validation matrix with `INVALID_BODY` and no write, duplicate code and email as `409` on both routes, changed-only update with `updated_at` and the no-op update, absent versus null versus blank, the four uniform `404`s, `ROLE_DENIED` before validation and `MODULE_NOT_ENTITLED` before role, scoped edit 200 with out-of-scope edit `404` and scoped create `403 SCOPE_DENIED`, the sanitized 500 with rollback when the audit grant is revoked, `no-store` on all eight write outcomes, and the listing and paging that a write then a scoped read must agree with.
- People placement path suite (§2.20): the options route's 401, its full sorted tenant-wide list with retired and foreign references absent and no audit row, the entity-scoped and org-unit-scoped lists including a parent entity offered as not placeable and a nothing-placeable member's empty 200, `ROLE_DENIED` and `MODULE_NOT_ENTITLED` on a GET with their denial rows, CSRF and origin refusal with the row byte-identical, the eleven-key place answer with every other column proven unmoved and one ids-only `person.placement.changed` row, entity-alone placement and tenant-wide unplace, 16 non-pair bodies as `INVALID_BODY`, seven reference misses as one `PLACEMENT_NOT_FOUND`, five person misses as one `PERSON_NOT_FOUND`, the gate before id and body, the scoped member's in-entity 200 with another entity `404`, unplace `403 SCOPE_DENIED` and unplaced target `404 PERSON_NOT_FOUND`, the subtree-only move, the no-op with `updated_at` as the proof, the sanitized 500 with rollback when the audit grant is revoked, `no-store` across `[200, 400, 404, 403, 403]`, the names appearing in the directory, and placement keys refused by the identity patch.
- Scope administration suite (§2.17): the owner-only link and unlink paths with their audit rows, idempotency and conflicts, the actor and tenant refusals, full scope replacement with sorted before/after and every refusal code, the real `23503` audit-failure rollback, the narrowing it produces in runtime reads, and the unchanged runtime and worker grant surface with `membership_scope` still unreadable.
- People directory read path (§2.18): the 401, the owner's tenant-wide page with exactly the eleven contract keys and no forbidden field or value, cross-tenant invisibility, the `ROLE_DENIED` and `MODULE_NOT_ENTITLED` denials with one denial row each, the cancelled-entitlement retention pair, the scoped-manager-versus-owner narrowing regression through the route, literal `%` and `_` search, deterministic paging and the true total past the end, ten `400 INVALID_QUERY` parameter cases, `no-store` on every outcome, and no audit row for a successful read.
- Outbox suite (§2.15): claim-helper guards, worker-role refusal of direct `domain_event` access, cross-tenant filtering, expired-lease re-claim, retry backoff and dead-lettering, duplicate delivery, and entitlement and suspension skips.
- Module entitlement suite, including expiry, cancellation, dependency degradation and catalog write protection.
- Authentication and session suite: login, invitation acceptance, cookie attributes, session expiry/revocation, CSRF/Origin checks and the auth-role privilege matrix.
- Authorization matrix: the exact seven-role policy, role denial after entitlement, entitlement-before-role ordering, and `/v1/context` permissions and effective modules.
- Denied-request audit: one `authorization.denied` row per authenticated access denial, no query/header/token leakage, and a denial still returned when the audit write fails.
- People directory export: exact streaming CSV, formula-injection guarding, tenant isolation and override attempts, entitlement and role denials with no bytes, soft-delete exclusion, forbidden-field exclusion, pre-disclosure audit, audit-failure 500 and column-level runtime grants.
- Migration runner: fresh apply, no-op re-apply and checksum tampering. The workflow also bootstraps, migrates twice and seeds twice before testing.
- Web unit tests for module filtering and ordering, People gating, role labels, error mapping and routing.
- Web build and one Playwright/Chromium browser journey against the built output, with a disposable database and an in-process API. The workflow installs Chromium with `pnpm exec playwright install --with-deps chromium`, then runs `pnpm test:e2e`; the journey's Playwright webServer runs `pnpm build:web` before serving, so it cannot pass on stale output.
- Secret scan over tracked and untracked non-ignored regular files. It does not scan Git history, ignored files, packed objects or remote state, and it cannot prove absence.
- Production dependency audit at high severity. It is not SAST or supply-chain provenance.
- Workflow contract test: asserts the triggers, read-only permissions, action allowlist, PostgreSQL versions, localhost-only dummy credentials and exact command order, including the browser steps. This proves the file's shape, not that GitHub executed it.

Not yet in CI: payroll golden cases (no payroll calculation), migration fixture → reconciliation → promotion → export (no Switch promotion), SAST, container scanning, SBOM, action SHA-pinning, branch protection and restore drills. The threat model is a draft and has not been reviewed by a named security owner.

Browser end-to-end coverage today is the single journey in §2.13: sign-in, the People directory with its rows, search, live count and paging controls, the add-person and edit panel with its duplicate-code refusal, the Place panel with its server-supplied choices, placement cell and reload survival, effective-module navigation, theme persistence, sign-out and the People access state. Invitation acceptance, employee onboarding, leave request/approval, payroll draft → finalise, import rehearsal → sign-off, invoice creation, module enablement and export have **no browser test and no screen**. There is a Playwright configuration and the CI workflow declares the browser job, but no job in the workflow has executed a step — the push of `f060bca` created run `39903221917`, whose attempt-1 reruns ended in `startup_failure` with zero jobs and whose post-public attempt 2 recorded both matrix jobs with `steps: []` under the billing-lock annotation — so the local browser pass is not evidence of CI execution.

---

## 5. Environments

| Environment | Data | Purpose |
| --- | --- | --- |
| Local | Synthetic | Development |
| CI | Synthetic, ephemeral | Automated verification |
| Staging | Synthetic or fully redacted | Release rehearsal and demos |
| Production | Customer data | Live service |

Staging never receives a production database dump. Payroll demos use a fixture tenant named as illustrative.

---

## 6. Release evidence

For each release that touches payroll, migration or authorization, attach:

- Commit SHA and schema version.
- Golden-case result and rule version.
- Migration fixture result and reconciliation totals.
- Isolation and authorization suite result.
- Known limitations and rollback plan.

The M0 interim pack is [`release/m0-evidence.md`](release/m0-evidence.md): source commits, environment, exact commands and results, criterion-by-criterion status and an explicit "not proven — do not claim" section. It records that M0 has not exited. [`release/m0-exit-audit.md`](release/m0-exit-audit.md) holds the per-criterion verdict with the exact test file and test name behind each claim, what has never run anywhere and the owner decisions that block exit.

A green build is not evidence that a feature works. The evidence is the specific suite above, plus a manual smoke test of the primary journey. For M0 the primary UI journey was the sign-in and empty People path; it is now the sign-in, directory read, core-identity write and placement path of §2.13, covered by the Playwright journey — sign in, search, add a person, edit it, hit a duplicate code, place it on an org unit, reload, unplace it, sign out — including automated overflow checks at 390, 768 and 1440 px on the sign-in page, with the write panel open and with the Place panel open. There is still no import or export journey to smoke-test, and no journey for delete or restore, because no such route exists.
