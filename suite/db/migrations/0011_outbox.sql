-- 0011_outbox.sql
-- Lease mechanics for the domain_event outbox and the saas_worker surface.
--
-- domain_event itself ships from 0001 (id, tenant_id, type, aggregate_type,
-- aggregate_id, payload, occurred_at, published_at, attempts, last_error).
-- This migration is append-only: it adds the claim columns, one claim index,
-- and four SECURITY DEFINER helpers (one shared argument/tenant guard plus
-- three disposition helpers) so a dedicated worker role can move an
-- event through pending -> leased -> published (or dead) without ever
-- holding a table privilege.
--
-- Delivery is at-least-once. A lease that expires lets another worker claim
-- the same event, so handlers must be idempotent. The helpers pin the lease
-- timestamp: mark-published and record-failure only act while the lease is
-- still live, so a late write from a lost lease is refused and can never
-- disturb a re-claimed row. Dead is terminal: no function returns a dead
-- event to leased.
--
-- The helpers follow the 0010 definer pattern: owner-owned, search_path
-- pinned to empty, fully qualified names, and an explicit tenant filter on
-- every read and write. The owner bypasses RLS by table ownership, so that
-- filter, not a policy, is the isolation boundary here. Each helper refuses
-- with a clear raised error when app.tenant_id is unset or not a valid uuid.
-- attempts increments at claim time only; the failure path never adds to it.

begin;

alter table public.domain_event
  add column status text not null default 'pending'
    check (status in ('pending', 'leased', 'published', 'dead')),
  add column lease_owner text,
  add column lease_expires_at timestamptz,
  add column next_attempt_at timestamptz not null default now();

-- The 0001 unpublished index has no tenant prefix and predates the status
-- column; per-tenant claiming reads this one instead. 0001 is frozen, so the
-- old index remains and is unused by the worker path.
create index domain_event_claim_idx
  on public.domain_event (tenant_id, occurred_at)
  where status in ('pending', 'leased');

create or replace function app.outbox_claimed_guard(
  p_batch_size integer,
  p_lease_owner text,
  p_lease_seconds integer,
  p_max_attempts integer
)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tenant uuid;
begin
  if current_setting('app.tenant_id', true) is null then
    raise exception 'outbox helper: app.tenant_id is not set'
      using errcode = 'P0002';
  end if;
  if current_setting('app.tenant_id', true) !~
     '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    raise exception 'outbox helper: app.tenant_id is not a valid uuid'
      using errcode = 'P0002';
  end if;
  v_tenant := current_setting('app.tenant_id', true)::uuid;

  if p_batch_size is null or p_batch_size < 1 or p_batch_size > 1000 then
    raise exception 'outbox_claim: p_batch_size must be between 1 and 1000'
      using errcode = '22023';
  end if;
  if p_lease_seconds is null or p_lease_seconds < 1 or p_lease_seconds > 86400 then
    raise exception 'outbox_claim: p_lease_seconds must be between 1 and 86400'
      using errcode = '22023';
  end if;
  if p_max_attempts is null or p_max_attempts < 1 or p_max_attempts > 1000 then
    raise exception 'outbox_claim: p_max_attempts must be between 1 and 1000'
      using errcode = '22023';
  end if;
  if p_lease_owner is null or p_lease_owner !~ '^[^[:space:]]{1,64}$' then
    raise exception 'outbox_claim: p_lease_owner must be 1-64 non-space characters'
      using errcode = '22023';
  end if;

  return v_tenant;
end;
$$;

comment on function app.outbox_claimed_guard(integer, text, integer, integer) is
  'Internal guard shared by the outbox helpers: resolves and returns the app.tenant_id GUC, raising a clear error when it is unset or not a valid uuid, and range-checks the claim arguments. SECURITY DEFINER, pinned search_path, EXECUTE only for saas_worker.';

