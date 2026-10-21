-- 0006_migration.sql
-- Switch: staging, mapping, validation, reconciliation and provenance.

begin;

create table import_batch (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant (id),
  source_system text not null,
  entity_type text not null,
  mode text not null default 'rehearsal'
    check (mode in ('rehearsal', 'production')),
  status text not null default 'draft'
    check (status in ('draft', 'uploaded', 'mapping', 'validating', 'ready', 'promoting', 'complete', 'failed', 'rolled_back')),
  sandbox boolean not null default true,
  row_count integer not null default 0 check (row_count >= 0),
  accepted_count integer not null default 0 check (accepted_count >= 0),
  rejected_count integer not null default 0 check (rejected_count >= 0),
  control_totals jsonb not null default '{}'::jsonb,
  created_by uuid references app_user (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  promoted_at timestamptz,
  rolled_back_at timestamptz,
  unique (tenant_id, id)
);

create index import_batch_status_idx on import_batch (tenant_id, status, created_at desc);

create table import_file (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant (id),
  batch_id uuid not null,
  filename text not null,
  content_type text,
  checksum_sha256 text not null,
  storage_key text not null,
  row_count integer not null default 0 check (row_count >= 0),
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, storage_key),
  foreign key (tenant_id, batch_id) references import_batch (tenant_id, id) on delete cascade
);

create table mapping_profile (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant (id),
  source_system text not null,
  entity_type text not null,
  version integer not null default 1 check (version > 0),
  field_map jsonb not null default '{}'::jsonb,
  transforms jsonb not null default '{}'::jsonb,
  constants jsonb not null default '{}'::jsonb,
  created_by uuid references app_user (id),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, source_system, entity_type, version)
);

create table import_row (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant (id),
  batch_id uuid not null,
  source_row_number integer not null check (source_row_number > 0),
  source_id text,
  raw jsonb not null,
  normalised jsonb,
  row_hash text,
  status text not null default 'pending'
    check (status in ('pending', 'valid', 'warning', 'rejected', 'imported', 'skipped')),
  target_table text,
  target_id uuid,
  error_count integer not null default 0 check (error_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, batch_id, source_row_number),
  foreign key (tenant_id, batch_id) references import_batch (tenant_id, id) on delete cascade
);

create index import_row_batch_status_idx on import_row (tenant_id, batch_id, status);
create index import_row_source_idx on import_row (tenant_id, batch_id, source_id);

create table import_issue (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant (id),
  batch_id uuid not null,
  row_id uuid,
  severity text not null check (severity in ('error', 'warning', 'info')),
  code text not null,
  field text,
  message text not null,
  suggested_fix jsonb,
  resolved_by uuid references app_user (id),
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, batch_id) references import_batch (tenant_id, id) on delete cascade,
  foreign key (tenant_id, row_id) references import_row (tenant_id, id) on delete cascade
);

create index import_issue_batch_idx on import_issue (tenant_id, batch_id, severity, code);

create table reconciliation (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant (id),
  batch_id uuid not null,
  metric text not null,
  source_value numeric(20,4) not null,
  imported_value numeric(20,4) not null,
  difference numeric(20,4) generated always as (imported_value - source_value) stored,
  unit text,
  status text not null default 'pending'
    check (status in ('pending', 'matched', 'exception', 'signed_off')),
  details jsonb not null default '{}'::jsonb,
  signed_off_by uuid references app_user (id),
  signed_off_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, batch_id, metric),
  foreign key (tenant_id, batch_id) references import_batch (tenant_id, id) on delete cascade
);

create index reconciliation_batch_idx on reconciliation (tenant_id, batch_id, status);

call app.enable_tenant_rls('import_batch');
call app.enable_tenant_rls('import_file');
call app.enable_tenant_rls('mapping_profile');
call app.enable_tenant_rls('import_row');
call app.enable_tenant_rls('import_issue');
call app.enable_tenant_rls('reconciliation');

call app.add_updated_at('import_batch');
call app.add_updated_at('mapping_profile');
call app.add_updated_at('import_row');
call app.add_updated_at('reconciliation');

commit;
