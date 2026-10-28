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
-- plus the columns it may write. deleted_at is used solely to exclude
-- soft-deleted rows and is never exported or written. The write grants are the
-- six identity fields plus the two placement columns: no table-level DML, no
-- DELETE, and no grant on personal_email, status, user_id, deleted_at, the
-- timestamps, the demographics or the reporting and source columns - those
-- stay owner-only. Placement is writable only through UPDATE: the INSERT list
-- has no placement column, so a person can only be created unplaced. id is
-- insertable so a create can name the row it made (the restrictive scope_read
-- policy refuses INSERT ... RETURNING on person; see ADR 0008) and is
-- deliberately absent from UPDATE, so no one can move a row onto another
-- identity. RLS remains the tenant and scope boundary for every write.
grant select (
  id, employee_code, first_name, last_name, display_name,
  work_email, phone, deleted_at, legal_entity_id, org_unit_id
) on table public.person to saas_runtime;

grant insert (
  id, tenant_id, employee_code, first_name, last_name, display_name,
  work_email, phone
) on table public.person to saas_runtime;

grant update (
  employee_code, first_name, last_name, display_name,
  work_email, phone, legal_entity_id, org_unit_id
) on table public.person to saas_runtime;

-- Placement reference data. Column-only SELECT on exactly the columns the
-- directory join and the placement options list need; no table-level grant, no
-- INSERT, UPDATE or DELETE, and no tenant_id. Queries reach these rows by their
-- globally unique id and rely on the composite (tenant_id, id) foreign key from
-- person plus the tenant_isolation RLS policy on each table; they never filter
-- on tenant_id. Legal entity and org unit administration is not built, so the
-- runtime role has no write path to either table.
grant select (
  id, name, code, deleted_at
) on table public.legal_entity to saas_runtime;

grant select (
  id, name, legal_entity_id, deleted_at
) on table public.org_unit to saas_runtime;

-- Compensation history. Column-only SELECT on exactly the seven columns the
-- read route names; no table-level grant, and no tenant_id. The structure jsonb
-- stays ungranted because it is where an unreviewed pay breakdown would live,
-- and the source, import and timestamp columns stay owner-only for the same
-- reason they do on person. Queries reach these rows by the person they hang off
-- and rely on the composite (tenant_id, person_id) foreign key, the
-- tenant_isolation policy from 0002 and the restrictive scope_read policy from
-- 0013_compensation_read.sql; the route never filters on tenant_id itself.
grant select (
  id, person_id, effective_from, effective_to, ctc_minor, currency, pay_frequency
) on table public.compensation to saas_runtime;

