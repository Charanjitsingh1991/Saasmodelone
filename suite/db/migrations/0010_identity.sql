-- Identity tables and pre-tenant lookup helpers.
--
-- auth_session and invitation intentionally have no tenant RLS policy. Login,
-- session validation and invitation acceptance run before a tenant transaction
-- exists. Access is limited to saas_owner and the least-privilege saas_auth
-- role by explicit grants in packages/db/sql/auth-grants.sql; neither table is
-- reachable from the runtime role.

begin;

create table auth_session (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_user (id) on delete cascade,
  tenant_id uuid not null references tenant (id) on delete cascade,
  token_hash text not null unique
    check (token_hash ~ '^[0-9a-f]{64}$'),
  csrf_token text not null
    check (char_length(csrf_token) = 43),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  ip inet,
  user_agent text,
  check (expires_at > created_at)
);

comment on table auth_session is
  'Opaque server-side sessions. Only the SHA-256 token hash is stored. Not tenant-RLS-scoped: session lookup precedes tenant context.';

create index auth_session_user_idx on auth_session (user_id);
create index auth_session_tenant_idx on auth_session (tenant_id);
create index auth_session_expires_idx on auth_session (expires_at);

create table invitation (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  user_id uuid not null,
  token_hash text not null unique
    check (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_by uuid references app_user (id),
  foreign key (tenant_id, user_id)
    references membership (tenant_id, user_id) on delete cascade,
  check (expires_at > created_at)
);

comment on table invitation is
  'One-time invitation tokens, stored as SHA-256 hashes. Not tenant-RLS-scoped: acceptance precedes tenant context. Unconsumed older rows are revoked by the library, not a partial index.';

create index invitation_membership_idx on invitation (tenant_id, user_id);

-- The auth role has no tenant setting and tenant is RLS-protected, so these
-- security-definer functions are the only pre-tenant tenant lookup path.
-- Forcing RLS on tenant would also require revisiting them; FORCE is not
-- enabled here.
create or replace function app.auth_tenant_by_slug(p_slug citext)
returns table (id uuid, slug citext, status text, deleted_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select t.id, t.slug, t.status, t.deleted_at
  from public.tenant t
  where t.slug = p_slug
  limit 1
$$;

comment on function app.auth_tenant_by_slug(citext) is
  'Pre-tenant tenant lookup for saas_auth only. Returns id, slug, status and deleted_at; callers decide whether the tenant may be used.';

create or replace function app.auth_tenant_by_id(p_id uuid)
returns table (id uuid, slug citext, status text, deleted_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select t.id, t.slug, t.status, t.deleted_at
  from public.tenant t
  where t.id = p_id
  limit 1
$$;

comment on function app.auth_tenant_by_id(uuid) is
  'Pre-tenant tenant lookup by id for saas_auth only.';

-- Narrow credential helper: saas_auth has no SELECT on app_user.password_hash.
create or replace function app.auth_credentials(p_tenant_id uuid, p_email citext)
returns table (
  user_id uuid,
  password_hash text,
  user_status text,
  membership_status text
)
language sql
stable
security definer
set search_path = ''
as $$
  select u.id, u.password_hash, u.status, m.status
  from public.app_user u
  join public.membership m on m.user_id = u.id
  where m.tenant_id = p_tenant_id
    and u.email = p_email
  limit 1
$$;

comment on function app.auth_credentials(uuid, citext) is
  'Credential lookup for saas_auth only. The role cannot SELECT password_hash directly; callers still enforce user and membership status.';

-- Membership RLS would hide or deny direct reads for saas_auth, which has no
-- tenant setting. Invitation acceptance needs the current user and membership
-- statuses through a narrow security-definer path.
create or replace function app.auth_membership_status(p_tenant_id uuid, p_user_id uuid)
returns table (user_status text, membership_status text)
language sql
stable
security definer
set search_path = ''
as $$
  select u.status, m.status
  from public.app_user u
  join public.membership m on m.user_id = u.id
  where u.id = p_user_id
    and m.tenant_id = p_tenant_id
  limit 1
$$;

comment on function app.auth_membership_status(uuid, uuid) is
  'Status lookup for saas_auth only, used before activating an invited membership.';

-- Membership activation helper: saas_auth may not UPDATE membership directly.
create or replace function app.auth_activate_membership(p_tenant_id uuid, p_user_id uuid)
returns boolean
language sql
security definer
set search_path = ''
as $$
  with activated as (
    update public.membership
       set status = 'active',
           updated_at = now()
     where tenant_id = p_tenant_id
       and user_id = p_user_id
       and status = 'invited'
     returning 1
  )
  select exists (select 1 from activated)
$$;

comment on function app.auth_activate_membership(uuid, uuid) is
  'Activate one invited membership for saas_auth only. Returns false when no invited membership matched.';

revoke all on function app.auth_tenant_by_slug(citext) from public;
revoke all on function app.auth_tenant_by_id(uuid) from public;
revoke all on function app.auth_credentials(uuid, citext) from public;
revoke all on function app.auth_membership_status(uuid, uuid) from public;
revoke all on function app.auth_activate_membership(uuid, uuid) from public;

-- EXECUTE for saas_auth is not granted here: the identity allowlist is applied
-- from packages/db/sql/auth-grants.sql after migrations, so role grants stay in
-- one place and this migration does not couple to the role.

commit;
