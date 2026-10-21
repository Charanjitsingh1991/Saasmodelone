-- 0002_people.sql
-- People, employment, identifiers, compensation, leave, attendance and payroll.

begin;

create table person (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant (id),
  employee_code text,
  first_name text not null,
  last_name text,
  display_name text not null,
  work_email citext,
  personal_email citext,
  phone text,
  date_of_birth date,
  gender text,
  date_of_joining date,
  date_of_exit date,
  status text not null default 'active'
    check (status in ('active', 'probation', 'notice', 'exited', 'archived')),
  employment_type text
    check (employment_type in ('full_time', 'part_time', 'contract', 'intern', 'consultant')),
  legal_entity_id uuid,
  org_unit_id uuid,
  location_id uuid,
  manager_person_id uuid,
  designation text,
  source_system text,
  source_id text,
  import_batch_id uuid,
  imported_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (tenant_id, id),
  unique (tenant_id, employee_code),
  unique (tenant_id, work_email),
  foreign key (tenant_id, legal_entity_id) references legal_entity (tenant_id, id),
  foreign key (tenant_id, org_unit_id) references org_unit (tenant_id, id),
  foreign key (tenant_id, location_id) references location (tenant_id, id),
  foreign key (tenant_id, manager_person_id) references person (tenant_id, id)
);

create index person_tenant_status_idx on person (tenant_id, status)
  where deleted_at is null;
create index person_tenant_name_idx on person (tenant_id, display_name);
create unique index person_source_uidx
  on person (tenant_id, source_system, source_id)
  where source_id is not null;

create table employment (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant (id),
  person_id uuid not null,
  legal_entity_id uuid not null,
  work_jurisdiction_id uuid references jurisdiction (id),
  employment_type text not null
    check (employment_type in ('full_time', 'part_time', 'contract', 'intern', 'consultant')),
  start_date date not null,
  end_date date,
  probation_end_date date,
  notice_days integer check (notice_days >= 0),
  status text not null default 'active'
    check (status in ('active', 'ended', 'cancelled')),
  source_system text,
  source_id text,
  import_batch_id uuid,
  imported_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  check (end_date is null or end_date >= start_date),
  foreign key (tenant_id, person_id) references person (tenant_id, id),
  foreign key (tenant_id, legal_entity_id) references legal_entity (tenant_id, id)
);

create index employment_person_idx on employment (tenant_id, person_id, start_date desc);

-- Identifier types are reference data scoped to a jurisdiction (tax ID,
-- social-insurance number, work permit, national ID, and so on).
create table statutory_identifier_type (
  id uuid primary key default gen_random_uuid(),
  jurisdiction_id uuid not null references jurisdiction (id),
  code text not null,
  name text not null,
  sensitive boolean not null default true,
  format_regex text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (jurisdiction_id, code)
);

create table person_identifier (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant (id),
  person_id uuid not null,
  identifier_type_id uuid not null references statutory_identifier_type (id),
  value_ciphertext text not null,
  last4 char(4),
  issued_on date,
  expires_on date,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, person_id, identifier_type_id),
  foreign key (tenant_id, person_id) references person (tenant_id, id)
);

create table bank_account (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant (id),
  person_id uuid not null,
  scheme text not null,
  country_code char(2) not null,
  currency char(3),
  account_name text not null,
  account_number_ciphertext text not null,
  account_last4 char(4) not null,
  routing_code_ciphertext text,
  routing_last4 char(4),
  bank_name text,
  branch text,
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, person_id) references person (tenant_id, id)
);

create unique index bank_account_primary_uidx
  on bank_account (tenant_id, person_id)
  where is_primary;

create table compensation (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant (id),
  person_id uuid not null,
  effective_from date not null,
  effective_to date,
  ctc_minor bigint not null check (ctc_minor >= 0),
  currency char(3) not null,
  pay_frequency text not null default 'monthly'
    check (pay_frequency in ('monthly', 'semi_monthly', 'biweekly', 'weekly')),
  structure jsonb not null default '{}'::jsonb,
  source_system text,
  source_id text,
  import_batch_id uuid,
  imported_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, person_id, effective_from),
  check (effective_to is null or effective_to >= effective_from),
  foreign key (tenant_id, person_id) references person (tenant_id, id)
);

create table salary_component (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant (id),
  jurisdiction_id uuid references jurisdiction (id),
  code text not null,
  name text not null,
  kind text not null
    check (kind in ('earning', 'deduction', 'employer_contribution', 'reimbursement')),
  taxable boolean not null default true,
  statutory boolean not null default false,
  calculation jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, code)
);

create table salary_structure (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant (id),
  jurisdiction_id uuid references jurisdiction (id),
  name text not null,
  version integer not null default 1 check (version > 0),
  currency char(3) not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, name, version)
);

