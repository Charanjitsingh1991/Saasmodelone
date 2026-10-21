# SaaSModels One — Product Blueprint

Status: working document · October 2026
Owner: SaaSModels
Scope: the product, market, data model, security baseline, pricing and phased plan for the suite that replaces the concept catalog as the company's commercial focus.

---

## 1. Decisions already made

1. The 12 products currently on saasmodels.tech are **concept studies**, not live products. They remain as a public lab and a source of module ideas. They are not sold, licensed or acquired.
2. The commercial product is **SaaSModels One**: one organisation workspace for service businesses, with a platform core and a catalog of independently licensable modules — **People (HRM), CRM, Work, Money (finance and ERP foundation), Content** — plus a first-class migration console called **Switch**. Procurement, assets and analytics are catalog entries for later; they are not sold today.
3. A customer can buy **one module, several, or the full suite**. Every purchase includes the same organisation shell, shared person and client directory, permissions, audit, documents and export. A full suite is every entitlement on one schema, not a separate edition or a second product.
4. The beachhead is **service businesses with 50–500 employees**: IT services, digital agencies, consultancies, design and engineering studios. The core is jurisdiction-neutral; the first payroll pack is selected with cohort 01, not assumed by the schema.
5. The first shippable slice is **People + Switch**, because HR and payroll data is the hardest thing to migrate and therefore the strongest reason to choose a new platform. The organisation shell, module catalog and entitlement model ship with it, so CRM, Work, Money or Content can be added later without a data migration.
6. Migration is not an onboarding feature. It is a product with its own team, interface, guarantees and pricing. Switch is available with any licensed module; the target module is chosen per import batch.
7. No feature claims, customer logos, certifications or traction figures appear on the site until they are true. Module availability follows the catalog status, not the sales deck.

---

## 2. The market and the wedge

### The buyer

| Role | Cares about | Fails today because |
| --- | --- | --- |
| Founder / COO | Margin, headcount cost, client profitability | Numbers arrive late and disagree across tools |
| HR lead | Payroll accuracy, attendance, documents, compliance | Payroll runs on spreadsheets and a portal login |
| Finance lead | Invoicing, collections, project margin | Reconciles five exports every month |
| Delivery lead | Utilization, staffing, scope changes | Resourcing lives in a spreadsheet; project truth in another tool |
| Employee | Payslips, leave, documents, timesheets | Logs into three systems and still emails HR |

The economic buyer is the founder/COO. The operational champions are HR and finance. A suite wins when all three trust the same number.

### Why the mid-market is underserved

- **HR platforms** (greytHR, Keka, Zoho People, BambooHR) stop at people. Project margin, client billing and content live elsewhere.
- **ERP platforms** (SAP Business ByDesign, NetSuite) assume a finance department, a consultant and a six-month implementation. A 120-person agency cannot absorb that.
- **Point tools** are excellent at one job and terrible at sharing a record. Every tool keeps its own copy of the client, the person and the project.
- **Agencies and IT services firms** run a matrix of utilization, project margin and payroll that generic SaaS does not model.
- The result: 7–12 tools, four copies of every client, monthly reconciliation, and a founder making decisions from last month's numbers.

### The wedge

> **One record for every person, client, project, document and unit of currency — with a migration path that keeps the history.**

The wedge is not "more features". It is:

1. **One canonical record.** People, clients, projects, documents and invoices share identifiers, permissions and history — whichever modules the customer buys.
2. **Migration-first.** Switch imports from the incumbent, validates, rehearses and reconciles before cutover. Most suites treat migration as a CSV upload; we treat it as the reason to switch.
3. **Service-business economics.** Utilization, project margin and payroll cost are first-class, not custom reports.
4. **Modular by packaging, single by architecture.** A customer can start with CRM, HRM or finance and add the rest later. The platform core and integration are included, never a paid add-on. A bundle is a discount, not a separate codebase.
5. **Operational honesty.** A public build log, clear status labels and a price that names what is actually licensed.
6. **Exit is easy.** Continuous export, open formats, documented API. Trust is earned by making leaving possible — including leaving one module.

### Positioning statement

> For 50–500 person service businesses that have outgrown disconnected tools, **SaaSModels One** is the operating system that puts people, clients, work, content and money on one record. Buy only the modules you need. Unlike HR suites that stop at payroll, CRMs that never see delivery, or ERPs that require a consulting project, One includes the organisation, the shared directory and **Switch** — a migration console that brings history across, proves it reconciles, and keeps it portable.

