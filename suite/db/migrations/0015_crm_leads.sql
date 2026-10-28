-- 0015_crm_leads.sql
-- CRM leads: the first table this product owns for one module only, the stages
-- a lead may sit in, and the two columns that record where a converted lead
-- went. This is the database half of ADR 0015.
--
-- A CRM-PRIVATE TABLE, AND THAT IS THE NEW PART
--
-- Accounts and contacts are shared platform rows: client and client_contact are
-- read by Work and Money too, so they carry tenant_isolation and no module
-- policy, and the gate on the CRM routes is the only thing that keeps an
-- unlicensed module from naming one. A lead is not shared. Nothing outside CRM
-- reads or writes it, so it can be held to a stricter rule at the table: three
-- restrictive policies that run app.has_module_read('crm') and
-- app.has_module_write('crm') beside the permissive tenant_isolation policy.
-- An unentitled tenant reaching this table is stopped by the policy, not only
-- by the route.
--
-- The policy names are crm_read, crm_write_insert and crm_write_update, and
-- app.apply_module_policies() only manages module_*_read and module_*_write_*,
-- so the installer can never drop them. The values list in 0008 is untouched:
-- this table has no entry there because its policies are declared here, beside
-- the table they protect.
--
-- NO DELETE, ON PURPOSE
--
-- There is no delete policy and the runtime gets no DELETE privilege on this
-- table, so a lead is retired by moving it to 'disqualified', not erased. The
-- same reasoning as compensation applies: a policy for a command no role can
-- execute is untestable surface area.
--
-- TERMINAL STAGES ARE AN INVARIANT, NOT A CONVENTION
--
-- A lead leaves the open stages ('new', 'contacted', 'qualified') in exactly
-- two ways. 'converted' records where it went, so the three conversion columns
-- must all be present; 'disqualified' records that it went nowhere, so they
-- must all be absent. The check below states that as one biconditional, so a
-- converted row with any of the three missing cannot exist and neither can an
-- unconverted row carrying all three. The route treats both terminal stages as
-- final; this table makes the terminal state internally consistent whatever a
-- future route does.
--
-- converted_client_id and converted_contact_id are composite foreign keys on
-- (tenant_id, id), like every other cross-table reference in this schema, so a
-- lead cannot point at an account or a contact of another workspace. Both are
-- nullable and MATCH SIMPLE leaves the reference unchecked while the column is
-- null, which is exactly what an unconverted lead holds.
--
-- No new function, no change to an existing helper, no table-level grant and no
-- change to any other table. The column grants that make this table readable
-- and writable land in the same change in packages/db/sql/runtime-grants.sql.

begin;

create table crm_lead (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant (id),
  name text not null,
  company text,
  email citext,
  phone text,
  source text,
  stage text not null default 'new'
    check (stage in ('new', 'contacted', 'qualified', 'converted', 'disqualified')),
  converted_client_id uuid,
  converted_contact_id uuid,
  converted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, converted_client_id) references client (tenant_id, id),
  foreign key (tenant_id, converted_contact_id) references client_contact (tenant_id, id),
  check (
    (stage = 'converted')
    = (converted_client_id is not null
       and converted_contact_id is not null
       and converted_at is not null)
  )
);

create index crm_lead_tenant_stage_idx on crm_lead (tenant_id, stage);

call app.enable_tenant_rls('crm_lead');
call app.add_updated_at('crm_lead');

create policy crm_read on public.crm_lead
  as restrictive for select
  using (app.has_module_read('crm'));

create policy crm_write_insert on public.crm_lead
  as restrictive for insert
  with check (app.has_module_write('crm'));

create policy crm_write_update on public.crm_lead
  as restrictive for update
  using (app.has_module_write('crm'))
  with check (app.has_module_write('crm'));

commit;