create table salary_structure_line (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant (id),
  structure_id uuid not null,
  component_id uuid not null,
  amount_minor bigint check (amount_minor is null or amount_minor >= 0),
  percentage numeric(7,4) check (percentage is null or percentage >= 0),
  formula text,
  sort_order smallint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, structure_id, component_id),
  foreign key (tenant_id, structure_id) references salary_structure (tenant_id, id) on delete cascade,
  foreign key (tenant_id, component_id) references salary_component (tenant_id, id)
);

-- Statutory rule packs are global reference data, not tenant data. A pack is
-- written in one jurisdiction and approved by a qualified local reviewer.
create table payroll_rule_pack (
  id uuid primary key default gen_random_uuid(),
  jurisdiction_id uuid not null references jurisdiction (id),
  code text not null,
  name text not null,
  version text not null,
  effective_from date not null,
  effective_to date,
  status text not null default 'draft'
    check (status in ('draft', 'in_review', 'approved', 'retired')),
  source_refs jsonb not null default '[]'::jsonb,
  reviewed_by text,
  reviewed_at date,
  checksum text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (jurisdiction_id, code, version),
  check (effective_to is null or effective_to >= effective_from)
);

create index payroll_rule_pack_effective_idx
  on payroll_rule_pack (jurisdiction_id, effective_from, effective_to);

create table payroll_rule (
  id uuid primary key default gen_random_uuid(),
  rule_pack_id uuid not null references payroll_rule_pack (id) on delete cascade,
  code text not null,
  label text not null,
  value jsonb not null,
  created_at timestamptz not null default now(),
  unique (rule_pack_id, code)
);

create table payroll_run (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant (id),
  legal_entity_id uuid not null,
  jurisdiction_id uuid not null references jurisdiction (id),
  period_start date not null,
  period_end date not null,
  pay_date date not null,
  status text not null default 'draft'
    check (status in ('draft', 'inputs_locked', 'calculated', 'in_review', 'approved', 'finalised', 'paid', 'reversed')),
  currency char(3) not null,
  gross_minor bigint not null default 0,
  deductions_minor bigint not null default 0,
  employer_cost_minor bigint not null default 0,
  net_minor bigint not null default 0,
  totals jsonb not null default '{}'::jsonb,
  rule_versions jsonb not null default '{}'::jsonb,
  calculated_by uuid references app_user (id),
  approved_by uuid references app_user (id),
  finalised_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, legal_entity_id, period_start, period_end),
  check (period_end >= period_start),
  foreign key (tenant_id, legal_entity_id) references legal_entity (tenant_id, id),
  foreign key (tenant_id, legal_entity_id, jurisdiction_id)
    references legal_entity (tenant_id, id, jurisdiction_id)
);

create index payroll_run_period_idx on payroll_run (tenant_id, period_start desc);

create table payroll_run_rule_pack (
  tenant_id uuid not null references tenant (id),
  payroll_run_id uuid not null,
  rule_pack_id uuid not null references payroll_rule_pack (id),
  created_at timestamptz not null default now(),
  primary key (tenant_id, payroll_run_id, rule_pack_id),
  foreign key (tenant_id, payroll_run_id) references payroll_run (tenant_id, id) on delete cascade
);

create table payslip (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant (id),
  payroll_run_id uuid not null,
  person_id uuid not null,
  bank_account_id uuid,
  currency char(3) not null,
  gross_minor bigint not null default 0,
  deductions_minor bigint not null default 0,
  net_minor bigint not null default 0,
  days_paid numeric(6,2) not null default 0,
  lop_days numeric(6,2) not null default 0,
  status text not null default 'draft'
    check (status in ('draft', 'published', 'held', 'reversed')),
  breakdown jsonb not null default '{}'::jsonb,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, payroll_run_id, person_id),
  foreign key (tenant_id, payroll_run_id) references payroll_run (tenant_id, id),
  foreign key (tenant_id, person_id) references person (tenant_id, id),
  foreign key (tenant_id, bank_account_id) references bank_account (tenant_id, id)
);

create index payslip_person_idx on payslip (tenant_id, person_id, created_at desc);

create table payslip_line (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant (id),
  payslip_id uuid not null,
  component_code text not null,
  kind text not null
    check (kind in ('earning', 'deduction', 'employer_contribution', 'reimbursement')),
  rule_pack_id uuid references payroll_rule_pack (id),
  rule_code text,
  amount_minor bigint not null,
  taxable boolean not null default true,
  sort_order smallint not null default 0,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, payslip_id, sort_order),
  foreign key (tenant_id, payslip_id) references payslip (tenant_id, id) on delete cascade
);

