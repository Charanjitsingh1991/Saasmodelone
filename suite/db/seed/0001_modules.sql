-- 0001_modules.sql
-- Initial module catalog. Run once after migrations, then change status
-- through the administrative path; this file is idempotent.

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
   true, false, 'employee', 'planned', 30),
  ('money', 'Money', 'finance',
   'Proposals, contracts, invoices, payments and expenses. ERP foundation for service businesses.',
   true, false, 'employee', 'planned', 40),
  ('content', 'Content', 'content',
   'CMS, knowledge, assets and client document rooms.',
   true, false, 'seat', 'planned', 50),
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
