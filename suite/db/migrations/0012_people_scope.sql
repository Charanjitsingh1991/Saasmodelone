-- 0012_people_scope.sql
-- People scope: the person-to-user link, the membership scope table, the
-- scope decision helpers and the restrictive scope RLS policies on person and
-- employment.
--
-- Scope only narrows. The M0 layers stay in front of it: the permissive
-- tenant_isolation policy from the base migrations, and the restrictive
-- module policies from app.apply_module_policies(). Nothing here can widen
-- access, because every policy added below is AS RESTRICTIVE and every helper
-- returns false or falls through to the existing tenant predicate.
--
-- Resolution order inside the helpers is fixed:
--   1. no app.user_id           -> no narrowing (see the residual below)
--   2. no app.tenant_id, or the user has no active membership in this tenant
--                              -> false
--   3. role employee          -> read: own linked person only; write: false
--   4. role outside the six manageable roles
--                              -> false
--   5. membership with zero scope rows
--                              -> tenant-wide (true)
--   6. otherwise              -> placement match: legal entity, or the org
--                                unit itself or any descendant
--
-- Documented residual (step 1). A transaction that sets app.tenant_id but
-- never sets app.user_id is a system or administrative path, and it sees the
-- whole tenant. That is deliberate: the shared directory has to stay reachable
-- for imports, exports and background work, and an unset GUC cannot be
-- distinguished from an empty one by any cheaper means. tests/scope.test.ts
-- pins it, so widening or narrowing it is a visible change.
--
-- A null placement (both legal_entity_id and org_unit_id null) is visible only
-- to a tenant-wide member. There is no scope row that can match nothing, so a
-- scoped member cannot see or write an unplaced person.
--
-- Deferred scopes: project and client are not modelled here. There are no
-- dead columns and no placeholder scope_type values - the CHECK list holds
-- only what the helpers can actually evaluate.
--
-- Grants: the five public helpers are EXECUTE for saas_runtime, and that grant
-- lives in packages/db/sql/runtime-grants.sql, which the migration runner
-- re-applies after every run; a grant only inside this file would be revoked
-- by the next migrate. The internal helpers are called only by other
-- owner-owned functions, so they keep the owner's implicit EXECUTE and are
-- revoked from PUBLIC - the same pattern as 0011's outbox_claimed_guard.
-- saas_runtime gets no privilege on membership_scope and saas_worker gets
-- nothing new at all.

begin;

-- ---------------------------------------------------------------------------
-- person <-> app_user link
-- ---------------------------------------------------------------------------

-- One person row per user per tenant. The FK is plain (not composite) because
-- app_user is a global identity table with no tenant_id column; the partial
-- unique index below is what keeps the link inside one tenant. Deleting the
-- user unlinks the person rather than deleting the shared directory record.
alter table public.person add column user_id uuid;

alter table public.person
  add constraint person_user_id_fkey
  foreign key (user_id) references app_user (id) on delete set null;

comment on column public.person.user_id is
  'The app_user this directory record belongs to, when the person is also a member of this tenant. Null for people who do not sign in. On delete set null: removing the identity never removes the directory record.';

create unique index person_user_uidx
  on public.person (tenant_id, user_id)
  where user_id is not null;

-- ---------------------------------------------------------------------------
-- membership scope table
-- ---------------------------------------------------------------------------

-- app.membership has only a surrogate primary key, so a composite
-- (tenant_id, ...) reference target does not exist yet. The scope FKs need it,
-- and adding it here is the only change this migration makes to an existing
-- table other than person.user_id.
alter table public.membership
  add constraint membership_tenant_id_key unique (tenant_id, id);

create table membership_scope (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant (id) on delete cascade,
  membership_id uuid not null,
  scope_type text not null
    check (scope_type in ('legal_entity', 'org_unit')),
  legal_entity_id uuid,
  org_unit_id uuid,
  created_at timestamptz not null default now(),
  check ((scope_type = 'legal_entity' and legal_entity_id is not null and org_unit_id is null)
      or (scope_type = 'org_unit' and org_unit_id is not null and legal_entity_id is null)),
  unique nulls not distinct (tenant_id, membership_id, scope_type, legal_entity_id, org_unit_id),
  foreign key (tenant_id, membership_id) references membership (tenant_id, id) on delete cascade,
  foreign key (tenant_id, legal_entity_id) references legal_entity (tenant_id, id),
  foreign key (tenant_id, org_unit_id) references org_unit (tenant_id, id)
);

comment on table public.membership_scope is
  'Narrowing scopes for one membership. Absence of rows means the role sees the whole tenant; scope never widens access. An org_unit scope covers that unit and every descendant. Project and client scopes are deliberately not modelled yet - see suite/docs/adr/0007-people-scope.md.';

create index membership_scope_membership_idx
  on public.membership_scope (tenant_id, membership_id);
create index membership_scope_entity_idx
  on public.membership_scope (tenant_id, legal_entity_id)
  where legal_entity_id is not null;
create index membership_scope_unit_idx
  on public.membership_scope (tenant_id, org_unit_id)
  where org_unit_id is not null;