create table payroll_adjustment (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant (id),
  payroll_run_id uuid not null,
  person_id uuid not null,
  component_code text not null,
  kind text not null check (kind in ('addition', 'deduction')),
  amount_minor bigint not null check (amount_minor > 0),
  reason text not null,
  status text not null default 'draft'
    check (status in ('draft', 'approved', 'applied', 'void')),
  approved_by uuid references app_user (id),
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, payroll_run_id) references payroll_run (tenant_id, id),
  foreign key (tenant_id, person_id) references person (tenant_id, id)
);

create table leave_type (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant (id),
  code text not null,
  name text not null,
  unit text not null default 'days' check (unit in ('days', 'hours')),
  annual_quota numeric(7,2) not null default 0 check (annual_quota >= 0),
  carry_forward boolean not null default false,
  encashable boolean not null default false,
  policy jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, code)
);

create table leave_balance (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant (id),
  person_id uuid not null,
  leave_type_id uuid not null,
  leave_year integer not null check (leave_year between 2000 and 2100),
  opening numeric(7,2) not null default 0,
  accrued numeric(7,2) not null default 0,
  used numeric(7,2) not null default 0,
  pending numeric(7,2) not null default 0,
  adjusted numeric(7,2) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, person_id, leave_type_id, leave_year),
  foreign key (tenant_id, person_id) references person (tenant_id, id),
  foreign key (tenant_id, leave_type_id) references leave_type (tenant_id, id)
);

create table leave_request (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant (id),
  person_id uuid not null,
  leave_type_id uuid not null,
  start_date date not null,
  end_date date not null,
  days numeric(6,2) not null check (days > 0),
  reason text,
  status text not null default 'draft'
    check (status in ('draft', 'submitted', 'approved', 'rejected', 'cancelled')),
  requested_at timestamptz,
  decided_by uuid references app_user (id),
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  check (end_date >= start_date),
  foreign key (tenant_id, person_id) references person (tenant_id, id),
  foreign key (tenant_id, leave_type_id) references leave_type (tenant_id, id)
);

create index leave_request_person_idx on leave_request (tenant_id, person_id, start_date desc);
create index leave_request_status_idx on leave_request (tenant_id, status);

create table attendance_day (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant (id),
  person_id uuid not null,
  work_date date not null,
  status text not null default 'present'
    check (status in ('present', 'absent', 'half_day', 'leave', 'holiday', 'weekend', 'wfh')),
  first_in timestamptz,
  last_out timestamptz,
  worked_minutes integer not null default 0 check (worked_minutes >= 0),
  overtime_minutes integer not null default 0 check (overtime_minutes >= 0),
  source text not null default 'manual'
    check (source in ('manual', 'web', 'mobile', 'device', 'import')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, person_id, work_date),
  foreign key (tenant_id, person_id) references person (tenant_id, id)
);

create index attendance_day_date_idx on attendance_day (tenant_id, work_date);

create table holiday (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant (id),
  legal_entity_id uuid,
  location_id uuid,
  holiday_date date not null,
  name text not null,
  is_optional boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, holiday_date, name),
  foreign key (tenant_id, legal_entity_id) references legal_entity (tenant_id, id),
  foreign key (tenant_id, location_id) references location (tenant_id, id)
);

call app.enable_tenant_rls('person');
call app.enable_tenant_rls('employment');
call app.enable_tenant_rls('person_identifier');
call app.enable_tenant_rls('bank_account');
call app.enable_tenant_rls('compensation');
call app.enable_tenant_rls('salary_component');
call app.enable_tenant_rls('salary_structure');
call app.enable_tenant_rls('salary_structure_line');
call app.enable_tenant_rls('payroll_run');
call app.enable_tenant_rls('payroll_run_rule_pack');
call app.enable_tenant_rls('payslip');
call app.enable_tenant_rls('payslip_line');
call app.enable_tenant_rls('payroll_adjustment');
call app.enable_tenant_rls('leave_type');
call app.enable_tenant_rls('leave_balance');
call app.enable_tenant_rls('leave_request');
call app.enable_tenant_rls('attendance_day');
call app.enable_tenant_rls('holiday');

call app.add_updated_at('person');
call app.add_updated_at('employment');
call app.add_updated_at('statutory_identifier_type');
call app.add_updated_at('person_identifier');
call app.add_updated_at('bank_account');
call app.add_updated_at('compensation');
call app.add_updated_at('salary_component');
call app.add_updated_at('salary_structure');
call app.add_updated_at('salary_structure_line');
call app.add_updated_at('payroll_rule_pack');
call app.add_updated_at('payroll_run');
call app.add_updated_at('payslip');
call app.add_updated_at('payroll_adjustment');
call app.add_updated_at('leave_type');
call app.add_updated_at('leave_balance');
call app.add_updated_at('leave_request');
call app.add_updated_at('attendance_day');
call app.add_updated_at('holiday');

commit;