### What "individual module" means commercially

- The customer licenses named modules for a named organisation. Entitlements live in the platform, not in a separate build or database.
- The **platform core is always included**: organisation, legal entities, memberships, roles, audit, documents, search, notifications, API and export.
- **Switch is included** with any module that needs history imported; it is not a separate purchase.
- Modules are useful alone. CRM does not require People. Money does not require Work. Where a module *extends* another, the dependency is declared, optional by default, and degrades gracefully.
- Removing a module removes access, never the customer's data. Records remain exportable; re-activation restores the workspace without re-import.
- A **full-suite** contract activates every module entitlement. There is no schema fork, no migration between editions and no "upgrade project".

### Non-goals for the first 24 months

- Full general ledger, statutory tax filing or audit-grade accounting.
- Payroll coverage for every country at launch. The platform supports jurisdiction packs; a jurisdiction is covered only after its rules are reviewed and tested locally.
- A marketplace, app store or partner ecosystem.
- Enterprise HR features for 5,000+ employees (complex grading, global mobility, union rules).
- Feature parity with SAP or Workday. Breadth is not the strategy; trust and coherence are.
- Building all 12 concept studies. Most should stay studies.

---

## 3. Product architecture

### Organisation and packaging

One organisation is the tenant. Inside it:

```
organisation
  ├── memberships, roles and scopes
  ├── module entitlements          which modules this organisation may use
  ├── legal entities               jurisdiction, currency, locale, timezone
  ├── shared directory             person identity, client identity and contacts
  ├── module data                  People, CRM, Work, Money, Content
  └── platform services            audit, documents, approvals, search, export, Switch
```

The customer sees one workspace with a module switcher, not five products with five logins. Provisioning is: create the organisation and legal entity, choose a data region, select the first module or the full suite, invite members, configure the shared directory, then import history with Switch or start clean. Adding a module later is an entitlement and configuration change on the same tenant.

### Module catalog

| Module | Category | First job | Status (Oct 2026) |
| --- | --- | --- | --- |
| Core platform | Platform | Organisation, identity, roles, audit, documents, export | In build |
| Switch | Platform capability | Migration, validation, rehearsal, reconciliation | In build |
| People | HRM | Employee record, leave, attendance, payroll, documents | In build |
| CRM | Customer relationships | Accounts, contacts, pipeline, activity, forecast | In design |
| Work | Projects and delivery | Engagements, projects, allocations, timesheets, margin | In design |
| Money | Finance and ERP foundation | Proposals, contracts, invoices, payments, expenses | In design |
| Content | CMS and knowledge | Pages, assets, knowledge, client rooms | Research |
| Procurement | Finance and ERP foundation | Purchase requests, orders, vendor bills | Planned, not sold |
| Assets | Operations | Asset register, assignment, maintenance | Planned, not sold |
| Analytics | Platform | Cross-module reporting and warehouse | Planned, not sold |

Core platform and Switch are not licensable modules. They are included with every paid module. The catalog is reference data with a status; sales may only quote a module in `available` or `preview`.

### Module detail

#### People (HRM) — first to ship

Core HRIS and payroll with jurisdiction packs for service businesses.

- Employee record: personal, contact, emergency, bank, jurisdiction-scoped identifiers, documents, assets, lifecycle.
- Org: legal entities, departments, locations, reporting lines, cost centres, grades.
- Onboarding and exit checklists, document expiry, letters and templates.
- Leave: policies, accruals, balances, encashment, holidays, calendars.
- Attendance: web/mobile punch, shifts, rosters, regularisation, overtime, geo/fence optional.
- Payroll: salary structures, earnings/deductions, arrears, hold/release, bank file, payslips, reimbursements. One run, one legal entity, one jurisdiction, one currency.
- Payroll packs: contribution, withholding, social-insurance and statutory-report rules for each covered jurisdiction, with effective dates and local reviewer sign-off. Reports and bank files are pack-defined. Rules are never generated by an LLM.
- Compliance calendar: due dates, evidence, ownership, per jurisdiction.
- Performance-lite: goals, review cycles, feedback, promotion history. No nine-box theatre in v1.
- Contractor and consultant payments, with a separate compliance path.

