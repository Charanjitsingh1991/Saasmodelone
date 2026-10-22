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
| Security regression | Cross-tenant access, role matrix, export permissions | Every commit |
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

Test the catalog seed twice: it must be idempotent and must not overwrite reviewed metadata.

### 2.3 Authorization matrix

A table-driven test per role × scope × action. Minimally:

- Employee: own profile, own payslips, own leave; no salary visibility for others.
- Manager: team leave/timesheets; no bank or statutory identifiers.
- HR: employee records and payroll inputs; no billing or tenant ownership changes.
- Finance: invoices, payments, payroll cost; no salary edits unless explicitly granted.
- Admin: configuration and users; payroll finalise still requires the explicit permission.
- Auditor: read-only audit and records, no mutations.
- Client contact: only their document room, no directory or internal search.

Denied actions must produce an audit event, not a generic 500.

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
- A finalised payroll run cannot be edited; reversal produces new records.
- Role changes, exports, login failures and connector credential changes are target audit events, not yet implemented.
- Audit write failure rolls back the underlying privileged action.
- Domain events are delivered at least once and consumers are idempotent.

### 2.7 Request layer

The API and worker share one tenant transaction helper, and the same suites prove both surfaces:

- The principal is injected by the caller; missing or malformed principals fail before data is read. No header, query string, body or cookie can supply a tenant.
- Request routes resolve an active membership before platform access. A non-member or suspended member receives `MEMBERSHIP_DENIED` even when the tenant is suspended, so tenant state is not disclosed. A member of a suspended, closed or deleted tenant receives `PLATFORM_ACCESS_DENIED`.
- A user with a valid membership in tenant A cannot use that user ID with tenant B.
- The resolved role is passed to the route callback and returned by `/v1/context`. An unknown stored role is a data-integrity error, never a permissive default. Role and scope enforcement is not implemented yet.
- Tenant and user context are transaction-local. The membership check, platform check, module gate and caller's query run on the same client and in the same transaction.
- Every module route and job declares a read or write gate; an unentitled operation returns a stable denial code and no rows.
- Attempts to override the tenant with `x-tenant-id` or a `tenant_id` parameter return only the principal's records.
- Reusing one pool for sequential tenants and users does not leak `app.tenant_id`, `app.user_id` or the resolved role.
- A denied gate or a failed callback rolls back; a callback error persists nothing.

These suites use the real database and the runtime role, not mocks. They sit above the table-level denial suite; authentication, sessions and authorization are not implemented yet.

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

- A full export includes every entitled module, document metadata and file objects.
- A per-module export includes exactly that module plus the shared directory records it needs, and nothing from an unentitled module.
- A cancelled module's records can still be exported for the contracted retention window.
- Re-importing the export into a clean tenant reproduces the same control totals.
- An export cannot include data from another tenant.
- Expired signed URLs fail.

### 2.10 Standalone module acceptance

Every licensable module must pass the same test before it is sold alone:

1. A fresh tenant is provisioned with only that module.
2. The tenant can create its core records without a second module: clients for CRM/Work/Money, people for People/Work, documents for Content.
3. The module's primary journey completes without a feature that belongs to an unlicensed module.
4. The shared directory is populated and visible to the licensed module; no duplicate client or person table is created.
5. Adding a second module on the same tenant links the existing records; no re-import or manual merge is required.
6. The per-module export is complete and re-importable.

If a module cannot pass this, it is a feature of another module and must not be priced alone.

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
- Authorization matrix.
- Payroll golden cases for the current and previous rule-pack versions in every covered jurisdiction.
- Migration fixture → reconciliation → promotion → export.
- Dependency audit with no unapproved critical vulnerability.
- Secret scan.
- Schema migration applies cleanly to an empty database and to the previous version.

Browser end-to-end tests cover: sign-in, invite, employee onboarding, leave request/approval, payroll draft → finalise, import rehearsal → sign-off, invoice creation, module enablement on an existing tenant, and export.

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
