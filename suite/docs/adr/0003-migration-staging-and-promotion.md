# ADR 0003 — Migration staging and transactional promotion

Status: accepted · October 2026

## Context

Migration is the acquisition wedge. A direct CSV-to-production import is fast to demo and impossible to trust: a bad mapping silently corrupts payroll, and a failed batch leaves partial state. Service businesses switching from greytHR, Keka or spreadsheets need proof that history survived before they cut over.

## Decision

- All imports land in staging tables: `import_batch`, `import_file`, `mapping_profile`, `import_row`, `import_issue`.
- Staging rows keep the raw payload, a normalised payload, a row hash and a status.
- Validation produces stable issue codes with owners and suggested fixes.
- Rehearsal happens in a sandbox tenant; production tables are untouched.
- Promotion is a single transaction, idempotent by `(tenant_id, source_system, source_id)`, and writes provenance columns.
- Reconciliation is a gate: control totals must match or carry a named sign-off.
- Rollback is available until the first production payroll is finalised.
- Every batch remains exportable, including after failure.

## Consequences

- More tables and a real pipeline, not a one-shot upload script.
- Re-running a batch is safe, which makes connector development tractable.
- Staging storage grows; retention and cleanup are explicit.
- Promotion logic must be tested per entity type, not just per connector.
- The product can show evidence of correctness, which is the point.
