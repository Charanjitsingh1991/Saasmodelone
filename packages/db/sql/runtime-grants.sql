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

revoke all on all sequences in schema public from public;
revoke all on all sequences in schema public from saas_runtime;

revoke all on all routines in schema app from public;
revoke all on all routines in schema app from saas_runtime;
grant execute on function app.current_tenant_id() to saas_runtime;

commit;
