import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  listSqlFiles,
  migrate,
  OWNER_ROLE,
  seed,
  type MigrationResult,
} from '@saasmodels/db';
import { createTestDatabase, type TestDatabase } from '@saasmodels/testkit';

const migrationsDir = path.resolve(process.cwd(), 'suite', 'db', 'migrations');

type Snapshot = {
  tenants: Record<string, unknown>[];
  appUsers: Record<string, unknown>[];
  memberships: Record<string, unknown>[];
  entitlements: Record<string, unknown>[];
  people: Record<string, unknown>[];
  events: Record<string, unknown>[];
};

let database: TestDatabase | undefined;
let tempDirs: string[] = [];
let allFiles: string[] | undefined;
let previousFiles: string[] | undefined;
let newestFile: string | undefined;
let upgrade: MigrationResult | undefined;
let before: Snapshot | undefined;
let after: Snapshot | undefined;
let preUpgradeIds: { tenantA: string; userId: string } | undefined;

function db(): TestDatabase {
  if (!database) {
    throw new Error('Test database has not been created');
  }
  return database;
}

function upgraded(): MigrationResult {
  if (!upgrade) {
    throw new Error('The roll-forward migrate has not run');
  }
  return upgrade;
}

async function ownerClient(): Promise<Client> {
  const client = new Client({ connectionString: db().ownerUrl });
  await client.connect();
  return client;
}

