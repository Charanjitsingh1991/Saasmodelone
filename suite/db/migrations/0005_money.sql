-- 0005_money.sql
-- Proposals, contracts, invoices, payments, expenses and vendor bills.

begin;

create table proposal (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant (id),
  client_id uuid not null,
  engagement_id uuid,
  number text not null,
  title text not null,
  status text not null default 'draft'
    check (status in ('draft', 'sent', 'accepted', 'declined', 'expired')),
  currency char(3) not null,
  valid_until date,
  subtotal_minor bigint not null default 0 check (subtotal_minor >= 0),
  tax_minor bigint not null default 0 check (tax_minor >= 0),
  total_minor bigint not null default 0 check (total_minor >= 0),
  version integer not null default 1 check (version > 0),
  document_id uuid,
  created_by uuid references app_user (id),
  sent_at timestamptz,
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, number),
  foreign key (tenant_id, client_id) references client (tenant_id, id),
  foreign key (tenant_id, engagement_id) references engagement (tenant_id, id),
  foreign key (tenant_id, document_id) references document (tenant_id, id)
);

create table proposal_line (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant (id),
  proposal_id uuid not null,
  description text not null,
  quantity numeric(12,3) not null default 1 check (quantity > 0),
  unit_price_minor bigint not null check (unit_price_minor >= 0),
  amount_minor bigint not null check (amount_minor >= 0),
  tax_code text,
  sort_order smallint not null default 0,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, proposal_id, sort_order),
  foreign key (tenant_id, proposal_id) references proposal (tenant_id, id) on delete cascade
);

create table contract (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant (id),
  client_id uuid not null,
  engagement_id uuid,
  number text not null,
  title text not null,
  type text not null default 'sow'
    check (type in ('msa', 'sow', 'retainer', 'nda', 'other')),
  status text not null default 'draft'
    check (status in ('draft', 'active', 'expired', 'terminated')),
  start_date date,
  end_date date,
  value_minor bigint check (value_minor is null or value_minor >= 0),
  currency char(3) not null,
  signed_at timestamptz,
  document_id uuid,
  renewal_notice_days integer not null default 30 check (renewal_notice_days >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, number),
  check (end_date is null or start_date is null or end_date >= start_date),
  foreign key (tenant_id, client_id) references client (tenant_id, id),
  foreign key (tenant_id, engagement_id) references engagement (tenant_id, id),
  foreign key (tenant_id, document_id) references document (tenant_id, id)
);

create table invoice (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant (id),
  client_id uuid not null,
  engagement_id uuid,
  project_id uuid,
  contract_id uuid,
  number text not null,
  status text not null default 'draft'
    check (status in ('draft', 'sent', 'partially_paid', 'paid', 'overdue', 'void')),
  issue_date date not null,
  due_date date not null,
  currency char(3) not null,
  subtotal_minor bigint not null default 0 check (subtotal_minor >= 0),
  tax_minor bigint not null default 0 check (tax_minor >= 0),
  total_minor bigint not null default 0 check (total_minor >= 0),
  amount_paid_minor bigint not null default 0 check (amount_paid_minor >= 0),
  tax_jurisdiction_id uuid references jurisdiction (id),
  notes text,
  source_system text,
  source_id text,
  import_batch_id uuid,
  imported_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, number),
  check (due_date >= issue_date),
  foreign key (tenant_id, client_id) references client (tenant_id, id),
  foreign key (tenant_id, engagement_id) references engagement (tenant_id, id),
  foreign key (tenant_id, project_id) references project (tenant_id, id),
  foreign key (tenant_id, contract_id) references contract (tenant_id, id)
);

create index invoice_client_idx on invoice (tenant_id, client_id, issue_date desc);
create index invoice_status_idx on invoice (tenant_id, status, due_date);
create unique index invoice_source_uidx
  on invoice (tenant_id, source_system, source_id)
  where source_id is not null;

create table invoice_line (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant (id),
  invoice_id uuid not null,
  description text not null,
  tax_code text,
  quantity numeric(12,3) not null default 1 check (quantity > 0),
  unit_price_minor bigint not null check (unit_price_minor >= 0),
  amount_minor bigint not null check (amount_minor >= 0),
  sort_order smallint not null default 0,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, invoice_id, sort_order),
  foreign key (tenant_id, invoice_id) references invoice (tenant_id, id) on delete cascade
);