-- Claim one batch for the tenant in app.tenant_id. Two kinds of row are
-- eligible, and only while below the attempt ceiling: a pending row that is
-- due (next_attempt_at reached), and a leased row whose lease_expires_at has
-- passed, so an abandoned or crashed lease is reclaimable by another worker.
-- Each claimed row becomes leased to p_lease_owner for p_lease_seconds and
-- its attempts counter increments exactly once.
-- FOR UPDATE SKIP LOCKED lets concurrent workers claim disjoint batches of
-- the same table without blocking each other.
create or replace function app.outbox_claim(
  p_batch_size integer,
  p_lease_owner text,
  p_lease_seconds integer,
  p_max_attempts integer
)
returns table (
  id uuid,
  type text,
  aggregate_type text,
  aggregate_id uuid,
  payload jsonb,
  occurred_at timestamptz,
  attempts integer,
  lease_expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant uuid;
begin
  v_tenant := app.outbox_claimed_guard(
    p_batch_size, p_lease_owner, p_lease_seconds, p_max_attempts);

  return query
    with eligible as (
      update public.domain_event e
         set status = 'leased',
             lease_owner = p_lease_owner,
             lease_expires_at = now() + make_interval(secs => p_lease_seconds),
             attempts = e.attempts + 1
       where e.id in (
         select candidate.id
           from public.domain_event candidate
          where candidate.tenant_id = v_tenant
            and candidate.attempts < p_max_attempts
            and (
              (candidate.status = 'pending' and candidate.next_attempt_at <= now())
              or (candidate.status = 'leased' and candidate.lease_expires_at <= now())
            )
          order by candidate.occurred_at, candidate.id
          for update of candidate skip locked
          limit p_batch_size
       )
       returning e.id, e.type, e.aggregate_type, e.aggregate_id, e.payload,
                 e.occurred_at, e.attempts, e.lease_expires_at
    )
    select candidate.id, candidate.type, candidate.aggregate_type,
           candidate.aggregate_id, candidate.payload, candidate.occurred_at,
           candidate.attempts, candidate.lease_expires_at
      from eligible candidate;
end;
$$;

comment on function app.outbox_claim(integer, text, integer, integer) is
  'Claim up to p_batch_size due, undisposed domain events for the tenant in app.tenant_id and lease them to p_lease_owner for p_lease_seconds, incrementing attempts once per claim. SECURITY DEFINER; EXECUTE only for saas_worker; raises when the tenant GUC is unset or not a uuid and when an argument is out of range. At-least-once: an expired lease can be reclaimed while the original worker still runs, so handlers must be idempotent.';

-- Finish one event. True = this call published it. False = the lease is not
-- held live by p_lease_owner (stolen after expiry, renewed by a later claim,
-- or the event is already published or dead); the caller must treat the
-- event as disposed and never retry.
create or replace function app.outbox_mark_published(
  p_id uuid,
  p_lease_owner text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant uuid;
  v_lease_expires_at timestamptz;
  v_count integer;
begin
  v_tenant := app.outbox_claimed_guard(1, p_lease_owner, 1, 1);

  -- Read the numeric lease state into locals first: inside an UPDATE WHERE,
  -- a bare column name always wins over a variable of the same name, so a
  -- predicate like published_at < now() could never reference a parameter.
  select e.lease_expires_at
    into v_lease_expires_at
    from public.domain_event e
   where e.id = p_id
     and e.tenant_id = v_tenant;

  update public.domain_event
     set status = 'published',
         published_at = now(),
         lease_owner = null,
         lease_expires_at = null,
         last_error = null
   where id = p_id
     and tenant_id = v_tenant
     and status = 'leased'
     and lease_owner = p_lease_owner
     and v_lease_expires_at > now();

  get diagnostics v_count = row_count;
  if v_count = 1 then
    return true;
  end if;

  if not exists (
    select 1 from public.domain_event e
     where e.id = p_id and e.tenant_id = v_tenant
  ) then
    raise exception 'outbox_mark_published: event % is not in this tenant', p_id
      using hint = 'The tenant filter comes from the app.tenant_id GUC.';
  end if;
  return false;
end;
$$;

comment on function app.outbox_mark_published(uuid, text) is
  'Publish one domain event in the tenant in app.tenant_id while p_lease_owner still holds a live lease on it. Returns false when the lease is not held live or the event is already disposed; raises when the tenant GUC is unset or the event is outside the tenant. SECURITY DEFINER; EXECUTE only for saas_worker.';

-- Record a failed delivery. attempts is already incremented at claim and is
-- never touched here. The row moves to dead once attempts reached
-- p_max_attempts (the claim ceiling made it unreclaimable and this is the
-- final recorded outcome); otherwise it returns to pending with
-- next_attempt_at = now() + p_retry_delay and loses its lease entirely:
-- lease_owner and lease_expires_at are both cleared, so no worker keeps
-- ownership while the row waits, and any worker may claim it once it is due.
-- Returns dead, retried or refused; refused means the lease is not held
-- live by p_lease_owner.
create or replace function app.outbox_record_failure(
  p_id uuid,
  p_lease_owner text,
  p_max_attempts integer,
  p_retry_delay interval,
  p_error text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant uuid;
  v_row record;
  v_count integer;
begin
  v_tenant := app.outbox_claimed_guard(1, p_lease_owner, 1, p_max_attempts);
  if p_retry_delay is null or p_retry_delay < interval '0 seconds' then
    raise exception 'outbox_record_failure: p_retry_delay must be a non-negative interval'
      using errcode = '22023';
  end if;

  -- Lock and read the numeric row state into locals first: inside an UPDATE
  -- WHERE, a bare column name always wins over a variable of the same name,
  -- so attempts comparisons must be carried through locals.
  select e.status, e.lease_owner, e.attempts, e.lease_expires_at > now() as lease_live
    into v_row
    from public.domain_event e
   where e.id = p_id
     and e.tenant_id = v_tenant
   for update;

  if not found then
    raise exception 'outbox_record_failure: event % is not in this tenant', p_id
      using hint = 'The tenant filter comes from the app.tenant_id GUC.';
  end if;

  if v_row.status <> 'leased'
     or v_row.lease_owner is distinct from p_lease_owner
     or not v_row.lease_live then
    return 'refused';
  end if;

  if v_row.attempts >= p_max_attempts then
    update public.domain_event
       set status = 'dead',
           last_error = left(p_error, 4000),
           lease_owner = null,
           lease_expires_at = null
     where id = p_id
       and tenant_id = v_tenant
       and status = 'leased'
       and lease_owner = p_lease_owner;
    return 'dead';
  end if;

  update public.domain_event
     set status = 'pending',
         last_error = left(p_error, 4000),
         next_attempt_at = now() + p_retry_delay,
         lease_owner = null,
         lease_expires_at = null
   where id = p_id
     and tenant_id = v_tenant
     and status = 'leased'
     and lease_owner = p_lease_owner;

  get diagnostics v_count = row_count;
  if v_count = 1 then
    return 'retried';
  end if;
  return 'refused';
end;
$$;

comment on function app.outbox_record_failure(uuid, text, integer, interval, text) is
  'Record one failed delivery attempt for a live lease in the tenant in app.tenant_id: dead when attempts already reached p_max_attempts, otherwise pending again with next_attempt_at = now() + p_retry_delay and lease_owner and lease_expires_at cleared, so the row is unowned and any worker may reclaim it once it is due. Never increments attempts. Returns refused when the lease is not held live. SECURITY DEFINER; EXECUTE only for saas_worker.';

revoke all on function app.outbox_claimed_guard(integer, text, integer, integer) from public;
revoke all on function app.outbox_claim(integer, text, integer, integer) from public;
revoke all on function app.outbox_mark_published(uuid, text) from public;
revoke all on function app.outbox_record_failure(uuid, text, integer, interval, text) from public;

-- saas_worker is created by the same bootstrap path as the other roles and
-- deliberately owns nothing here. It gets schema usage, the four outbox
-- functions and the access helpers that withTenantTransaction calls (the
-- platform and entitlement checks); it gets NO table privileges and every
-- helper it can reach is read-only or lease-scoped. The blanket revokes in
-- runtime-grants.sql target public and saas_runtime only, so these worker
-- grants persist across grant re-applies; tests/schema-inventory.test.ts
-- asserts that inventory deliberately.
grant usage on schema public to saas_worker;
grant usage on schema app to saas_worker;

grant execute on function app.outbox_claimed_guard(integer, text, integer, integer) to saas_worker;
grant execute on function app.outbox_claim(integer, text, integer, integer) to saas_worker;
grant execute on function app.outbox_mark_published(uuid, text) to saas_worker;
grant execute on function app.outbox_record_failure(uuid, text, integer, interval, text) to saas_worker;
grant execute on function app.current_tenant_id() to saas_worker;
grant execute on function app.has_platform_access() to saas_worker;
grant execute on function app.has_module_read(text) to saas_worker;
grant execute on function app.has_module_write(text) to saas_worker;

commit;
