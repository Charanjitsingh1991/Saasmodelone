-- 0003_work.sql
-- Clients, engagements, projects, allocations, time and project cost.

begin;

create table client (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant (id),
  name text not null,
  code text,
  status text not null default 'active'
    check (status in ('prospect', 'active', 'dormant', 'archived')),
  billing_email citext,
  phone text,
  currency char(3) not null,
  payment_terms_days integer not null default 30 check (payment_terms_days >= 0),
  owner_user_id uuid references app_user (id),
  source_system text,
  source_id text,
  import_batch_id uuid,
  imported_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (tenant_id, id),
  unique (tenant_id, code)
);

create index client_tenant_name_idx on client (tenant_id, name)
  where deleted_at is null;
create unique index client_source_uidx
  on client (tenant_id, source_system, source_id)
  where source_id is not null;

create table client_contact (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant (id),
  client_id uuid not null,
  name text not null,
  email citext,
  phone text,
  role text,
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, client_id) references client (tenant_id, id)
);

create unique index client_contact_primary_uidx
  on client_contact (tenant_id, client_id)
  where is_primary;

create table engagement (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant (id),
  client_id uuid not null,
  name text not null,
  code text,
  type text not null default 'project'
    check (type in ('project', 'retainer', 'retainer_project')),
  status text not null default 'draft'
    check (status in ('draft', 'active', 'paused', 'closed')),
  start_date date,
  end_date date,
  currency char(3) not null,
  contract_value_minor bigint check (contract_value_minor is null or contract_value_minor >= 0),
  billing_model text
    check (billing_model in ('time_materials', 'fixed_fee', 'retainer', 'milestone')),
  source_system text,
  source_id text,
  import_batch_id uuid,
  imported_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, client_id, code),
  check (end_date is null or start_date is null or end_date >= start_date),
  foreign key (tenant_id, client_id) references client (tenant_id, id)
);

create table project (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant (id),
  client_id uuid not null,
  engagement_id uuid,
  name text not null,
  code text,
  status text not null default 'planned'
    check (status in ('planned', 'active', 'on_hold', 'completed', 'cancelled')),
  start_date date,
  end_date date,
  manager_user_id uuid references app_user (id),
  currency char(3) not null,
  budget_minor bigint check (budget_minor is null or budget_minor >= 0),
  budget_hours numeric(10,2) check (budget_hours is null or budget_hours >= 0),
  source_system text,
  source_id text,
  import_batch_id uuid,
  imported_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (tenant_id, id),
  unique (tenant_id, code),
  check (end_date is null or start_date is null or end_date >= start_date),
  foreign key (tenant_id, client_id) references client (tenant_id, id),
  foreign key (tenant_id, engagement_id) references engagement (tenant_id, id)
);

create index project_client_idx on project (tenant_id, client_id, status);

create unique index project_source_uidx
  on project (tenant_id, source_system, source_id)
  where source_id is not null;

create table milestone (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant (id),
  project_id uuid not null,
  name text not null,
  due_date date,
  amount_minor bigint check (amount_minor is null or amount_minor >= 0),
  status text not null default 'pending'
    check (status in ('pending', 'in_progress', 'approved', 'invoiced')),
  approved_at timestamptz,
  sort_order smallint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, project_id) references project (tenant_id, id)
);

create table task (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant (id),
  project_id uuid not null,
  milestone_id uuid,
  title text not null,
  description text,
  assignee_person_id uuid,
  status text not null default 'todo'
    check (status in ('todo', 'in_progress', 'blocked', 'done', 'cancelled')),
  estimate_minutes integer check (estimate_minutes is null or estimate_minutes >= 0),
  due_date date,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, project_id) references project (tenant_id, id),
  foreign key (tenant_id, milestone_id) references milestone (tenant_id, id),
  foreign key (tenant_id, assignee_person_id) references person (tenant_id, id)
);

