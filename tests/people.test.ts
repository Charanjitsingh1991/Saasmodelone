import { Client, Pool } from 'pg';
import type { OutgoingHttpHeaders } from 'node:http';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  createAuthPool,
  createRuntimePool,
  setMembershipScope,
  type AuthPool,
  type RuntimePool,
} from '@saasmodels/db';
import {
  PEOPLE_LIST_DEFAULT_PAGE_SIZE,
  PEOPLE_LIST_MAX_PAGE_SIZE,
  PEOPLE_SEARCH_MAX_LENGTH,
  type MembershipRole,
  type PeopleListResponse,
} from '@saasmodels/contracts';
import { createServer } from '@saasmodels/api';
import { createTestDatabase, type TestDatabase } from '@saasmodels/testkit';
import {
  createAccessFixtures,
  type AccessFixtures,
  type PersonRowFixture,
} from './support/access-fixtures.js';
import {
  createSessionFixture,
  randomToken,
  type SessionFixture,
} from './support/auth-fixtures.js';

const appOrigin = 'https://app.example.test';
const USER_AGENT = 'People directory test/1.0';

type DirectoryResponse = {
  statusCode: number;
  headers: OutgoingHttpHeaders;
  body: string;
  data: PeopleListResponse;
};

type DenialRow = {
  action: string;
  entity_type: string;
  entity_id: string | null;
  actor_type: string;
  actor_user_id: string | null;
  metadata: Record<string, unknown>;
};

type Sessions = {
  a: SessionFixture;
  b: SessionFixture;
  employee: SessionFixture;
  cancelled: SessionFixture;
  dualModule: SessionFixture;
};

let database: TestDatabase | undefined;
let fixtures: AccessFixtures | undefined;
let runtime: RuntimePool | undefined;
let auth: AuthPool | undefined;
let owner: Pool | undefined;
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

function ownerPool(): Pool {
  if (!owner) {
    throw new Error('Owner pool has not been created');
  }
  return owner;
}

function session(name: keyof Sessions): SessionFixture {
  if (!sessions) {
    throw new Error('Sessions have not been created');
  }
  return sessions[name];
}

function one<T>(rows: T[]): T {
  const row = rows[0];
  if (!row) {
    throw new Error('Expected exactly one row');
  }
  return row;
}

function sorted(ids: string[]): string[] {
  return [...ids].sort();
}

function exportPerson(index: number): PersonRowFixture {
  const person = fx().exportPeople[index];
  if (!person) {
    throw new Error(`Missing export person fixture at index ${index}`);
  }
  return person;
}