Out of scope for People v1: recruitment ATS, benefits marketplace, learning management, and payroll coverage for jurisdictions without an approved rule pack.

#### CRM — second to design

The customer relationship module for service businesses: enough pipeline to run the business, connected to delivery and billing rather than a separate sales database.

- Accounts and contacts on the shared client identity; no duplicate client records when Work or Money is added.
- Leads and qualification, with source, owner and conversion into an account.
- Pipelines, stages, probability and expected close, per team and per owner.
- Activities: calls, emails, meetings, notes, tasks, with a timeline on the account.
- Relationship health: last contact, open opportunities, won/lost history, renewal dates.
- Forecast and coverage: weighted pipeline by period, owner and service line.
- Handoff to Work (engagement) and Money (proposal) as a linked record, not a copy.
- Consent and contact preferences stored with the contact for privacy compliance.

Out of scope for CRM v1: marketing automation, bulk email campaigns, ad management, a support desk, telephony and CPQ. Proposals deliberately live in Money.

#### Work — third

- Clients and contacts, account ownership, agreements.
- Engagements, projects, tasks, milestones, deliverables, scope changes.
- Resourcing: roles, allocations, capacity, bench, utilization.
- Timesheets: billable/non-billable, approvals, rates, cost rates.
- Approvals: timesheets, expenses, scope, deliverables.
- Client portal: progress, deliverables, approvals, documents, invoices.
- Project profitability: revenue, cost, margin, realization, utilization.
- Delivery health: budget burn, change orders, timeline risk.

Out of scope for Work v1: software issue tracking, support desk, full Agile planning.

#### Content — fourth

- Marketing CMS: pages, collections, SEO fields, publishing workflow, scheduled publish.
- Digital asset management: folders, tags, versions, renditions, rights/expiry.
- Knowledge base and SOPs, with review dates and owners.
- Client document rooms and approval trails.
- Templates for proposals, contracts, letters and reports.
- Public API and webhooks for the marketing site.

Out of scope for Content v1: marketing automation, email campaigns, ad management.

#### Money — finance and ERP foundation

The commercial record from proposal to cash. This is the foundation a service business needs; it is not a general ledger, a manufacturing ERP or a replacement for statutory accounting.

- Proposals: reusable blocks, pricing, versions, client comments, acceptance.
- Contracts and SOWs: templates, e-signature, renewal dates, obligations.
- Rate cards, retainers, milestones, change orders.
- Invoices: tax treatment, tax jurisdiction, multi-currency, recurring, credit notes, tax lines that support national and subnational components.
- Payments: payment-provider integrations by region, bank transfer, statement import, reconciliation, dunning.
- Expenses and vendor bills, approvals, reimbursements.
- Collections ageing, project margin, cash view, forecast-lite.
- Accounting exports and regional accounting integrations rather than replacing the ledger.

Out of scope for Money v1: general ledger, statutory filing, payroll accounting postings beyond exports, procurement, inventory and fixed-asset accounting. Those are catalog entries for a later decision, not promises.

#### Switch — platform capability, available with any module

The migration console. See `docs/migration-blueprint.md`.

- Source connectors, CSV/Excel fallback, field mapping, validation, duplicate detection.
- Sandbox import, reconciliation, parallel run, rollback, cutover.
- Document, payroll, attendance and approval history.
- A target module is selected per batch; importing CRM accounts does not require a People licence.
- One-click export of everything, always.

### Platform spine (shared by all modules)

| Capability | v1 requirement |
| --- | --- |
| Tenancy | Tenant per company; optional multiple legal entities; strict isolation |
| Module entitlements | Catalog, per-tenant entitlements, trials, suspension, cancellation and reactivation; checked server-side on every module request |
| Shared directory | Person identity and client identity with contacts and tax registrations; modules extend, never fork |
| Identity | Email/password + Google/Microsoft OAuth; SSO (SAML/OIDC) and SCIM at enterprise tier |
| Authorization | Role-based access + scoped roles (entity, department, project, client); entitlement is checked before role |
| Audit | Append-only audit events for privileged actions, entitlement changes and data exports |
| Documents | Versioned object storage, virus scan, signed URLs, retention |
| Workflow | Approval chains, delegation, reminders, escalation |
| Notifications | In-app, email; digest controls |
| Search | Cross-module search with permission-aware results; only entitled modules are indexed for the user |
| Reporting | Saved views, scheduled exports; no report builder in v1 |
| API | REST + webhooks, scoped API keys; module scopes in tokens |
| Portability | Full export in CSV/JSON + documents; per-module export; documented schema |
| Localization | Per-entity currency, locale, tax regime and date/number formats; English UI v1 |

