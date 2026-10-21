import { appendFile, copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  assertLocalDatabaseUrl,
  listSqlFiles,
  migrate,
  OWNER_ROLE,
  RUNTIME_ROLE,
  seed,
} from '@saasmodels/db';
import { createTestDatabase, type TestDatabase } from '@saasmodels/testkit';

const root = process.cwd();
const migrationsDir = path.resolve(root, 'suite', 'db', 'migrations');

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

async function runtimeClient(): Promise<Client> {
  const client = new Client({ connectionString: db().runtimeUrl });
  await client.connect();
  return client;
}

beforeAll(async () => {
  database = await createTestDatabase({ migrate: false });
});

afterAll(async () => {
  await database?.drop();
});

describe('local database harness', () => {
  test('fresh apply records every baseline migration and creates the schema', async () => {
    const expected = await listSqlFiles(migrationsDir);
    expect(expected).toHaveLength(7);

    const result = await migrate({ ownerUrl: db().ownerUrl });
    expect(result.applied).toEqual(expected);
    expect(result.skipped).toEqual([]);

    const client = await ownerClient();
    try {
      const ledger = await client.query<{
        version: string;
        status: string;
        checksum: string;
      }>('select version, status, checksum from infra.schema_migration order by version');
      expect(ledger.rows.map((row) => row.version)).toEqual(expected);
      expect(ledger.rows.every((row) => row.status === 'applied')).toBe(true);
      expect(ledger.rows.every((row) => /^[0-9a-f]{64}$/.test(row.checksum))).toBe(true);

      const tables = await client.query<{ tablename: string }>(
        "select tablename from pg_tables where schemaname = 'public' order by tablename",
      );
      const names = tables.rows.map((row) => row.tablename);
      expect(names).toEqual(
        expect.arrayContaining([
          'tenant',
          'app_user',
          'membership',
          'jurisdiction',
          'person',
          'client',
          'platform_module',
          'platform_module_dependency',
          'module_entitlement',
          'import_batch',
        ]),
      );

      const funcs = await client.query<{ proname: string }>(
        "select proname from pg_proc join pg_namespace on pg_namespace.oid = pg_proc.pronamespace where nspname = 'app'",
      );
      expect(funcs.rows.map((row) => row.proname)).toEqual(
        expect.arrayContaining([
          'current_tenant_id',
          'enable_tenant_rls',
          'add_updated_at',
          'block_mutation',
          'has_active_module',
        ]),
      );
    } finally {
      await client.end();
    }
  });

  test('seeding twice is idempotent and does not overwrite a reviewed catalog row', async () => {
    await seed({ ownerUrl: db().ownerUrl });
    await seed({ ownerUrl: db().ownerUrl });

    const client = await ownerClient();
    try {
      const counts = await client.query<{ modules: string; dependencies: string }>(`
        select
          (select count(*) from platform_module)::text as modules,
          (select count(*) from platform_module_dependency)::text as dependencies
      `);
      expect(counts.rows[0]).toEqual({ modules: '10', dependencies: '10' });

      await client.query("update platform_module set name = 'Reviewed CRM row' where code = 'crm'");
      await seed({ ownerUrl: db().ownerUrl });

      const reviewed = await client.query<{ name: string }>(
        "select name from platform_module where code = 'crm'",
      );
      expect(reviewed.rows[0]?.name).toBe('Reviewed CRM row');
    } finally {
      await client.end();
    }
  });

  test('a second migrate is a no-op', async () => {
    const expected = await listSqlFiles(migrationsDir);
    const client = await ownerClient();
    let before: unknown[];
    try {
      const snapshot = await client.query(
        'select version, status, applied_at, duration_ms from infra.schema_migration order by version',
      );
      before = snapshot.rows;
    } finally {
      await client.end();
    }

    const result = await migrate({ ownerUrl: db().ownerUrl });
    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual(expected);

    const verifier = await ownerClient();
    try {
      const after = await verifier.query(
        'select version, status, applied_at, duration_ms from infra.schema_migration order by version',
      );
      expect(after.rows).toEqual(before);
    } finally {
      await verifier.end();
    }
  });

  test('a tampered applied migration is rejected by checksum', async () => {
    const copyDir = await mkdtemp(path.join(tmpdir(), 'saasmodels-migrations-'));
    const tamperDb = await createTestDatabase({ migrate: false, namePrefix: 'saasmodels_tamper' });
    try {
      for (const file of await readdir(migrationsDir)) {
        if (file.endsWith('.sql')) {
          await copyFile(path.join(migrationsDir, file), path.join(copyDir, file));
        }
      }

      await migrate({ ownerUrl: tamperDb.ownerUrl, migrationsDir: copyDir });
      const last = (await listSqlFiles(copyDir)).at(-1);
      if (!last) {
        throw new Error('No migration copied');
      }
      await appendFile(path.join(copyDir, last), '\n-- tampered after apply\n');

      await expect(
        migrate({ ownerUrl: tamperDb.ownerUrl, migrationsDir: copyDir }),
      ).rejects.toThrow(/different checksum/);
    } finally {
      await tamperDb.drop();
      await rm(copyDir, { recursive: true, force: true });
    }
  });
});

