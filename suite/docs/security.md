# Security and Privacy Baseline

Status: target baseline for the first design partner · October 2026
This is not a certification claim. It is the minimum bar before a real company's payroll data enters the product.

---

## 1. What we are protecting

| Asset | Why it matters | Classification |
| --- | --- | --- |
| Payroll, salary and bank details | Direct financial harm, insider risk | Restricted |
| Tax, social-insurance and national identifiers | Identity theft, statutory exposure | Restricted |
| Employment and performance records | Employee privacy, local privacy-law obligations | Confidential |
| Client contracts, invoices, margins | Commercial harm | Confidential |
| Documents and client room files | Confidentiality, contractual duties | Confidential |
| Credentials, API keys, signing keys | Full compromise if leaked | Secret |
| Audit trail | Trust, incident reconstruction | Restricted integrity |

Threats we design against first:

1. **Tenant escape** — a user reads or mutates another company's records.
2. **Entitlement bypass** — a user reaches a module the organisation has not licensed, or keeps access after cancellation.
3. **Privilege abuse** — an employee, HR user or insider sees salary or exports data they should not.
4. **Credential compromise** — reused passwords, stolen sessions, leaked API keys.
5. **Import poisoning** — a crafted CSV or connector payload corrupts payroll or injects content.
6. **Destructive mistakes** — an accidental edit to a finalised payroll run or a bulk delete.
7. **Export leakage** — signed URLs shared publicly, exports left in a bucket.
8. **Supply-chain compromise** — a malicious dependency or CI credential.

---

## 2. Tenancy

- Every tenant table has `tenant_id` and RLS enabled (see `db/migrations/0001_core.sql`).
- Runtime transactions set `app.tenant_id`; no setting means no rows.
- The runtime database role does not own tables and cannot bypass RLS.
- Cross-tenant foreign keys are prevented with composite `(tenant_id, id)` references.
- Tenant context is cleared when a pooled connection is returned.
- Automated table-level tests prove the restrictive module policies on the two M0 proof tables, `employment` (People) and `project` (Work): entitled access, denial for an unentitled module on an entitled tenant, denial for suspended, closed and deleted tenants holding an active entitlement, denial of cross-tenant reads and writes, and read-only access for a cancelled entitlement inside `read_until`. The matrix expands with each runtime table grant; it does not yet cover every tenant table.
- The API and worker share one tenant transaction: the injected principal is the only source of tenant identity, and no header, query string, body or cookie is trusted for it. The platform check, module gate and data query use the same client and transaction, with `app.tenant_id` set transaction-locally. Authentication is not implemented yet, and role and scope checks are not built; the current principal is trusted for tenant identity only.
- Tenant provisioning and login-time membership lookup use a narrow privileged path, audited separately.
- `FORCE ROW LEVEL SECURITY` is not enabled yet. The `tenant` table gains it only when the provisioning path sets `app.tenant_id` before inserting the tenant row and that path is tested; global reference tables and `infra.schema_migration` are never forced.

## 3. Module entitlements

- The module catalog (`platform_module`, `platform_module_dependency`) is reference data. The runtime role can read it and cannot write it.
- Each tenant has `module_entitlement` rows for licensed modules, with status, seat unit, start/end dates and contract reference. RLS scopes entitlements to the tenant. `read_until` is set if and only if the entitlement is cancelled; it is null for every other state.
- Authorization order is **entitlement → role → scope**. A user with the right role in the wrong module is still denied.
- Module access has one database definition, split by operation: `app.has_module_read('<code>')` and `app.has_module_write('<code>')`, both security-definer. Every module helper first requires `app.has_platform_access()`: a tenant context is set and the tenant is active and not deleted. Write requires a trialing/active entitlement inside its window; read additionally allows suspended entitlements inside their original term and cancelled entitlements inside `read_until`. Post-term retention is `cancelled` plus `read_until`, never a stale suspension. Public tenants can use only `available`/`preview` catalog modules; `planned` modules require `tenant.is_internal` and an internal-source entitlement. `app.has_active_module('<code>')` is the exact delegate to the write helper, kept for compatibility; new SQL uses the read/write helpers, and no helper is ever called with `'core'` or `'switch'`.
- Module tables carry `as restrictive` RLS policies installed by the idempotent, owner-only procedure `app.apply_module_policies()`; the runtime role has no `EXECUTE` on it. Switch staging is gated by `app.has_switch_access()` — any trialing/active licensable entitlement inside its window and an active tenant — never by a Switch entitlement.
- `tenant.is_internal` is set only by the provisioning path; the runtime role has no `UPDATE` on `tenant`.
- Tenant-level suspension, closure and soft deletion are denied at both layers: `app.has_platform_access()` at the request layer, and every module RLS policy through the module helpers.
- Cancellation and expiry remove access but never delete module data. Read/export access for a cancelled module is an explicit retention decision, not a side effect of the entitlement being absent.
- Entitlement changes are audited with actor, module, previous state and new state.
- A dependency that is optional does not imply a licence: Work can run without CRM or People, and the UI must hide or degrade the dependent feature rather than leak data from an unlicensed module.
- API tokens carry module scopes; a token cannot be used to call an unentitled module even if the role allows it.