---

## 4. Data model

Principles:

- Every table carries `tenant_id`; every query is scoped by it; Postgres Row-Level Security as a second line of defence.
- **Module is an entitlement, not a schema boundary.** A tenant buys modules; it does not get a different database. Module data is colocated and linked by shared identifiers, and access is gated by entitlement plus role.
- **The shared directory is owned by the platform.** `person` and `client` identities are canonical. People owns employment, compensation and payroll extensions; CRM owns relationship and pipeline; Work owns engagements and delivery; Money owns billing. No module creates a parallel client or employee table.
- UUIDv7 identifiers; `created_at`, `updated_at`, `deleted_at` (soft delete) everywhere.
- Money stored as integer minor units (`bigint`) plus currency; never floats.
- Statutory identifiers and bank details are classified as sensitive PII, encrypted at the application layer or column level. Identifiers are typed by jurisdiction, not by a hard-coded national format.
- Every legal entity selects a jurisdiction, currency, locale and timezone. No country or currency is a schema default.
- Every imported record carries `source_system`, `source_id`, `import_batch_id` and `imported_at`.
- No hard deletes for payroll, audit or approval records; retention policy per jurisdiction. Cancelling a module ends access, not the customer's ability to export.
- Domain events (`person.created`, `opportunity.won`, `payroll.finalised`, `invoice.paid`) feed audit, notifications and cross-module workflows. Consumers must tolerate a module being absent or unentitled.

Core entities:

```
jurisdiction ── payroll_rule_pack ── payroll_rule
tenant
  ├── module_entitlement ── platform_module ── platform_module_dependency
  ├── legal_entity (jurisdiction, currency, locale, timezone)
  ├── tax_registration (legal entity, client, vendor)
  ├── org_unit
  ├── location
  ├── person ── employment ── compensation ── bank_account      shared directory + People
  │     ├── person_identifier (jurisdiction-scoped types)
  │     ├── document
  │     ├── leave_policy / leave_balance / leave_request
  │     ├── attendance_day / shift / roster
  │     ├── payroll_run → payslip → payslip_line
  │     └── timesheet entry / project allocation
  ├── client ── contact                                          shared directory
  │     ├── lead / opportunity / pipeline / activity              CRM
  │     ├── engagement ── project ── milestone ── task             Work
  │     │      ├── allocation
  │     │      ├── timesheet → timesheet_entry
  │     │      ├── deliverable
  │     │      └── project_cost
  │     └── proposal → contract → invoice → tax_line → payment    Money
  ├── content_item / asset / knowledge_page
  ├── expense / vendor_bill
  ├── audit_event
  └── import_batch → import_row → import_issue
```

Canonical relationships that make the suite defensible:

- A `person` can be allocated to a `project`; that allocation produces timesheet cost; payroll cost and project cost meet in margin.
- A `client` owns `contact`s, `opportunity`s, `engagement`s, `invoice`s, `document`s and portal access. CRM, Work and Money extend the same client row.
- A `document` can attach to a person, client, project, contract or payroll run without duplication.
- Permissions resolve from entitlement + role + scope, not from the module being installed.
- A tenant with only CRM still has people and clients in the directory; a tenant with only People still has a client table for documents and approvals. Buying a module adds capability, not a second copy of the world.

---

## 5. Migration and onboarding

The full architecture is in `docs/migration-blueprint.md`. Product commitments:

- **Connector or file.** Native connectors for the first cohort; CSV/Excel for every other source.
- **Rehearse before cutover.** Import into a sandbox tenant, reconcile totals, then promote.
- **No silent loss.** Every rejected row is visible with a reason and a fix.
- **Parallel run.** One payroll cycle can run alongside the incumbent.
- **Rollback.** Cutover is reversible until the first production payroll is finalised.
- **Export always.** One-click full export, including documents, in open formats.

Success measures:

- ≥ 99.5% of source rows imported or explicitly parked with a reason.
- Totals reconcile to source for headcount, payroll gross/net, leave balances and open invoices.
- First migration completed in under 10 working days; routine migrations in a weekend.
- Zero unresolved P1 data issues at cutover.