-- The compensation write, and exactly the columns the two write routes need.
-- There is still no table-level privilege: each command is granted per column,
-- so the runtime cannot write a column no route names. id is insertable so a
-- create can name the row it made; unlike person, this table's scope policies
-- evaluate their oracle against a person_id that already exists rather than
-- against the new row's own id, so INSERT ... RETURNING is not refused here
-- (0008 refuses it on person because that policy reads the new row's own id). The route still generates the id and
-- reads the row back, so a write answer is built from the same select fragments
-- as the list. tenant_id and person_id are
-- insertable because a new row must state whose pay it is, and both are
-- deliberately absent from UPDATE: person_id in particular must not become a way
-- to re-parent a salary row across the directory, which is also what the
-- restrictive scope_update policy's WITH CHECK clause in
-- 0014_compensation_write.sql refuses. There is no DELETE grant at all: a
-- compensation row is superseded, never erased, and 0014 therefore adds no
-- delete policy for a command no role can execute. RLS remains the tenant,
-- module and scope boundary for every write.
grant insert (
  id, tenant_id, person_id, effective_from, effective_to, ctc_minor, currency,
  pay_frequency
) on table public.compensation to saas_runtime;

grant update (
  effective_from, effective_to, ctc_minor, currency, pay_frequency
) on table public.compensation to saas_runtime;

-- The Work, Money and Content read surfaces. Three column-only SELECT grants,
-- one per table, for exactly the columns the three routes name. There is no
-- table-level privilege on any of the three and no INSERT, UPDATE or DELETE on
-- invoice or content_item: the runtime role has no path that could create,
-- change or remove an invoice or a content item, and there is still no product
-- write route and no write screen in either of those two modules. The client
-- grant is the third of the three, and it is the one CRM widens - the CRM
-- write grants are further down this file.
--
-- public.project is not in this list because it already carries the M0
-- table-level grant above, which the M0 module denial proof depends on: those
-- tests must fail on the restrictive RLS policy, not on a missing table
-- privilege. Narrowing that grant is deferred to the Work write slice, and
-- until then the Work route names only the columns it returns.
--
-- public.client is platform-owned shared directory data. It has no module
-- policy - only the permissive tenant_isolation policy - exactly like
-- legal_entity and org_unit, so the column grant follows that precedent: the
-- rows are reached by their globally unique id and never filtered on tenant_id
-- in the route. Its exposure is bounded by the route that reads it, and the
-- only two routes that read a client name are module-gated.
grant select (
  id, client_id, number, status, issue_date, due_date, currency,
  subtotal_minor, tax_minor, total_minor, amount_paid_minor
) on table public.invoice to saas_runtime;

grant select (
  id, kind, slug, title, locale, status, published_at, updated_at, deleted_at
) on table public.content_item to saas_runtime;

-- The CRM account surface widens the client grant and no other: billing_email,
-- phone, currency and payment_terms_days are added for the CRM read, and
-- deleted_at stays because the account route excludes a soft-deleted row
-- without ever answering with it. A module policy on this table would break a
-- standalone Work or Money read, so the module gate on the route is the only
-- thing that keeps an unlicensed module from naming a client.
grant select (
  id, name, code, status, billing_email, phone, currency, payment_terms_days,
  deleted_at
) on table public.client to saas_runtime;

-- The CRM account write, and exactly the columns the two write routes name.
-- There is still no table-level privilege on this table and no DELETE: an
-- account is retired through its status, never erased, and there is no delete
-- route and no delete policy for a command no role can execute. id and
-- tenant_id are insertable because a new row must state which account it is
-- and which workspace owns it; both are deliberately absent from UPDATE, so no
-- one can move an account onto another identity or another tenant. The UPDATE
-- grant is the seven stored fields the account write names: name, code, status,
-- billing_email, phone, currency and payment_terms_days. With id that is the
-- eight-key response, and nothing else is writable: owner_user_id, the
-- provenance columns, the timestamps and deleted_at stay owner-only, and the
-- runtime never writes deleted_at, so a soft delete is not something the
-- product can do to a shared record. RLS remains the tenant boundary for every
-- write.
grant insert (
  id, tenant_id, name, code, status, billing_email, phone, currency,
  payment_terms_days
) on table public.client to saas_runtime;

grant update (
  name, code, status, billing_email, phone, currency, payment_terms_days
) on table public.client to saas_runtime;

-- The CRM contact surface. client_contact is shared platform-owned directory
-- data like client itself, and it carries the same tenant_isolation policy
-- with no module policy, so a standalone Work or Money read is untouched by
-- it. The column grants name exactly the six fields the contact surface
-- returns plus the two a new row must state: there is no table-level
-- privilege, no DELETE, and no grant on the timestamps. client_id is
-- insertable because a new contact must state which account it belongs to,
-- and it is deliberately absent from UPDATE, so no one can move a contact onto
-- another account. There is no delete route and no soft-delete column on this
-- table, which is a limitation of the shared record and not a choice this
-- product makes: a contact is corrected in place. RLS remains the tenant
-- boundary for every write.
grant select (
  id, client_id, name, email, phone, role, is_primary
) on table public.client_contact to saas_runtime;

grant insert (
  id, tenant_id, client_id, name, email, phone, role, is_primary
) on table public.client_contact to saas_runtime;

grant update (
  name, email, phone, role, is_primary
) on table public.client_contact to saas_runtime;

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
