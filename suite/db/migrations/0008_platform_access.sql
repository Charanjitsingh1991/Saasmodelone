-- 0008_platform_access.sql
-- Platform and module access helpers, the entitlement retention window, the
-- internal-tenant flag, and the restrictive module RLS policies applied by an
-- idempotent procedure.
--
-- Decisions recorded here:
-- - Module access has one definition, split into read and write helpers.
--   app.has_active_module() is kept as an exact delegate to the write helper.
-- - Every module helper requires app.has_platform_access() first: an active,
--   non-deleted tenant. Tenant-level suspension is therefore enforced by the
--   module policies as well as the request layer.
-- - No table gets FORCE ROW LEVEL SECURITY in this migration. tenant gains it
--   only once the provisioning path sets app.tenant_id before inserting the
--   tenant row and that path is tested. Global reference tables and
--   infra.schema_migration are never forced.

begin;

-- ---------------------------------------------------------------------------
-- tenant.is_internal and module_entitlement.read_until
-- ---------------------------------------------------------------------------

-- Studio-internal tenant flag. Set only by the provisioning path; the runtime
-- role never receives UPDATE on tenant. Unlocks planned modules only when the
-- entitlement source is 'internal'.
alter table tenant
  add column is_internal boolean not null default false;

comment on column tenant.is_internal is
  'Studio-internal tenant. Set only by the provisioning path; with an internal-source entitlement it unlocks planned modules.';

-- Retention window after cancellation. Set if and only if the entitlement is
-- cancelled; null for every other state. Data is never deleted on cancellation.
alter table module_entitlement
  add column read_until timestamptz;

alter table module_entitlement
  add constraint module_entitlement_read_until_contract
  check ((status = 'cancelled') = (read_until is not null));

comment on column module_entitlement.read_until is
  'Read/export retention deadline after cancellation. Set if and only if status is cancelled; null for every other state.';

-- ---------------------------------------------------------------------------
-- Access helpers
--
-- All helpers are security definer so the runtime role needs no table grant
-- on tenant. Every query is pinned to app.current_tenant_id(); an unset
-- tenant context makes every helper false. The owner bypasses RLS, so the
-- explicit tenant filter is the isolation boundary here.
-- ---------------------------------------------------------------------------

create or replace function app.has_platform_access()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app.current_tenant_id() is not null
     and exists (
           select 1
           from public.tenant t
           where t.id = app.current_tenant_id()
             and t.status = 'active'
             and t.deleted_at is null
         );
$$;

comment on function app.has_platform_access() is
  'True when a tenant context is set and that tenant is active and not deleted. First predicate of every module helper, and the request-layer gate.';

