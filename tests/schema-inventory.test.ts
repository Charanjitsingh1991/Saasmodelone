import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@saasmodels/testkit';

let database: TestDatabase | undefined;

function db(): TestDatabase {
  if (!database) {
    throw new Error('Test database has not been created');
  }
  return database;
}

async function ownerClient(): Promise<Client> {
  const client = new Client({ connectionString: db().ownerUrl });
  await client.connect();
  return client;
}

type TenantTable = {
  table_name: string;
  rls: boolean;
  has_permissive_isolation: boolean;
  policy_count: number;
};

type TableGrant = {
  table_name: string;
  privilege_type: string;
};

type ColumnGrant = {
  column_name: string;
  privilege_type: string;
};

beforeAll(async () => {
  database = await createTestDatabase({ migrate: true, seed: false });
});

afterAll(async () => {
  await database?.drop();
});

describe('schema inventory', () => {
  test('has 67 tenant-id tables, with exactly two auth exceptions from RLS', async () => {
    const client = await ownerClient();
    try {
      const result = await client.query<TenantTable>(`
        select t.table_name,
               c.relrowsecurity as rls,
               exists (
                 select 1 from pg_policy p
                  where p.polrelid = c.oid
                    and p.polname = 'tenant_isolation'
                    and p.polpermissive
               ) as has_permissive_isolation,
               (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policy_count
          from information_schema.tables t
          join pg_namespace n on n.nspname = t.table_schema
          join pg_class c on c.relnamespace = n.oid and c.relname = t.table_name
         where t.table_schema = 'public'
           and t.table_type = 'BASE TABLE'
           and exists (
             select 1 from information_schema.columns col
              where col.table_schema = 'public'
                and col.table_name = t.table_name
                and col.column_name = 'tenant_id'
           )
         order by t.table_name
      `);

      expect(result.rows).toHaveLength(67);
      const isolated = result.rows.filter((row) => row.rls);
      expect(isolated).toHaveLength(65);
      expect(isolated.every((row) => row.has_permissive_isolation)).toBe(true);
      expect(isolated.every((row) => row.policy_count >= 1)).toBe(true);

      const exceptions = result.rows.filter((row) => !row.rls);
      expect(exceptions.map((row) => row.table_name)).toEqual(['auth_session', 'invitation']);
      expect(exceptions.every((row) => !row.has_permissive_isolation)).toBe(true);
      expect(exceptions.every((row) => row.policy_count === 0)).toBe(true);
    } finally {
      await client.end();
    }
  });

  test('holds exactly one permissive isolation policy per RLS table inside the reviewed 277-policy inventory', async () => {
    const client = await ownerClient();
    try {
      const totals = await client.query<{ permissive: string; restrictive: string }>(`
        select count(*) filter (where p.polpermissive)::text as permissive,
               count(*) filter (where not p.polpermissive)::text as restrictive
          from pg_policy p
          join pg_class c on c.oid = p.polrelid
          join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public'
      `);
      expect(totals.rows).toEqual([{ permissive: '66', restrictive: '211' }]);

      const perTable = await client.query<{ rls_tables: string; with_isolation: string }>(`
        select count(*) filter (where c.relrowsecurity)::text as rls_tables,
               count(*) filter (
                 where exists (
                   select 1 from pg_policy p
                    where p.polrelid = c.oid and p.polpermissive
                 )
               )::text as with_isolation
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind = 'r'
      `);
      // Every RLS-enabled table carries exactly one permissive policy
      // (tenant_isolation, or tenant_self on tenant) and nothing else.
      expect(perTable.rows).toEqual([{ rls_tables: '66', with_isolation: '66' }]);

      const multiIsolation = await client.query<{ relname: string }>(`
        select c.relname
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind = 'r'
           and (select count(*) from pg_policy p where p.polrelid = c.oid and p.polpermissive) > 1
      `);
      expect(multiIsolation.rows).toEqual([]);

      const scopePolicies = await client.query<{ table_name: string; polname: string }>(`
        select c.relname as table_name, p.polname
          from pg_policy p
          join pg_class c on c.oid = p.polrelid
         where c.relname in ('compensation', 'employment', 'person')
           and p.polname like 'scope_%'
         order by c.relname, p.polname
      `);
      // 0012 adds the same four names to person and employment. 0013 adds the one
      // name compensation had at the time - a read - because no route wrote salary
      // yet and the runtime held no write privilege on the table. 0014 adds the
      // insert and update pair, so all three person-child tables now carry the
      // same shape of scope layer, and compensation carries no delete name because
      // a pay row is superseded, not erased. All eleven are restrictive, so they AND
      // with tenant_isolation and the module_people_* set instead of replacing
      // either; tests/scope.test.ts asserts the expressions and
      // tests/people-compensation-write.test.ts the two grants beside them.
      expect(scopePolicies.rows.map((row) => `${row.table_name}.${row.polname}`)).toEqual([
        'compensation.scope_insert',
        'compensation.scope_read',
        'compensation.scope_update',
        'employment.scope_delete',
        'employment.scope_insert',
        'employment.scope_read',
        'employment.scope_update',
        'person.scope_delete',
        'person.scope_insert',
        'person.scope_read',
        'person.scope_update',
      ]);
    } finally {
      await client.end();
    }
  });

  test('keeps tenant self-access without a tenant_id column and never forces RLS', async () => {
    const client = await ownerClient();
    try {
      const tenant = await client.query<{
        rls: boolean;
        policies: string[];
        has_tenant_id: boolean;
      }>(`
        select c.relrowsecurity as rls,
               coalesce((
                 select array_agg(p.polname::text order by p.polname)::text[]
                   from pg_policy p
                  where p.polrelid = c.oid
               ), '{}'::text[]) as policies,
               exists (
                 select 1 from information_schema.columns
                  where table_schema = 'public'
                    and table_name = 'tenant'
                    and column_name = 'tenant_id'
               ) as has_tenant_id
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relname = 'tenant'
      `);
      expect(tenant.rows).toEqual([
        { rls: true, policies: ['tenant_self'], has_tenant_id: false },
      ]);

      const forced = await client.query<{ schema: string; relname: string }>(`
        select n.nspname as schema, c.relname
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
         where n.nspname in ('public', 'infra')
           and c.relkind = 'r'
           and c.relforcerowsecurity
         order by 1, 2
      `);
      expect(forced.rows).toEqual([]);
    } finally {
      await client.end();
    }
  });

  test('keeps the auth exception tables unreachable by the runtime role', async () => {
    const client = await ownerClient();
    try {
      const grants = await client.query<TableGrant>(`
        select table_name, privilege_type
          from information_schema.role_table_grants
         where grantee = 'saas_runtime'
           and table_schema = 'public'
           and table_name in ('auth_session', 'invitation')
         order by table_name, privilege_type
      `);
      expect(grants.rows).toEqual([]);

      const privileges = await client.query<{
        table_name: string;
        privilege: string;
        allowed: boolean;
      }>(`
        select t as table_name, p as privilege,
               has_table_privilege('saas_runtime', 'public.' || t, p) as allowed
          from unnest(array['auth_session', 'invitation']) t
         cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p
         order by 1, 2
      `);
      expect(privileges.rows.every((row) => !row.allowed)).toBe(true);

      const functions = await client.query<{ proname: string; prosecdef: boolean }>(`
        select p.proname, p.prosecdef
          from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'app'
           and p.proname in (
             'auth_tenant_by_slug',
             'auth_tenant_by_id',
             'auth_credentials',
             'auth_membership_status',
             'auth_activate_membership'
           )
         order by p.proname
      `);
      expect(functions.rows).toHaveLength(5);
      expect(functions.rows.every((row) => row.prosecdef)).toBe(true);
    } finally {
      await client.end();
    }
  });

  test('grants the runtime exactly the reviewed table privileges', async () => {
    const client = await ownerClient();
    try {
      const grants = await client.query<TableGrant>(`
        select table_name, privilege_type
          from information_schema.role_table_grants
         where grantee = 'saas_runtime'
           and table_schema = 'public'
         order by table_name, privilege_type
      `);
      const expected: TableGrant[] = [
        { table_name: 'audit_event', privilege_type: 'INSERT' },
        { table_name: 'employment', privilege_type: 'DELETE' },
        { table_name: 'employment', privilege_type: 'INSERT' },
        { table_name: 'employment', privilege_type: 'SELECT' },
        { table_name: 'employment', privilege_type: 'UPDATE' },
        { table_name: 'module_entitlement', privilege_type: 'SELECT' },
        { table_name: 'platform_module', privilege_type: 'SELECT' },
        { table_name: 'platform_module_dependency', privilege_type: 'SELECT' },
        { table_name: 'project', privilege_type: 'DELETE' },
        { table_name: 'project', privilege_type: 'INSERT' },
        { table_name: 'project', privilege_type: 'SELECT' },
        { table_name: 'project', privilege_type: 'UPDATE' },
      ];
      expect(grants.rows).toEqual(expected);
      // This is the table-level inventory, so it stays at twelve: compensation's
      // grants are column-qualified and belong to column_privileges, where the
      // test below pins the exact read and write columns.

      const tables = await client.query<{ table_name: string; rls: boolean }>(`
        select t.table_name, c.relrowsecurity as rls
          from information_schema.tables t
          join pg_namespace n on n.nspname = t.table_schema
          join pg_class c on c.relnamespace = n.oid and c.relname = t.table_name
         where t.table_schema = 'public'
           and t.table_type = 'BASE TABLE'
           and exists (
             select 1 from information_schema.columns col
              where col.table_schema = 'public'
                and col.table_name = t.table_name
                and col.column_name = 'tenant_id'
           )
      `);
      const tenantTables = new Map(tables.rows.map((row) => [row.table_name, row.rls]));
      const catalogOnly = new Set(['platform_module', 'platform_module_dependency']);

      for (const table of new Set(grants.rows.map((row) => row.table_name))) {
        if (catalogOnly.has(table)) {
          expect(tenantTables.has(table)).toBe(false);
        } else {
          expect(tenantTables.get(table)).toBe(true);
        }
      }
    } finally {
      await client.end();
    }
  });

  test('grants only the reviewed person columns and no table privilege', async () => {
    const client = await ownerClient();
    try {
      const tablePrivileges = await client.query<{
        privilege: string;
        allowed: boolean;
      }>(`
        select p as privilege,
               has_table_privilege('saas_runtime', 'public.person', p) as allowed
          from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p
         order by 1
      `);
      expect(tablePrivileges.rows.every((row) => !row.allowed)).toBe(true);

      const columns = await client.query<ColumnGrant>(`
        select column_name, privilege_type
          from information_schema.column_privileges
         where grantee = 'saas_runtime'
           and table_schema = 'public'
           and table_name = 'person'
         order by column_name, privilege_type
      `);
      expect(columns.rows).toEqual([
        { column_name: 'deleted_at', privilege_type: 'SELECT' },
        { column_name: 'display_name', privilege_type: 'INSERT' },
        { column_name: 'display_name', privilege_type: 'SELECT' },
        { column_name: 'display_name', privilege_type: 'UPDATE' },
        { column_name: 'employee_code', privilege_type: 'INSERT' },
        { column_name: 'employee_code', privilege_type: 'SELECT' },
        { column_name: 'employee_code', privilege_type: 'UPDATE' },
        { column_name: 'first_name', privilege_type: 'INSERT' },
        { column_name: 'first_name', privilege_type: 'SELECT' },
        { column_name: 'first_name', privilege_type: 'UPDATE' },
        { column_name: 'id', privilege_type: 'INSERT' },
        { column_name: 'id', privilege_type: 'SELECT' },
        { column_name: 'last_name', privilege_type: 'INSERT' },
        { column_name: 'last_name', privilege_type: 'SELECT' },
        { column_name: 'last_name', privilege_type: 'UPDATE' },
        { column_name: 'legal_entity_id', privilege_type: 'SELECT' },
        { column_name: 'legal_entity_id', privilege_type: 'UPDATE' },
        { column_name: 'org_unit_id', privilege_type: 'SELECT' },
        { column_name: 'org_unit_id', privilege_type: 'UPDATE' },
        { column_name: 'phone', privilege_type: 'INSERT' },
        { column_name: 'phone', privilege_type: 'SELECT' },
        { column_name: 'phone', privilege_type: 'UPDATE' },
        { column_name: 'tenant_id', privilege_type: 'INSERT' },
        { column_name: 'work_email', privilege_type: 'INSERT' },
        { column_name: 'work_email', privilege_type: 'SELECT' },
        { column_name: 'work_email', privilege_type: 'UPDATE' },
      ]);

      // The same inventory expressed as counts, so a grant added in the wrong
      // place cannot hide inside an ordered list comparison.
      const counts = await client.query<{ privilege_type: string; total: string }>(`
        select privilege_type, count(*)::text as total
          from information_schema.column_privileges
         where grantee = 'saas_runtime'
           and table_schema = 'public'
           and table_name = 'person'
         group by privilege_type
         order by privilege_type
      `);
      expect(counts.rows).toEqual([
        { privilege_type: 'INSERT', total: '8' },
        { privilege_type: 'SELECT', total: '10' },
        { privilege_type: 'UPDATE', total: '8' },
      ]);

      // id is insertable so a create can name the row it made, but it is never
      // updatable or deletable: no one can move a row onto another identity.
      const identity = await client.query<{ privilege: string; allowed: boolean }>(`
        select 'update id' as privilege,
               has_column_privilege('saas_runtime', 'public.person', 'id', 'UPDATE') as allowed
        union all
        select 'insert tenant_id',
               has_column_privilege('saas_runtime', 'public.person', 'tenant_id', 'INSERT')
        union all
        select 'delete row',
               has_table_privilege('saas_runtime', 'public.person', 'DELETE')
        order by 1
      `);
      expect(identity.rows).toEqual([
        { privilege: 'delete row', allowed: false },
        { privilege: 'insert tenant_id', allowed: true },
        { privilege: 'update id', allowed: false },
      ]);

      // Every column outside the identity fields and the two placement columns
      // stays owner-only for writes.
      const restricted = await client.query<{
        column_name: string;
        insertable: boolean;
        updatable: boolean;
      }>(`
        select c as column_name,
               has_column_privilege('saas_runtime', 'public.person', c, 'INSERT') as insertable,
               has_column_privilege('saas_runtime', 'public.person', c, 'UPDATE') as updatable
          from unnest(array[
            'status', 'user_id',
            'deleted_at', 'created_at', 'updated_at', 'personal_email'
          ]) c
         order by 1
      `);
      for (const row of restricted.rows) {
        expect(row).toMatchObject({ insertable: false, updatable: false });
      }

      // A placement is written onto an existing row only: the INSERT list has no
      // placement column, so a person can only be created unplaced.
      const placement = await client.query<{
        column_name: string;
        selectable: boolean;
        insertable: boolean;
        updatable: boolean;
      }>(`
        select c as column_name,
               has_column_privilege('saas_runtime', 'public.person', c, 'SELECT') as selectable,
               has_column_privilege('saas_runtime', 'public.person', c, 'INSERT') as insertable,
               has_column_privilege('saas_runtime', 'public.person', c, 'UPDATE') as updatable
          from unnest(array['legal_entity_id', 'org_unit_id']) c
         order by 1
      `);
      for (const row of placement.rows) {
        expect(row).toMatchObject({
          selectable: true,
          insertable: false,
          updatable: true,
        });
      }
    } finally {
      await client.end();
    }
  });

  // 0013_compensation_read.sql and 0014_compensation_write.sql between them give
  // the runtime one column-qualified command per operation the routes issue, on
  // exactly the columns those routes name. The shape is the same as person's: no
  // table-level privilege anywhere, and the columns no route names - the pay
  // breakdown, the import provenance, the clock - stay owner-only.
  test('grants the runtime the compensation read and the two write commands by column only', async () => {
    const client = await ownerClient();
    try {
      // A column grant is not a table privilege, and there is no DELETE grant to
      // find at any level: a salary row is superseded by a later one, never erased.
      const tablePrivileges = await client.query<{
        privilege: string;
        allowed: boolean;
      }>(`
        select p as privilege,
               has_table_privilege('saas_runtime', 'public.compensation', p) as allowed
          from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p
         order by 1
      `);
      expect(tablePrivileges.rows.every((row) => !row.allowed)).toBe(true);

      const columns = await client.query<ColumnGrant>(`
        select column_name, privilege_type
          from information_schema.column_privileges
         where grantee = 'saas_runtime'
           and table_schema = 'public'
           and table_name = 'compensation'
         order by column_name, privilege_type
      `);
      expect(columns.rows).toEqual([
        { column_name: 'ctc_minor', privilege_type: 'INSERT' },
        { column_name: 'ctc_minor', privilege_type: 'SELECT' },
        { column_name: 'ctc_minor', privilege_type: 'UPDATE' },
        { column_name: 'currency', privilege_type: 'INSERT' },
        { column_name: 'currency', privilege_type: 'SELECT' },
        { column_name: 'currency', privilege_type: 'UPDATE' },
        { column_name: 'effective_from', privilege_type: 'INSERT' },
        { column_name: 'effective_from', privilege_type: 'SELECT' },
        { column_name: 'effective_from', privilege_type: 'UPDATE' },
        { column_name: 'effective_to', privilege_type: 'INSERT' },
        { column_name: 'effective_to', privilege_type: 'SELECT' },
        { column_name: 'effective_to', privilege_type: 'UPDATE' },
        { column_name: 'id', privilege_type: 'INSERT' },
        { column_name: 'id', privilege_type: 'SELECT' },
        { column_name: 'pay_frequency', privilege_type: 'INSERT' },
        { column_name: 'pay_frequency', privilege_type: 'SELECT' },
        { column_name: 'pay_frequency', privilege_type: 'UPDATE' },
        { column_name: 'person_id', privilege_type: 'INSERT' },
        { column_name: 'person_id', privilege_type: 'SELECT' },
        { column_name: 'tenant_id', privilege_type: 'INSERT' },
      ]);

      const counts = await client.query<{ privilege_type: string; total: string }>(`
        select privilege_type, count(*)::text as total
          from information_schema.column_privileges
         where grantee = 'saas_runtime'
           and table_schema = 'public'
           and table_name = 'compensation'
         group by privilege_type
         order by privilege_type
      `);
      expect(counts.rows).toEqual([
        { privilege_type: 'INSERT', total: '8' },
        { privilege_type: 'SELECT', total: '7' },
        { privilege_type: 'UPDATE', total: '5' },
      ]);

      // The row's identity and its owner are stated once, at insert: a create
      // cannot be re-parented onto another person or another tenant, which is the
      // same rule person's id and tenant_id follow above.
      const identity = await client.query<{ privilege: string; allowed: boolean }>(`
        select 'update id' as privilege,
               has_column_privilege('saas_runtime', 'public.compensation', 'id', 'UPDATE') as allowed
        union all
        select 'update person_id',
               has_column_privilege('saas_runtime', 'public.compensation', 'person_id', 'UPDATE')
        union all
        select 'update tenant_id',
               has_column_privilege('saas_runtime', 'public.compensation', 'tenant_id', 'UPDATE')
        union all
        select 'insert tenant_id',
               has_column_privilege('saas_runtime', 'public.compensation', 'tenant_id', 'INSERT')
        union all
        select 'delete row',
               has_table_privilege('saas_runtime', 'public.compensation', 'DELETE')
        order by 1
      `);
      expect(identity.rows).toEqual([
        { privilege: 'delete row', allowed: false },
        { privilege: 'insert tenant_id', allowed: true },
        { privilege: 'update id', allowed: false },
        { privilege: 'update person_id', allowed: false },
        { privilege: 'update tenant_id', allowed: false },
      ]);

      // The jsonb pay breakdown stays ungranted, and so do the provenance and
      // clock columns: a salary write names five values and nothing else.
      const restricted = await client.query<{
        column_name: string;
        selectable: boolean;
        insertable: boolean;
        updatable: boolean;
      }>(`
        select c as column_name,
               has_column_privilege('saas_runtime', 'public.compensation', c, 'SELECT') as selectable,
               has_column_privilege('saas_runtime', 'public.compensation', c, 'INSERT') as insertable,
               has_column_privilege('saas_runtime', 'public.compensation', c, 'UPDATE') as updatable
          from unnest(array[
            'structure', 'source_system', 'source_id', 'import_batch_id',
            'imported_at', 'created_at', 'updated_at'
          ]) c
         order by 1
      `);
      expect(restricted.rows.every((row) => !row.selectable && !row.insertable && !row.updatable)).toBe(
        true,
      );
    } finally {
      await client.end();
    }
  });

  test('grants the runtime column-only SELECT on the placement reference tables', async () => {
    const client = await ownerClient();
    try {
      const columns = await client.query<{
        table_name: string;
        column_name: string;
        privilege_type: string;
      }>(`
        select table_name, column_name, privilege_type
          from information_schema.column_privileges
         where grantee = 'saas_runtime'
           and table_schema = 'public'
           and table_name in ('legal_entity', 'org_unit')
         order by table_name, column_name, privilege_type
      `);
      expect(columns.rows).toEqual([
        { table_name: 'legal_entity', column_name: 'code', privilege_type: 'SELECT' },
        { table_name: 'legal_entity', column_name: 'deleted_at', privilege_type: 'SELECT' },
        { table_name: 'legal_entity', column_name: 'id', privilege_type: 'SELECT' },
        { table_name: 'legal_entity', column_name: 'name', privilege_type: 'SELECT' },
        { table_name: 'org_unit', column_name: 'deleted_at', privilege_type: 'SELECT' },
        { table_name: 'org_unit', column_name: 'id', privilege_type: 'SELECT' },
        { table_name: 'org_unit', column_name: 'legal_entity_id', privilege_type: 'SELECT' },
        { table_name: 'org_unit', column_name: 'name', privilege_type: 'SELECT' },
      ]);

      // Reference data is read by id under each table's own tenant_isolation
      // policy. No table-level privilege, and no write path: legal entity and
      // org unit administration is not built in this milestone.
      const privileges = await client.query<{
        check: string;
        allowed: boolean;
      }>(`
        select 'legal_entity select' as check,
               has_table_privilege('saas_runtime', 'public.legal_entity', 'SELECT') as allowed
        union all
        select 'legal_entity insert',
               has_table_privilege('saas_runtime', 'public.legal_entity', 'INSERT')
        union all
        select 'legal_entity update',
               has_table_privilege('saas_runtime', 'public.legal_entity', 'UPDATE')
        union all
        select 'legal_entity delete',
               has_table_privilege('saas_runtime', 'public.legal_entity', 'DELETE')
        union all
        select 'org_unit select',
               has_table_privilege('saas_runtime', 'public.org_unit', 'SELECT')
        union all
        select 'org_unit insert',
               has_table_privilege('saas_runtime', 'public.org_unit', 'INSERT')
        union all
        select 'org_unit update',
               has_table_privilege('saas_runtime', 'public.org_unit', 'UPDATE')
        union all
        select 'org_unit delete',
               has_table_privilege('saas_runtime', 'public.org_unit', 'DELETE')
        union all
        select 'legal_entity tenant_id',
               has_column_privilege('saas_runtime', 'public.legal_entity', 'tenant_id', 'SELECT')
        union all
        select 'org_unit tenant_id',
               has_column_privilege('saas_runtime', 'public.org_unit', 'tenant_id', 'SELECT')
        order by 1
      `);
      expect(privileges.rows.filter((row) => row.allowed)).toEqual([]);
    } finally {
      await client.end();
    }
  });

  // T13 deliberately adds saas_worker: CONNECT at bootstrap, schema usage
  // and the eight EXECUTE grants below from 0011_outbox.sql. 0012_people_scope.sql
  // grants it none of the nine scope helpers. Any change to this inventory must
  // be a reviewed migration, not a runtime grant.
  test('grants the worker no table or column privileges at all', async () => {
    const client = await ownerClient();
    try {
      const tableGrants = await client.query(
        "select 1 from information_schema.role_table_grants where grantee = 'saas_worker'",
      );
      expect(tableGrants.rows).toEqual([]);

      const columnGrants = await client.query(
        "select 1 from information_schema.column_privileges where grantee = 'saas_worker'",
      );
      expect(columnGrants.rows).toEqual([]);

      const domainEvent = await client.query<{ privilege: string; allowed: boolean }>(`
        select p as privilege,
               has_table_privilege('saas_worker', 'public.domain_event', p) as allowed
          from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p
         order by 1
      `);
      expect(domainEvent.rows.every((row) => !row.allowed)).toBe(true);
    } finally {
      await client.end();
    }
  });

  test('grants the worker exactly the outbox and access-helper functions', async () => {
    const client = await ownerClient();
    try {
      const executable = await client.query<{ proname: string }>(`
        select p.proname
          from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'app'
           and has_function_privilege('saas_worker', p.oid, 'EXECUTE')
         order by 1
      `);
      expect(executable.rows.map((row) => row.proname)).toEqual([
        'current_tenant_id',
        'has_module_read',
        'has_module_write',
        'has_platform_access',
        'outbox_claim',
        'outbox_claimed_guard',
        'outbox_mark_published',
        'outbox_record_failure',
      ]);

      const denied = await client.query<{ proname: string }>(`
        select p.proname
          from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'app'
           and not has_function_privilege('saas_worker', p.oid, 'EXECUTE')
           and p.proname in ('current_member_role', 'has_switch_access',
                             'has_active_module', 'auth_activate_membership',
                             'apply_module_policies', 'enable_tenant_rls',
                             'block_mutation',
                             'current_user_id', 'current_person_id', 'person_visible',
                             'person_in_scope', 'person_placement_in_scope',
                             'current_active_membership_id', 'member_has_scope',
                             'org_unit_is_in_scope_subtree', 'member_placement_matches')
         order by 1
      `);
      // 0012 adds nine scope functions and grants the worker none of them: the
      // worker path has no person or scope reads at all.
      expect(denied.rows.map((row) => row.proname)).toEqual([
        'apply_module_policies',
        'auth_activate_membership',
        'block_mutation',
        'current_active_membership_id',
        'current_member_role',
        'current_person_id',
        'current_user_id',
        'enable_tenant_rls',
        'has_active_module',
        'has_switch_access',
        'member_has_scope',
        'member_placement_matches',
        'org_unit_is_in_scope_subtree',
        'person_in_scope',
        'person_placement_in_scope',
        'person_visible',
      ]);

      const definer = await client.query<{ proname: string; prosecdef: boolean }>(`
        select p.proname, p.prosecdef
          from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'app'
           and p.proname in ('outbox_claim', 'outbox_mark_published',
                             'outbox_record_failure', 'outbox_claimed_guard')
         order by 1
      `);
      expect(definer.rows).toHaveLength(4);
      expect(definer.rows.every((row) => row.prosecdef)).toBe(true);
    } finally {
      await client.end();
    }
  });
});