describe('database URL guard', () => {
  test.each([
    [
      'remote socket host without authority',
      'postgresql:///saasmodels?host=db.internal.example',
    ],
    [
      'remote socket host overriding a local authority',
      'postgresql://u:p@localhost:5432/saasmodels?host=db.internal.example',
    ],
    ['remote hostaddr', 'postgresql://u:p@localhost:5432/saasmodels?hostaddr=10.0.0.8'],
    ['service lookup', 'postgresql://u:p@localhost:5432/saasmodels?service=prod'],
    ['passfile lookup', 'postgresql://u:p@localhost:5432/saasmodels?passfile=/tmp/prod.pgpass'],
  ])('rejects %s', (_label, url) => {
    expect(() => assertLocalDatabaseUrl('TEST_DB_ADMIN_URL', url)).toThrow(/refus|must not use|Unix socket/);
  });

  test('accepts local hosts and Unix socket paths', () => {
    expect(() =>
      assertLocalDatabaseUrl('TEST_DB_ADMIN_URL', 'postgres://u:p@localhost:5432/postgres'),
    ).not.toThrow();
    expect(() =>
      assertLocalDatabaseUrl('TEST_DB_ADMIN_URL', 'postgres://u:p@127.0.0.1:5432/postgres'),
    ).not.toThrow();
    expect(() =>
      assertLocalDatabaseUrl('TEST_DB_ADMIN_URL', 'postgres://u:p@[::1]:5432/postgres'),
    ).not.toThrow();
    expect(() =>
      assertLocalDatabaseUrl(
        'TEST_DB_ADMIN_URL',
        'postgresql:///saasmodels?host=/var/run/postgresql',
      ),
    ).not.toThrow();
    expect(() =>
      assertLocalDatabaseUrl(
        'TEST_DB_ADMIN_URL',
        'postgres://u:p@db.internal.example:5432/postgres',
      ),
    ).toThrow(/local PostgreSQL/);
    expect(() =>
      assertLocalDatabaseUrl('TEST_DB_ADMIN_URL', 'postgres://u:p@10.0.0.8:5432/postgres'),
    ).toThrow(/local PostgreSQL/);
  });
});

