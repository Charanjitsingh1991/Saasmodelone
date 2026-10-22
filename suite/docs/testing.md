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
| End-to-end | Critical user journeys in a browser | Every pull request to main |
| Security regression | Cross-tenant access, role matrix, export authorization | Every commit |
| Restore drill | Backup restores within RPO/RTO | Monthly and before a design partner goes live |

No mocks for the database in isolation or migration tests. A mocked tenant filter has already passed in systems that later leaked.

---

## 2. Non-negotiable suites

### 2.1 Tenant isolation

For every tenant table:

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

Not covered yet: browser login and invitation screens (none exist), email delivery, password reset, MFA, OAuth, session rotation, device lists, distributed rate limiting and authentication-event audit.

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

---

## 3. Test data

- Only synthetic data in development and CI.
- Design-partner data only in the designated production tenant, never copied to staging.
- If a production issue must be reproduced, use a redacted subset with written approval and a defined deletion date.
- Fixtures are generated by scripts, not copied from real customers.
- No secrets in fixtures.

---

## 4. CI gates

A merge is blocked when any of these fail:

- Type check and lint.
- Unit, contract and integration tests.
- Tenant isolation suite.
- Module entitlement suite, including expiry, cancellation, dependency degradation and catalog write protection.
- Authentication and session suite: login, invitation acceptance, cookie attributes, session expiry/revocation, CSRF/Origin checks and the auth-role privilege matrix.
- Authorization matrix: the exact seven-role policy, role denial after entitlement, entitlement-before-role ordering, and `/v1/context` permissions and effective modules.
- Denied-request audit: one `authorization.denied` row per authenticated access denial, no query/header/token leakage, and a denial still returned when the audit write fails.
- People directory export: exact streaming CSV, formula-injection guarding, tenant isolation and override attempts, entitlement and role denials with no bytes, soft-delete exclusion, forbidden-field exclusion, pre-disclosure audit, audit-failure 500 and column-level runtime grants.
- Payroll golden cases for the current and previous rule-pack versions in every covered jurisdiction.
- Migration fixture → reconciliation → promotion → export.
- Dependency audit with no unapproved critical vulnerability.
- Secret scan.
- Schema migration applies cleanly to an empty database and to the previous version.

Browser end-to-end tests cover: sign-in, invite, employee onboarding, leave request/approval, payroll draft → finalise, import rehearsal → sign-off, invoice creation, module enablement on an existing tenant, and export. None of these browser tests exist yet; authentication is currently proven at the API and database layers only.

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

A green build is not evidence that a feature works. The evidence is the specific suite above, plus a manual smoke test of the primary journey.
