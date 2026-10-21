# Switch — Migration Blueprint

Status: working document · October 2026
Scope: architecture, data contracts, UX, safety guarantees and delivery plan for the migration console inside SaaSModels One.

---

## 1. Why migration is the product

Every suite demo looks the same. Every migration is different. That is exactly why migration is the wedge.

A 120-person services company has years of payroll history, leave balances, attendance, approval trails, client contracts, documents and invoices spread across three to seven systems. The incumbent can keep them because leaving looks dangerous, not because the product is better. Removing that fear is the strongest acquisition story available to a new suite.

Switch is a **platform capability**, included with any licensed module. It is not sold separately and it is not limited to People. Each import batch declares its target module; the tenant must hold an active entitlement for that module. A CRM-only customer can import accounts, contacts and pipeline without buying HRM.

Commitments that define the product:

1. **History comes with you** — not just names and email addresses.
2. **Nothing is silently lost** — every row is imported or explicitly parked with a reason.
3. **The totals must reconcile** — control totals are shown against the source before cutover.
4. **Cutover is reversible** — until the first production payroll is finalised.
5. **Leaving stays easy** — a complete export is one click, always, including per module.
6. **A module can be added later** — importing into a new module links to the existing shared directory; it does not create a second client or employee record.

---

## 2. Sources and connector order

### First cohort (with People)

| Source | What we take | Mode |
| --- | --- | --- |
| greytHR | Employees, org, salary structures, payslips, leave balances, attendance, documents | API + export fallback |
| Keka | Employees, org, salary, leave, attendance, documents | API + export |
| Zoho People | Employees, org, leave, attendance | API |
| BambooHR | Employees, org, compensation, documents | API |
| CSV / Excel | Any of the above, via templates and mapping | File upload |

### CRM cohort

| Source | What we take | Mode |
| --- | --- | --- |
| HubSpot | Companies, contacts, deals, pipelines, activities, owners | API + export |
| Salesforce | Accounts, contacts, opportunities, activities | Export-first, API where permitted |
| Pipedrive | Organisations, people, deals, stages, activities | API |
| Zoho CRM | Accounts, contacts, deals, notes, activities | API |
| CSV / Excel | Accounts, contacts, opportunities, activity history | File upload |

### Work, Money and Content cohorts

| Source | What we take | Mode |
| --- | --- | --- |
| Harvest / Toggl / Float | Projects, clients, allocations, time entries | Export-first |
| Asana / Jira | Projects, tasks, milestones, assignees | Export |
| Tally / Zoho Books / Xero / QuickBooks | Opening balances, invoices, payments, contacts, tax lines | Export |
| WordPress / Webflow / Contentful | Pages, collections, assets, authors, redirects | Export + API |
| CSV / Excel | Any of the above, via templates and mapping | File upload |

### Later

- SAP Business ByDesign, NetSuite, Oracle HCM (export-first; API where permitted).
- Razorpay Payroll, ADP, Paylocity (evaluation based on customer demand).

**Rule:** never claim a connector is available until it has passed a real migration with a design partner. The website labels cohort availability and the target module. A connector without an active entitlement for its module is visible but disabled, with the reason.

---

## 3. Canonical staging model

Imports never write directly to production tables. Data flows through staging with lineage.

```
source system
   │  connector / file
   ▼
import_batch          one run, one tenant, one entity type, immutable
   ├── import_file     checksum, original filename, storage key, row count
   ├── mapping_profile field map, transforms, constants, version
   ├── import_row      raw payload (JSONB), normalised payload, status, row hash
   └── import_issue    severity, code, message, field, suggested fix, resolved_by
   ▼
validation + dedupe
   ▼
sandbox tenant        full rehearsal, no production effects
   ▼
reconciliation        control totals, exceptions, sign-off
   ▼
promotion            transactional, idempotent, audited
   ▼
production tables + provenance columns
```

### Staging tables

```sql
import_batch (
  id uuid primary key,
  tenant_id uuid not null,
  source_system text not null,
  target_module text not null,        -- catalog code: people, crm, work, money, content
  entity_type text not null,          -- person, employment, account, opportunity, invoice, ...
  status text not null,                -- draft|uploaded|mapping|validating|ready|promoting|complete|failed|rolled_back
  sandbox boolean not null default true,
  row_count integer, accepted_count integer, rejected_count integer,
  control_totals jsonb,
  created_by uuid, created_at timestamptz, completed_at timestamptz
);

import_file (
  id uuid primary key, batch_id uuid not null,
  filename text, checksum text, storage_key text, row_count integer
);

mapping_profile (
  id uuid primary key, tenant_id uuid, source_system text,
  version integer, field_map jsonb, transforms jsonb, created_by uuid
);

import_row (
  id uuid primary key, batch_id uuid not null,
  source_row_number integer, source_id text,
  raw jsonb not null, normalised jsonb,
  row_hash text, status text not null,  -- pending|valid|warning|rejected|imported|skipped
  target_table text, target_id uuid,
  error_count integer default 0
);

import_issue (
  id uuid primary key, batch_id uuid, row_id uuid,
  severity text not null,               -- error|warning|info
  code text not null,                    -- E_DUPLICATE_EMAIL, W_MISSING_STATUTORY_ID, ...
  field text, message text, suggested_fix jsonb,
  resolved_by uuid, resolved_at timestamptz
);
```

