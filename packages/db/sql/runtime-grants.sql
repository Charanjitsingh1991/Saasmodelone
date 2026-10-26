-- Runtime grant allowlist. Applied by the migration runner after every migrate.
-- The runtime role is not the schema owner, does not bypass RLS, and receives
-- no CREATE, ALTER, TRUNCATE or catalog write privilege.

begin;

revoke all on schema app from public;
grant usage on schema app to saas_runtime;

revoke all on schema public from public;
grant usage on schema public to saas_owner, saas_runtime;
grant create on schema public to saas_owner;
revoke create on schema public from saas_runtime;

revoke all on all tables in schema public from public;
revoke all on all tables in schema public from saas_runtime;

-- Read-only harness surface. Forward milestones add explicit grants per table
-- and per command; this list is intentionally not a blanket GRANT ON ALL TABLES.
grant select on table
  public.platform_module,
  public.platform_module_dependency,
  public.module_entitlement
to saas_runtime;

-- M0 RLS proof tables. Full DML is deliberate: the module denial tests must
-- fail on the restrictive RLS policy, not on a missing table privilege.
-- Every further table gains grants per command with the API path that uses it.
grant select, insert, update, delete on table
  public.employment,
  public.project
to saas_runtime;

-- People directory. These are the only person columns the runtime may read,
-- plus the identity columns it may write. deleted_at is used solely to exclude
-- soft-deleted rows and is never exported or written. The write grants are
-- identity columns only: no table-level DML, no DELETE, and no grant on
-- personal_email, status, the placement columns, user_id, deleted_at, the
-- timestamps or the demographic columns - those stay owner-only. id is insertable
-- so a create can name the row it made (the restrictive scope_read policy refuses
-- INSERT ... RETURNING on person; see ADR 0008) and is deliberately absent from
-- UPDATE, so no one can move a row onto another identity. RLS remains the
-- tenant and scope boundary for every write.
grant select (
  id, employee_code, first_name, last_name, display_name,
  work_email, phone, deleted_at
) on table public.person to saas_runtime;

grant insert (
  id, tenant_id, employee_code, first_name, last_name, display_name,
  work_email, phone
) on table public.person to saas_runtime;

grant update (
  employee_code, first_name, last_name, display_name,
  work_email, phone
) on table public.person to saas_runtime;

-- Append-only audit writer. No SELECT, UPDATE or DELETE is granted.
grant insert on table public.audit_event to saas_runtime;

revoke all on all sequences in schema public from public;
revoke all on all sequences in schema public from saas_runtime;

revoke all on all routines in schema app from public;
revoke all on all routines in schema app from saas_runtime;
grant execute on function app.current_tenant_id() to saas_runtime;
grant execute on function app.has_platform_access() to saas_runtime;
grant execute on function app.has_module_read(text) to saas_runtime;
grant execute on function app.has_module_write(text) to saas_runtime;
grant execute on function app.has_switch_access() to saas_runtime;
-- Compatibility alias; an exact delegate to has_module_write.
grant execute on function app.has_active_module(text) to saas_runtime;
-- Resolves the membership role without granting SELECT on public.membership.
grant execute on function app.current_member_role() to saas_runtime;

-- M1 people scope. These are the predicates behind the scope_* policies on
-- person and employment, plus the two context readers they expose. The
-- internal helpers (current_active_membership_id, member_has_scope,
-- org_unit_is_in_scope_subtree, member_placement_matches) stay owner-only:
-- they are called by the definer helpers above, which run as the owner. No
-- grant here touches public.membership_scope - SELECT on that table is never
-- given to the runtime role, which is why the scope readers are definers.
grant execute on function app.current_user_id() to saas_runtime;
grant execute on function app.current_person_id() to saas_runtime;
grant execute on function app.person_visible(uuid) to saas_runtime;
grant execute on function app.person_in_scope(uuid) to saas_runtime;
grant execute on function app.person_placement_in_scope(uuid, uuid) to saas_runtime;

-- The policy installer is owner-only. The blanket revoke above already covers
-- it; this line keeps that contract explicit.
revoke execute on procedure app.apply_module_policies() from saas_runtime;

commit;
