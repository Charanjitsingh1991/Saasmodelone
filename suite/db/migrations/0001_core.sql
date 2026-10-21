-- 0001_core.sql
-- Tenancy, identity, jurisdictions, audit, events, documents and approvals.

begin;

create extension if not exists pgcrypto;
create extension if not exists citext;

create schema if not exists app;

-- Returns the tenant for the current transaction, or null when unset.
-- RLS treats null as "no rows", never "all rows".
create or replace function app.current_tenant_id()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('app.tenant_id', true), '')::uuid
$$;

create or replace function app.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create or replace function app.block_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'append-only table % cannot be updated or deleted', tg_table_name
    using errcode = '42501';
  return null;
end;
$$;

create or replace procedure app.enable_tenant_rls(p_table text)
language plpgsql
as $$
begin
  execute format('alter table %I enable row level security', p_table);
  execute format('drop policy if exists tenant_isolation on %I', p_table);
  execute format(
    'create policy tenant_isolation on %I for all using (tenant_id = app.current_tenant_id()) with check (tenant_id = app.current_tenant_id())',
    p_table
  );
end;
$$;

create or replace procedure app.add_updated_at(p_table text)
language plpgsql
as $$
begin
  execute format('drop trigger if exists %I on %I', p_table || '_set_updated_at', p_table);
  execute format(
    'create trigger %I before update on %I for each row execute function app.set_updated_at()',
    p_table || '_set_updated_at',
    p_table
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Tenancy and identity
-- ---------------------------------------------------------------------------

create table tenant (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug citext not null unique,
  data_region text not null,
  default_locale text not null default 'en',
  status text not null default 'active'
    check (status in ('active', 'suspended', 'closed')),
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

alter table tenant enable row level security;
create policy tenant_self on tenant
  for all
  using (id = app.current_tenant_id())
  with check (id = app.current_tenant_id());

create table app_user (
  id uuid primary key default gen_random_uuid(),
  email citext not null unique,
  display_name text not null,
  password_hash text,
  mfa_enabled boolean not null default false,
  status text not null default 'active'
    check (status in ('invited', 'active', 'suspended', 'disabled')),
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table membership (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant (id) on delete cascade,
  user_id uuid not null references app_user (id) on delete cascade,
  role text not null
    check (role in ('owner', 'admin', 'hr', 'finance', 'manager', 'employee', 'auditor')),
  status text not null default 'active'
    check (status in ('invited', 'active', 'suspended')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, user_id)
);

create index membership_user_idx on membership (user_id);
create index membership_tenant_idx on membership (tenant_id);

-- ---------------------------------------------------------------------------
-- Jurisdictions and organisation
-- ---------------------------------------------------------------------------

-- Global reference data. A jurisdiction is a country or a subdivision
-- (state, province, canton). No country is privileged in the schema.
create table jurisdiction (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  country_code char(2) not null,
  parent_id uuid references jurisdiction (id),
  name text not null,
  default_currency char(3) not null,
  default_locale text not null default 'en',
  default_timezone text not null,
  fiscal_year_start_month smallint not null default 1
    check (fiscal_year_start_month between 1 and 12),
  week_starts_on smallint not null default 1
    check (week_starts_on between 0 and 6),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index jurisdiction_country_idx on jurisdiction (country_code);
create index jurisdiction_parent_idx on jurisdiction (parent_id);

create table legal_entity (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant (id),
  name text not null,
  code text not null,
  jurisdiction_id uuid not null references jurisdiction (id),
  currency char(3) not null,
  locale text not null default 'en',
  timezone text not null,
  address jsonb not null default '{}'::jsonb,
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (tenant_id, id),
  unique (tenant_id, id, jurisdiction_id),
  unique (tenant_id, code)
);

create table org_unit (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant (id),
  legal_entity_id uuid,
  parent_id uuid,
  name text not null,
  kind text not null default 'department'
    check (kind in ('department', 'division', 'team', 'cost_center')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (tenant_id, id),
  unique (tenant_id, legal_entity_id, name),
  foreign key (tenant_id, legal_entity_id) references legal_entity (tenant_id, id),
  foreign key (tenant_id, parent_id) references org_unit (tenant_id, id)
);

create table location (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant (id),
  legal_entity_id uuid,
  name text not null,
  timezone text not null,
  address jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (tenant_id, id),
  unique (tenant_id, legal_entity_id, name),
  foreign key (tenant_id, legal_entity_id) references legal_entity (tenant_id, id)
);

-- Tax registrations are business identifiers, not secrets. Owner is
-- polymorphic because legal entities, clients and vendors all carry them.
create table tax_registration (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant (id),
  owner_type text not null
    check (owner_type in ('legal_entity', 'client', 'vendor')),
  owner_id uuid not null,
  jurisdiction_id uuid not null references jurisdiction (id),
  registration_type text not null,
  value text not null,
  is_primary boolean not null default false,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, owner_type, owner_id, jurisdiction_id, registration_type)
);

create index tax_registration_owner_idx
  on tax_registration (tenant_id, owner_type, owner_id);
create unique index tax_registration_primary_uidx
  on tax_registration (tenant_id, owner_type, owner_id, jurisdiction_id)
  where is_primary;

-- ---------------------------------------------------------------------------
-- Audit and outbox
-- ---------------------------------------------------------------------------

create table audit_event (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant (id),
  actor_user_id uuid references app_user (id),
  actor_type text not null default 'user'
    check (actor_type in ('user', 'system', 'api_key', 'support')),
  action text not null,
  entity_type text not null,
  entity_id uuid,
  before_state jsonb,
  after_state jsonb,
  metadata jsonb not null default '{}'::jsonb,
  ip inet,
  user_agent text,
  occurred_at timestamptz not null default now()
);

create index audit_event_tenant_time_idx on audit_event (tenant_id, occurred_at desc);
create index audit_event_entity_idx on audit_event (tenant_id, entity_type, entity_id, occurred_at desc);

create trigger audit_event_immutable
before update or delete on audit_event
for each row execute function app.block_mutation();

create table domain_event (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant (id),
  type text not null,
  aggregate_type text not null,
  aggregate_id uuid not null,
  payload jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  published_at timestamptz,
  attempts integer not null default 0,
  last_error text
);

create index domain_event_unpublished_idx
  on domain_event (occurred_at)
  where published_at is null;
create index domain_event_aggregate_idx
  on domain_event (tenant_id, aggregate_type, aggregate_id);

create table idempotency_key (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant (id),
  key text not null,
  operation text not null,
  request_hash text not null,
  response_status smallint,
  response_body jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  unique (tenant_id, operation, key)
);

create index idempotency_key_expiry_idx on idempotency_key (expires_at);

-- ---------------------------------------------------------------------------
-- Documents and approvals
-- ---------------------------------------------------------------------------

create table document (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant (id),
  entity_type text not null,
  entity_id uuid not null,
  filename text not null,
  mime_type text not null,
  size_bytes bigint not null check (size_bytes >= 0),
  storage_key text not null unique,
  checksum_sha256 text not null,
  version integer not null default 1 check (version > 0),
  is_current boolean not null default true,
  scan_status text not null default 'pending'
    check (scan_status in ('pending', 'clean', 'infected', 'failed')),
  retention_until date,
  uploaded_by uuid references app_user (id),
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (tenant_id, id),
  unique (tenant_id, entity_type, entity_id, filename, version)
);

create index document_entity_idx on document (tenant_id, entity_type, entity_id);
create index document_retention_idx on document (tenant_id, retention_until)
  where deleted_at is null;

create table approval_request (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant (id),
  kind text not null,
  entity_type text not null,
  entity_id uuid not null,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  requested_by uuid references app_user (id),
  decided_by uuid references app_user (id),
  decided_at timestamptz,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id)
);

create index approval_request_entity_idx
  on approval_request (tenant_id, entity_type, entity_id, status);

-- ---------------------------------------------------------------------------
-- RLS and timestamps
-- ---------------------------------------------------------------------------

call app.enable_tenant_rls('membership');
call app.enable_tenant_rls('legal_entity');
call app.enable_tenant_rls('org_unit');
call app.enable_tenant_rls('location');
call app.enable_tenant_rls('tax_registration');
call app.enable_tenant_rls('audit_event');
call app.enable_tenant_rls('domain_event');
call app.enable_tenant_rls('idempotency_key');
call app.enable_tenant_rls('document');
call app.enable_tenant_rls('approval_request');

call app.add_updated_at('tenant');
call app.add_updated_at('app_user');
call app.add_updated_at('membership');
call app.add_updated_at('jurisdiction');
call app.add_updated_at('legal_entity');
call app.add_updated_at('org_unit');
call app.add_updated_at('location');
call app.add_updated_at('tax_registration');
call app.add_updated_at('approval_request');

commit;
