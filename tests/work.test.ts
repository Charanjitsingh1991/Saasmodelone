import { Client, Pool } from 'pg';
import type { OutgoingHttpHeaders } from 'node:http';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  createAuthPool,
  createRuntimePool,
  type AuthPool,
  type RuntimePool,
} from '@saasmodels/db';
import {
  WORK_LIST_DEFAULT_PAGE_SIZE,
  WORK_LIST_MAX_PAGE_SIZE,
  WORK_SEARCH_MAX_LENGTH,
  type ProjectListResponse,
} from '@saasmodels/contracts';
import { createServer } from '@saasmodels/api';
import { createTestDatabase, type TestDatabase } from '@saasmodels/testkit';
import { randomToken } from './support/auth-fixtures.js';
import {
  insertClientRow,
  insertProjectRow,
  provisionModuleTenant,
  type ClientRowFixture,
  type ModuleTenantFixture,
  type ProjectRowFixture,
} from './support/module-fixtures.js';

const appOrigin = 'https://app.example.test';
const USER_AGENT = 'Work read test/1.0';

// Above Number.MAX_SAFE_INTEGER: the exact digits are stored, and a
// JavaScript number cannot hold them.
const OVERSIZED_BUDGET = '9007199254740993';

type WorkResponse = {
  statusCode: number;
  headers: OutgoingHttpHeaders;
  body: string;
  data: ProjectListResponse;
};

type DenialRow = {
  action: string;
  entity_type: string;
  entity_id: string | null;
  actor_type: string;
  actor_user_id: string | null;
  metadata: Record<string, unknown>;
};

type WorkTenants = {
  owner: ModuleTenantFixture;
  other: ModuleTenantFixture;
  unentitled: ModuleTenantFixture;
  hr: ModuleTenantFixture;
  employee: ModuleTenantFixture;
  empty: ModuleTenantFixture;
  retired: ModuleTenantFixture;
  oversized: ModuleTenantFixture;
};

let database: TestDatabase | undefined;
let runtime: RuntimePool | undefined;
let auth: AuthPool | undefined;
let owner: Pool | undefined;
let tenants: WorkTenants | undefined;
let ownerProjects: ProjectRowFixture[] | undefined;
let otherProject: ProjectRowFixture | undefined;
let ownerRetiredProject: ProjectRowFixture | undefined;
let retiredClient: ClientRowFixture | undefined;
let retiredClientProject: ProjectRowFixture | undefined;
let withdrawnProject: ProjectRowFixture | undefined;

function db(): TestDatabase {
  if (!database) {
    throw new Error('Test database has not been created');
  }
  return database;
}