Provenance columns on every imported production table:

```
source_system text, source_id text, import_batch_id uuid, imported_at timestamptz
```

Unique constraints on `(tenant_id, source_system, source_id)` make promotion idempotent.

---

## 4. Pipeline stages

### 01 Connect

- OAuth/API key or file upload.
- Read-only credentials. No write access to the source.
- Preflight: available entities, record counts, date ranges, rate limits, data residency.
- Output: a source inventory with counts and gaps.

### 02 Map

- The batch declares its **target module**; the tenant must hold an active entitlement for it before mapping starts.
- Suggested field mapping based on source schema and historical profiles.
- Required fields flagged; transforms (date formats, currency, case, phone, statutory IDs).
- Constants (legal entity, pay cycle, leave policy, pipeline, owner) set once.
- Mapping saved as a versioned profile, reusable across batches and modules.
- Output: mapping profile + unmapped-field report.

### 03 Extract and stage

- Idempotent extraction with checkpointing; resumable.
- Raw payload stored immutably; normalised copy computed.
- Row hash for change detection and duplicate suppression.
- PII encrypted at rest; access limited to the migration role.
- Output: staged rows with lineage.

### 04 Validate

Validation is split into blocking errors and warnings.

| Code | Severity | Example | Fix |
| --- | --- | --- | --- |
| E_DUPLICATE_EMAIL | error | Two employees share a login email | Merge or assign a unique email |
| E_MISSING_REQUIRED | error | No joining date | Provide date or map another field |
| E_BAD_STATUTORY_ID | error | Tax or social-insurance identifier fails the jurisdiction's format | Correct or park the row |
| E_ORPHAN_REFERENCE | error | Leave balance for unknown employee | Map employee or skip |
| W_MISSING_STATUTORY_ID | warning | Required identifier absent for a payroll employee | Collect before first payroll |
| W_SALARY_MISMATCH | warning | Structure total ≠ payslip gross | Review with payroll lead |
| W_DOCUMENT_MISSING | warning | Document referenced but not exported | Upload manually |
| W_DUPLICATE_PERSON | warning | Same name + DOB, different source IDs | Confirm merge |

Rules are deterministic and versioned. Every rule has a human-readable explanation and a suggested fix. No automatic destructive merges.

### 05 Rehearse

- Import into a sandbox tenant with production-like configuration.
- Run payroll preview, leave accrual and attendance calculations.
- Compare against source reports.
- Output: rehearsal report with exceptions by module.

### 06 Reconcile

Control totals that must match or be explicitly explained:

- Headcount by entity, department and status.
- Gross and net payroll by month (last 12 months, or full history if available).
- Leave balances by employee and policy as at cutover date.
- Attendance days and overtime.
- Accounts, contacts and open pipeline by stage and owner (CRM).
- Engagements, projects, allocations and open time entries (Work).
- Open invoices, receivables and opening balances (Money).
- Document counts by type.
- Approval history counts for sampled records.

Reconciliation displays source total, imported total, delta and explanation. The controls required depend on the batch's target module; a CRM import is not blocked because the tenant has no payroll. Sign-off requires a named customer owner.

### 07 Cutover

- Freeze window agreed in writing.
- Final delta sync (changes since rehearsal).
- Promote in a single transaction per entity group; all-or-nothing.
- Post-cutover verification checklist.
- Rollback available until the first production payroll is finalised. After that, corrections are handled by adjustment, not deletion.

### 08 Stay portable

- One-click full export: CSV/JSON + original documents + schema documentation.
- Scheduled exports available.
- API and webhooks for ongoing access.
- Export events are audited and never blocked for commercial reasons.

---

## 5. Reconciliation and rollback

### Reconciliation contract

For each batch, store and display:

```
source_rows, staged_rows, valid_rows, imported_rows, rejected_rows, skipped_rows
control_totals: { headcount, gross_pay, net_pay, leave_balance_days, overtime_hours, ... }
delta: imported - source, with tolerance (0 for counts and money)
sign_off: user_id, timestamp, note
```