describe('runtime role privileges', () => {
  test('is a non-owner login without BYPASSRLS or elevated attributes', async () => {
    const client = await runtimeClient();
    try {
      const identity = await client.query<{
        current_user: string;
        owner: string;
        rolsuper: boolean;
        rolcreaterole: boolean;
        rolcreatedb: boolean;
        rolbypassrls: boolean;
        rolcanlogin: boolean;
      }>(`
        select
          current_user,
          (select pg_get_userbyid(datdba) from pg_database where datname = current_database()) as owner,
          r.rolsuper,
          r.rolcreaterole,
          r.rolcreatedb,
          r.rolbypassrls,
          r.rolcanlogin
        from pg_roles r
        where r.rolname = current_user
      `);
      expect(identity.rows[0]).toEqual({
        current_user: RUNTIME_ROLE,
        owner: OWNER_ROLE,
        rolsuper: false,
        rolcreaterole: false,
        rolcreatedb: false,
        rolbypassrls: false,
        rolcanlogin: true,
      });

      const privileges = await client.query<{
        catalog_select: boolean;
        catalog_insert: boolean;
        catalog_update: boolean;
        catalog_delete: boolean;
        dependency_insert: boolean;
        entitlement_select: boolean;
        invoice_select: boolean;
        app_user_select: boolean;
        schema_create: boolean;
        database_create: boolean;
      }>(`
        select
          has_table_privilege(current_user, 'public.platform_module', 'SELECT') as catalog_select,
          has_table_privilege(current_user, 'public.platform_module', 'INSERT') as catalog_insert,
          has_table_privilege(current_user, 'public.platform_module', 'UPDATE') as catalog_update,
          has_table_privilege(current_user, 'public.platform_module', 'DELETE') as catalog_delete,
          has_table_privilege(current_user, 'public.platform_module_dependency', 'INSERT') as dependency_insert,
          has_table_privilege(current_user, 'public.module_entitlement', 'SELECT') as entitlement_select,
          has_table_privilege(current_user, 'public.invoice', 'SELECT') as invoice_select,
          has_table_privilege(current_user, 'public.app_user', 'SELECT') as app_user_select,
          has_schema_privilege(current_user, 'public', 'CREATE') as schema_create,
          has_database_privilege(current_user, current_database(), 'CREATE') as database_create
      `);
      expect(privileges.rows[0]).toEqual({
        catalog_select: true,
        catalog_insert: false,
        catalog_update: false,
        catalog_delete: false,
        dependency_insert: false,
        entitlement_select: true,
        invoice_select: false,
        app_user_select: false,
        schema_create: false,
        database_create: false,
      });

      const routines = await client.query<{
        current_tenant: boolean;
        enable_rls: boolean;
        add_updated_at: boolean;
        block_mutation: boolean;
        has_active_module: boolean;
      }>(`
        select
          has_function_privilege(current_user, 'app.current_tenant_id()', 'EXECUTE') as current_tenant,
          has_function_privilege(current_user, 'app.enable_tenant_rls(text)', 'EXECUTE') as enable_rls,
          has_function_privilege(current_user, 'app.add_updated_at(text)', 'EXECUTE') as add_updated_at,
          has_function_privilege(current_user, 'app.block_mutation()', 'EXECUTE') as block_mutation,
          has_function_privilege(current_user, 'app.has_active_module(text)', 'EXECUTE') as has_active_module
      `);
      expect(routines.rows[0]).toEqual({
        current_tenant: true,
        enable_rls: false,
        add_updated_at: false,
        block_mutation: false,
        has_active_module: false,
      });

      const catalog = await client.query<{ count: string }>(
        'select count(*)::text as count from platform_module',
      );
      expect(catalog.rows[0]?.count).toBe('10');
    } finally {
      await client.end();
    }
  });

  test('cannot write the catalog or truncate it', async () => {
    const client = await runtimeClient();
    try {
      await expect(
        client.query(
          "insert into platform_module (code, name, category) values ('runtime_probe', 'Probe', 'test')",
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        client.query("update platform_module set name = 'Probe' where code = 'crm'"),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        client.query("delete from platform_module where code = 'crm'"),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        client.query(`
          insert into platform_module_dependency (module_id, depends_on_module_id, optional, reason)
          values (
            '00000000-0000-0000-0000-000000000001',
            '00000000-0000-0000-0000-000000000002',
            true,
            'runtime probe'
          )
        `),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(client.query('truncate platform_module')).rejects.toMatchObject({
        code: '42501',
      });
    } finally {
      await client.end();
    }
  });

  test('cannot call administrative procedures or create objects', async () => {
    const client = await runtimeClient();
    try {
      await expect(client.query("call app.enable_tenant_rls('tenant')")).rejects.toMatchObject({
        code: '42501',
      });
      await expect(client.query("call app.add_updated_at('tenant')")).rejects.toMatchObject({
        code: '42501',
      });
      await expect(client.query('select app.block_mutation()')).rejects.toMatchObject({
        code: '42501',
      });
      await expect(
        client.query('create table public.runtime_probe (id integer)'),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(client.query('create schema runtime_probe')).rejects.toMatchObject({
        code: '42501',
      });
    } finally {
      await client.end();
    }
  });
});
