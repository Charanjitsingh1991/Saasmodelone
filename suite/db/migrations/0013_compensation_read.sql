-- 0013_compensation_read.sql
-- Compensation read scope: the one restrictive scope_read policy that keeps a
-- salary row reachable only through the directory scope the person already sits
-- in. This is the database half of ADR 0011.
--
-- THE INVARIANT THIS MIGRATION EXISTS TO SATISFY
--
-- tests/scope.test.ts pins a rule with no exceptions list: every table in
-- public that has a person_id column AND that the saas_runtime role can read -
-- by a table-level SELECT or by any column-level SELECT - must carry exactly
-- one restrictive SELECT policy whose USING expression names
-- app.person_visible(person_id). The suite discovers those tables from the
-- catalog, so it finds any table a later grant adds by accident.
--
-- That is why this file and packages/db/sql/runtime-grants.sql land together.
-- The grant makes compensation runtime-readable; the policy below is what makes
-- it runtime-readable *within a scope*. Apply the grant without this migration
-- and the invariant test fails with 'compensation' in the uncovered list, which
-- is the failure this suite is built to produce rather than let pass.
--
-- Scope only narrows, exactly as in 0012. The permissive tenant_isolation
-- policy from 0002_people.sql and the restrictive module policies from
-- app.apply_module_policies() stay in front of this one; a restrictive policy
-- ANDs with them, so nothing here can widen what any role may read.
--
-- READ ONLY, ON PURPOSE
--
-- There is no scope_insert, scope_update or scope_delete policy on compensation
-- here, and there will not be one added by a read slice. Least privilege says
-- they arrive with 0014, the migration that grants the runtime a write and opens
-- the route that needs them: a policy for a command no role can execute is
-- untestable surface area, and the runtime holds no INSERT, UPDATE or DELETE on
-- this table to test it against.
--
-- No new function, no change to an existing helper, no table-level grant and no
-- change to the twelve runtime table privileges. The person_id column this
-- policy reads is already in the seven compensation columns the runtime may
-- select, so the policy evaluates with the privileges the route already holds.

begin;

create policy scope_read on public.compensation
  as restrictive for select
  using (app.person_visible(person_id));

commit;