create or replace function app.has_module_read(p_code text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app.has_platform_access()
     and exists (
    select 1
    from public.module_entitlement e
    join public.platform_module m on m.id = e.module_id
    join public.tenant t on t.id = e.tenant_id
    where e.tenant_id = app.current_tenant_id()
      and m.code = p_code
      and m.is_licensable
      and (
        m.status in ('available', 'preview')
        or (m.status = 'planned' and t.is_internal and e.source = 'internal')
      )
      and (
        (
          e.status in ('trialing', 'active')
          and e.starts_at <= now()
          and (e.ends_at is null or e.ends_at > now())
        )
        or (
          e.status = 'suspended'
          and e.starts_at <= now()
          and (e.ends_at is null or e.ends_at > now())
        )
        or (
          e.status = 'cancelled'
          and e.starts_at <= now()
          and e.read_until is not null
          and e.read_until > now()
        )
      )
  );
$$;

comment on function app.has_module_read(text) is
  'Read gate: requires an active, non-deleted tenant (has_platform_access). Trialing/active inside the window, suspended inside its original term, or cancelled inside read_until. Public tenants need available/preview; planned modules require an internal tenant and an internal-source entitlement. Non-licensable codes (core, switch) always return false.';

create or replace function app.has_module_write(p_code text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app.has_platform_access()
     and exists (
    select 1
    from public.module_entitlement e
    join public.platform_module m on m.id = e.module_id
    join public.tenant t on t.id = e.tenant_id
    where e.tenant_id = app.current_tenant_id()
      and m.code = p_code
      and m.is_licensable
      and (
        m.status in ('available', 'preview')
        or (m.status = 'planned' and t.is_internal and e.source = 'internal')
      )
      and e.status in ('trialing', 'active')
      and e.starts_at <= now()
      and (e.ends_at is null or e.ends_at > now())
  );
$$;

comment on function app.has_module_write(text) is
  'Write gate: requires an active, non-deleted tenant (has_platform_access) and a trialing/active entitlement inside the window, with the same catalog and internal gates as the read helper. Suspended and cancelled entitlements never write.';

create or replace function app.has_switch_access()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app.has_platform_access()
     and exists (
    select 1
    from public.module_entitlement e
    join public.platform_module m on m.id = e.module_id
    join public.tenant t on t.id = e.tenant_id
    where e.tenant_id = app.current_tenant_id()
      and m.is_licensable
      and (
        m.status in ('available', 'preview')
        or (m.status = 'planned' and t.is_internal and e.source = 'internal')
      )
      and e.status in ('trialing', 'active')
      and e.starts_at <= now()
      and (e.ends_at is null or e.ends_at > now())
  );
$$;

comment on function app.has_switch_access() is
  'Switch staging is included with any licensed module: requires an active, non-deleted tenant and at least one trialing/active licensable entitlement inside its window. Never check an entitlement for switch itself.';

-- Single-definition rule: has_active_module is kept for compatibility and is
-- exactly module write access. New SQL calls has_module_read or
-- has_module_write directly. Never call any module helper with 'core' or
-- 'switch'; both are non-licensable and always answer false.
create or replace function app.has_active_module(p_code text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app.has_module_write(p_code);
$$;

comment on function app.has_active_module(text) is
  'Compatibility alias of app.has_module_write; exact delegate, single definition. New SQL uses the read/write helpers.';

-- ---------------------------------------------------------------------------
-- Module RLS policies
--
-- The values list in app.apply_module_policies is the complete table-to-policy
-- allowlist. Policies are AS RESTRICTIVE so they AND with the permissive
-- tenant_isolation policy from the base migrations. Directory records
-- (person, client, client_contact), core tables, the catalog and
-- module_entitlement get no module policy.
-- ---------------------------------------------------------------------------

create or replace procedure app.apply_module_policies()
language plpgsql
security definer
set search_path = ''
as $$
declare
  target record;
  policy_group text;
  read_expression text;
  write_expression text;
begin
  for target in
    select entry.table_name, entry.gate
    from (
      values
        -- People module. person itself stays tenant-only (shared directory).
        ('employment',            'people'),
        ('person_identifier',     'people'),
        ('bank_account',          'people'),
        ('compensation',          'people'),
        ('salary_component',      'people'),
        ('salary_structure',      'people'),
        ('salary_structure_line', 'people'),
        ('payroll_run',           'people'),
        ('payroll_run_rule_pack', 'people'),
        ('payslip',               'people'),
        ('payslip_line',          'people'),
        ('payroll_adjustment',    'people'),
        ('leave_type',            'people'),
        ('leave_balance',         'people'),
        ('leave_request',         'people'),
        ('attendance_day',        'people'),
        ('holiday',               'people'),
        -- Work module. client and client_contact stay tenant-only in M0.
        ('engagement',            'work'),
        ('project',               'work'),
        ('milestone',             'work'),
        ('task',                  'work'),
        ('allocation',            'work'),
        ('timesheet',             'work'),
        ('timesheet_entry',       'work'),
        ('deliverable',           'work'),
        ('project_cost',          'work'),
        -- Content module.
        ('content_item',          'content'),
        ('content_version',       'content'),
        ('asset',                 'content'),
        ('content_asset',         'content'),
        ('document_room',         'content'),
        ('document_room_member',  'content'),
        -- Money module.
        ('proposal',              'money'),
        ('proposal_line',         'money'),
        ('contract',              'money'),
        ('invoice',               'money'),
        ('invoice_line',          'money'),
        ('tax_line',              'money'),
        ('payment',               'money'),
        ('payment_allocation',    'money'),
        ('credit_note',           'money'),
        ('expense',               'money'),
        ('vendor',                'money'),
        ('vendor_bill',           'money'),
        -- Switch staging, gated by has_switch_access(), never by a switch entitlement.
        ('import_batch',          'switch'),
        ('import_file',           'switch'),
        ('mapping_profile',       'switch'),
        ('import_row',            'switch'),
        ('import_issue',          'switch'),
        ('reconciliation',        'switch')
    ) as entry(table_name, gate)
  loop
    if target.gate = 'switch' then
      policy_group := 'switch';
      read_expression := 'app.has_switch_access()';
      write_expression := 'app.has_switch_access()';
    else
      policy_group := 'module_' || target.gate;
      read_expression := format('app.has_module_read(%L)', target.gate);
      write_expression := format('app.has_module_write(%L)', target.gate);
    end if;

    execute format('drop policy if exists %I on public.%I', policy_group || '_read', target.table_name);
    execute format(
      'create policy %I on public.%I as restrictive for select using (%s)',
      policy_group || '_read', target.table_name, read_expression
    );

    execute format('drop policy if exists %I on public.%I', policy_group || '_write_insert', target.table_name);
    execute format(
      'create policy %I on public.%I as restrictive for insert with check (%s)',
      policy_group || '_write_insert', target.table_name, write_expression
    );

    execute format('drop policy if exists %I on public.%I', policy_group || '_write_update', target.table_name);
    execute format(
      'create policy %I on public.%I as restrictive for update using (%s) with check (%s)',
      policy_group || '_write_update', target.table_name, write_expression, write_expression
    );

    execute format('drop policy if exists %I on public.%I', policy_group || '_write_delete', target.table_name);
    execute format(
      'create policy %I on public.%I as restrictive for delete using (%s)',
      policy_group || '_write_delete', target.table_name, write_expression
    );
  end loop;
end;
$$;

comment on procedure app.apply_module_policies() is
  'Idempotently (re)creates the restrictive module RLS policies for the allowlisted tables. Owner-only; the runtime role has no EXECUTE.';

call app.apply_module_policies();

revoke all on function app.has_platform_access() from public;
revoke all on function app.has_module_read(text) from public;
revoke all on function app.has_module_write(text) from public;
revoke all on function app.has_switch_access() from public;
revoke all on function app.has_active_module(text) from public;
revoke all on procedure app.apply_module_policies() from public;
revoke execute on procedure app.apply_module_policies() from saas_runtime;

commit;
