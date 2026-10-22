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
- CI workflow authored with type check, lint, boundary lint, tests, secret scan, dependency audit, Chromium install, web build, browser journey and a PostgreSQL 16/17 matrix. It has not run because there is no Git remote; PostgreSQL 16 and the CI browser job remain unproven.
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

Progress (October 2026): database and API tests prove tenant isolation, platform access, module entitlement, the auth-role boundary and the M0 role matrix with real sessions. Email/password login, session validation, logout, one-time invitation acceptance, role authorization for People and Work, authenticated access-denial audit and the streaming People directory CSV export exist. The React 19 + Vite shell has real sign-in and sign-out, entitlement-and-role-filtered navigation and an empty People screen; one Playwright journey proves the signed-in criterion in a real browser against the built output and a disposable database. A working-tree secret scanner for tracked and untracked non-ignored regular files, a production dependency audit, a schema/privilege inventory over 66 tenant-id tables, a CI workflow contract test, the draft threat model in [`security/m0-threat-model.md`](security/m0-threat-model.md) and the interim evidence pack in [`release/m0-evidence.md`](release/m0-evidence.md) exist. M0 has **not** exited: there is no People data-entry route or screen, scope enforcement or payroll; the Postgres outbox has its claim helpers, `saas_worker` role and polling loop but no producer, no registered production handler and no deployed consumer, so no event ever moves on a real system; the restore capability is a manually executed logical pg_dump/pg_restore drill (`pnpm drill:restore`) verified once locally on PostgreSQL 17.9 against synthetic data — not a scheduled, encrypted backup regime, and not run in CI. The CI workflow has never run on GitHub (no remote), so PostgreSQL 16 and the CI browser job are unproven; the threat model has no named owner or human review; and the design-partner gate remains open.

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
