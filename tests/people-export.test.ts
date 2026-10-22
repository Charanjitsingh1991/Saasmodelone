import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  createAuthPool,
  createRuntimePool,
  type AuthPool,
  type RuntimePool,
} from '@saasmodels/db';
import { createServer, PEOPLE_EXPORT_COLUMNS } from '@saasmodels/api';
import { createTestDatabase, type TestDatabase } from '@saasmodels/testkit';
import {
  createAccessFixtures,
  type AccessFixtures,
  type EmploymentFixture,
  type PersonRowFixture,
} from './support/access-fixtures.js';
import {
  createSessionFixture,
  randomToken,
  type SessionFixture,
} from './support/auth-fixtures.js';

const appOrigin = 'https://app.example.test';
const EXPORT_HEADER =
  'person_id,employee_code,first_name,last_name,display_name,work_email,phone\r\n';
const USER_AGENT = 'People export test/1.0';
const EXPORT_SELECT = `select id as person_id,
       employee_code,
       first_name,
       last_name,
       display_name,
       work_email::text as work_email,
       phone
  from person
 where deleted_at is null
 order by employee_code nulls last, id`;

type Sessions = {
  a: SessionFixture;
  b: SessionFixture;
  cancelled: SessionFixture;
  employee: SessionFixture;
};

type ExportAuditRow = {
  action: string;
  entity_type: string;
  entity_id: string | null;
  actor_type: string;
  actor_user_id: string | null;
  metadata: Record<string, unknown>;
  ip: string | null;
  user_agent: string | null;
};

let database: TestDatabase | undefined;
let fixtures: AccessFixtures | undefined;
let runtime: RuntimePool | undefined;
let auth: AuthPool | undefined;
let sessions: Sessions | undefined;

function db(): TestDatabase {
  if (!database) {
    throw new Error('Test database has not been created');
  }
  return database;
}

function fx(): AccessFixtures {
  if (!fixtures) {
    throw new Error('Fixtures have not been created');
  }
  return fixtures;
}

function runtimePool(): RuntimePool {
  if (!runtime) {
    throw new Error('Runtime pool has not been created');
  }
  return runtime;
}

function authPool(): AuthPool {
  if (!auth) {
    throw new Error('Auth pool has not been created');
  }
  return auth;
}

function session(name: keyof Sessions): SessionFixture {
  if (!sessions) {
    throw new Error('Sessions have not been created');
  }
  return sessions[name];
}

async function sessionFor(
  owner: Client,
  fixture: EmploymentFixture,
): Promise<SessionFixture> {
  return createSessionFixture(owner, {
    userId: fixture.userId,
    tenantId: fixture.tenantId,
  });
}

async function withOwner<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: db().ownerUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function withRuntime<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: db().runtimeUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function exportAuditRows(tenantId: string): Promise<ExportAuditRow[]> {
  return withOwner(async (client) => {
    const result = await client.query<ExportAuditRow>(
      `select action, entity_type, entity_id, actor_type, actor_user_id, metadata,
              host(ip) as ip, user_agent
         from audit_event
        where tenant_id = $1
          and action = 'people.directory.exported'
        order by occurred_at, id`,
      [tenantId],
    );
    return result.rows;
  });
}

function exportPerson(index: number): PersonRowFixture {
  const person = fx().exportPeople[index];
  if (!person) {
    throw new Error(`Missing export person fixture at index ${index}`);
  }
  return person;
}

function expectedExportBody(): string {
  const first = exportPerson(0);
  const second = exportPerson(1);
  const third = exportPerson(2);
  const base = fx().a.person;
  if (!first.workEmail || !second.workEmail || !base.workEmail) {
    throw new Error('Expected work email fixture is missing');
  }

  return (
    EXPORT_HEADER +
    `${first.id},EXP-001,Ada,Lovelace,"Ada, ""Countess""",${first.workEmail},'+1 555 0100\r\n` +
    `${second.id},EXP-002,Grace,Hopper,"Line\r\nBreak",${second.workEmail},'=1+1\r\n` +
    `${third.id},EXP-003,Alan,,"'@SUM(A1,A2)",,\r\n` +
    `${base.id},,Ada,,Person a,${base.workEmail},\r\n`
  );
}

