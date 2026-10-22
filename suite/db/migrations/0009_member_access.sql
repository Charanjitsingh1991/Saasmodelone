-- 0009_member_access.sql
-- Resolves the active membership role for the current tenant and user.
--
-- The helper is security definer because the runtime role has no SELECT on
-- membership. It deliberately does not call has_platform_access(): the request
-- layer checks membership first, so a non-member cannot probe tenant state.
-- A suspended membership returns null, exactly like no membership.

begin;

create or replace function app.current_member_role()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select m.role
  from public.membership m
  where m.tenant_id = app.current_tenant_id()
    and m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
    and m.status = 'active'
  limit 1
$$;

comment on function app.current_member_role() is
  'Role of the active membership for app.tenant_id and app.user_id, or null. Security definer; no membership table grant is given to the runtime role.';

revoke all on function app.current_member_role() from public;

commit;