-- A document can carry several taxes, for example national and subnational
-- components, or VAT plus withholding. Tax is never implied by the country.
create table tax_line (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant (id),
  document_type text not null
    check (document_type in ('proposal', 'invoice', 'vendor_bill', 'credit_note')),
  document_id uuid not null,
  jurisdiction_id uuid references jurisdiction (id),
  tax_type text not null,
  tax_code text,
  rate numeric(7,4) not null default 0 check (rate >= 0 and rate <= 100),
  taxable_minor bigint not null,
  amount_minor bigint not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, id)
);

create index tax_line_document_idx
  on tax_line (tenant_id, document_type, document_id);

create table payment (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant (id),
  client_id uuid not null,
  invoice_id uuid,
  amount_minor bigint not null check (amount_minor > 0),
  currency char(3) not null,
  received_on date not null,
  method text not null default 'bank_transfer'
    check (method in ('bank_transfer', 'card', 'cash', 'cheque', 'direct_debit', 'wallet', 'other')),
  reference text,
  status text not null default 'received'
    check (status in ('received', 'cleared', 'bounced', 'refunded')),
  source_system text,
  source_id text,
  import_batch_id uuid,
  imported_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, client_id) references client (tenant_id, id),
  foreign key (tenant_id, invoice_id) references invoice (tenant_id, id)
);

create unique index payment_source_uidx
  on payment (tenant_id, source_system, source_id)
  where source_id is not null;

create table payment_allocation (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant (id),
  payment_id uuid not null,
  invoice_id uuid not null,
  amount_minor bigint not null check (amount_minor > 0),
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, payment_id, invoice_id),
  foreign key (tenant_id, payment_id) references payment (tenant_id, id) on delete cascade,
  foreign key (tenant_id, invoice_id) references invoice (tenant_id, id)
);

create table credit_note (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant (id),
  invoice_id uuid not null,
  number text not null,
  issue_date date not null,
  amount_minor bigint not null check (amount_minor > 0),
  reason text not null,
  status text not null default 'draft'
    check (status in ('draft', 'issued', 'applied', 'void')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, number),
  foreign key (tenant_id, invoice_id) references invoice (tenant_id, id)
);

create table expense (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant (id),
  person_id uuid not null,
  project_id uuid,
  client_id uuid,
  category text not null,
  amount_minor bigint not null check (amount_minor > 0),
  currency char(3) not null,
  incurred_on date not null,
  description text,
  status text not null default 'draft'
    check (status in ('draft', 'submitted', 'approved', 'rejected', 'reimbursed')),
  receipt_document_id uuid,
  approved_by uuid references app_user (id),
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, person_id) references person (tenant_id, id),
  foreign key (tenant_id, project_id) references project (tenant_id, id),
  foreign key (tenant_id, client_id) references client (tenant_id, id),
  foreign key (tenant_id, receipt_document_id) references document (tenant_id, id)
);

create index expense_person_idx on expense (tenant_id, person_id, incurred_on desc);
create index expense_status_idx on expense (tenant_id, status);

create table vendor (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant (id),
  name text not null,
  code text,
  email citext,
  phone text,
  status text not null default 'active'
    check (status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, code)
);

create table vendor_bill (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant (id),
  vendor_id uuid not null,
  project_id uuid,
  number text not null,
  bill_date date not null,
  due_date date,
  amount_minor bigint not null check (amount_minor >= 0),
  tax_minor bigint not null default 0 check (tax_minor >= 0),
  total_minor bigint not null check (total_minor >= 0),
  currency char(3) not null,
  status text not null default 'draft'
    check (status in ('draft', 'approved', 'paid', 'void')),
  document_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, vendor_id, number),
  check (due_date is null or due_date >= bill_date),
  foreign key (tenant_id, vendor_id) references vendor (tenant_id, id),
  foreign key (tenant_id, project_id) references project (tenant_id, id),
  foreign key (tenant_id, document_id) references document (tenant_id, id)
);

call app.enable_tenant_rls('proposal');
call app.enable_tenant_rls('proposal_line');
call app.enable_tenant_rls('contract');
call app.enable_tenant_rls('invoice');
call app.enable_tenant_rls('invoice_line');
call app.enable_tenant_rls('tax_line');
call app.enable_tenant_rls('payment');
call app.enable_tenant_rls('payment_allocation');
call app.enable_tenant_rls('credit_note');
call app.enable_tenant_rls('expense');
call app.enable_tenant_rls('vendor');
call app.enable_tenant_rls('vendor_bill');

call app.add_updated_at('proposal');
call app.add_updated_at('contract');
call app.add_updated_at('invoice');
call app.add_updated_at('payment');
call app.add_updated_at('credit_note');
call app.add_updated_at('expense');
call app.add_updated_at('vendor');
call app.add_updated_at('vendor_bill');

commit;
