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
  test('has 66 tenant-id tables, with exactly two auth exceptions from RLS', async () => {
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

      expect(result.rows).toHaveLength(66);
      const isolated = result.rows.filter((row) => row.rls);
      expect(isolated).toHaveLength(64);
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

  test('grants only eight person columns and no table privilege', async () => {
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
        { column_name: 'display_name', privilege_type: 'SELECT' },
        { column_name: 'employee_code', privilege_type: 'SELECT' },
        { column_name: 'first_name', privilege_type: 'SELECT' },
        { column_name: 'id', privilege_type: 'SELECT' },
        { column_name: 'last_name', privilege_type: 'SELECT' },
        { column_name: 'phone', privilege_type: 'SELECT' },
        { column_name: 'work_email', privilege_type: 'SELECT' },
      ]);
    } finally {
      await client.end();
    }
  });
});
