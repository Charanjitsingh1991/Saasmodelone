import { appendFile, copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  assertLocalDatabaseUrl,
  AUTH_ROLE,
  listSqlFiles,
  migrate,
  OWNER_ROLE,
  RUNTIME_ROLE,
  seed,
  WORKER_ROLE,
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

async function authClient(): Promise<Client> {
  const client = new Client({ connectionString: db().authUrl });
  await client.connect();
  return client;
}

async function workerClient(): Promise<Client> {
  const client = new Client({ connectionString: db().workerUrl });
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
    expect(expected).toHaveLength(12);

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
          'auth_session',
          'invitation',
          'membership_scope',
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
          'has_platform_access',
          'has_module_read',
          'has_module_write',
          'has_switch_access',
          'apply_module_policies',
          'current_member_role',
          'auth_tenant_by_slug',
          'auth_tenant_by_id',
          'auth_credentials',
          'auth_membership_status',
          'auth_activate_membership',
          'outbox_claim',
          'outbox_mark_published',
          'outbox_record_failure',
          'outbox_claimed_guard',
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
        auth_session_select: boolean;
        auth_session_insert: boolean;
        auth_session_update: boolean;
        auth_session_delete: boolean;
        invitation_select: boolean;
        invitation_insert: boolean;
        invitation_update: boolean;
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
          has_table_privilege(current_user, 'public.auth_session', 'SELECT') as auth_session_select,
          has_table_privilege(current_user, 'public.auth_session', 'INSERT') as auth_session_insert,
          has_table_privilege(current_user, 'public.auth_session', 'UPDATE') as auth_session_update,
          has_table_privilege(current_user, 'public.auth_session', 'DELETE') as auth_session_delete,
          has_table_privilege(current_user, 'public.invitation', 'SELECT') as invitation_select,
          has_table_privilege(current_user, 'public.invitation', 'INSERT') as invitation_insert,
          has_table_privilege(current_user, 'public.invitation', 'UPDATE') as invitation_update,
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
        auth_session_select: false,
        auth_session_insert: false,
        auth_session_update: false,
        auth_session_delete: false,
        invitation_select: false,
        invitation_insert: false,
        invitation_update: false,
        schema_create: false,
        database_create: false,
      });

      const routines = await client.query<{
        current_tenant: boolean;
        enable_rls: boolean;
        add_updated_at: boolean;
        block_mutation: boolean;
        has_active_module: boolean;
        has_platform_access: boolean;
        has_module_read: boolean;
        has_module_write: boolean;
        has_switch_access: boolean;
        apply_module_policies: boolean;
        current_member_role: boolean;
        auth_tenant_by_slug: boolean;
        auth_tenant_by_id: boolean;
        auth_credentials: boolean;
        auth_activate_membership: boolean;
        auth_membership_status: boolean;
      }>(`
        select
          has_function_privilege(current_user, 'app.current_tenant_id()', 'EXECUTE') as current_tenant,
          has_function_privilege(current_user, 'app.enable_tenant_rls(text)', 'EXECUTE') as enable_rls,
          has_function_privilege(current_user, 'app.add_updated_at(text)', 'EXECUTE') as add_updated_at,
          has_function_privilege(current_user, 'app.block_mutation()', 'EXECUTE') as block_mutation,
          has_function_privilege(current_user, 'app.has_active_module(text)', 'EXECUTE') as has_active_module,
          has_function_privilege(current_user, 'app.has_platform_access()', 'EXECUTE') as has_platform_access,
          has_function_privilege(current_user, 'app.has_module_read(text)', 'EXECUTE') as has_module_read,
          has_function_privilege(current_user, 'app.has_module_write(text)', 'EXECUTE') as has_module_write,
          has_function_privilege(current_user, 'app.has_switch_access()', 'EXECUTE') as has_switch_access,
          has_function_privilege(current_user, 'app.apply_module_policies()', 'EXECUTE') as apply_module_policies,
          has_function_privilege(current_user, 'app.current_member_role()', 'EXECUTE') as current_member_role,
          has_function_privilege(current_user, 'app.auth_tenant_by_slug(citext)', 'EXECUTE') as auth_tenant_by_slug,
          has_function_privilege(current_user, 'app.auth_tenant_by_id(uuid)', 'EXECUTE') as auth_tenant_by_id,
          has_function_privilege(current_user, 'app.auth_credentials(uuid, citext)', 'EXECUTE') as auth_credentials,
          has_function_privilege(current_user, 'app.auth_activate_membership(uuid, uuid)', 'EXECUTE') as auth_activate_membership,
          has_function_privilege(current_user, 'app.auth_membership_status(uuid, uuid)', 'EXECUTE') as auth_membership_status
      `);
      expect(routines.rows[0]).toEqual({
        current_tenant: true,
        enable_rls: false,
        add_updated_at: false,
        block_mutation: false,
        has_active_module: true,
        has_platform_access: true,
        has_module_read: true,
        has_module_write: true,
        has_switch_access: true,
        apply_module_policies: false,
        current_member_role: true,
        auth_tenant_by_slug: false,
        auth_tenant_by_id: false,
        auth_credentials: false,
        auth_activate_membership: false,
        auth_membership_status: false,
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

describe('auth role privileges', () => {
  test('is a non-owner login without elevated attributes or DDL', async () => {
    const client = await authClient();
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
        current_user: AUTH_ROLE,
        owner: OWNER_ROLE,
        rolsuper: false,
        rolcreaterole: false,
        rolcreatedb: false,
        rolbypassrls: false,
        rolcanlogin: true,
      });

      const privileges = await client.query<{
        app_user_id_select: boolean;
        app_user_email_select: boolean;
        password_hash_select: boolean;
        password_hash_update: boolean;
        display_name_update: boolean;
        session_select: boolean;
        session_insert: boolean;
        session_update: boolean;
        session_delete: boolean;
        invitation_token_select: boolean;
        invitation_accept_update: boolean;
        invitation_token_update: boolean;
        membership_select: boolean;
        lookup_execute: boolean;
        lookup_by_id_execute: boolean;
        credentials_execute: boolean;
        membership_status_execute: boolean;
        activate_execute: boolean;
        current_tenant_execute: boolean;
        module_helper_execute: boolean;
        schema_create: boolean;
        app_schema_create: boolean;
        database_create: boolean;
      }>(`
        select
          has_column_privilege(current_user, 'public.app_user', 'id', 'SELECT') as app_user_id_select,
          has_column_privilege(current_user, 'public.app_user', 'email', 'SELECT') as app_user_email_select,
          has_column_privilege(current_user, 'public.app_user', 'password_hash', 'SELECT') as password_hash_select,
          has_column_privilege(current_user, 'public.app_user', 'password_hash', 'UPDATE') as password_hash_update,
          has_column_privilege(current_user, 'public.app_user', 'display_name', 'UPDATE') as display_name_update,
          has_table_privilege(current_user, 'public.auth_session', 'SELECT') as session_select,
          has_table_privilege(current_user, 'public.auth_session', 'INSERT') as session_insert,
          has_table_privilege(current_user, 'public.auth_session', 'UPDATE') as session_update,
          has_table_privilege(current_user, 'public.auth_session', 'DELETE') as session_delete,
          has_column_privilege(current_user, 'public.invitation', 'token_hash', 'SELECT') as invitation_token_select,
          has_column_privilege(current_user, 'public.invitation', 'accepted_at', 'UPDATE') as invitation_accept_update,
          has_column_privilege(current_user, 'public.invitation', 'token_hash', 'UPDATE') as invitation_token_update,
          has_table_privilege(current_user, 'public.membership', 'SELECT') as membership_select,
          has_function_privilege(current_user, 'app.auth_tenant_by_slug(citext)', 'EXECUTE') as lookup_execute,
          has_function_privilege(current_user, 'app.auth_tenant_by_id(uuid)', 'EXECUTE') as lookup_by_id_execute,
          has_function_privilege(current_user, 'app.auth_credentials(uuid, citext)', 'EXECUTE') as credentials_execute,
          has_function_privilege(current_user, 'app.auth_membership_status(uuid, uuid)', 'EXECUTE') as membership_status_execute,
          has_function_privilege(current_user, 'app.auth_activate_membership(uuid, uuid)', 'EXECUTE') as activate_execute,
          has_function_privilege(current_user, 'app.current_tenant_id()', 'EXECUTE') as current_tenant_execute,
          has_function_privilege(current_user, 'app.has_active_module(text)', 'EXECUTE') as module_helper_execute,
          has_schema_privilege(current_user, 'public', 'CREATE') as schema_create,
          has_schema_privilege(current_user, 'app', 'CREATE') as app_schema_create,
          has_database_privilege(current_user, current_database(), 'CREATE') as database_create
      `);
      expect(privileges.rows[0]).toEqual({
        app_user_id_select: true,
        app_user_email_select: true,
        password_hash_select: false,
        password_hash_update: true,
        display_name_update: false,
        session_select: true,
        session_insert: true,
        session_update: true,
        session_delete: false,
        invitation_token_select: true,
        invitation_accept_update: true,
        invitation_token_update: false,
        membership_select: false,
        lookup_execute: true,
        lookup_by_id_execute: true,
        credentials_execute: true,
        membership_status_execute: true,
        activate_execute: true,
        current_tenant_execute: false,
        module_helper_execute: false,
        schema_create: false,
        app_schema_create: false,
        database_create: false,
      });
    } finally {
      await client.end();
    }
  });

  test('reads only the granted identity columns', async () => {
    const client = await authClient();
    try {
      await client.query(
        'select id, email, display_name, status, last_login_at from app_user limit 1',
      );
      await client.query(
        `select id, tenant_id, user_id, token_hash, expires_at, accepted_at, revoked_at
           from invitation limit 1`,
      );
      await client.query(
        `select id, user_id, tenant_id, token_hash, csrf_token, created_at, expires_at,
                revoked_at, ip, user_agent
           from auth_session limit 1`,
      );

      const lookup = await client.query(
        "select * from app.auth_tenant_by_slug('missing-auth-slug')",
      );
      expect(lookup.rows).toEqual([]);

      // Membership status is reachable only through app.auth_membership_status;
      // membership itself carries tenant RLS, which the auth role cannot set.
      const status = await client.query(
        'select user_status, membership_status from app.auth_membership_status($1, $2)',
        ['00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002'],
      );
      expect(status.rows).toEqual([]);

      for (const sql of [
        'select password_hash from app_user',
        'select * from app_user',
        'select id, tenant_id, user_id, role, status from membership limit 1',
        'select * from tenant',
        'select * from employment',
        'select * from person',
        'select * from audit_event',
        'select * from platform_module',
        'select * from module_entitlement',
        'select * from invoice',
      ]) {
        await expect(client.query(sql)).rejects.toMatchObject({ code: '42501' });
      }
    } finally {
      await client.end();
    }
  });

  test('cannot write identity outside its grants or touch business data', async () => {
    const client = await authClient();
    try {
      const forbidden = [
        "insert into platform_module (code, name, category) values ('auth_probe', 'Probe', 'test')",
        "insert into app_user (email, display_name) values ('auth_probe@example.test', 'Probe')",
        "update app_user set display_name = 'Probe'",
        'delete from auth_session',
        "update invitation set token_hash = repeat('a', 64)",
        'truncate platform_module',
        'create table public.auth_probe (id integer)',
        'create schema auth_probe',
        'create database auth_probe',
      ];
      for (const sql of forbidden) {
        await expect(client.query(sql)).rejects.toMatchObject({ code: '42501' });
      }
    } finally {
      await client.end();
    }
  });

  test('cannot execute tenant, module or administrative helpers', async () => {
    const client = await authClient();
    try {
      const calls = [
        "call app.enable_tenant_rls('tenant')",
        "call app.add_updated_at('tenant')",
        'select app.block_mutation()',
        "select app.has_active_module('people')",
        'select app.has_platform_access()',
        "select app.has_module_read('people')",
        "select app.has_module_write('people')",
        'select app.has_switch_access()',
        'call app.apply_module_policies()',
        'select app.current_member_role()',
        'select app.current_tenant_id()',
      ];
      for (const sql of calls) {
        await expect(client.query(sql)).rejects.toMatchObject({ code: '42501' });
      }
    } finally {
      await client.end();
    }
  });

  test('runtime cannot read or write identity tables', async () => {
    const client = await runtimeClient();
    try {
      const forbidden = [
        'select * from auth_session',
        'select * from invitation',
        "insert into auth_session (user_id, tenant_id, token_hash, csrf_token, expires_at) values ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', repeat('a', 64), repeat('b', 43), now() + interval '1 hour')",
        'update invitation set accepted_at = now()',
      ];
      for (const sql of forbidden) {
        await expect(client.query(sql)).rejects.toMatchObject({ code: '42501' });
      }
    } finally {
      await client.end();
    }
  });
});

