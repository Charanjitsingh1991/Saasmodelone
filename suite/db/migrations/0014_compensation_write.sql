-- 0014_compensation_write.sql
-- Compensation write scope: the two restrictive policies that let a member who
-- administers pay add and amend a salary row only for a person they may
-- maintain. This is the database half of ADR 0012 and the second half of the
-- grant that 0013 started: that file made compensation runtime-readable within a
-- scope, this one makes it runtime-writable within the same scope.
--
-- THE INVARIANT THIS MIGRATION EXISTS TO SATISFY
--
-- A read policy alone would let a member write what they cannot maintain. Before
-- this file the runtime already held INSERT and UPDATE on other person-owned
-- tables, and compensation's only scope policy was the 0013 scope_read. RLS does
-- not distinguish a command a route happens not to issue: with a write privilege
-- and no write policy, any member who reached the table could have placed a
-- salary row on a person whose directory row they cannot edit, or moved one off.
-- So the two policies below arrive in the same change as the two column grants in
-- packages/db/sql/runtime-grants.sql - and they are the only reason those grants
-- are safe to have.
--
-- Writes ask the WRITE oracle, not the read oracle
--
-- app.person_in_scope(person_id) is app.person_visible(person_id) with the
-- self-read exception removed, and it is false for the employee role whatever
-- else is true. That asymmetry is the whole design: a person may see their own
-- directory row through app.person_visible and still never write anything that
-- hangs off it, because nothing a member may read about themselves is therefore
-- theirs to change. The 0013 scope_read uses the visible oracle because a row a
-- member may see is a row they may list; these two use the in-scope oracle
-- because a row a member may list is not a row they may maintain.
--
-- WITH CHECK on the update is not a copy-paste of USING
--
-- Both halves say the same predicate here, and they stop two different things.
-- USING asks whether the member may touch the row that already exists. WITH
-- CHECK asks whether the row that would result is one they may own - so it is
-- what refuses an UPDATE that leaves the row readable and moves
-- person_id to someone outside the member's scope. Drop the WITH CHECK clause
-- and the same privilege could re-parent a salary row across the directory; the
-- employment pair in 0012 is held to the same rule for the same reason.
--
-- NO DELETE, ON PURPOSE
--
-- There is no scope_delete policy on compensation, and the runtime gets no
-- DELETE privilege on it either, so there is nothing for such a policy to
-- govern. This repeats 0013's reasoning: a policy for a command no role can
-- execute is untestable surface area. A compensation row is corrected by a new
-- row with a later effective_from, which is also what the append-only rule for
-- pay history wants; an error is superseded, not erased.
--
-- Scope only narrows. The permissive tenant_isolation policy from 0002_people.sql
-- and the restrictive module policies from app.apply_module_policies() stay in
-- front of these two, and names are scope_* so app.apply_module_policies() -
-- which only manages module_*_read and module_*_write_* - never drops them.
--
-- No new function, no change to an existing helper, no table-level grant, no
-- FORCE ROW LEVEL SECURITY, and no change to any other table's privileges. The
-- person_id column both policies read is already among the compensation columns
-- the runtime may select, and the accompanying grant makes it insertable too, so
-- each policy evaluates with privileges the route already holds.

begin;

create policy scope_insert on public.compensation
  as restrictive for insert
  with check (app.person_in_scope(person_id));

create policy scope_update on public.compensation
  as restrictive for update
  using (app.person_in_scope(person_id))
  with check (app.person_in_scope(person_id));

commit;