## 4. Identity and sessions

- Email/password with Argon2id hashing; Google and Microsoft OAuth.
- MFA required for owners, admins, HR and finance; available to everyone.
- Short-lived sessions with rotation, server-side revocation and a device list.
- SSO (SAML/OIDC) and SCIM at enterprise tier.
- API keys are scoped, hashed at rest, shown once, and revocable.
- Brute-force and credential-stuffing protection at the edge.
- No shared accounts. Support access requires explicit, time-boxed, audited impersonation consent.

## 5. Authorization

- Role + scope checks on the server for every action, after the module entitlement check.
- Sensitive permissions are explicit: payroll finalise, bank change, role change, export, delete, connector credentials.
- Four-eyes approval for payroll finalisation and bank-detail changes above a configurable threshold.
- Client contacts are a separate principal type with document-room-only access.
- Every denied request is logged with the actor, action and reason, including a denied module entitlement.
- A module administrator can administer one module without becoming a tenant owner.

## 6. Sensitive data

- Application-layer encryption for bank account numbers, tax identifiers and social-insurance identifiers, with a KMS-managed key and rotation.
- Only last-four values are stored in clear for display and matching.
- PII is redacted from logs, traces and error reports by default.
- Production data never enters development or test environments. Fixtures are synthetic.
- Document uploads are quarantined, scanned and served via short-lived signed URLs.
- Exports are encrypted, time-limited and audited.

## 7. Audit

- Append-only `audit_event` table; updates and deletes are blocked by trigger.
- Captured: authentication, role/permission changes, payroll actions, bank changes, exports, connector credentials, document downloads by privileged users, tenant settings.
- Audit events include actor, action, entity, before/after where appropriate, IP, user agent and timestamp.
- Audit retention is defined per jurisdiction; legal holds are explicit.
- Audit logs are not editable by tenant admins.

## 8. Infrastructure

- Data residency in the region selected for the tenant at provisioning. The first region is chosen with cohort 01; additional regions follow real requirements.
- Private networking; database and object storage not publicly reachable.
- Encryption in transit (TLS 1.2+) and at rest.
- Least-privilege infrastructure roles; no long-lived production credentials in CI.
- Secrets in a managed store with rotation; never in Git.
- Backups encrypted, tested with scheduled restore drills.
- Dependency pinning, lockfiles, automated vulnerability scanning and SAST in CI.
- Annual independent penetration test before general availability; remediation tracked.

## 9. Privacy and compliance

- GDPR-aligned DPA baseline, with local-law addenda where required (including DPDP for customers it applies to). The applicable privacy schedule is named in the contract, not assumed from the customer's location.
- Purpose limitation: customer data is used to provide the service, not to train models or build a cross-customer dataset.
- Subprocessor register published to customers; new subprocessors notified before use.
- Retention and deletion schedules per record class, with legal-hold exceptions.
- Data subject requests supported through the customer's administrator and the studio.
- Breach notification runbook with defined owners and timelines.
- Customer data is exportable in CSV/JSON plus original documents.

## 10. AI policy

- No customer payroll, bank or statutory data is sent to consumer AI services.
- Any AI feature uses an enterprise/zero-retention endpoint or a self-hosted model, under a documented data flow.
- AI may assist with drafting, search, summarisation and anomaly hints. It does not calculate statutory liability, approve payroll or decide access.
- AI output is labelled, reviewable and never silently applied to a financial record.
- Prompts and outputs containing customer data are not retained for model training.

## 11. Design-partner gate

Before the first real dataset is imported:

- [ ] Tenant isolation tests pass for every table.
- [ ] Entitlement tests pass: no access to an unlicensed, expired or cancelled module; no dependency leak.
- [ ] DPA and security schedule signed.
- [ ] Named security owner and incident contact exchanged.
- [ ] Read-only source credentials verified; no write scope.
- [ ] Encryption keys and secret storage configured for production.
- [ ] Backup and restore drill completed.
- [ ] Audit events verified for login, import, payroll and export.
- [ ] Access review completed for the design-partner workspace.
- [ ] Migration rehearsal completed on synthetic or redacted data.
- [ ] Rollback and export rehearsed with the customer watching.

## 12. Incident response

1. Triage and classify severity; appoint an incident lead.
2. Contain: revoke sessions/keys, isolate tenants or components.
3. Preserve evidence; do not destroy logs.
4. Notify the affected customer and regulator within contractual and legal timelines.
5. Remediate the root cause and add a regression test.
6. Publish an internal post-incident review; share the relevant parts with the customer.

Severity 1 means confirmed or suspected cross-tenant access, entitlement bypass into restricted module data, payroll corruption, or exposure of restricted data. It pages the on-call owner immediately.
