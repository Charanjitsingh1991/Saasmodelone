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

## Clarification — October 2026

The decision above says "every tenant table". The verified M0 inventory is narrower and this clarification records the intended reading without rewriting the accepted text:

- 66 public tables carry `tenant_id`; 64 are tenant business tables with RLS enabled and a permissive `tenant_isolation` policy.
- The two identity tables `auth_session` and `invitation` carry `tenant_id` but deliberately have no RLS. A session must resolve before `app.tenant_id` exists, and an invitation token is a pre-authentication credential. The runtime role has no table privilege on either; access is through `saas_auth` and security-definer auth functions with hashed tokens. Tenant and membership checks run after session resolution.
- `tenant` has RLS and a `tenant_self` policy but no `tenant_id` column.
- No relation currently has `FORCE ROW LEVEL SECURITY`; provisioning is tested under FORCE but no baseline migration enables it.

The exception set and runtime grants are executable assertions in `tests/schema-inventory.test.ts`. A future identity table does not inherit this exception automatically: it needs the same review, no runtime grant and a security-definer access path.