---

## 6. Security, privacy and compliance

Target state, not current certification. The website must say "programme" or "target", never "certified".

### Baseline (before first design partner)

- Data residency in the region selected for the tenant at provisioning, encrypted at rest and in transit. The first region is chosen with cohort 01.
- Tenant isolation with RLS and automated cross-tenant tests.
- RBAC, SSO-ready identity, MFA for admins, session management.
- Audit log for logins, permission changes, exports and payroll actions.
- Secrets management, least-privilege infrastructure, no production data in development.
- Backups with point-in-time recovery; documented RPO 15 minutes / RTO 4 hours.
- Vulnerability scanning, dependency pinning, SAST in CI, annual penetration test before GA.
- Incident response runbook, breach notification process, subprocessor register.
- GDPR-aligned DPA baseline with local-law addenda where required (including DPDP where it applies), purpose limitation, retention and deletion.
- PII classification, access reviews, field-level encryption for bank and statutory IDs.

### Certification path

1. Design partners: security questionnaire, architecture note, DPA, pen test.
2. GA: SOC 2 Type I readiness, then Type II observation window (6–12 months).
3. Enterprise: ISO 27001 evaluation based on customer demand.
4. Payroll: annual independent review of statutory calculations and reports with a qualified local payroll advisor for each covered jurisdiction.

### AI policy

- AI assists with drafting, search, anomaly detection and migration mapping suggestions.
- AI never computes statutory payroll, files returns or makes final approval decisions.
- Customer data is not used to train shared models; enterprise/zero-retention providers only.
- Every AI suggestion is labelled, reversible and logged.

---

## 7. Pricing and packaging

Principles:

- **Price the module the customer licenses.** The platform core, shared directory, audit, API and export are included in every paid module. Integration is never a line item.
- **A module must be affordable alone.** A CRM-only or finance-only buyer should not pay for HRM to get a client record.
- **Bundles are discounts, not a different product.** Complete activates every module on the same tenant; there is no upgrade migration.
- Migration is included. Annual contracts, no implementation maze, published bands.
- Prices are indicative until an order form is signed. The reference list currency is INR; the contracting currency and applicable taxes are stated on the order form.

| Offer | Target | Indicative price | Includes |
| --- | --- | --- | --- |
| Single module | 10–500 employees | from ₹149 / seat / month, annual | One module, core platform, Switch for that module's history, standard support |
| People + Switch | 25–150 employees | ₹249 / employee / month, annual | People, payroll packs, documents, Switch |
| Complete | 50–500 employees | ₹649 / employee / month, annual | All five modules, Switch, portal, API |
| Enterprise | 500+ / multi-entity | Custom | SSO/SCIM, residency options, dedicated support, security review |

Indicative single-module rate card:

| Module | Unit | Indicative price | Notes |
| --- | --- | --- | --- |
| People | employee / month | ₹249 | Includes payroll packs and Switch |
| CRM | seat / month | ₹249 | 10-seat minimum |
| Work | employee / month | ₹199 | Timesheets and margin included |
| Money | employee / month | ₹249 | Proposals, invoices, payments, expenses |
| Content | seat / month | ₹149 | CMS, knowledge, document rooms |

- Minimum 10 seats for a single module; minimum 25 employees for People + Switch and Complete.
- Complete is priced per employee and includes every module, so a customer does not have to forecast module seats. Single-module pricing uses the unit above.
- Design partners: founding rate (target 50% for 12 months), migration included, direct product line, case-study participation optional.
- Standard implementation and migration from ₹75,000 one-time, waived for design partners.
- No charge for API access, audit logs, data export, adding a legal entity or switching on a module that is already contracted.
- Module cancellation does not delete data; the tenant keeps read/export access to the cancelled module's records for the contracted retention window.
- Website prices are labelled indicative. The reference list currency is INR; the contracting currency and applicable taxes are stated in the order form.

Unit economics target: gross margin ≥ 78% at scale; support cost ≤ 8% of revenue; CAC payback < 18 months. A single-module account must cover its own support and infrastructure cost; if it cannot, the module is not sellable alone.

---

## 8. Roadmap and team

### Phased delivery