describe('worker role privileges', () => {
  test('is a non-owner login without elevated attributes', async () => {
    const client = await workerClient();
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
        current_user: WORKER_ROLE,
        owner: OWNER_ROLE,
        rolsuper: false,
        rolcreaterole: false,
        rolcreatedb: false,
        rolbypassrls: false,
        rolcanlogin: true,
      });
    } finally {
      await client.end();
    }
  });

  test('has no table privileges anywhere and reaches the outbox only through helpers', async () => {
    const client = await workerClient();
    try {
      const privileges = await client.query<{
        domain_event_select: boolean;
        domain_event_insert: boolean;
        domain_event_update: boolean;
        tenant_select: boolean;
        membership_select: boolean;
        outbox_functions: boolean;
        access_helpers: boolean;
      }>(`
        select
          has_table_privilege(current_user, 'public.domain_event', 'SELECT') as domain_event_select,
          has_table_privilege(current_user, 'public.domain_event', 'INSERT') as domain_event_insert,
          has_table_privilege(current_user, 'public.domain_event', 'UPDATE') as domain_event_update,
          has_table_privilege(current_user, 'public.tenant', 'SELECT') as tenant_select,
          has_table_privilege(current_user, 'public.membership', 'SELECT') as membership_select,
          has_function_privilege(current_user, 'app.outbox_claim(integer, text, integer, integer)', 'EXECUTE') and
          has_function_privilege(current_user, 'app.outbox_mark_published(uuid, text)', 'EXECUTE') and
          has_function_privilege(current_user, 'app.outbox_record_failure(uuid, text, integer, interval, text)', 'EXECUTE') as outbox_functions,
          has_function_privilege(current_user, 'app.has_platform_access()', 'EXECUTE') and
          has_function_privilege(current_user, 'app.has_module_read(text)', 'EXECUTE') and
          has_function_privilege(current_user, 'app.has_module_write(text)', 'EXECUTE') as access_helpers
      `);
      expect(privileges.rows[0]).toEqual({
        domain_event_select: false,
        domain_event_insert: false,
        domain_event_update: false,
        tenant_select: false,
        membership_select: false,
        outbox_functions: true,
        access_helpers: true,
      });

      const denied = await client.query<{
        switch_execute: boolean;
        member_role_execute: boolean;
        auth_execute: boolean;
      }>(`
        select
          has_function_privilege(current_user, 'app.has_switch_access()', 'EXECUTE') as switch_execute,
          has_function_privilege(current_user, 'app.current_member_role()', 'EXECUTE') as member_role_execute,
          has_function_privilege(current_user, 'app.auth_activate_membership(uuid, uuid)', 'EXECUTE') as auth_execute
      `);
      expect(denied.rows[0]).toEqual({
        switch_execute: false,
        member_role_execute: false,
        auth_execute: false,
      });
    } finally {
      await client.end();
    }
  });

  test('cannot write the outbox table, DDL or grant itself anything', async () => {
    const client = await workerClient();
    try {
      const forbidden = [
        'select * from domain_event',
        "insert into domain_event (tenant_id, type, aggregate_type, aggregate_id) values ('00000000-0000-0000-0000-000000000001', 'probe', 'probe', '00000000-0000-0000-0000-000000000002')",
        'update domain_event set attempts = 99',
        'delete from domain_event',
        'create table public.worker_probe (id integer)',
        'create schema worker_probe',
        'create database worker_probe',
        'create role worker_probe login',
        'grant saas_runtime to current_user',
        'grant execute on function app.current_member_role() to saas_worker',
        "call app.enable_tenant_rls('tenant')",
        'call app.apply_module_policies()',
        'select app.current_member_role()',
      ];
      for (const sql of forbidden) {
        await expect(client.query(sql)).rejects.toMatchObject({ code: '42501' });
      }
    } finally {
      await client.end();
    }
  });
});
