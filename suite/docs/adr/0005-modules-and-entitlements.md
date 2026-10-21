# ADR 0005 — One organisation, independently licensable modules

Status: accepted · October 2026

## Context

Customers do not adopt a suite in one purchase. A 120-person agency may need HRM and payroll first, a sales-led consultancy may need CRM first, and a finance team may want invoicing without replacing its HR system. A product that only sells the whole suite loses the first buyer and forces every module to justify a bundle.

At the same time, per-module licensing usually recreates the integration tax it claims to remove: each module keeps its own person and client, and the vendor charges to reconnect them. That outcome is worse than a suite.

## Decision

1. **One organisation workspace.** The tenant is the organisation. Legal entities, locations, departments, memberships and the shared directory belong to it.
2. **A module catalog.** Every module has a stable code, ownership boundary, lifecycle status and seat unit. The catalog is data, not a code fork.
3. **Independent entitlements.** A tenant can license one module, several modules or all of them. Entitlements have a trial, active, suspended and cancelled lifecycle and are checked in the API before authorization.
4. **A shared platform core.** Identity, directory, roles, audit, documents, approvals, search, notifications, export and Switch are included with any module. Integration is a property of the record, never a line item.
5. **Standalone by default.** Modules may have optional dependencies, but no domain module requires another domain module to operate. The shared directory carries person and client identity so Work and Money are useful without HRM or CRM.
6. **The suite is a bundle, not a separate product.** Full-suite licensing activates every module against the same schema, permissions and audit trail.
7. **No schema fork by package.** A single-module tenant and a full-suite tenant run the same migrations. Data for unlicensed modules is absent, not structurally different.
8. **Data survives cancellation.** Suspension stops writes; cancellation leaves a read-only export window before purge. A customer never has to buy another module to retrieve its own data.

Switch is a platform capability, not a purchasable module. It is available with whatever module the customer licenses.

## Consequences

- Packaging is a first-class product concern, not a sales spreadsheet. The module catalog and entitlement states need their own UI, tests and audit events.
- The shared directory must be designed before the second module ships; otherwise CRM and Work will create local copies of the client.
- Authorization has two questions: is the module licensed, and is this user allowed to act inside it? Tests must cover both, including direct API calls.
- Module-level pricing is now possible without module-level data silos. The commercial model can price modules individually while keeping one record and one export.
- Bundle discounts and trials become entitlement policy; they do not change the runtime.
- Modules can be sequenced by customer demand rather than a single launch date. The catalog will contain planned modules that cannot be licensed yet, and the UI must label them honestly.
