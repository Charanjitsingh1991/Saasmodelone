-- 0001_modules.sql
-- Initial module catalog. Run once after migrations, then change status
-- through the administrative path; this file is idempotent.
--
-- Work, Money and Content moved from 'planned' to 'preview' on 27 October
-- 2026, by the owner's decision to build all five modules rather than one at a
-- time (suite/docs/adr/0013-work-money-content-read.md). 'preview' means the
-- module is publicly licensable and pre-GA: a normal tenant can hold it on a
-- contract entitlement and its read surface is served, but nothing here says
-- the module is generally available or that anything beyond the shipped read
-- surfaces works.
--
-- There is no administrative path for catalog status yet. Nothing in this
-- repository writes platform_module.status after this seed, so moving a module
-- between 'planned', 'preview', 'available' and 'retired' is still a reviewed
-- migration and seed change. That gap is real and is recorded in the "still not
-- built" list of ADR 0013.
--
-- The insert below is 'on conflict (code) do nothing', so a database seeded
-- before this change keeps its existing 'planned' rows. The update below is
-- what moves an existing catalog to the status this file declares; it is
-- idempotent and it only touches the three modules named here.

begin;

insert into platform_module
  (code, name, category, description, is_licensable, is_core, default_seat_unit, status, sort_order)
values
  ('core', 'Platform core', 'platform',
   'Identity, organisation directory, roles, audit, documents, approvals, search, notifications, export and Switch.',
   false, true, 'organisation', 'preview', 0),
  ('switch', 'Switch', 'platform',
   'Migration console included with any licensed module.',
   false, false, 'organisation', 'preview', 1),
  ('people', 'People', 'hr',
   'HRM, attendance and payroll with reviewed jurisdiction packs.',
   true, false, 'employee', 'preview', 10),
  ('crm', 'CRM', 'crm',
   'Accounts, contacts, leads, pipeline and activities.',
   true, false, 'seat', 'planned', 20),
  ('work', 'Work', 'projects',
   'Engagements, projects, allocations, timesheets and project margin.',
   true, false, 'employee', 'preview', 30),
  ('money', 'Money', 'finance',
   'Proposals, contracts, invoices, payments and expenses. ERP foundation for service businesses.',
   true, false, 'employee', 'preview', 40),
  ('content', 'Content', 'content',
   'CMS, knowledge, assets and client document rooms.',
   true, false, 'seat', 'preview', 50),
  ('procurement', 'Procurement', 'finance',
   'Purchase requests, vendors and approvals. Planned module.',
   true, false, 'employee', 'planned', 60),
  ('assets', 'Assets', 'finance',
   'Equipment, assignments and maintenance. Planned module.',
   true, false, 'employee', 'planned', 70),
  ('analytics', 'Analytics', 'platform',
   'Cross-module reporting and benchmarks. Planned module.',
   true, false, 'employee', 'planned', 80)
on conflict (code) do nothing;

-- The insert above cannot change an existing row, so a catalog seeded before
-- 27 October 2026 still says 'planned' for these three modules. This moves
-- exactly those rows and nothing else: a module already at 'preview',
-- 'available' or 'retired' is left alone.
update platform_module
   set status = 'preview'
 where code in ('work', 'money', 'content')
   and status = 'planned';

insert into platform_module_dependency (module_id, depends_on_module_id, optional, reason)
select m.id, d.id, true, 'Allocation reads People availability when that module is licensed.'
from platform_module m, platform_module d
where m.code = 'work' and d.code = 'people'
on conflict do nothing;

insert into platform_module_dependency (module_id, depends_on_module_id, optional, reason)
select m.id, d.id, true, 'Projects can link to CRM accounts when that module is licensed.'
from platform_module m, platform_module d
where m.code = 'work' and d.code = 'crm'
on conflict do nothing;

insert into platform_module_dependency (module_id, depends_on_module_id, optional, reason)
select m.id, d.id, true, 'Invoices can reuse CRM client records when that module is licensed.'
from platform_module m, platform_module d
where m.code = 'money' and d.code = 'crm'
on conflict do nothing;

insert into platform_module_dependency (module_id, depends_on_module_id, optional, reason)
select m.id, d.id, true, 'Milestone billing reads Work when that module is licensed.'
from platform_module m, platform_module d
where m.code = 'money' and d.code = 'work'
on conflict do nothing;

insert into platform_module_dependency (module_id, depends_on_module_id, optional, reason)
select m.id, d.id, true, 'Project cost reads People cost when that module is licensed.'
from platform_module m, platform_module d
where m.code = 'money' and d.code = 'people'
on conflict do nothing;

insert into platform_module_dependency (module_id, depends_on_module_id, optional, reason)
select m.id, d.id, true, 'Document rooms can attach to CRM accounts when that module is licensed.'
from platform_module m, platform_module d
where m.code = 'content' and d.code = 'crm'
on conflict do nothing;

insert into platform_module_dependency (module_id, depends_on_module_id, optional, reason)
select m.id, d.id, true, 'Purchase requests can reference people and finance records when licensed.'
from platform_module m, platform_module d
where m.code = 'procurement' and d.code = 'people'
on conflict do nothing;

insert into platform_module_dependency (module_id, depends_on_module_id, optional, reason)
select m.id, d.id, true, 'Purchase requests can post to Money when that module is licensed.'
from platform_module m, platform_module d
where m.code = 'procurement' and d.code = 'money'
on conflict do nothing;

insert into platform_module_dependency (module_id, depends_on_module_id, optional, reason)
select m.id, d.id, true, 'Assets can be assigned to people when that module is licensed.'
from platform_module m, platform_module d
where m.code = 'assets' and d.code = 'people'
on conflict do nothing;

insert into platform_module_dependency (module_id, depends_on_module_id, optional, reason)
select m.id, d.id, true, 'Cross-module reporting reads the modules a tenant has licensed.'
from platform_module m, platform_module d
where m.code = 'analytics' and d.code = 'core'
on conflict do nothing;

commit;