function deterministicUuid(seedValue: string): string {
  const hex = createHash('sha256').update(seedValue).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

// Only columns that already exist at 0010, so one query serves both the
// before and after snapshots and any change to a preserved row fails the
// comparison rather than passing unnoticed.
async function snapshot(client: Client): Promise<Snapshot> {
  const queries: [keyof Snapshot, string][] = [
    [
      'tenants',
      `select id, name, slug, data_region, status, deleted_at, is_internal
         from tenant order by slug`,
    ],
    [
      'appUsers',
      `select id, email, display_name, status, last_login_at
         from app_user order by email`,
    ],
    [
      'memberships',
      `select tenant_id, user_id, role, status
         from membership order by tenant_id, user_id`,
    ],
    [
      'entitlements',
      `select e.tenant_id, m.code, e.status, e.source, e.starts_at, e.ends_at, e.read_until
         from module_entitlement e
         join platform_module m on m.id = e.module_id
        order by m.code`,
    ],
    [
      'people',
      `select id, tenant_id, employee_code, first_name, last_name, display_name,
              work_email, phone, personal_email, date_of_birth, gender, designation,
              status, employment_type, deleted_at
         from person order by employee_code`,
    ],
    [
      'events',
      `select id, tenant_id, type, aggregate_type, aggregate_id, payload,
              occurred_at, published_at, attempts, last_error
         from domain_event order by type`,
    ],
  ];

  const result: Snapshot = {
    tenants: [],
    appUsers: [],
    memberships: [],
    entitlements: [],
    people: [],
    events: [],
  };
  for (const [key, sql] of queries) {
    result[key] = (await client.query(sql)).rows;
  }
  return result;
}

// Representative rows for every table 0011 touches or must preserve. The event
// set spans the pre-upgrade outcomes: never attempted, retried with an error,
// already published, and a second tenant's row.
async function insertPreUpgradeRows(client: Client): Promise<{ tenantA: string; userId: string }> {
  const tenantIds: string[] = [];

  for (const slug of ['roll_a', 'roll_b']) {
    const inserted = await client.query<{ id: string }>(
      `insert into tenant (name, slug, data_region, status, deleted_at, is_internal)
       values ($1, $2, 'test', 'active', null, false)
       returning id`,
      [`Roll-forward tenant ${slug}`, `${slug}_${process.pid.toString(36)}`],
    );
    const row = inserted.rows[0];
    if (!row) {
      throw new Error(`Could not create tenant ${slug}`);
    }
    tenantIds.push(row.id);
  }

  const user = await client.query<{ id: string }>(
    `insert into app_user (email, display_name, status)
     values ('rollforward_owner@example.test', 'Roll-forward owner', 'active')
     returning id`,
  );
  const userId = user.rows[0]?.id;
  if (!userId) {
    throw new Error('Could not create the roll-forward user');
  }

  await client.query(
    `insert into membership (tenant_id, user_id, role, status)
     values ($1, $2, 'owner', 'active')`,
    [tenantIds[0], userId],
  );

  await client.query(
    `insert into module_entitlement
       (tenant_id, module_id, status, source, starts_at, ends_at, read_until)
     values ($1, (select id from platform_module where code = 'people'),
             'active', 'contract', now() - interval '1 day', null, null)`,
    [tenantIds[0]],
  );

  await client.query(
    `insert into person
       (tenant_id, employee_code, first_name, last_name, display_name, work_email,
        phone, personal_email, date_of_birth, gender, designation, status,
        employment_type, legal_entity_id, deleted_at)
     values ($1, 'ROLL-001', 'Ada', 'Lovelace', 'Ada Lovelace',
             'rollforward_person@example.test', '+1 555 0100', 'ada@example.test',
             date '1980-01-02', 'female', 'Engineer', 'active',
             'full_time', null, null)`,
    [tenantIds[0]],
  );

  const events = [
    {
      tenant: tenantIds[0],
      type: 'roll.pending',
      attempts: 0,
      publishedAt: null,
      lastError: null,
      occurredAt: '2026-01-02T00:00:00.000Z',
      payload: { step: 1 },
    },
    {
      tenant: tenantIds[0],
      type: 'roll.retried',
      attempts: 3,
      publishedAt: null,
      lastError: 'synthetic pre-upgrade failure',
      occurredAt: '2026-01-03T00:00:00.000Z',
      payload: { step: 2 },
    },
    {
      tenant: tenantIds[0],
      type: 'roll.published',
      attempts: 2,
      publishedAt: '2026-01-04T00:00:00.000Z',
      lastError: null,
      occurredAt: '2026-01-04T00:00:00.000Z',
      payload: { step: 3 },
    },
    {
      tenant: tenantIds[1],
      type: 'roll.other-tenant',
      attempts: 1,
      publishedAt: null,
      lastError: 'synthetic failure in the other tenant',
      occurredAt: '2026-01-05T00:00:00.000Z',
      payload: { step: 4 },
    },
  ];

  for (const event of events) {
    await client.query(
      `insert into domain_event
         (tenant_id, type, aggregate_type, aggregate_id, payload, occurred_at,
          published_at, attempts, last_error)
       values ($1, $2, 'rollforward', $3::uuid, $4::jsonb, $5::timestamptz,
               $6::timestamptz, $7, $8)`,
      [
        event.tenant,
        event.type,
        deterministicUuid(event.type),
        JSON.stringify(event.payload),
        event.occurredAt,
        event.publishedAt,
        event.attempts,
        event.lastError,
      ],
    );
  }

  const tenantA = tenantIds[0];
  if (!tenantA) {
    throw new Error('Could not record the first roll-forward tenant');
  }
  return { tenantA, userId };
}

beforeAll(async () => {
  const files = await listSqlFiles(migrationsDir);
  allFiles = files;
  newestFile = files.at(-1);
  previousFiles = files.slice(0, -1);
  if (!newestFile) {
    throw new Error('No migrations found');
  }

  const previousDir = await mkdtemp(path.join(tmpdir(), 'saasmodels-prev-migrations-'));
  const fullDir = await mkdtemp(path.join(tmpdir(), 'saasmodels-full-migrations-'));
  tempDirs = [previousDir, fullDir];
  for (const file of files) {
    await copyFile(path.join(migrationsDir, file), path.join(fullDir, file));
    if (previousFiles.includes(file)) {
      await copyFile(path.join(migrationsDir, file), path.join(previousDir, file));
    }
  }

  database = await createTestDatabase({ migrate: false, namePrefix: 'saasmodels_roll' });

  try {
    // The runtime grant allowlist describes the current schema, so it names the
    // 0012 helpers that a truncated migration set has not created yet. The
    // synthetic pre-upgrade database is therefore built without it; the real
    // upgrade below re-applies both grant files and every grant assertion in
    // this suite runs against the upgraded database.
    const initial = await migrate({
      ownerUrl: db().ownerUrl,
      migrationsDir: previousDir,
      grantsFiles: [],
    });
    if (initial.applied.length !== previousFiles.length) {
      throw new Error(`Previous-version apply expected ${previousFiles.length} files, got ${initial.applied.length}`);
    }

    await seed({ ownerUrl: db().ownerUrl });

    const writer = await ownerClient();
    try {
      preUpgradeIds = await insertPreUpgradeRows(writer);
      before = await snapshot(writer);
    } finally {
      await writer.end();
    }

    upgrade = await migrate({ ownerUrl: db().ownerUrl, migrationsDir: fullDir });

    const reader = await ownerClient();
    try {
      after = await snapshot(reader);
    } finally {
      await reader.end();
    }
  } catch (error) {
    await database.drop().catch(() => undefined);
    database = undefined;
    for (const directory of tempDirs) {
      await rm(directory, { recursive: true, force: true });
    }
    tempDirs = [];
    throw error;
  }
});

afterAll(async () => {
  await database?.drop();
  for (const directory of tempDirs) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe('migration roll-forward over populated data', () => {
  test('applies only the newest file while the earlier ones are skipped by checksum', () => {
    expect(allFiles).toHaveLength(12);
    expect(newestFile).toBe('0012_people_scope.sql');
    expect(previousFiles).toHaveLength(11);
    expect(previousFiles).toContain('0011_outbox.sql');
    expect(upgraded().applied).toEqual([newestFile]);
    expect(upgraded().skipped).toEqual(previousFiles);
  });

  test('advances the ledger to the newest migration with the checked-in checksum', async () => {
    const client = await ownerClient();
    try {
      const ledger = await client.query<{
        version: string;
        status: string;
        checksum: string;
        applied_at: Date | null;
      }>(
        `select version, status, checksum, applied_at
           from infra.schema_migration order by version`,
      );

      expect(ledger.rows.map((row) => row.version)).toEqual(allFiles);
      expect(ledger.rows.every((row) => row.status === 'applied')).toBe(true);
      expect(ledger.rows.every((row) => row.applied_at !== null)).toBe(true);

      const expected = createHash('sha256')
        .update(await readFile(path.join(migrationsDir, String(newestFile))))
        .digest('hex');
      expect(ledger.rows.find((row) => row.version === newestFile)?.checksum).toBe(expected);
    } finally {
      await client.end();
    }
  });

  test('keeps every pre-upgrade row with its values intact', () => {
    if (!before || !after) {
      throw new Error('The roll-forward snapshots were not captured');
    }
    expect(after.tenants).toHaveLength(2);
    expect(after.events).toHaveLength(4);
    expect(after.tenants).toEqual(before.tenants);
    expect(after.appUsers).toEqual(before.appUsers);
    expect(after.memberships).toEqual(before.memberships);
    expect(after.entitlements).toEqual(before.entitlements);
    expect(after.people).toEqual(before.people);
    expect(after.events).toEqual(before.events);
  });

  test('carries the 0011 lease defaults of every domain event through the 0012 upgrade', async () => {
    if (!after) {
      throw new Error('The post-upgrade snapshot was not captured');
    }
    const client = await ownerClient();
    try {
      const rows = await client.query<{
        type: string;
        status: string;
        attempts: number;
        next_attempt_at: Date | null;
        lease_owner: string | null;
        lease_expires_at: Date | null;
      }>(
        `select type, status, attempts, next_attempt_at, lease_owner, lease_expires_at
           from domain_event order by type`,
      );

      expect(rows.rows.map((row) => row.type)).toEqual([
        'roll.other-tenant',
        'roll.pending',
        'roll.published',
        'roll.retried',
      ]);
      for (const row of rows.rows) {
        expect(row.status).toBe('pending');
        expect(row.lease_owner).toBeNull();
        expect(row.lease_expires_at).toBeNull();
        expect(row.next_attempt_at).toBeInstanceOf(Date);
      }

      // attempts survives the upgrade untouched, and the rows already carried
      // the 0011 lease columns when 0012 ran: this test shows 0012 preserves
      // them. The 0011 lease behaviour itself is covered by tests/outbox.test.ts.
      expect(rows.rows.map((row) => row.attempts)).toEqual([1, 0, 2, 3]);

      // An event inserted with published_at before the 0012 upgrade keeps its
      // published_at and its 0011 'pending' status: 0012 changes neither.
      expect(after.events.find((row) => row.type === 'roll.published')?.published_at).toBeInstanceOf(
        Date,
      );
    } finally {
      await client.end();
    }
  });

  test('creates the partial domain_event claim index on tenant_id and occurred_at', async () => {
    const client = await ownerClient();
    try {
      const claim = await client.query<{
        is_partial: boolean;
        indexdef: string;
        predicate: string | null;
      }>(
        `select ix.indpred is not null as is_partial,
                pg_get_indexdef(ix.indexrelid) as indexdef,
                pg_get_expr(ix.indpred, ix.indrelid) as predicate
           from pg_index ix
           join pg_class i on i.oid = ix.indexrelid
           join pg_class t on t.oid = ix.indrelid
          where i.relname = 'domain_event_claim_idx' and t.relname = 'domain_event'`,
      );
      expect(claim.rows).toHaveLength(1);
      expect(claim.rows[0]?.is_partial).toBe(true);
      expect(claim.rows[0]?.indexdef).toContain('public.domain_event');
      expect(claim.rows[0]?.indexdef).toContain('(tenant_id, occurred_at)');
      expect(claim.rows[0]?.predicate).toContain('pending');
      expect(claim.rows[0]?.predicate).toContain('leased');

      // The 0001 indexes are frozen, so the upgrade leaves them in place.
      const names = await client.query<{ indexname: string }>(
        `select i.relname as indexname
           from pg_index ix
           join pg_class i on i.oid = ix.indexrelid
           join pg_class t on t.oid = ix.indrelid
          where t.relname = 'domain_event'
          order by i.relname`,
      );
      expect(names.rows.map((row) => row.indexname)).toEqual(
        expect.arrayContaining([
          'domain_event_aggregate_idx',
          'domain_event_claim_idx',
          'domain_event_pkey',
          'domain_event_unpublished_idx',
        ]),
      );
    } finally {
      await client.end();
    }
  });

  test('installs the four outbox helpers and the saas_worker grants on the upgraded database', async () => {
    const client = await ownerClient();
    try {
      const functions = await client.query<{
        proname: string;
        prosecdef: boolean;
        owner: string;
        proconfig: string[] | null;
      }>(
        `select p.proname, p.prosecdef, pg_get_userbyid(p.proowner) as owner, p.proconfig
           from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'app'
            and p.proname in ('outbox_claimed_guard', 'outbox_claim',
                              'outbox_mark_published', 'outbox_record_failure')
          order by p.proname`,
      );
      expect(functions.rows.map((row) => row.proname)).toEqual([
        'outbox_claim',
        'outbox_claimed_guard',
        'outbox_mark_published',
        'outbox_record_failure',
      ]);
      for (const row of functions.rows) {
        expect(row.prosecdef).toBe(true);
        expect(row.owner).toBe(OWNER_ROLE);
        expect(row.proconfig).toContain('search_path=""');
      }

      const grants = await client.query<{
        worker_guard: boolean;
        worker_claim: boolean;
        worker_published: boolean;
        worker_failure: boolean;
        worker_access_helpers: boolean;
        worker_table_privileges: boolean;
        runtime_outbox: boolean;
      }>(
        `select
           has_function_privilege('saas_worker', 'app.outbox_claimed_guard(integer, text, integer, integer)', 'EXECUTE') as worker_guard,
           has_function_privilege('saas_worker', 'app.outbox_claim(integer, text, integer, integer)', 'EXECUTE') as worker_claim,
           has_function_privilege('saas_worker', 'app.outbox_mark_published(uuid, text)', 'EXECUTE') as worker_published,
           has_function_privilege('saas_worker', 'app.outbox_record_failure(uuid, text, integer, interval, text)', 'EXECUTE') as worker_failure,
           has_function_privilege('saas_worker', 'app.current_tenant_id()', 'EXECUTE') and
           has_function_privilege('saas_worker', 'app.has_platform_access()', 'EXECUTE') and
           has_function_privilege('saas_worker', 'app.has_module_read(text)', 'EXECUTE') and
           has_function_privilege('saas_worker', 'app.has_module_write(text)', 'EXECUTE') as worker_access_helpers,
           has_table_privilege('saas_worker', 'public.domain_event', 'SELECT') or
           has_table_privilege('saas_worker', 'public.domain_event', 'INSERT') or
           has_table_privilege('saas_worker', 'public.domain_event', 'UPDATE') or
           has_table_privilege('saas_worker', 'public.domain_event', 'DELETE') as worker_table_privileges,
           has_function_privilege('saas_runtime', 'app.outbox_claim(integer, text, integer, integer)', 'EXECUTE') as runtime_outbox`,
      );
      expect(grants.rows[0]).toEqual({
        worker_guard: true,
        worker_claim: true,
        worker_published: true,
        worker_failure: true,
        worker_access_helpers: true,
        worker_table_privileges: false,
        runtime_outbox: false,
      });
    } finally {
      await client.end();
    }
  });

  // The 0011 database above is populated before 0012 runs, so these four tests
  // are the consequences of the people-scope upgrade on data that already
  // exists: the new link starts empty, the new table starts empty, the scope
  // surface is installed, and a tenant-wide member still reads the directory
  // exactly as it did under M0.
  test('leaves every pre-upgrade person unlinked by user_id', async () => {
    const client = await ownerClient();
    try {
      const rows = await client.query<{ user_id: string | null; total: string }>(
        `select user_id, count(*) over () as total from person order by employee_code`,
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]?.user_id).toBeNull();
      expect(after?.people).toHaveLength(1);
    } finally {
      await client.end();
    }
  });

  test('creates membership_scope with no rows on the upgraded database', async () => {
    const client = await ownerClient();
    try {
      const scope = await client.query<{ rows: string; rls: boolean; forced: boolean }>(
        `select (select count(*)::text from public.membership_scope) as rows,
                c.relrowsecurity as rls,
                c.relforcerowsecurity as forced
           from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relname = 'membership_scope'`,
      );
      expect(scope.rows).toEqual([{ rows: '0', rls: true, forced: false }]);
    } finally {
      await client.end();
    }
  });

  test('keeps a pre-upgrade person readable by a tenant-wide member and by a system context', async () => {
    if (!preUpgradeIds) {
      throw new Error('The pre-upgrade fixture ids were not recorded');
    }
    const { tenantA, userId } = preUpgradeIds;
    const read = async (memberId: string | null): Promise<number> => {
      const client = new Client({ connectionString: db().runtimeUrl });
      await client.connect();
      try {
        await client.query('begin');
        await client.query("select set_config('app.tenant_id', $1, true)", [tenantA]);
        if (memberId) {
          await client.query("select set_config('app.user_id', $1, true)", [memberId]);
        }
        const result = await client.query(
          `select id from public.person where employee_code = 'ROLL-001'`,
        );
        await client.query('rollback');
        return result.rowCount ?? 0;
      } finally {
        await client.end();
      }
    };

    // The pre-upgrade owner membership has no scope row, so it stays
    // tenant-wide: the person it could read under M0 it can still read.
    expect(await read(userId)).toBe(1);
    // The documented fail-open for a tenant-only system path is unchanged.
    expect(await read(null)).toBe(1);
    // A user with no membership in this tenant reads nothing.
    expect(await read(deterministicUuid('rollforward_absent_user'))).toBe(0);
  });

  test('installs the scope helpers and the eight restrictive policies on the upgraded database', async () => {
    const client = await ownerClient();
    try {
      const functions = await client.query<{ proname: string; owner: string; config: string[] }>(
        `select p.proname, pg_get_userbyid(p.proowner) as owner, p.proconfig as config
           from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'app'
            and p.proname in ('person_visible', 'person_in_scope',
                              'person_placement_in_scope', 'current_person_id',
                              'current_user_id')
          order by p.proname`,
      );
      expect(functions.rows.map((row) => row.proname)).toEqual([
        'current_person_id',
        'current_user_id',
        'person_in_scope',
        'person_placement_in_scope',
        'person_visible',
      ]);
      for (const row of functions.rows) {
        expect(row.owner).toBe(OWNER_ROLE);
        expect(row.config).toContain('search_path=""');
      }

      const privileges = await client.query<{ runtime: boolean; worker: boolean }>(
        `select has_function_privilege('saas_runtime', 'app.person_visible(uuid)', 'EXECUTE') as runtime,
                has_function_privilege('saas_worker', 'app.person_visible(uuid)', 'EXECUTE') as worker`,
      );
      expect(privileges.rows[0]).toEqual({ runtime: true, worker: false });

      const policies = await client.query<{ table_name: string; polname: string; permissive: boolean }>(
        `select c.relname as table_name, p.polname, p.polpermissive as permissive
           from pg_policy p
           join pg_class c on c.oid = p.polrelid
          where c.relname in ('person', 'employment') and p.polname like 'scope_%'
          order by c.relname, p.polname`,
      );
      expect(policies.rows).toHaveLength(8);
      expect(policies.rows.every((row) => row.permissive === false)).toBe(true);

      // The pre-existing person read still works for the owner path, which is
      // what the snapshot above proved: nothing was dropped or weakened.
      const survivors = await client.query(
        `select 1 from pg_policy p
           join pg_class c on c.oid = p.polrelid
          where c.relname = 'person' and p.polname = 'tenant_isolation'`,
      );
      expect(survivors.rows).toHaveLength(1);
    } finally {
      await client.end();
    }
  });
});