| Phase | Window | Scope | Exit criteria |
| --- | --- | --- | --- |
| M0 Foundations | Q4 2026 | Tenancy, identity, RBAC, audit, module catalog and entitlements, organisation provisioning, People core (records, org, documents, leave), Switch v0 (CSV + greytHR), design system | 3 design partners onboarded; employee + leave data migrated and reconciled; a tenant can be provisioned with one or several module entitlements |
| M1 First payroll pack | Q1 2027 | Attendance, payroll, payslips, reimbursements, statutory reports, compliance calendar for the first reviewed jurisdiction pack | First parallel payroll run signed off by a qualified local advisor; 5–8 paying design partners |
| M2 CRM + Work | Q2–Q3 2027 | Accounts, contacts, pipeline, activity and forecast; clients, projects, allocations, timesheets, utilization, project margin, portal beta | CRM adopted weekly as a standalone module by 3 customers; utilization and margin adopted weekly by 5 customers on the same client record |
| M3 Money + Content | Q4 2027–Q1 2028 | Proposals, contracts, invoices, tax lines, payments, expenses; CMS, knowledge, DAM, client rooms | Invoice-to-payment cycle live; 20+ customers; at least one customer running four of the five modules on one tenant |
| M4 Suite GA | 2028 | SSO/SCIM, SOC 2 Type II, partner programme, deeper connectors, procurement/assets/analytics only against customer demand | 50+ customers, NRR > 110%, support cost target met; module attach and standalone retention both measured |

### Team shape (realistic, not a pitch)

- 12–18 engineers across platform, People, Work, Money, Switch.
- 1 product lead, 2 designers, 2 QA/automation, 1 DevOps/SRE, 1 security lead (fractional at first).
- Payroll domain: 1 payroll lead + 1 local payroll/statutory reviewer + external compliance reviewer per covered jurisdiction.
- Migration: 3–4 engineers with data engineering experience.
- Customer success: 1 per 15–20 design partners at the start.
- Total: ~20–25 people at M2; 18–24 months to a credible suite. A single model cannot compress payroll compliance.

### What not to do

- Do not build all modules at once. Build one that stands alone, prove it with design partners, then add the next.
- Do not sell a module whose catalog status is `planned`; do not quote a module in `research` as if it were buyable.
- Do not fork the schema or create a separate edition for the full suite.
- Do not make integration, the shared directory or export a paid add-on.
- Do not promise "more features than the incumbent suite"; promise a better record, migration and service-business margin.
- Do not let AI generate statutory logic.
- Do not accept a design partner whose data cannot be migrated.
- Do not publish a certification, customer count or benchmark that is not independently true.

---

## 9. Success metrics

- Design partners onboarded and activated (target 10 by M1).
- Migration reconciliation accuracy (≥ 99.5% rows; 100% on control totals).
- Time to first payroll (target < 15 working days from kickoff).
- Weekly active admins per account (target ≥ 60% of licensed admins).
- Module adoption: ≥ 2 modules used weekly by 70% of accounts by M3.
- Standalone retention: a customer who bought one module renews without needing a bundle.
- Module attach rate after first renewal (target ≥ 35% add a second module within 12 months).
- Entitlement-to-use rate: every active entitlement has at least one weekly active user; unused entitlements trigger a customer conversation, not an automatic renewal.
- Payroll exceptions per 100 employees (trend down).
- Support tickets per 100 employees per month (target < 3).
- Net revenue retention (target > 110% by M4).
- Export usage (tracked, not discouraged — it is a trust signal).

---

## 10. Website truth rules

1. The suite is **pre-launch**. Say so on the home page and in the footer.
2. Status labels are literal: `In build`, `In design`, `Research`. No "beta" unless users are using it.
3. Do not name customers, design partners or advisors without written permission.
4. Security claims use "target", "programme" or "designed for"; never "certified" until the report exists.
5. Prices are indicative until a signed order form exists; no checkout.
6. Product previews are illustrative and labelled as such.
7. The lab is labelled **concept studies**; no prices, acquisition offers or fake traction.
8. Migration connector availability is labelled by cohort: first cohort, next, later.
9. Module availability follows the catalog: `available`, `preview`, `planned`. The site may describe a planned module as planned; it may not offer it for sale or imply it can be enabled today.
10. Every module page states what is included, what is not, and whether it requires another module. "Buy only what you need" is only true if the limits are visible.
