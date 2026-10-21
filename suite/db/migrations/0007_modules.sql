-- 0007_modules.sql
-- Organisation module catalog, optional dependencies and per-tenant entitlements.

begin;

-- Global catalog. A module is a product boundary, not a deployment.
create table platform_module (
  id uuid primary key default gen_random_uuid(),
  code text not null unique
    check (code ~ '^[a-z][a-z0-9_]*$'),
  name text not null,
  category text not null,
  description text not null default '',
  is_licensable boolean not null default true,
  is_core boolean not null default false,
  default_seat_unit text not null default 'employee'
    check (default_seat_unit in ('employee', 'seat', 'organisation')),
  status text not null default 'planned'
    check (status in ('available', 'preview', 'planned', 'retired')),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (not is_core or not is_licensable)
);

create index platform_module_catalog_idx
  on platform_module (status, sort_order)
  where status <> 'retired';

-- Dependencies are optional by default. A hard dependency is allowed only
-- when a module cannot operate at all without the other module's data.
create table platform_module_dependency (
  module_id uuid not null references platform_module (id) on delete cascade,
  depends_on_module_id uuid not null references platform_module (id) on delete cascade,
  optional boolean not null default true,
  reason text,
  primary key (module_id, depends_on_module_id),
  check (module_id <> depends_on_module_id)
);

create table module_entitlement (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant (id),
  module_id uuid not null references platform_module (id),
  status text not null default 'active'
    check (status in ('trialing', 'active', 'suspended', 'cancelled')),
  seat_unit text not null default 'employee'
    check (seat_unit in ('employee', 'seat', 'organisation')),
  seat_count integer
    check (seat_count is null or seat_count > 0),
  starts_at timestamptz not null default now(),
  ends_at timestamptz,
  source text not null default 'contract'
    check (source in ('contract', 'trial', 'internal')),
  contract_ref text,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references app_user (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, module_id),
  check (ends_at is null or ends_at > starts_at)
);

create index module_entitlement_active_idx
  on module_entitlement (tenant_id, status)
  where status in ('trialing', 'active');
create index module_entitlement_module_idx on module_entitlement (module_id);

-- Tenant-safe entitlement check for database-side defence in depth.
-- Application services still enforce the entitlement explicitly.
create or replace function app.has_active_module(p_code text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from module_entitlement e
    join platform_module m on m.id = e.module_id
    where e.tenant_id = app.current_tenant_id()
      and m.code = p_code
      and m.is_licensable
      and m.status in ('available', 'preview')
      and e.status in ('trialing', 'active')
      and e.starts_at <= now()
      and (e.ends_at is null or e.ends_at > now())
  )
$$;

revoke all on function app.has_active_module(text) from public;

-- Ownership contract for the two records every module shares.
comment on table person is
  'Shared directory identity. People owns employment, compensation and payroll extensions; other modules read through the directory service.';
comment on table client is
  'Shared directory client identity. CRM owns relationships and pipeline; Work and Money extend it.';

call app.enable_tenant_rls('module_entitlement');

call app.add_updated_at('platform_module');
call app.add_updated_at('module_entitlement');

commit;