function ownerVisibleIds(): string[] {
  return sorted([
    fx().a.personId,
    exportPerson(0).id,
    exportPerson(1).id,
    exportPerson(2).id,
  ]);
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

async function auditRows(tenantId: string): Promise<DenialRow[]> {
  return withOwner(async (client) => {
    const result = await client.query<DenialRow>(
      `select action, entity_type, entity_id, actor_type, actor_user_id, metadata
         from audit_event
        where tenant_id = $1
        order by occurred_at, id`,
      [tenantId],
    );
    return result.rows;
  });
}

async function denialRows(tenantId: string): Promise<DenialRow[]> {
  const rows = await auditRows(tenantId);
  return rows.filter((row) => row.action === 'authorization.denied');
}

async function legalEntityName(id: string): Promise<string> {
  return withOwner(async (client) => {
    const result = await client.query<{ name: string }>(
      'select name from legal_entity where id = $1',
      [id],
    );
    return one(result.rows).name;
  });
}

type TestServer = ReturnType<typeof createServer>;

async function withApp<T>(fn: (app: TestServer) => Promise<T>): Promise<T> {
  const app = createServer({
    pool: runtimePool(),
    authPool: authPool(),
    appOrigin,
    secureCookies: false,
    logger: false,
  });
  await app.ready();
  try {
    return await fn(app);
  } finally {
    await app.close();
  }
}

async function list(
  app: TestServer,
  cookie: string,
  query = '',
): Promise<DirectoryResponse> {
  const response = await app.inject({
    method: 'GET',
    url: `/v1/people${query}`,
    headers: { cookie, 'user-agent': USER_AGENT },
  });
  return {
    statusCode: response.statusCode,
    headers: response.headers,
    body: response.body,
    data: response.json() as PeopleListResponse,
  };
}

beforeAll(async () => {
  database = await createTestDatabase({ migrate: true, seed: true });
  runtime = createRuntimePool(database.runtimeUrl);
  auth = createAuthPool(database.authUrl);
  owner = new Pool({ connectionString: database.ownerUrl });

  await withOwner(async (client) => {
    fixtures = await createAccessFixtures(client);
    sessions = {
      a: await createSessionFixture(client, {
        userId: fixtures.a.userId,
        tenantId: fixtures.a.tenantId,
      }),
      b: await createSessionFixture(client, {
        userId: fixtures.b.userId,
        tenantId: fixtures.b.tenantId,
      }),
      employee: await createSessionFixture(client, {
        userId: fixtures.employee.userId,
        tenantId: fixtures.employee.tenantId,
      }),
      cancelled: await createSessionFixture(client, {
        userId: fixtures.cancelled.userId,
        tenantId: fixtures.cancelled.tenantId,
      }),
      dualModule: await createSessionFixture(client, {
        userId: fixtures.dualModule.userId,
        tenantId: fixtures.dualModule.tenantId,
      }),
    };
  });
});

afterAll(async () => {
  await owner?.end();
  await auth?.end();
  await runtime?.end();
  await database?.drop();
});

describe('People directory read path', () => {
  test('rejects requests without a valid session', async () => {
    await withApp(async (app) => {
      for (const headers of [
        {},
        { cookie: `saas_session=${randomToken()}` },
      ]) {
        const response = await app.inject({
          method: 'GET',
          url: '/v1/people',
          headers,
        });
        expect(response.statusCode).toBe(401);
        expect(response.json()).toEqual({ error: { code: 'UNAUTHENTICATED' } });
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.body).not.toContain('EXP-001');
      }
    });
  });

  test('returns the tenant-wide owner page with only the granted columns', async () => {
    const a = fx().a;
    const softDeleted = fx().softDeletedPerson;

    await withApp(async (app) => {
      const result = await list(app, session('a').cookie);
      expect(result.statusCode).toBe(200);

      const body = result.data;
      expect(Object.keys(body).sort()).toEqual([
        'items',
        'page',
        'pageSize',
        'total',
      ]);
      expect(typeof body.total).toBe('number');
      expect(body.total).toBe(4);
      expect(body.page).toBe(1);
      expect(body.pageSize).toBe(PEOPLE_LIST_DEFAULT_PAGE_SIZE);
      expect(body.items).toHaveLength(4);
      expect(sorted(body.items.map((item) => item.id))).toEqual(
        ownerVisibleIds(),
      );

      const placedEntityName = await legalEntityName(fx().a.legalEntityId);

      for (const item of body.items) {
        expect(Object.keys(item).sort()).toEqual([
          'displayName',
          'employeeCode',
          'firstName',
          'id',
          'lastName',
          'legalEntityId',
          'legalEntityName',
          'orgUnitId',
          'orgUnitName',
          'phone',
          'workEmail',
        ]);
        // A placement name never appears without the id it came from, and no
        // fixture row in this view carries an org unit.
        if (item.legalEntityId === null) {
          expect(item.legalEntityName).toBeNull();
        }
        expect(item.orgUnitId).toBeNull();
        expect(item.orgUnitName).toBeNull();
      }

      expect(body.items.find((item) => item.employeeCode === 'EXP-001')).toEqual(
        {
          id: exportPerson(0).id,
          employeeCode: 'EXP-001',
          firstName: 'Ada',
          lastName: 'Lovelace',
          displayName: 'Ada, "Countess"',
          workEmail: exportPerson(0).workEmail,
          phone: '+1 555 0100',
          legalEntityId: fx().a.legalEntityId,
          legalEntityName: placedEntityName,
          orgUnitId: null,
          orgUnitName: null,
        },
      );

      const disclosures = [
        softDeleted.id,
        softDeleted.displayName,
        softDeleted.employeeCode,
        a.person.personalEmail,
        exportPerson(0).personalEmail,
        exportPerson(0).dateOfBirth,
        exportPerson(0).gender,
        exportPerson(0).designation,
      ];
      for (const value of disclosures) {
        if (value) {
          expect(result.body).not.toContain(value);
        }
      }
      for (const field of [
        'tenant_id',
        'tenantId',
        'user_id',
        'userId',
        'personal_email',
        'personalEmail',
        'date_of_birth',
        'dateOfBirth',
        'gender',
        'designation',
        'employment_type',
        'employmentType',
      ]) {
        expect(result.body).not.toContain(field);
      }

      // A placement name belongs to the tenant that owns the reference row: the
      // other workspace's legal entity never appears in this response.
      expect(result.body).not.toContain(
        await legalEntityName(fx().b.legalEntityId),
      );
    });
  });

  test('never discloses another tenant directory rows', async () => {
    const dualModule = fx().dualModule;

    await withApp(async (app) => {
      const result = await list(app, session('dualModule').cookie);
      expect(result.statusCode).toBe(200);
      expect(result.data.total).toBe(1);
      expect(result.data.items).toHaveLength(1);
      expect(one(result.data.items)).toMatchObject({
        id: dualModule.personId,
        displayName: 'Person m',
        employeeCode: null,
      });

      for (const id of ownerVisibleIds()) {
        expect(result.body).not.toContain(id);
      }
      expect(result.body).not.toContain('EXP-001');
    });
  });

  test('denies a permissionless employee with one ROLE_DENIED audit row', async () => {
    const employee = fx().employee;
    const before = await denialRows(employee.tenantId);

    await withApp(async (app) => {
      const result = await list(app, session('employee').cookie);
      expect(result.statusCode).toBe(403);
      expect(JSON.parse(result.body)).toEqual({
        error: { code: 'ROLE_DENIED', permission: 'people.read' },
      });
      expect(result.headers['cache-control']).toBe('no-store');
      expect(result.body).not.toContain('EXP-001');
    });

    const after = await denialRows(employee.tenantId);
    expect(after).toHaveLength(before.length + 1);
    expect(one(after.slice(-1))).toMatchObject({
      action: 'authorization.denied',
      entity_type: 'request',
      entity_id: null,
      actor_type: 'user',
      actor_user_id: employee.userId,
      metadata: {
        reason: 'ROLE_DENIED',
        method: 'GET',
        path: '/v1/people',
        module: 'people',
        operation: 'read',
        permission: 'people.read',
      },
    });
  });

  test('denies an unentitled tenant with one MODULE_NOT_ENTITLED audit row', async () => {
    const b = fx().b;
    const before = await denialRows(b.tenantId);

    await withApp(async (app) => {
      const result = await list(app, session('b').cookie);
      expect(result.statusCode).toBe(403);
      expect(JSON.parse(result.body)).toEqual({
        error: { code: 'MODULE_NOT_ENTITLED', module: 'people', operation: 'read' },
      });
      expect(result.headers['cache-control']).toBe('no-store');
      expect(result.body).not.toContain('EXP-001');
    });

    const after = await denialRows(b.tenantId);
    expect(after).toHaveLength(before.length + 1);
    expect(one(after.slice(-1))).toMatchObject({
      action: 'authorization.denied',
      actor_user_id: b.userId,
      metadata: {
        reason: 'MODULE_NOT_ENTITLED',
        method: 'GET',
        path: '/v1/people',
        module: 'people',
        operation: 'read',
      },
    });
  });

  test('reads inside read_until after the entitlement is cancelled', async () => {
    const cancelled = fx().cancelled;

    await withApp(async (app) => {
      const result = await list(app, session('cancelled').cookie);
      expect(result.statusCode).toBe(200);
      expect(result.data.total).toBe(1);
      expect(one(result.data.items)).toMatchObject({
        id: cancelled.personId,
        displayName: 'Person c',
      });
    });
  });

  test('denies a cancelled entitlement once read_until has passed', async () => {
    const cancelled = fx().cancelled;
    const before = await denialRows(cancelled.tenantId);

    async function lapseReadUntil(): Promise<void> {
      await withOwner(async (client) => {
        await client.query(
          `update module_entitlement
              set read_until = now() - interval '1 hour'
            where tenant_id = $1
              and module_id = (select id from platform_module where code = 'people')`,
          [cancelled.tenantId],
        );
      });
    }

    async function restoreReadUntil(): Promise<void> {
      await withOwner(async (client) => {
        await client.query(
          `update module_entitlement
              set read_until = now() + interval '30 days'
            where tenant_id = $1
              and module_id = (select id from platform_module where code = 'people')`,
          [cancelled.tenantId],
        );
      });
    }

    await lapseReadUntil();
    try {
      await withApp(async (app) => {
        const result = await list(app, session('cancelled').cookie);
        expect(result.statusCode).toBe(403);
        expect(JSON.parse(result.body)).toEqual({
          error: {
            code: 'MODULE_NOT_ENTITLED',
            module: 'people',
            operation: 'read',
          },
        });
      });
    } finally {
      await restoreReadUntil();
    }

    const after = await denialRows(cancelled.tenantId);
    expect(after).toHaveLength(before.length + 1);

    await withApp(async (app) => {
      const restored = await list(app, session('cancelled').cookie);
      expect(restored.statusCode).toBe(200);
      expect(restored.data.total).toBe(1);
    });
  });

  test('narrows a scoped manager through the route while the owner stays tenant-wide', async () => {
    const a = fx().a;
    const managerRole: MembershipRole = 'manager';

    const manager = await withOwner(async (client) => {
      const user = await client.query<{ id: string }>(
        `insert into app_user (email, display_name, status)
         values ($1, 'Scoped manager', 'active')
         returning id`,
        [`scoped_manager_${randomToken().slice(0, 8)}@example.test`],
      );
      const membership = await client.query<{ id: string }>(
        `insert into membership (tenant_id, user_id, role, status)
         values ($1, $2, $3, 'active')
         returning id`,
        [a.tenantId, one(user.rows).id, managerRole],
      );
      return {
        userId: one(user.rows).id,
        membershipId: one(membership.rows).id,
      };
    });

    const managerSession = await withOwner(async (client) =>
      createSessionFixture(client, {
        userId: manager.userId,
        tenantId: a.tenantId,
      }),
    );

    const scopeChange = await setMembershipScope(ownerPool(), {
      tenantId: a.tenantId,
      membershipId: manager.membershipId,
      scopes: [{ scopeType: 'legal_entity', scopeId: a.legalEntityId }],
      actorUserId: a.userId,
    });
    expect(scopeChange).toEqual({ changed: true });

    await withApp(async (app) => {
      const scoped = await list(app, managerSession.cookie);
      expect(scoped.statusCode).toBe(200);
      expect(scoped.data.total).toBe(1);
      expect(scoped.data.items).toHaveLength(1);
      expect(one(scoped.data.items)).toMatchObject({
        id: exportPerson(0).id,
        employeeCode: 'EXP-001',
      });
      for (const hiddenId of [a.personId, exportPerson(1).id, exportPerson(2).id]) {
        expect(scoped.body).not.toContain(hiddenId);
      }

      const ownerPage = await list(app, session('a').cookie);
      expect(ownerPage.statusCode).toBe(200);
      expect(ownerPage.data.total).toBe(4);
      expect(sorted(ownerPage.data.items.map((item) => item.id))).toEqual(
        ownerVisibleIds(),
      );

      const unplaced = await list(
        app,
        managerSession.cookie,
        `?q=${encodeURIComponent('Person a')}`,
      );
      expect(unplaced.statusCode).toBe(200);
      expect(unplaced.data.total).toBe(0);
    });
  });

  test('matches name, code and work email literally and case-insensitively', async () => {
    await withApp(async (app) => {
      const cookie = session('a').cookie;

      const byName = await list(app, cookie, '?q=CouNtEsS');
      expect(byName.statusCode).toBe(200);
      expect(byName.data.total).toBe(1);
      expect(one(byName.data.items).id).toBe(exportPerson(0).id);

      const byCode = await list(app, cookie, '?q=exp-003');
      expect(byCode.data.total).toBe(1);
      expect(one(byCode.data.items).id).toBe(exportPerson(2).id);

      const byEmail = await list(app, cookie, '?q=EXPORT_GRACE');
      expect(byEmail.data.total).toBe(1);
      expect(one(byEmail.data.items).id).toBe(exportPerson(1).id);

      // A percent sign is search text, not a wildcard.
      const wildcard = await list(app, cookie, '?q=%25');
      expect(wildcard.statusCode).toBe(200);
      expect(wildcard.data).toMatchObject({ items: [], total: 0, page: 1 });

      const embedded = await list(app, cookie, '?q=EXP%25001');
      expect(embedded.data.total).toBe(0);

      const empty = await list(app, cookie, '?q=');
      expect(empty.data.total).toBe(4);

      const whitespace = await list(app, cookie, '?q=%20%20%20');
      expect(whitespace.data.total).toBe(4);

      const noMatch = await list(app, cookie, '?q=nobody-here');
      expect(noMatch.data).toMatchObject({ items: [], total: 0 });
    });
  });

  test('pages deterministically and reports the true total past the end', async () => {
    await withApp(async (app) => {
      const cookie = session('a').cookie;
      const first = await list(app, cookie, '?page=1&pageSize=2');
      const second = await list(app, cookie, '?page=2&pageSize=2');
      const third = await list(app, cookie, '?page=3&pageSize=2');

      expect(first.statusCode).toBe(200);
      expect(first.data.items).toHaveLength(2);
      expect(first.data).toMatchObject({ page: 1, pageSize: 2, total: 4 });

      expect(second.data.items).toHaveLength(2);
      expect(second.data).toMatchObject({ page: 2, pageSize: 2, total: 4 });

      expect(third.statusCode).toBe(200);
      expect(third.data).toMatchObject({
        items: [],
        page: 3,
        pageSize: 2,
        total: 4,
      });

      const seen = [...first.data.items, ...second.data.items].map(
        (item) => item.id,
      );
      expect(new Set(seen).size).toBe(4);
      expect(sorted(seen)).toEqual(ownerVisibleIds());

      const beyond = await list(app, cookie, '?page=999999');
      expect(beyond.statusCode).toBe(200);
      expect(beyond.data).toMatchObject({ items: [], total: 4, page: 999999 });
    });
  });

  test('rejects malformed paging and search parameters with 400', async () => {
    const invalid = [
      '?page=0',
      '?page=abc',
      '?page=1.5',
      '?page=2&page=3',
      '?pageSize=0',
      `?pageSize=${PEOPLE_LIST_MAX_PAGE_SIZE + 1}`,
      '?pageSize=abc',
      '?pageSize=50&pageSize=50',
      `?q=${'x'.repeat(PEOPLE_SEARCH_MAX_LENGTH + 1)}`,
      '?q=a&q=b',
    ];

    await withApp(async (app) => {
      for (const query of invalid) {
        const response = await app.inject({
          method: 'GET',
          url: `/v1/people${query}`,
          headers: { cookie: session('a').cookie },
        });
        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({ error: { code: 'INVALID_QUERY' } });
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.body).not.toContain('EXP-001');
      }

      const atLimit = await app.inject({
        method: 'GET',
        url: `/v1/people?q=${'x'.repeat(PEOPLE_SEARCH_MAX_LENGTH)}`,
        headers: { cookie: session('a').cookie },
      });
      expect(atLimit.statusCode).toBe(200);
      expect((atLimit.json() as PeopleListResponse).total).toBe(0);
    });
  });

  test('marks every directory response uncacheable', async () => {
    await withApp(async (app) => {
      const allowed = await list(app, session('a').cookie, '?page=1');
      expect(allowed.statusCode).toBe(200);
      expect(allowed.headers['cache-control']).toBe('no-store');

      const denied = await list(app, session('b').cookie);
      expect(denied.statusCode).toBe(403);
      expect(denied.headers['cache-control']).toBe('no-store');
    });
  });

  test('writes no audit row for a successful directory read', async () => {
    const a = fx().a;
    const before = await auditRows(a.tenantId);

    await withApp(async (app) => {
      for (const query of ['', '?q=countess', '?page=2&pageSize=2']) {
        const result = await list(app, session('a').cookie, query);
        expect(result.statusCode).toBe(200);
      }
    });

    expect(await auditRows(a.tenantId)).toHaveLength(before.length);
  });

  test('leaves the export route and unknown subpaths unchanged', async () => {
    await withApp(async (app) => {
      const exported = await app.inject({
        method: 'GET',
        url: '/v1/people/export',
        headers: { cookie: session('a').cookie },
      });
      expect(exported.statusCode).toBe(200);
      expect(exported.headers['content-type']).toBe('text/csv; charset=utf-8');
      expect(exported.headers['cache-control']).toBe('no-store');
      expect(exported.body).toContain('EXP-001');

      const unknown = await app.inject({
        method: 'GET',
        url: '/v1/people/unknown',
        headers: { cookie: session('a').cookie },
      });
      expect(unknown.statusCode).toBe(404);
    });
  });
});
