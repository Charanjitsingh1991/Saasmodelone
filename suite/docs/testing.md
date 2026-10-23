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
| Security regression | Cross-tenant access, role matrix, export authorization | Every commit |
| Restore drill | Logical dump and restore parity (`pnpm drill:restore`) | Executed manually against the local developer database; the target RPO of 15 minutes and RTO of 4 hours recorded in [`architecture.md`](architecture.md) and a monthly schedule are not built |

No mocks for the database in isolation or migration tests. A mocked tenant filter has already passed in systems that later leaked.

---

## 2. Non-negotiable suites

### 2.1 Tenant isolation

For every RLS tenant business table (currently 64; `auth_session` and `invitation` are the two no-RLS identity exceptions and are covered by §2.11 instead):

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

Target matrix per role × scope × action, not built:

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
- The resolved role is passed to the route callback and returned by `/v1/context`. An unknown stored role is a data-integrity error, never a permissive default. A gate checks membership, platform access, module entitlement and role permission in that order; an entitled module with a role lacking the permission returns `ROLE_DENIED` with the permission name and no rows. Scope enforcement is not implemented.
- Tenant and user context are transaction-local. The membership check, platform check, module gate, role check and caller's query run on the same client and in the same transaction.
- Every module route and job declares a read or write gate; an unentitled operation returns a stable denial code and no rows.
- Attempts to override the tenant with `x-tenant-id` or a `tenant_id` parameter return only the principal's records.
- Reusing one pool for sequential tenants and users does not leak `app.tenant_id`, `app.user_id` or the resolved role.
- A denied gate or a failed callback rolls back; a callback error persists nothing.
- Each authenticated access denial appends exactly one `authorization.denied` row. The registered route template is stored, never a query string; metadata contains no role, email, tenant slug, header, cookie, token, body or stack. A denial is still returned when the audit write fails.
- `GET /v1/people/export` is registered in production even when proof routes are disabled. It takes the principal only from the session, applies the People read gate in the member transaction and streams through a server-side cursor. It sends `Cache-Control: no-store`, `X-Content-Type-Options: nosniff` and no `Content-Length`; a gate denial returns the typed code with no CSV; `x-tenant-id` and a `tenant_id` parameter are ignored.

These suites use the real database, the runtime and auth roles, real Argon2 verification and real cookies, not mocks. They sit above the table-level denial suite. Scope enforcement, employee self-scope, role administration and seat enforcement are still not implemented.

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
- Runtime privileges: `has_column_privilege` is true for exactly the eight granted person columns and false for `tenant_id`, personal contact, date of birth, gender, status, designation and the employment columns; table-level `SELECT` is false.
- The route works with proof routes disabled, and invalid `exportBatchSize` values are rejected.

### 2.13 Web shell and browser journey (M0)

`apps/web/test` contains pure unit tests for the client logic:

- Module ordering by catalog `sortOrder` then `code`, without mutating the input; navigation filtering by `canRead || canWrite`; People gating on `canRead`; read/write badge labels; role labels with a safe fallback; the module names listed in the People access state.
- Login error mapping: the exact generic `401` message, a distinct `429` message, a retryable network state and a non-generic unknown state.
- The History API router: `/login`, `/app`, `/app/people`, trailing slashes, unknown paths that must not become module screens, and document titles.

`tests/e2e/people.spec.ts` is one Playwright/Chromium journey against `pnpm build:web` output served by Vite preview on `http://localhost:3000`, with an in-process API on `127.0.0.1:3001` and a disposable database created by `packages/testkit`. It uses real HTTP, real session cookies and real Argon2 hashes; fetch, the session and the database are not mocked. It covers:

- An anonymous request to `/app/people` redirects to `/login`.
- An invalid password returns exactly `Email, password or workspace is incorrect.`
- A successful People owner sign-in reaches the empty People screen, shows `Read and write`, and the navigation contains People with `aria-current="page"` but not Work.
- Local storage and session storage remain empty of credentials and session state; the URL contains no token.
- The light and dark layouts have no horizontal overflow at 390, 768 and 1440 px.
- The theme toggle survives a reload and is the only persisted key.
- Sign-out returns to `/login` and removes the session cookie.
- A keyboard-only sign-in reaches a Work-only workspace, shows Work but not People, and opening `/app/people` shows the access state rather than the directory shell.

The journey is one test, not a full regression suite. It does not cover the distinct `429` sign-in message (covered only by the login-mapping unit tests), the post-sign-in `401` that clears in-memory state (no test; code inspection only), invitation acceptance, password reset, session expiry while a request is in flight, a People data-entry flow (none exists), export UI (none exists), other module screens (none exist), real proxy/edge deployment, CSP or assistive-technology testing.

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

---

## 3. Test data

- Only synthetic data in development and CI.
- Design-partner data only in the designated production tenant, never copied to staging.
- If a production issue must be reproduced, use a redacted subset with written approval and a defined deletion date.
- Fixtures are generated by scripts, not copied from real customers.
- No secrets in fixtures.

---

## 4. CI gates

The workflow at [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) is authored to run these gates on push to `main` and on pull requests, against PostgreSQL 16 and 17, with read-only repository permissions, no repository secrets and a frozen lockfile. **There is no Git remote, so it has never run; no merge has been blocked by it, and PostgreSQL 16 is unproven.** Local results are recorded in [`release/m0-evidence.md`](release/m0-evidence.md).

- Type check, lint and import-boundary lint.
- Unit, contract and integration tests.
- Tenant isolation suite over the RLS tenant business tables, plus the explicit identity-table privilege tests.
- Schema inventory: 66 tables with `tenant_id`, 64 RLS tables, exactly two no-RLS identity exceptions, no forced RLS, the exact runtime table grants, the eight person column grants, and the `saas_worker` surface (zero table and column privileges, exactly eight executable `app` functions, four of them security definer).
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

Browser end-to-end coverage today is the single journey in §2.13: sign-in, the empty People screen, effective-module navigation, theme persistence, sign-out and the People access state. Invitation acceptance, employee onboarding, leave request/approval, payroll draft → finalise, import rehearsal → sign-off, invoice creation, module enablement and export have **no browser test and no screen**. There is a Playwright configuration and the CI workflow declares the browser job, but the workflow has never run; the local browser pass is not evidence of CI execution.

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

A green build is not evidence that a feature works. The evidence is the specific suite above, plus a manual smoke test of the primary journey. For M0 the primary UI journey is the sign-in and empty People path; it is covered by the Playwright journey, including automated overflow checks at 390, 768 and 1440 px. There is still no People data-entry journey to smoke-test.
