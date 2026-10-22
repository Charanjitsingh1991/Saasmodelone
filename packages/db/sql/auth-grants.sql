-- Identity grant allowlist. Applied after runtime-grants.sql on every migrate.
-- saas_auth can read and maintain identity rows only. It has no privilege on
-- tenant business data, module catalog, entitlements, audit, DDL or TRUNCATE.

begin;

revoke all on schema public from saas_auth;
grant usage on schema public to saas_auth;
revoke create on schema public from saas_auth;

revoke all on schema app from saas_auth;
grant usage on schema app to saas_auth;
revoke create on schema app from saas_auth;

revoke all on all tables in schema public from saas_auth;
revoke all on all sequences in schema public from saas_auth;
revoke all on all routines in schema app from saas_auth;

-- The runtime role gets no access to identity tables.
revoke all on table
  public.app_user,
  public.membership,
  public.auth_session,
  public.invitation
from public, saas_runtime;

-- Password hashes are readable only through app.auth_credentials(); the table
-- grant deliberately excludes password_hash from SELECT.
grant select (id, email, display_name, status, last_login_at)
  on public.app_user to saas_auth;
grant update (password_hash, status, last_login_at)
  on public.app_user to saas_auth;

grant select, insert, update on public.auth_session to saas_auth;

grant select (id, tenant_id, user_id, token_hash, expires_at, accepted_at, revoked_at)
  on public.invitation to saas_auth;
grant update (accepted_at) on public.invitation to saas_auth;

revoke all on function app.auth_tenant_by_slug(citext) from public, saas_runtime;
revoke all on function app.auth_tenant_by_id(uuid) from public, saas_runtime;
revoke all on function app.auth_credentials(uuid, citext) from public, saas_runtime;
revoke all on function app.auth_membership_status(uuid, uuid) from public, saas_runtime;
revoke all on function app.auth_activate_membership(uuid, uuid) from public, saas_runtime;
grant execute on function app.auth_tenant_by_slug(citext) to saas_auth;
grant execute on function app.auth_tenant_by_id(uuid) to saas_auth;
grant execute on function app.auth_credentials(uuid, citext) to saas_auth;
grant execute on function app.auth_membership_status(uuid, uuid) to saas_auth;
grant execute on function app.auth_activate_membership(uuid, uuid) to saas_auth;

commit;
