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

-- The policy installer is owner-only. The blanket revoke above already covers
-- it; this line keeps that contract explicit.
revoke execute on procedure app.apply_module_policies() from saas_runtime;

commit;