-- Tenant isolation first, exactly like every other tenant business table. The
-- scope helpers run as the owner and read this table with an explicit tenant
-- filter, so the runtime role needs no grant here.
call app.enable_tenant_rls('membership_scope');

-- ---------------------------------------------------------------------------
-- Context helpers
--
-- Every read of a business table inside these functions carries an explicit
-- tenant_id = app.current_tenant_id() predicate. The owner bypasses RLS by
-- table ownership, so that filter - not a policy - is the isolation boundary
-- here. app.tenant_id unset means the predicate matches nothing, which is why
-- the helpers answer false before they consult scope.
-- ---------------------------------------------------------------------------

-- Security invoker on purpose: it reads a GUC and touches no table, so it
-- needs no definer privilege.
create or replace function app.current_user_id()
returns uuid
language sql
stable
set search_path = ''
as $$
  select nullif(current_setting('app.user_id', true), '')::uuid
$$;

comment on function app.current_user_id() is
  'app.user_id as a uuid, or null when it is unset. Security invoker: reads only a GUC. Null means a system or administrative context, which the scope helpers treat as no narrowing.';

create or replace function app.current_active_membership_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.id
  from public.membership m
  where m.tenant_id = app.current_tenant_id()
    and m.user_id = app.current_user_id()
    and m.status = 'active'
  limit 1
$$;

comment on function app.current_active_membership_id() is
  'Internal: id of the active membership for app.tenant_id and app.user_id, or null. Mirrors app.current_member_role(), which returns null for a suspended membership or a non-member. Security definer; no EXECUTE grant for the runtime role.';

create or replace function app.current_person_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p.id
  from public.person p
  where p.tenant_id = app.current_tenant_id()
    and p.user_id = app.current_user_id()
  limit 1
$$;

comment on function app.current_person_id() is
  'The person row linked to app.user_id inside app.tenant_id, or null. This is the employee self-scope anchor. Security definer; the runtime role has no SELECT on person.user_id, so the lookup cannot be inlined into a policy.';

create or replace function app.member_has_scope()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.membership_scope s
    where s.tenant_id = app.current_tenant_id()
      and s.membership_id = app.current_active_membership_id()
  )
$$;

comment on function app.member_has_scope() is
  'Internal: true when the current active membership has at least one scope row. False is what makes a role tenant-wide; it is not an access denial.';