create table allocation (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant (id),
  person_id uuid not null,
  project_id uuid not null,
  start_date date not null,
  end_date date,
  allocation_percent numeric(5,2) not null check (allocation_percent > 0 and allocation_percent <= 100),
  billable boolean not null default true,
  bill_rate_minor_per_hour bigint check (bill_rate_minor_per_hour is null or bill_rate_minor_per_hour >= 0),
  cost_rate_minor_per_hour bigint check (cost_rate_minor_per_hour is null or cost_rate_minor_per_hour >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  check (end_date is null or end_date >= start_date),
  foreign key (tenant_id, person_id) references person (tenant_id, id),
  foreign key (tenant_id, project_id) references project (tenant_id, id)
);

create index allocation_person_idx on allocation (tenant_id, person_id, start_date);

create table timesheet (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant (id),
  person_id uuid not null,
  week_start date not null,
  status text not null default 'draft'
    check (status in ('draft', 'submitted', 'approved', 'rejected')),
  submitted_at timestamptz,
  approved_by uuid references app_user (id),
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, person_id, week_start),
  foreign key (tenant_id, person_id) references person (tenant_id, id)
);

create table timesheet_entry (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant (id),
  timesheet_id uuid not null,
  project_id uuid not null,
  task_id uuid,
  work_date date not null,
  minutes integer not null check (minutes > 0 and minutes <= 1440),
  billable boolean not null default true,
  note text,
  bill_rate_minor_per_hour bigint check (bill_rate_minor_per_hour is null or bill_rate_minor_per_hour >= 0),
  cost_rate_minor_per_hour bigint check (cost_rate_minor_per_hour is null or cost_rate_minor_per_hour >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, timesheet_id) references timesheet (tenant_id, id) on delete cascade,
  foreign key (tenant_id, project_id) references project (tenant_id, id),
  foreign key (tenant_id, task_id) references task (tenant_id, id)
);

create index timesheet_entry_timesheet_idx on timesheet_entry (tenant_id, timesheet_id);
create index timesheet_entry_project_date_idx on timesheet_entry (tenant_id, project_id, work_date);

create table deliverable (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant (id),
  project_id uuid not null,
  name text not null,
  status text not null default 'pending'
    check (status in ('pending', 'in_progress', 'submitted', 'approved', 'rejected')),
  due_date date,
  document_id uuid,
  approved_by uuid references app_user (id),
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, project_id) references project (tenant_id, id),
  foreign key (tenant_id, document_id) references document (tenant_id, id)
);

create table project_cost (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant (id),
  project_id uuid not null,
  category text not null
    check (category in ('payroll', 'contractor', 'expense', 'vendor', 'other')),
  amount_minor bigint not null,
  currency char(3) not null,
  incurred_on date not null,
  description text,
  source text not null default 'manual'
    check (source in ('timesheet', 'payroll', 'expense', 'vendor_bill', 'manual')),
  source_id uuid,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, project_id) references project (tenant_id, id)
);

create index project_cost_project_idx on project_cost (tenant_id, project_id, incurred_on);
create unique index project_cost_source_uidx
  on project_cost (tenant_id, source, source_id)
  where source_id is not null;

call app.enable_tenant_rls('client');
call app.enable_tenant_rls('client_contact');
call app.enable_tenant_rls('engagement');
call app.enable_tenant_rls('project');
call app.enable_tenant_rls('milestone');
call app.enable_tenant_rls('task');
call app.enable_tenant_rls('allocation');
call app.enable_tenant_rls('timesheet');
call app.enable_tenant_rls('timesheet_entry');
call app.enable_tenant_rls('deliverable');
call app.enable_tenant_rls('project_cost');

call app.add_updated_at('client');
call app.add_updated_at('client_contact');
call app.add_updated_at('engagement');
call app.add_updated_at('project');
call app.add_updated_at('milestone');
call app.add_updated_at('task');
call app.add_updated_at('allocation');
call app.add_updated_at('timesheet');
call app.add_updated_at('timesheet_entry');
call app.add_updated_at('deliverable');

commit;