function tenants_(): WorkTenants {
  if (!tenants) {
    throw new Error('Tenants have not been provisioned');
  }
  return tenants;
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

function one<T>(rows: T[]): T {
  const row = rows[0];
  if (!row) {
    throw new Error('Expected exactly one row');
  }
  return row;
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

// The soft-deleted rows are counted in the table itself, so a route proof
// cannot pass on an empty table.
async function softDeletedCount(
  table: 'project' | 'client',
  tenantId: string,
): Promise<number> {
  return withOwner(async (client) => {
    const result = await client.query<{ total: string }>(
      `select count(*) as total from ${table}
        where tenant_id = $1 and deleted_at is not null`,
      [tenantId],
    );
    return Number(result.rows[0]?.total ?? '0');
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
): Promise<WorkResponse> {
  const response = await app.inject({
    method: 'GET',
    url: `/v1/work/projects${query}`,
    headers: { cookie, 'user-agent': USER_AGENT },
  });
  return {
    statusCode: response.statusCode,
    headers: response.headers,
    body: response.body,
    data: response.json() as ProjectListResponse,
  };
}

beforeAll(async () => {
  database = await createTestDatabase({ migrate: true, seed: true });
  runtime = createRuntimePool(database.runtimeUrl);
  auth = createAuthPool(database.authUrl);
  owner = new Pool({ connectionString: database.ownerUrl });

  // Every tenant is provisioned through the real path. The role is the only
  // thing set afterwards, so a role refusal can be told apart from an
  // entitlement refusal.
  const [
    ownerTenant,
    otherTenant,
    unentitled,
    hr,
    employee,
    empty,
    retired,
    oversized,
  ] = await Promise.all([
    provisionModuleTenant(db().ownerUrl, {
      label: 'workowner',
      modules: ['people', 'work', 'money', 'content'],
    }),
    provisionModuleTenant(db().ownerUrl, {
      label: 'workother',
      modules: ['people', 'work', 'money', 'content'],
    }),
    // No Work entitlement, and a role that holds no Work permission either:
    // the answer must be the entitlement, because entitlement is checked first.
    provisionModuleTenant(db().ownerUrl, {
      label: 'workunentitled',
      modules: ['people'],
      role: 'employee',
    }),
    provisionModuleTenant(db().ownerUrl, {
      label: 'workhr',
      modules: ['people', 'work', 'money', 'content'],
      role: 'hr',
    }),
    provisionModuleTenant(db().ownerUrl, {
      label: 'workemployee',
      modules: ['people', 'work', 'money', 'content'],
      role: 'employee',
    }),
    provisionModuleTenant(db().ownerUrl, {
      label: 'workempty',
      modules: ['people', 'work', 'money', 'content'],
    }),
    // A workspace of its own, so a retired client and a withdrawn project
    // can be proved without disturbing the owner page's totals.
    provisionModuleTenant(db().ownerUrl, {
      label: 'workretired',
      modules: ['people', 'work', 'money', 'content'],
    }),
    // A workspace of its own, because a budget a JavaScript number cannot
    // hold fails the whole page and must not reach the owner page.
    provisionModuleTenant(db().ownerUrl, {
      label: 'workoversized',
      modules: ['people', 'work', 'money', 'content'],
    }),
  ]);

  tenants = {
    owner: ownerTenant,
    other: otherTenant,
    unentitled,
    hr,
    employee,
    empty,
    retired,
    oversized,
  };

  await withOwner(async (client) => {
    const clientRow = await insertClientRow(client, ownerTenant.tenantId, {
      name: 'Aster Logistics',
      code: 'CL-ASTER',
    });
    ownerProjects = [
      await insertProjectRow(client, ownerTenant.tenantId, {
        clientId: clientRow.id,
        name: 'Aster rollout',
        code: 'PR-ASTER-1',
        status: 'active',
        currency: 'ZZZ',
        startDate: '2026-01-05',
        endDate: '2026-06-30',
        budgetMinor: '2500000',
        // project carries a table-level grant to the runtime role, so the
        // provenance columns are on the row on purpose: only the route keeps
        // them out of an answer.
        sourceSystem: 'legacy_erp',
        sourceId: 'LEGACY-77',
      }),
      await insertProjectRow(client, ownerTenant.tenantId, {
        clientId: clientRow.id,
        name: 'Beacon audit',
        code: 'PR-BEACON-2',
        status: 'planned',
        currency: 'EUR',
        budgetMinor: null,
      }),
    ];

    const otherClient = await insertClientRow(client, otherTenant.tenantId, {
      name: 'Zephyr Holdings',
      code: 'CL-ZEPHYR',
    });
    otherProject = await insertProjectRow(client, otherTenant.tenantId, {
      clientId: otherClient.id,
      name: 'Zephyr migration',
      code: 'PR-ZEPHYR-1',
      status: 'active',
      currency: 'ZZZ',
      startDate: '2026-03-01',
      endDate: null,
      budgetMinor: '900000',
    });

    // A withdrawn project in the owner workspace. The owner page answers two
    // projects, so the row proves the route drops a soft-deleted row from the
    // list and from the total rather than the table being empty.
    ownerRetiredProject = await insertProjectRow(
      client,
      ownerTenant.tenantId,
      {
        clientId: clientRow.id,
        name: 'Retired rollout',
        code: 'PR-RETIRED-3',
        status: 'cancelled',
        currency: 'ZZZ',
        budgetMinor: '750000',
        deletedAt: '2026-03-01',
      },
    );

    // A retired client in a workspace of its own. Its project stays visible
    // and keeps the client id, and the client name is neither disclosed nor
    // searchable through the join.
    retiredClient = await insertClientRow(client, retired.tenantId, {
      name: 'Meridian Systems',
      code: 'CL-MERIDIAN',
      deletedAt: '2026-03-01',
    });
    retiredClientProject = await insertProjectRow(
      client,
      retired.tenantId,
      {
        clientId: retiredClient.id,
        name: 'Beacon retrofit',
        code: 'PR-BEACON-9',
        status: 'active',
        currency: 'ZZZ',
        budgetMinor: '410000',
      },
    );
    withdrawnProject = await insertProjectRow(client, retired.tenantId, {
      clientId: retiredClient.id,
      name: 'Withdrawn retrofit',
      code: 'PR-WITHDRAWN-4',
      status: 'cancelled',
      currency: 'ZZZ',
      budgetMinor: '120000',
      deletedAt: '2026-03-02',
    });

    const oversizedClient = await insertClientRow(client, oversized.tenantId, {
      name: 'Oversized Trading',
      code: 'CL-OVER',
    });
    await insertProjectRow(client, oversized.tenantId, {
      clientId: oversizedClient.id,
      name: 'Oversized rollout',
      code: 'PR-OVER-1',
      status: 'active',
      currency: 'ZZZ',
      // Above Number.MAX_SAFE_INTEGER: the exact digits are stored, and a
      // JavaScript number cannot hold them.
      budgetMinor: OVERSIZED_BUDGET,
    });
  });
});

afterAll(async () => {
  await owner?.end();
  await auth?.end();
  await runtime?.end();
  await database?.drop();
});

describe('Work project read path', () => {
  test('rejects requests without a valid session', async () => {
    await withApp(async (app) => {
      for (const headers of [
        {},
        { cookie: `saas_session=${randomToken()}` },
      ]) {
        const response = await app.inject({
          method: 'GET',
          url: '/v1/work/projects',
          headers,
        });
        expect(response.statusCode).toBe(401);
        expect(response.json()).toEqual({ error: { code: 'UNAUTHENTICATED' } });
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.body).not.toContain('Aster rollout');
      }
    });
  });

  test('returns the tenant-wide owner page with only the granted columns', async () => {
    const session = tenants_().owner.session;
    const projects = ownerProjects ?? [];

    await withApp(async (app) => {
      const result = await list(app, session.cookie);
      expect(result.statusCode).toBe(200);

      const body = result.data;
      expect(Object.keys(body).sort()).toEqual([
        'items',
        'page',
        'pageSize',
        'total',
      ]);
      expect(body.total).toBe(2);
      expect(body.page).toBe(1);
      expect(body.pageSize).toBe(WORK_LIST_DEFAULT_PAGE_SIZE);
      expect(body.items).toHaveLength(2);

      for (const item of body.items) {
        expect(Object.keys(item).sort()).toEqual([
          'budgetMinor',
          'clientId',
          'clientName',
          'code',
          'currency',
          'endDate',
          'id',
          'name',
          'startDate',
          'status',
        ]);
      }

      expect(one(body.items)).toEqual({
        id: one(projects).id,
        code: 'PR-ASTER-1',
        name: 'Aster rollout',
        clientId: one(projects).clientId,
        clientName: 'Aster Logistics',
        status: 'active',
        currency: 'ZZZ',
        startDate: '2026-01-05',
        endDate: '2026-06-30',
        budgetMinor: 2500000,
      });

      // The second project carries a null budget and no dates, and the answers
      // say so rather than inventing a zero.
      expect(body.items[1]).toMatchObject({
        id: projects[1]?.id,
        name: 'Beacon audit',
        currency: 'EUR',
        budgetMinor: null,
        startDate: null,
        endDate: null,
      });

      // project keeps a table-level grant to the runtime role, so only the
      // route's own column list keeps these out of the answer.
      for (const disclosure of [
        'source_system',
        'sourceSystem',
        'legacy_erp',
        'LEGACY-77',
        'budget_hours',
        'budgetHours',
        'manager_user_id',
        'managerUserId',
        'engagement_id',
        'engagementId',
        'tenant_id',
        'tenantId',
        'import_batch_id',
        'imported_at',
      ]) {
        expect(result.body).not.toContain(disclosure);
      }
    });
  });

  test('never discloses another tenant projects', async () => {
    const ownerSession = tenants_().owner.session;
    const otherSession = tenants_().other.session;
    const foreign = otherProject;

    await withApp(async (app) => {
      const result = await list(app, ownerSession.cookie);
      expect(result.statusCode).toBe(200);
      expect(result.data.total).toBe(2);
      expect(result.body).not.toContain('Zephyr migration');
      expect(result.body).not.toContain('Zephyr Holdings');
      if (foreign) {
        expect(result.body).not.toContain(foreign.id);
      }

      // The other workspace sees only its own row, and the total counts that
      // row alone: the total is the tenant's, never the catalogue's.
      const otherView = await list(app, otherSession.cookie);
      expect(otherView.statusCode).toBe(200);
      expect(otherView.data.total).toBe(1);
      expect(otherView.data.items).toHaveLength(1);
      expect(one(otherView.data.items)).toMatchObject({
        id: foreign?.id,
        name: 'Zephyr migration',
      });
      expect(otherView.body).not.toContain('Aster rollout');
    });
  });

  test('denies an unentitled tenant before the role is considered', async () => {
    const unentitled = tenants_().unentitled;
    const before = await denialRows(unentitled.tenantId);

    await withApp(async (app) => {
      const result = await list(app, unentitled.session.cookie);
      expect(result.statusCode).toBe(403);
      expect(JSON.parse(result.body)).toEqual({
        error: { code: 'MODULE_NOT_ENTITLED', module: 'work', operation: 'read' },
      });
      expect(result.headers['cache-control']).toBe('no-store');
      expect(result.body).not.toContain('Aster rollout');
    });

    // The role is the employee role, which holds no Work permission either. The
    // entitlement is answered first, so the answer is MODULE_NOT_ENTITLED and
    // not ROLE_DENIED.
    const after = await denialRows(unentitled.tenantId);
    expect(after).toHaveLength(before.length + 1);
    expect(one(after.slice(-1))).toMatchObject({
      action: 'authorization.denied',
      entity_type: 'request',
      entity_id: null,
      actor_type: 'user',
      actor_user_id: unentitled.userId,
      metadata: {
        reason: 'MODULE_NOT_ENTITLED',
        method: 'GET',
        path: '/v1/work/projects',
        module: 'work',
        operation: 'read',
      },
    });
  });

  test('denies a role that does not hold work.read', async () => {
    const hr = tenants_().hr;
    const before = await denialRows(hr.tenantId);

    await withApp(async (app) => {
      const result = await list(app, hr.session.cookie);
      expect(result.statusCode).toBe(403);
      expect(JSON.parse(result.body)).toEqual({
        error: { code: 'ROLE_DENIED', permission: 'work.read' },
      });
      expect(result.headers['cache-control']).toBe('no-store');
      expect(result.body).not.toContain('Aster rollout');
    });

    const after = await denialRows(hr.tenantId);
    expect(after).toHaveLength(before.length + 1);
    expect(one(after.slice(-1))).toMatchObject({
      action: 'authorization.denied',
      actor_user_id: hr.userId,
      metadata: {
        reason: 'ROLE_DENIED',
        method: 'GET',
        path: '/v1/work/projects',
        module: 'work',
        operation: 'read',
        permission: 'work.read',
      },
    });
  });

  test('refuses an employee with the same role answer', async () => {
    const employee = tenants_().employee;

    await withApp(async (app) => {
      const result = await list(app, employee.session.cookie);
      expect(result.statusCode).toBe(403);
      expect(JSON.parse(result.body)).toEqual({
        error: { code: 'ROLE_DENIED', permission: 'work.read' },
      });
      expect(result.body).not.toContain('Aster rollout');
    });
  });

  test('matches the project name, code and client name literally', async () => {
    await withApp(async (app) => {
      const cookie = tenants_().owner.session.cookie;

      const byName = await list(app, cookie, '?q=rollOuT');
      expect(byName.statusCode).toBe(200);
      expect(byName.data.total).toBe(1);
      expect(one(byName.data.items).name).toBe('Aster rollout');

      const byCode = await list(app, cookie, '?q=pr-beacon-2');
      expect(byCode.data.total).toBe(1);
      expect(one(byCode.data.items).name).toBe('Beacon audit');

      // The client name is part of the search, so it finds both projects.
      const byClient = await list(app, cookie, '?q=aster%20log');
      expect(byClient.data.total).toBe(2);

      const empty = await list(app, cookie, '?q=');
      expect(empty.data.total).toBe(2);

      const noMatch = await list(app, cookie, '?q=nothing-here');
      expect(noMatch.data).toMatchObject({ items: [], total: 0 });

      // A wildcard cannot widen the search: these are ordinary characters.
      const wildcard = await list(app, cookie, '?q=%25');
      expect(wildcard.statusCode).toBe(200);
      expect(wildcard.data).toMatchObject({ items: [], total: 0 });

      const underscore = await list(app, cookie, '?q=_');
      expect(underscore.statusCode).toBe(200);
      expect(underscore.data).toMatchObject({ items: [], total: 0 });

      const embedded = await list(app, cookie, '?q=PR%25ASTER');
      expect(embedded.data.total).toBe(0);
    });
  });

  test('pages deterministically and reports the true total past the end', async () => {
    await withApp(async (app) => {
      const cookie = tenants_().owner.session.cookie;
      const first = await list(app, cookie, '?page=1&pageSize=1');
      const second = await list(app, cookie, '?page=2&pageSize=1');
      const third = await list(app, cookie, '?page=3&pageSize=1');

      expect(first.statusCode).toBe(200);
      expect(first.data.items).toHaveLength(1);
      expect(first.data).toMatchObject({ page: 1, pageSize: 1, total: 2 });

      expect(second.data.items).toHaveLength(1);
      expect(second.data).toMatchObject({ page: 2, pageSize: 1, total: 2 });

      expect(third.statusCode).toBe(200);
      expect(third.data).toMatchObject({ items: [], page: 3, pageSize: 1, total: 2 });

      const seen = [...first.data.items, ...second.data.items].map((item) => item.id);
      expect(new Set(seen).size).toBe(2);

      const beyond = await list(app, cookie, '?page=999999');
      expect(beyond.statusCode).toBe(200);
      expect(beyond.data).toMatchObject({ items: [], total: 2, page: 999999 });
    });
  });

  test('rejects malformed paging and search parameters with 400', async () => {
    const invalid = [
      '?page=0',
      '?page=abc',
      '?page=1.5',
      '?page=2&page=3',
      '?pageSize=0',
      `?pageSize=${WORK_LIST_MAX_PAGE_SIZE + 1}`,
      '?pageSize=abc',
      '?pageSize=50&pageSize=50',
      `?q=${'x'.repeat(WORK_SEARCH_MAX_LENGTH + 1)}`,
      '?q=a&q=b',
    ];

    await withApp(async (app) => {
      for (const query of invalid) {
        const response = await app.inject({
          method: 'GET',
          url: `/v1/work/projects${query}`,
          headers: { cookie: tenants_().owner.session.cookie },
        });
        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({ error: { code: 'INVALID_QUERY' } });
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.body).not.toContain('Aster rollout');
      }

      const atLimit = await app.inject({
        method: 'GET',
        url: `/v1/work/projects?q=${'x'.repeat(WORK_SEARCH_MAX_LENGTH)}`,
        headers: { cookie: tenants_().owner.session.cookie },
      });
      expect(atLimit.statusCode).toBe(200);
      expect((atLimit.json() as ProjectListResponse).total).toBe(0);
    });
  });

  test('marks every project response uncacheable', async () => {
    await withApp(async (app) => {
      const allowed = await list(app, tenants_().owner.session.cookie);
      expect(allowed.statusCode).toBe(200);
      expect(allowed.headers['cache-control']).toBe('no-store');

      const denied = await list(app, tenants_().hr.session.cookie);
      expect(denied.statusCode).toBe(403);
      expect(denied.headers['cache-control']).toBe('no-store');
    });
  });

  test('writes no audit row for a successful project read', async () => {
    const tenant = tenants_().owner;
    const before = await auditRows(tenant.tenantId);

    await withApp(async (app) => {
      for (const query of ['', '?q=aster', '?page=2&pageSize=1']) {
        const result = await list(app, tenant.session.cookie, query);
        expect(result.statusCode).toBe(200);
      }
    });

    expect(await auditRows(tenant.tenantId)).toHaveLength(before.length);
  });

  test('answers an empty list for a workspace with no projects', async () => {
    const empty = tenants_().empty;

    await withApp(async (app) => {
      const result = await list(app, empty.session.cookie);
      expect(result.statusCode).toBe(200);
      expect(result.data).toMatchObject({ items: [], total: 0, page: 1 });
      expect(result.data.pageSize).toBe(WORK_LIST_DEFAULT_PAGE_SIZE);
    });
  });

  test('drops a soft-deleted project from the list and from the total', async () => {
    const withdrawn = ownerRetiredProject;
    const tenant = tenants_().owner;

    // The row is in the table and it is soft deleted.
    expect(await softDeletedCount('project', tenant.tenantId)).toBe(1);

    await withApp(async (app) => {
      const cookie = tenants_().owner.session.cookie;
      const result = await list(app, cookie);
      expect(result.statusCode).toBe(200);

      // The workspace holds three project rows and one of them is soft
      // deleted, so the total counts the two live rows and not the third.
      expect(result.data.total).toBe(2);
      expect(result.data.items).toHaveLength(2);
      expect(result.data.items.map((item) => item.name)).not.toContain(
        'Retired rollout',
      );
      expect(result.body).not.toContain('Retired rollout');
      expect(result.body).not.toContain('PR-RETIRED-3');
      if (withdrawn) {
        expect(result.body).not.toContain(withdrawn.id);
      }

      // A soft-deleted row is not searchable either.
      const byName = await list(app, cookie, '?q=retired');
      expect(byName.statusCode).toBe(200);
      expect(byName.data).toMatchObject({ items: [], total: 0 });

      const byCode = await list(app, cookie, '?q=pr-retired-3');
      expect(byCode.statusCode).toBe(200);
      expect(byCode.data).toMatchObject({ items: [], total: 0 });
    });
  });

  test('keeps a project whose client is retired and names no client', async () => {
    const client = retiredClient;
    const project = retiredClientProject;
    const tenant = tenants_().retired;

    // The client is in the table and it is soft deleted.
    expect(await softDeletedCount('client', tenant.tenantId)).toBe(1);

    await withApp(async (app) => {
      const cookie = tenants_().retired.session.cookie;
      const result = await list(app, cookie);
      expect(result.statusCode).toBe(200);

      // The project is live, so it is listed, and the client id it was
      // recorded with is kept so the row stays traceable.
      expect(result.data.total).toBe(1);
      expect(result.data.items).toHaveLength(1);
      expect(one(result.data.items)).toMatchObject({
        id: project?.id,
        name: 'Beacon retrofit',
        clientId: client?.id,
        clientName: null,
      });

      // The retired client is not named: the join skips a soft-deleted
      // client, so there is no name to disclose.
      expect(result.body).not.toContain('Meridian Systems');

      // And it is not searchable through the join either.
      const byClient = await list(app, cookie, '?q=meridian');
      expect(byClient.statusCode).toBe(200);
      expect(byClient.data).toMatchObject({ items: [], total: 0 });

      // The project's own code still finds it.
      const byCode = await list(app, cookie, '?q=pr-beacon-9');
      expect(byCode.statusCode).toBe(200);
      expect(byCode.data.total).toBe(1);
      expect(one(byCode.data.items).clientName).toBeNull();
    });
  });

  test('drops a soft-deleted project from a workspace that has one', async () => {
    const withdrawn = withdrawnProject;
    const tenant = tenants_().retired;

    // The row is in the table and it is soft deleted.
    expect(await softDeletedCount('project', tenant.tenantId)).toBe(1);

    await withApp(async (app) => {
      const cookie = tenants_().retired.session.cookie;
      const result = await list(app, cookie);
      expect(result.statusCode).toBe(200);

      // The workspace holds two project rows and one of them is soft
      // deleted, so the total is one.
      expect(result.data.total).toBe(1);
      expect(result.data.items).toHaveLength(1);
      expect(result.body).not.toContain('Withdrawn retrofit');
      expect(result.body).not.toContain('PR-WITHDRAWN-4');
      if (withdrawn) {
        expect(result.body).not.toContain(withdrawn.id);
      }
    });
  });

  test('refuses a budget a JavaScript number cannot hold', async () => {
    const oversized = tenants_().oversized;

    await withApp(async (app) => {
      const result = await list(app, oversized.session.cookie);
      expect(result.statusCode).toBe(500);
      expect(JSON.parse(result.body)).toEqual({ error: { code: 'INTERNAL_ERROR' } });
      expect(result.headers['cache-control']).toBe('no-store');
      // Neither the exact digits nor the neighbour a rounded number would
      // carry appears in the answer.
      expect(result.body).not.toContain(OVERSIZED_BUDGET);
      expect(result.body).not.toContain('9007199254740992');
    });
  });
});