create or replace function app.org_unit_is_in_scope_subtree(p_root uuid, p_node uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  with recursive tree as (
    select o.id
    from public.org_unit o
    where o.tenant_id = app.current_tenant_id()
      and o.id = p_root
    union all
    select child.id
    from public.org_unit child
    join tree t on t.id = child.parent_id
    where child.tenant_id = app.current_tenant_id()
  )
  cycle id set is_cycle to true default false using walked
  select exists (
    select 1
    from tree
    where id = p_node
      and not is_cycle
  )
$$;

comment on function app.org_unit_is_in_scope_subtree(uuid, uuid) is
  'Internal: true when p_node is p_root itself or a descendant of it, inside app.tenant_id. Ancestors and siblings never match. The CYCLE clause makes a malformed parent chain terminate instead of recursing forever. Security definer; no EXECUTE grant for the runtime role.';

create or replace function app.member_placement_matches(p_legal_entity_id uuid, p_org_unit_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.membership_scope s
    where s.tenant_id = app.current_tenant_id()
      and s.membership_id = app.current_active_membership_id()
      and (
        (s.scope_type = 'legal_entity' and s.legal_entity_id = p_legal_entity_id)
        or (s.scope_type = 'org_unit'
            and app.org_unit_is_in_scope_subtree(s.org_unit_id, p_org_unit_id))
      )
  )
$$;

comment on function app.member_placement_matches(uuid, uuid) is
  'Internal: true when a scope row of the current active membership covers the given placement - an exact legal entity, or an org unit that is the placement unit or an ancestor of it. A null placement argument can never match, which is why an unplaced person is visible only to a tenant-wide member. Security definer; no EXECUTE grant for the runtime role.';

-- ---------------------------------------------------------------------------
-- Scope decision helpers
--
-- These are the predicates the policies call. Language plpgsql with locals: a
-- bare column name inside an UPDATE/SELECT WHERE would otherwise shadow a
-- parameter of the same name, the defect 0011 documents.
-- ---------------------------------------------------------------------------

create or replace function app.person_visible(p_person_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tenant uuid := app.current_tenant_id();
  v_user uuid := app.current_user_id();
  v_role text := app.current_member_role();
  v_row record;
begin
  if v_user is null then
    return true;
  end if;
  if v_tenant is null or v_role is null then
    return false;
  end if;

  select p.legal_entity_id, p.org_unit_id, p.user_id = v_user as is_self
    into v_row
    from public.person p
   where p.id = p_person_id
     and p.tenant_id = v_tenant;
  if not found then
    return false;
  end if;

  if v_row.is_self then
    return true;
  end if;

  -- An employee is self-only: scope rows never widen their read.
  if v_role = 'employee' then
    return false;
  end if;
  if v_role not in ('owner', 'admin', 'hr', 'finance', 'manager', 'auditor') then
    return false;
  end if;
  if not app.member_has_scope() then
    return true;
  end if;
  return app.member_placement_matches(v_row.legal_entity_id, v_row.org_unit_id);
end;
$$;

comment on function app.person_visible(uuid) is
  'Read predicate for the shared directory, used by the person and employment scope_read policies. True with no app.user_id (system path, documented residual), true for the person linked to the current user, true for a tenant-wide role, otherwise legal entity or org-unit-subtree match. False without an active membership, for a person outside the tenant, for an employee who is not the person, and for an unplaced person seen by a scoped member. SECURITY DEFINER; EXECUTE only for saas_runtime.';

create or replace function app.person_in_scope(p_person_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tenant uuid := app.current_tenant_id();
  v_user uuid := app.current_user_id();
  v_role text := app.current_member_role();
  v_row record;
begin
  if v_user is null then
    return true;
  end if;
  if v_tenant is null or v_role is null then
    return false;
  end if;

  -- No role may write a person row it is not allowed to reach, and an
  -- employee may never write through SQL scope at all.
  if v_role = 'employee' then
    return false;
  end if;
  if v_role not in ('owner', 'admin', 'hr', 'finance', 'manager', 'auditor') then
    return false;
  end if;

  select p.legal_entity_id, p.org_unit_id
    into v_row
    from public.person p
   where p.id = p_person_id
     and p.tenant_id = v_tenant;
  if not found then
    return false;
  end if;

  if not app.member_has_scope() then
    return true;
  end if;
  return app.member_placement_matches(v_row.legal_entity_id, v_row.org_unit_id);
end;
$$;

comment on function app.person_in_scope(uuid) is
  'Write predicate: which existing person rows the current member may change or remove. Identical to app.person_visible except that an employee is always false and a person linked to the current user gets no exception - self is a read scope, not a write scope. The application layer denies employee writes before this is reached; this is the database half of the same rule. SECURITY DEFINER; EXECUTE only for saas_runtime.';

create or replace function app.person_placement_in_scope(p_legal_entity_id uuid, p_org_unit_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when app.current_user_id() is null then true
    when app.current_tenant_id() is null then false
    when app.current_member_role() is null then false
    when app.current_member_role() = 'employee' then false
    when app.current_member_role() not in
         ('owner', 'admin', 'hr', 'finance', 'manager', 'auditor') then false
    when not app.member_has_scope() then true
    else app.member_placement_matches(p_legal_entity_id, p_org_unit_id)
  end
$$;

comment on function app.person_placement_in_scope(uuid, uuid) is
  'Placement predicate for inserts and for the placement columns of an update: may this member create or move a person into this legal entity and org unit? Same ladder as app.person_in_scope, and because a null placement argument can never match a scope row, a both-null placement is allowed only for a tenant-wide member. SECURITY DEFINER; EXECUTE only for saas_runtime.';

-- ---------------------------------------------------------------------------
-- Restrictive scope policies
--
-- AS RESTRICTIVE, so each one ANDs with the permissive tenant_isolation
-- policy and with the module_people_* policies from 0008. No policy is
-- dropped, no table gets FORCE ROW LEVEL SECURITY, and an unset app.user_id
-- keeps the previous M0 behaviour. Names are scope_* so
-- app.apply_module_policies() - which only manages module_*_read and
-- module_*_write_* - never drops them.
-- ---------------------------------------------------------------------------

create policy scope_read on public.person
  as restrictive for select
  using (app.person_visible(id));

create policy scope_insert on public.person
  as restrictive for insert
  with check (app.person_placement_in_scope(legal_entity_id, org_unit_id));

create policy scope_update on public.person
  as restrictive for update
  using (app.person_in_scope(id))
  with check (app.person_placement_in_scope(legal_entity_id, org_unit_id));

create policy scope_delete on public.person
  as restrictive for delete
  using (app.person_in_scope(id));

create policy scope_read on public.employment
  as restrictive for select
  using (app.person_visible(person_id));

create policy scope_insert on public.employment
  as restrictive for insert
  with check (app.person_in_scope(person_id));

create policy scope_update on public.employment
  as restrictive for update
  using (app.person_in_scope(person_id))
  with check (app.person_in_scope(person_id));

create policy scope_delete on public.employment
  as restrictive for delete
  using (app.person_in_scope(person_id));

-- ---------------------------------------------------------------------------

revoke all on function app.current_user_id() from public;
revoke all on function app.current_active_membership_id() from public;
revoke all on function app.current_person_id() from public;
revoke all on function app.member_has_scope() from public;
revoke all on function app.org_unit_is_in_scope_subtree(uuid, uuid) from public;
revoke all on function app.member_placement_matches(uuid, uuid) from public;
revoke all on function app.person_visible(uuid) from public;
revoke all on function app.person_in_scope(uuid) from public;
revoke all on function app.person_placement_in_scope(uuid, uuid) from public;

commit;