function countingPool(
  real: RuntimePool,
  batchSize: number,
): { pool: RuntimePool; fetches: () => number } {
  let fetches = 0;
  const pool = {
    connect: async () => {
      const client = await real.connect();
      const query = client.query.bind(client) as (
        text: string,
        values?: unknown[],
      ) => Promise<unknown>;
      return new Proxy(client, {
        get(target, property, receiver) {
          if (property === 'query') {
            return (text: unknown, values?: unknown[]) => {
              if (
                typeof text === 'string' &&
                text.startsWith(`fetch forward ${batchSize} from`)
              ) {
                fetches += 1;
              }
              return query(text as string, values);
            };
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  } as unknown as RuntimePool;
  return { pool, fetches: () => fetches };
}

type TestServer = ReturnType<typeof createServer>;

async function withApp<T>(
  fn: (app: TestServer) => Promise<T>,
  options: {
    exportBatchSize?: number;
    enableProofRoutes?: boolean;
    pool?: RuntimePool;
  } = {},
): Promise<T> {
  const app = createServer({
    pool: options.pool ?? runtimePool(),
    authPool: authPool(),
    appOrigin,
    secureCookies: false,
    exportBatchSize: options.exportBatchSize,
    enableProofRoutes: options.enableProofRoutes ?? false,
    logger: false,
  });
  await app.ready();
  try {
    return await fn(app);
  } finally {
    await app.close();
  }
}

beforeAll(async () => {
  database = await createTestDatabase({ migrate: true, seed: true });
  runtime = createRuntimePool(database.runtimeUrl);
  auth = createAuthPool(database.authUrl);

  const owner = new Client({ connectionString: database.ownerUrl });
  await owner.connect();
  try {
    fixtures = await createAccessFixtures(owner);
    sessions = {
      a: await sessionFor(owner, fixtures.a),
      b: await sessionFor(owner, fixtures.b),
      cancelled: await sessionFor(owner, fixtures.cancelled),
      employee: await sessionFor(owner, fixtures.employee),
    };
  } finally {
    await owner.end();
  }
});

afterAll(async () => {
  await auth?.end();
  await runtime?.end();
  await database?.drop();
});

describe('People directory export', () => {
  test('streams exact CSV across multiple batches with production routes only', async () => {
    const counting = countingPool(runtimePool(), 2);

    await withApp(
      async (app) => {
        const response = await app.inject({
          method: 'GET',
          url: `/v1/people/export?tenant_id=${fx().b.tenantId}`,
          headers: {
            cookie: session('a').cookie,
            'x-tenant-id': fx().b.tenantId,
            'user-agent': USER_AGENT,
          },
        });

        expect(response.statusCode).toBe(200);
        expect(response.headers['content-type']).toBe('text/csv; charset=utf-8');
        expect(response.headers['content-disposition']).toBe(
          `attachment; filename="people-directory-${new Date()
            .toISOString()
            .slice(0, 10)}.csv"`,
        );
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.headers['x-content-type-options']).toBe('nosniff');
        expect(response.headers['content-length']).toBeUndefined();
        expect(response.body.startsWith('\uFEFF')).toBe(false);
        expect(response.body).toBe(expectedExportBody());

        const header = response.body.slice(0, response.body.indexOf('\r\n'));
        expect(header).toBe(
          'person_id,employee_code,first_name,last_name,display_name,work_email,phone',
        );
        for (const forbiddenColumn of [
          'tenant_id',
          'personal_email',
          'date_of_birth',
          'gender',
          'status',
          'designation',
          'employment_type',
          'legal_entity_id',
          'manager_person_id',
          'created_at',
          'updated_at',
        ]) {
          expect(header).not.toContain(forbiddenColumn);
        }

        const forbiddenPerson = exportPerson(0);
        for (const value of [
          forbiddenPerson.personalEmail,
          forbiddenPerson.dateOfBirth,
          forbiddenPerson.gender,
          forbiddenPerson.designation,
          forbiddenPerson.status,
          forbiddenPerson.employmentType,
          forbiddenPerson.legalEntityId,
        ]) {
          if (value) {
            expect(response.body).not.toContain(value);
          }
        }

        expect(response.body).not.toContain(fx().b.personId);
        expect(response.body).not.toContain(fx().softDeletedPerson.id);
        expect(response.body).not.toContain(fx().softDeletedPerson.displayName);

        const proof = await app.inject({
          method: 'GET',
          url: '/v1/proof/people/employment',
          headers: { cookie: session('a').cookie },
        });
        expect(proof.statusCode).toBe(404);
      },
      { exportBatchSize: 2, enableProofRoutes: false, pool: counting.pool },
    );

    expect(counting.fetches()).toBe(3);
  });

  test('records exactly one export audit row per successful export', async () => {
    const a = fx().a;
    const before = await exportAuditRows(a.tenantId);

    await withApp(
      async (app) => {
        const response = await app.inject({
          method: 'GET',
          url: `/v1/people/export?tenant_id=${fx().b.tenantId}`,
          headers: {
            cookie: session('a').cookie,
            'x-tenant-id': fx().b.tenantId,
            'user-agent': USER_AGENT,
          },
        });
        expect(response.statusCode).toBe(200);
        expect(response.body.startsWith(EXPORT_HEADER)).toBe(true);
      },
      { exportBatchSize: 2, enableProofRoutes: false },
    );

    const after = await exportAuditRows(a.tenantId);
    expect(after).toHaveLength(before.length + 1);
    const row = after[after.length - 1];
    if (!row) {
      throw new Error('No export audit row was recorded');
    }

    expect(row).toMatchObject({
      action: 'people.directory.exported',
      entity_type: 'tenant',
      entity_id: a.tenantId,
      actor_type: 'user',
      actor_user_id: a.userId,
      metadata: {
        module: 'people',
        format: 'csv',
        columns: [...PEOPLE_EXPORT_COLUMNS],
      },
      ip: '127.0.0.1',
      user_agent: USER_AGENT,
    });
    expect(Object.keys(row.metadata).sort()).toEqual(['columns', 'format', 'module']);

    const metadata = JSON.stringify(row.metadata);
    const token = session('a').cookie.replace(/^saas_session=/, '');
    for (const forbidden of [
      'tenant_id',
      'x-tenant-id',
      'saas_session',
      token,
      '@example.test',
      'owner',
      a.personId,
      a.tenantId,
    ]) {
      expect(metadata).not.toContain(forbidden);
    }
  });

  test('denies an entitled employee without people.read and writes no CSV', async () => {
    const employee = fx().employee;
    const before = await exportAuditRows(employee.tenantId);

    await withApp(async (app) => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/people/export',
        headers: { cookie: session('employee').cookie },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({
        error: { code: 'ROLE_DENIED', permission: 'people.read' },
      });
      expect(response.headers['content-type']).toContain('application/json');
      expect(response.body).not.toContain('person_id');
      expect(response.body).not.toContain(EXPORT_HEADER);
    });

    expect(await exportAuditRows(employee.tenantId)).toHaveLength(before.length);
  });

  test('denies a Work-only tenant with MODULE_NOT_ENTITLED and no CSV', async () => {
    const b = fx().b;
    const before = await exportAuditRows(b.tenantId);

    await withApp(async (app) => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/people/export',
        headers: { cookie: session('b').cookie },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({
        error: {
          code: 'MODULE_NOT_ENTITLED',
          module: 'people',
          operation: 'read',
        },
      });
      expect(response.body).not.toContain('person_id');
      expect(response.body).not.toContain(EXPORT_HEADER);
    });

    expect(await exportAuditRows(b.tenantId)).toHaveLength(before.length);
  });

  test('rejects unauthenticated export requests without CSV bytes', async () => {
    await withApp(async (app) => {
      for (const headers of [{}, { cookie: `saas_session=${randomToken()}` }]) {
        const response = await app.inject({
          method: 'GET',
          url: '/v1/people/export',
          headers,
        });
        expect(response.statusCode).toBe(401);
        expect(response.json()).toEqual({ error: { code: 'UNAUTHENTICATED' } });
        expect(response.body).not.toContain('person_id');
      }
    });
  });

  test('exports inside read_until after the entitlement is cancelled', async () => {
    const c = fx().cancelled;
    if (!c.person.workEmail) {
      throw new Error('Expected a work email for the cancelled tenant person');
    }

    await withApp(async (app) => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/people/export',
        headers: { cookie: session('cancelled').cookie },
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toBe(
        EXPORT_HEADER +
          `${c.personId},,Ada,,Person c,${c.person.workEmail},\r\n`,
      );
    });
  });

  test('fails closed with a sanitized 500 when the export audit cannot be written', async () => {
    const a = fx().a;
    const before = await exportAuditRows(a.tenantId);

    await withOwner(async (client) => {
      await client.query(
        'revoke insert on table public.audit_event from saas_runtime',
      );
    });
    try {
      await withApp(async (app) => {
        const response = await app.inject({
          method: 'GET',
          url: '/v1/people/export',
          headers: { cookie: session('a').cookie },
        });
        expect(response.statusCode).toBe(500);
        expect(response.json()).toEqual({ error: { code: 'INTERNAL_ERROR' } });
        expect(response.headers['content-type']).toContain('application/json');
        expect(response.body).not.toContain('person_id');
        expect(response.body).not.toContain(EXPORT_HEADER);
        expect(response.body).not.toMatch(/audit_event|42501|select|insert/i);
      });
    } finally {
      await withOwner(async (client) => {
        await client.query(
          'grant insert on table public.audit_event to saas_runtime',
        );
      });
    }

    expect(await exportAuditRows(a.tenantId)).toHaveLength(before.length);
  });

  test('grants only the exported person columns to the runtime role', async () => {
    await withRuntime(async (client) => {
      const tableSelect = await client.query<{ allowed: boolean }>(
        "select has_table_privilege(current_user, 'public.person', 'SELECT') as allowed",
      );
      expect(tableSelect.rows[0]?.allowed).toBe(false);

      const columns = await client.query<{ column: string; allowed: boolean }>(
        `select column_name as column,
                has_column_privilege(current_user, 'public.person', column_name, 'SELECT') as allowed
           from information_schema.columns
          where table_schema = 'public'
            and table_name = 'person'
          order by ordinal_position`,
      );
      const allowed = columns.rows
        .filter((row) => row.allowed)
        .map((row) => row.column)
        .sort();
      expect(allowed).toEqual([
        'deleted_at',
        'display_name',
        'employee_code',
        'first_name',
        'id',
        'last_name',
        'phone',
        'work_email',
      ]);

      await expect(client.query('select * from person')).rejects.toMatchObject({
        code: '42501',
      });
      for (const column of [
        'tenant_id',
        'personal_email',
        'date_of_birth',
        'gender',
        'status',
        'designation',
        'employment_type',
        'legal_entity_id',
        'org_unit_id',
        'location_id',
        'manager_person_id',
        'created_at',
        'updated_at',
        'source_system',
        'source_id',
        'import_batch_id',
        'imported_at',
      ]) {
        await expect(
          client.query(`select ${column} from person`),
        ).rejects.toMatchObject({ code: '42501' });
      }
    });
  });

  test('RLS remains the tenant boundary for the granted person columns', async () => {
    const a = fx().a;
    const b = fx().b;

    async function exportedIds(tenantId?: string): Promise<string[]> {
      return withRuntime(async (client) => {
        await client.query('begin');
        try {
          if (tenantId) {
            await client.query(
              "select set_config('app.tenant_id', $1, true)",
              [tenantId],
            );
          }
          const result = await client.query<{ person_id: string }>(EXPORT_SELECT);
          return result.rows.map((row) => row.person_id);
        } finally {
          await client.query('rollback');
        }
      });
    }

    expect(await exportedIds(a.tenantId)).toEqual([
      exportPerson(0).id,
      exportPerson(1).id,
      exportPerson(2).id,
      a.personId,
    ]);
    expect(await exportedIds(b.tenantId)).toEqual([b.personId]);
    expect(await exportedIds()).toEqual([]);
  });

  test('rejects an invalid exportBatchSize', () => {
    for (const value of [0, 1001, 1.5, Number.NaN]) {
      expect(() =>
        createServer({
          pool: runtimePool(),
          authPool: authPool(),
          appOrigin,
          secureCookies: false,
          exportBatchSize: value,
        }),
      ).toThrow(/exportBatchSize/);
    }
  });
});
