# ADR 0002 — PostgreSQL RLS plus application tenant context

Status: accepted · October 2026

## Context

Tenant escape is the most damaging failure mode for an HR and payroll product. Application-level `where tenant_id = ?` filters are necessary but not sufficient: one missed filter, background job or ad-hoc query can expose another company's payroll. The database must enforce the boundary too.

## Decision

- Every tenant table carries `tenant_id` and has Row-Level Security enabled.
- The runtime database role does not own tables and cannot bypass RLS.
- Each request and job runs in a transaction that sets `set local app.tenant_id`.
- The policy compares `tenant_id` to `app.current_tenant_id()`, which returns null when unset. Null means no rows.
- Cross-tenant references are blocked with composite `(tenant_id, id)` foreign keys.
- Tenant provisioning and login-time membership discovery use a narrow privileged path that is audited and unavailable to normal requests.

## Consequences

- A missing tenant filter returns nothing instead of everything.
- Connection pooling must clear transaction-local settings; this is covered by tests.
- Migrations and administrative jobs need an explicit privileged role or an operator-set tenant context.
- Some queries need `security definer` functions; each one is reviewed and kept minimal.
- Slight index overhead for composite constraints, accepted for isolation guarantees.