A batch cannot be marked `complete` while a blocking delta is unexplained.

### Rollback

- Sandbox: delete the batch and its staged rows; production untouched.
- Promoted batch: reverse by provenance (`import_batch_id`) inside a transaction.
- Payroll finalised: no destructive rollback; use reversal or adjustment entries with audit trail.
- Every rollback is an audited event with a reason.

---

## 6. Security and privacy

- Source credentials stored in a secrets manager, encrypted, scoped read-only, rotated.
- Migration role: least privilege, time-bound, MFA required.
- PII in staging encrypted at rest; column-level encryption for bank, tax and social-insurance identifiers.
- Raw files stored with signed, expiring URLs; deleted after retention window (default 90 days after sign-off).
- Access to staging logged; no production data in developer environments.
- Subprocessors listed; DPA covers migration data.
- Data residency in the region selected for the tenant at provisioning.
- No AI-generated statutory calculations; AI may suggest field mappings, always reviewable.

---

## 7. UX principles

1. **A checklist, not a wizard.** Customers see all stages, what is blocked and who owns the next action.
2. **Every error is actionable.** Row, field, reason, suggested fix, and a link to the source if available.
3. **Counts everywhere.** "1,284 of 1,291 rows ready" beats a spinner.
4. **The customer signs off.** The migration lead sees reconciliation and approves cutover.
5. **No surprises in payroll.** Parallel run is the default for the first cycle.
6. **Plain language.** "Leave balance" not "leave ledger accrual object".

Primary screens:

- Migration overview: source, batch, stage, owner, next action, risk.
- Mapping: suggested fields, confidence, required fields, transforms.
- Issues: filter by severity/entity, bulk fixes where safe.
- Reconciliation: control totals with deltas and explanations.
- Cutover: checklist, freeze window, sign-off, rollback window.

---

## 8. Testing and quality

- **Golden datasets** from anonymised source exports for each connector, versioned.
- **Contract tests** for every connector against recorded fixtures; live smoke tests before release.
- **Validation unit tests** for each rule and each jurisdiction-scoped identifier format.
- **Property-based tests**: any row that passes validation must import with the same control totals.
- **Reconciliation regression suite**: known source totals must match after import, per target module.
- **Rollback tests** on a staging tenant for every release.
- **Entitlement tests**: a batch cannot target a module the tenant has not licensed; cancelling the module blocks new batches but preserves staged and promoted history.
- **Security tests**: cross-tenant access, signed URL expiry, role escalation.
- **Payroll parallel-run acceptance** signed by a qualified local payroll advisor before customer cutover.

Targets:

- 100% of blocking rules covered by tests.
- 0 cross-tenant data exposure (automated negative tests in CI).
- ≥ 99.5% row acceptance on supported sources; every rejection explained.
- Migration runbook tested quarterly with a synthetic tenant.

---

## 9. Delivery plan

| Milestone | Window | Deliverable |
| --- | --- | --- |
| S0 | Q4 2026 | Staging schema with target module, CSV/Excel importer, validation engine, issues UI, reconciliation report |
| S1 | Q4 2026 | greytHR connector, document import, sandbox promotion, rollback |
| S2 | Q1 2027 | Keka + Zoho People, payroll history, leave balance reconciliation, parallel run workflow |
| S3 | Q2 2027 | BambooHR, saved mapping profiles, bulk fixes, migration dashboard, module-aware controls |
| S4 | Q2–Q3 2027 | HubSpot/Zoho CRM connectors, account/contact/pipeline reconciliation; Work export adapters |
| S5 | 2027–2028 | Money/Content sources, SAP ByD/NetSuite export adapters, partner migration certification |

Team: 3–4 engineers (one data engineer), 1 designer, 1 QA automation, payroll domain expert, security reviewer.

---

## 10. Open questions

1. Full payroll history vs last 12 months: what is the minimum customers need for disputes and statutory queries?
2. Document retention: do customers expect us to import every historical document, or only active ones?
3. Parallel payroll: which incumbent reports are authoritative when totals disagree?
4. Multi-entity migrations: one batch per entity or one batch with entity scoping?
5. Who signs reconciliation when the customer's HR and finance disagree?
6. Do we support migration from spreadsheets that were never a real system? (Likely yes, with templates.)
7. Should Switch be sold standalone to non-customers? (No. It is included with any licensed module; selling it alone creates support load without platform revenue.)
8. When a customer adds a second module, which existing directory fields become authoritative, and who resolves conflicts — the customer owner, not an automatic merge.
9. How long after cancelling a module should its records stay read-only and exportable? (Default: the contract's retention window, minimum 90 days, with a documented deletion request.)
