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
  CRM_LIST_DEFAULT_PAGE_SIZE,
  CRM_LIST_MAX_PAGE_SIZE,
  CRM_SEARCH_MAX_LENGTH,
  type CrmAccountListResponse,
} from '@saasmodels/contracts';
import { createServer } from '@saasmodels/api';
import { createTestDatabase, type TestDatabase } from '@saasmodels/testkit';
import { randomToken } from './support/auth-fixtures.js';
import {
  insertClientRow,
  provisionModuleTenant,
  type ClientRowFixture,
  type ModuleTenantFixture,
} from './support/module-fixtures.js';

const appOrigin = 'https://app.example.test';
const USER_AGENT = 'CRM account read test/1.0';

type CrmResponse = {
  statusCode: number;
  headers: OutgoingHttpHeaders;
  body: string;
  data: CrmAccountListResponse;
};

type DenialRow = {
  action: string;
  entity_type: string;
  entity_id: string | null;
  actor_type: string;
  actor_user_id: string | null;
  metadata: Record<string, unknown>;
};

type CrmTenants = {
  owner: ModuleTenantFixture;
  other: ModuleTenantFixture;
  unentitled: ModuleTenantFixture;
  admin: ModuleTenantFixture;
  finance: ModuleTenantFixture;
  manager: ModuleTenantFixture;
  hr: ModuleTenantFixture;
  employee: ModuleTenantFixture;
  auditor: ModuleTenantFixture;
  empty: ModuleTenantFixture;
  workOnly: ModuleTenantFixture;
};

let database: TestDatabase | undefined;
let runtime: RuntimePool | undefined;
let auth: AuthPool | undefined;
let owner: Pool | undefined;
let tenants: CrmTenants | undefined;
let ownerAccounts: ClientRowFixture[] | undefined;
let withdrawnAccount: ClientRowFixture | undefined;
let otherAccount: ClientRowFixture | undefined;

function db(): TestDatabase {
  if (!database) {
    throw new Error('Test database has not been created');
  }
  return database;
}

function tenants_(): CrmTenants {
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

// The soft-deleted account is counted in the table itself, so the route proof
// cannot pass on an empty table.
async function softDeletedAccountCount(tenantId: string): Promise<number> {
  return withOwner(async (client) => {
    const result = await client.query<{ total: string }>(
      `select count(*) as total from client
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
): Promise<CrmResponse> {
  const response = await app.inject({
    method: 'GET',
    url: `/v1/crm/accounts${query}`,
    headers: { cookie, 'user-agent': USER_AGENT },
  });
  return {
    statusCode: response.statusCode,
    headers: response.headers,
    body: response.body,
    data: response.json() as CrmAccountListResponse,
  };
}

beforeAll(async () => {
  database = await createTestDatabase({ migrate: true, seed: true });
  runtime = createRuntimePool(database.runtimeUrl);
  auth = createAuthPool(database.authUrl);
  owner = new Pool({ connectionString: database.ownerUrl });

  // Every tenant is provisioned through the real path, and every one of them
  // holds CRM and nothing else. There is no People entitlement anywhere in
  // this file: the CRM journey has to stand on its own.
  const [
    ownerTenant,
    otherTenant,
    unentitled,
    admin,
    finance,
    manager,
    hr,
    employee,
    auditor,
    empty,
    workOnly,
  ] = await Promise.all([
    provisionModuleTenant(db().ownerUrl, {
      label: 'crmowner',
      modules: ['crm'],
    }),
    provisionModuleTenant(db().ownerUrl, {
      label: 'crmother',
      modules: ['crm'],
    }),
    // No CRM entitlement, and a role that holds no CRM permission either: the
    // answer must be the entitlement, because entitlement is checked first.
    provisionModuleTenant(db().ownerUrl, {
      label: 'crmunentitled',
      modules: ['people'],
      role: 'employee',
    }),
    provisionModuleTenant(db().ownerUrl, {
      label: 'crmadmin',
      modules: ['crm'],
      role: 'admin',
    }),
    provisionModuleTenant(db().ownerUrl, {
      label: 'crmfinance',
      modules: ['crm'],
      role: 'finance',
    }),
    provisionModuleTenant(db().ownerUrl, {
      label: 'crmmanager',
      modules: ['crm'],
      role: 'manager',
    }),
    provisionModuleTenant(db().ownerUrl, {
      label: 'crmhr',
      modules: ['crm'],
      role: 'hr',
    }),
    provisionModuleTenant(db().ownerUrl, {
      label: 'crmemployee',
      modules: ['crm'],
      role: 'employee',
    }),
    provisionModuleTenant(db().ownerUrl, {
      label: 'crmauditor',
      modules: ['crm'],
      role: 'auditor',
    }),
    provisionModuleTenant(db().ownerUrl, {
      label: 'crmempty',
      modules: ['crm'],
    }),
    // A Work-only workspace, to prove the shared client table still answers
    // the Work read without a CRM licence.
    provisionModuleTenant(db().ownerUrl, {
      label: 'crmworkonly',
      modules: ['work'],
    }),
  ]);

  tenants = {
    owner: ownerTenant,
    other: otherTenant,
    unentitled,
    admin,
    finance,
    manager,
    hr,
    employee,
    auditor,
    empty,
    workOnly,
  };

  await withOwner(async (client) => {
    ownerAccounts = [
      await insertClientRow(client, ownerTenant.tenantId, {
        name: 'Aster Logistics',
        code: 'CL-ASTER',
        status: 'active',
        billingEmail: 'billing@aster.example.test',
        phone: '+1-555-0101',
        currency: 'ZZZ',
        paymentTermsDays: 30,
      }),
      await insertClientRow(client, ownerTenant.tenantId, {
        name: 'Beacon Advisory',
        code: 'CL-BEACON',
        status: 'prospect',
        billingEmail: null,
        phone: null,
        currency: 'EUR',
        paymentTermsDays: 45,
      }),
      await insertClientRow(client, ownerTenant.tenantId, {
        name: 'Cedar Works',
        code: null,
        status: 'dormant',
        billingEmail: 'accounts@cedar.example.test',
        phone: null,
        currency: 'ZZZ',
        paymentTermsDays: 0,
      }),
    ];

    // A withdrawn account in the owner workspace. The owner page answers three
    // accounts, so the row proves the route drops a soft-deleted account from
    // the list and from the total rather than the table being empty.
    withdrawnAccount = await insertClientRow(client, ownerTenant.tenantId, {
      name: 'Retired Traders',
      code: 'CL-RETIRED',
      status: 'archived',
      deletedAt: '2026-03-01',
    });

    const otherClient = await insertClientRow(client, otherTenant.tenantId, {
      name: 'Zephyr Holdings',
      code: 'CL-ZEPHYR',
    });
    otherAccount = otherClient;

    await insertClientRow(client, workOnly.tenantId, {
      name: 'Kestrel Freight',
      code: 'CL-KESTREL',
    });
  });
});

afterAll(async () => {
  await owner?.end();
  await auth?.end();
  await runtime?.end();
  await database?.drop();
});

describe('CRM account read path', () => {
  test('rejects requests without a valid session', async () => {
    await withApp(async (app) => {
      for (const headers of [
        {},
        { cookie: `saas_session=${randomToken()}` },
      ]) {
        const response = await app.inject({
          method: 'GET',
          url: '/v1/crm/accounts',
          headers,
        });
        expect(response.statusCode).toBe(401);
        expect(response.json()).toEqual({ error: { code: 'UNAUTHENTICATED' } });
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.body).not.toContain('Aster Logistics');
      }
    });
  });

  test('provisions a CRM-only tenant with no People entitlement at all', async () => {
    const tenant = tenants_().owner;

    const entitlements = await withOwner(async (client) => {
      const result = await client.query<{ code: string }>(
        `select m.code
           from module_entitlement e
           join platform_module m on m.id = e.module_id
          where e.tenant_id = $1 and e.status = 'active'`,
        [tenant.tenantId],
      );
      return result.rows.map((row) => row.code);
    });
    expect(entitlements).toEqual(['crm']);

    // The context answers the module without a People module beside it.
    await withApp(async (app) => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/context',
        headers: { cookie: tenant.session.cookie, 'user-agent': USER_AGENT },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        modules: { code: string; canRead: boolean; canWrite: boolean }[];
      };
      expect(body.modules.map((module) => module.code)).toEqual(['crm']);
      expect(body.modules[0]?.canRead).toBe(true);
    });
  });

  test('returns the tenant accounts with only the eight account fields', async () => {
    const session = tenants_().owner.session;
    const accounts = ownerAccounts ?? [];

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
      expect(body.total).toBe(3);
      expect(body.page).toBe(1);
      expect(body.pageSize).toBe(CRM_LIST_DEFAULT_PAGE_SIZE);
      expect(body.items).toHaveLength(3);

      for (const item of body.items) {
        expect(Object.keys(item).sort()).toEqual([
          'billingEmail',
          'code',
          'currency',
          'id',
          'name',
          'paymentTermsDays',
          'phone',
          'status',
        ]);
      }

      // lower(name), id: the order does not depend on the insertion order.
      expect(body.items.map((item) => item.name)).toEqual([
        'Aster Logistics',
        'Beacon Advisory',
        'Cedar Works',
      ]);

      expect(one(body.items)).toEqual({
        id: one(accounts).id,
        name: 'Aster Logistics',
        code: 'CL-ASTER',
        status: 'active',
        billingEmail: 'billing@aster.example.test',
        phone: '+1-555-0101',
        currency: 'ZZZ',
        paymentTermsDays: 30,
      });

      // The second account carries nulls and says so rather than inventing an
      // empty string, and the third has no code.
      expect(body.items[1]).toMatchObject({
        name: 'Beacon Advisory',
        status: 'prospect',
        billingEmail: null,
        phone: null,
        currency: 'EUR',
        paymentTermsDays: 45,
      });
      expect(body.items[2]).toMatchObject({
        name: 'Cedar Works',
        code: null,
        status: 'dormant',
        paymentTermsDays: 0,
      });
    });
  });

  test('never discloses the platform columns of the shared client record', async () => {
    await withApp(async (app) => {
      const result = await list(app, tenants_().owner.session.cookie);
      expect(result.statusCode).toBe(200);

      for (const disclosure of [
        'tenant_id',
        'tenantId',
        'owner_user_id',
        'ownerUserId',
        'source_system',
        'sourceSystem',
        'source_id',
        'sourceId',
        'import_batch_id',
        'imported_at',
        'created_at',
        'updated_at',
        'deleted_at',
        'deletedAt',
      ]) {
        expect(result.body).not.toContain(disclosure);
      }
    });
  });

  test('never discloses another tenant accounts', async () => {
    const ownerSession = tenants_().owner.session;
    const otherSession = tenants_().other.session;
    const foreign = otherAccount;

    await withApp(async (app) => {
      const result = await list(app, ownerSession.cookie);
      expect(result.statusCode).toBe(200);
      expect(result.data.total).toBe(3);
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
        name: 'Zephyr Holdings',
      });
      expect(otherView.body).not.toContain('Aster Logistics');
    });
  });

  test('denies an unentitled tenant before the role is considered', async () => {
    const unentitled = tenants_().unentitled;
    const before = await denialRows(unentitled.tenantId);

    await withApp(async (app) => {
      const result = await list(app, unentitled.session.cookie);
      expect(result.statusCode).toBe(403);
      expect(JSON.parse(result.body)).toEqual({
        error: { code: 'MODULE_NOT_ENTITLED', module: 'crm', operation: 'read' },
      });
      expect(result.headers['cache-control']).toBe('no-store');
      expect(result.body).not.toContain('Aster Logistics');
    });

    // The role is the employee role, which holds no CRM permission either. The
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
        path: '/v1/crm/accounts',
        module: 'crm',
        operation: 'read',
      },
    });
  });

  test('answers a read for every role that holds crm.read', async () => {
    await withApp(async (app) => {
      for (const role of ['admin', 'finance', 'manager'] as const) {
        const tenant = tenants_()[role];
        const result = await list(app, tenant.session.cookie);
        expect(result.statusCode).toBe(200);
        expect(result.data.total).toBe(0);
      }
    });
  });

  test('denies a role that does not hold crm.read', async () => {
    const hr = tenants_().hr;
    const before = await denialRows(hr.tenantId);

    await withApp(async (app) => {
      const result = await list(app, hr.session.cookie);
      expect(result.statusCode).toBe(403);
      expect(JSON.parse(result.body)).toEqual({
        error: { code: 'ROLE_DENIED', permission: 'crm.read' },
      });
      expect(result.headers['cache-control']).toBe('no-store');
      expect(result.body).not.toContain('Aster Logistics');
    });

    const after = await denialRows(hr.tenantId);
    expect(after).toHaveLength(before.length + 1);
    expect(one(after.slice(-1))).toMatchObject({
      action: 'authorization.denied',
      actor_user_id: hr.userId,
      metadata: {
        reason: 'ROLE_DENIED',
        method: 'GET',
        path: '/v1/crm/accounts',
        module: 'crm',
        operation: 'read',
        permission: 'crm.read',
      },
    });
  });

  test('refuses an employee and an auditor with the same role answer', async () => {
    await withApp(async (app) => {
      for (const role of ['employee', 'auditor'] as const) {
        const tenant = tenants_()[role];
        const result = await list(app, tenant.session.cookie);
        expect(result.statusCode).toBe(403);
        expect(JSON.parse(result.body)).toEqual({
          error: { code: 'ROLE_DENIED', permission: 'crm.read' },
        });
        expect(result.body).not.toContain('Aster Logistics');
      }
    });
  });

  test('matches the account name, code and billing email literally', async () => {
    await withApp(async (app) => {
      const cookie = tenants_().owner.session.cookie;

      const byName = await list(app, cookie, '?q=aster%20log');
      expect(byName.statusCode).toBe(200);
      expect(byName.data.total).toBe(1);
      expect(one(byName.data.items).name).toBe('Aster Logistics');

      const byCode = await list(app, cookie, '?q=cl-beacon');
      expect(byCode.data.total).toBe(1);
      expect(one(byCode.data.items).name).toBe('Beacon Advisory');

      const byEmail = await list(app, cookie, '?q=accounts@cedar');
      expect(byEmail.data.total).toBe(1);
      expect(one(byEmail.data.items).name).toBe('Cedar Works');

      const empty = await list(app, cookie, '?q=');
      expect(empty.data.total).toBe(3);

      const noMatch = await list(app, cookie, '?q=nothing-here');
      expect(noMatch.data).toMatchObject({ items: [], total: 0 });

      // A wildcard cannot widen the search: these are ordinary characters.
      const wildcard = await list(app, cookie, '?q=%25');
      expect(wildcard.statusCode).toBe(200);
      expect(wildcard.data).toMatchObject({ items: [], total: 0 });

      const underscore = await list(app, cookie, '?q=_');
      expect(underscore.statusCode).toBe(200);
      expect(underscore.data).toMatchObject({ items: [], total: 0 });

      const embedded = await list(app, cookie, '?q=CL%25ASTER');
      expect(embedded.data.total).toBe(0);
    });
  });

  test('pages deterministically and reports the true total past the end', async () => {
    await withApp(async (app) => {
      const cookie = tenants_().owner.session.cookie;
      const first = await list(app, cookie, '?page=1&pageSize=1');
      const second = await list(app, cookie, '?page=2&pageSize=1');
      const third = await list(app, cookie, '?page=3&pageSize=1');
      const fourth = await list(app, cookie, '?page=4&pageSize=1');

      expect(first.statusCode).toBe(200);
      expect(first.data.items).toHaveLength(1);
      expect(first.data).toMatchObject({ page: 1, pageSize: 1, total: 3 });
      expect(one(first.data.items).name).toBe('Aster Logistics');

      expect(second.data.items).toHaveLength(1);
      expect(second.data).toMatchObject({ page: 2, pageSize: 1, total: 3 });
      expect(one(second.data.items).name).toBe('Beacon Advisory');

      expect(third.statusCode).toBe(200);
      expect(third.data.items).toHaveLength(1);
      expect(third.data).toMatchObject({ page: 3, pageSize: 1, total: 3 });
      expect(one(third.data.items).name).toBe('Cedar Works');

      // The page past the end is empty and the total is still the true one.
      expect(fourth.statusCode).toBe(200);
      expect(fourth.data).toMatchObject({ items: [], page: 4, pageSize: 1, total: 3 });

      const seen = [...first.data.items, ...second.data.items, ...third.data.items].map(
        (item) => item.id,
      );
      expect(new Set(seen).size).toBe(3);

      const beyond = await list(app, cookie, '?page=999999');
      expect(beyond.statusCode).toBe(200);
      expect(beyond.data).toMatchObject({ items: [], total: 3, page: 999999 });
    });
  });

  test('rejects malformed paging and search parameters with 400', async () => {
    const invalid = [
      '?page=0',
      '?page=abc',
      '?page=1.5',
      '?page=2&page=3',
      '?pageSize=0',
      `?pageSize=${CRM_LIST_MAX_PAGE_SIZE + 1}`,
      '?pageSize=abc',
      '?pageSize=50&pageSize=50',
      `?q=${'x'.repeat(CRM_SEARCH_MAX_LENGTH + 1)}`,
      '?q=a&q=b',
    ];

    await withApp(async (app) => {
      for (const query of invalid) {
        const response = await app.inject({
          method: 'GET',
          url: `/v1/crm/accounts${query}`,
          headers: { cookie: tenants_().owner.session.cookie },
        });
        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({ error: { code: 'INVALID_QUERY' } });
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.body).not.toContain('Aster Logistics');
      }

      const atLimit = await app.inject({
        method: 'GET',
        url: `/v1/crm/accounts?q=${'x'.repeat(CRM_SEARCH_MAX_LENGTH)}`,
        headers: { cookie: tenants_().owner.session.cookie },
      });
      expect(atLimit.statusCode).toBe(200);
      expect((atLimit.json() as CrmAccountListResponse).total).toBe(0);
    });
  });

  test('marks every account response uncacheable', async () => {
    await withApp(async (app) => {
      const allowed = await list(app, tenants_().owner.session.cookie);
      expect(allowed.statusCode).toBe(200);
      expect(allowed.headers['cache-control']).toBe('no-store');

      const denied = await list(app, tenants_().hr.session.cookie);
      expect(denied.statusCode).toBe(403);
      expect(denied.headers['cache-control']).toBe('no-store');
    });
  });

  test('writes no audit row for a successful account read', async () => {
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

  test('answers an empty list for a workspace with no accounts', async () => {
    const empty = tenants_().empty;

    await withApp(async (app) => {
      const result = await list(app, empty.session.cookie);
      expect(result.statusCode).toBe(200);
      expect(result.data).toMatchObject({ items: [], total: 0, page: 1 });
      expect(result.data.pageSize).toBe(CRM_LIST_DEFAULT_PAGE_SIZE);
    });
  });

  test('drops a soft-deleted account from the list and from the total', async () => {
    const withdrawn = withdrawnAccount;
    const tenant = tenants_().owner;

    // The row is in the table and it is soft deleted.
    expect(await softDeletedAccountCount(tenant.tenantId)).toBe(1);

    await withApp(async (app) => {
      const cookie = tenants_().owner.session.cookie;
      const result = await list(app, cookie);
      expect(result.statusCode).toBe(200);

      // The workspace holds four client rows and one of them is soft deleted,
      // so the total counts the three live rows and not the fourth.
      expect(result.data.total).toBe(3);
      expect(result.data.items).toHaveLength(3);
      expect(result.data.items.map((item) => item.name)).not.toContain(
        'Retired Traders',
      );
      expect(result.body).not.toContain('Retired Traders');
      expect(result.body).not.toContain('CL-RETIRED');
      if (withdrawn) {
        expect(result.body).not.toContain(withdrawn.id);
      }

      // A soft-deleted account is not searchable either.
      const byName = await list(app, cookie, '?q=retired');
      expect(byName.statusCode).toBe(200);
      expect(byName.data).toMatchObject({ items: [], total: 0 });

      const byCode = await list(app, cookie, '?q=cl-retired');
      expect(byCode.statusCode).toBe(200);
      expect(byCode.data).toMatchObject({ items: [], total: 0 });
    });
  });

  test('answers the Work read for a workspace without a CRM licence', async () => {
    const workOnly = tenants_().workOnly;

    await withApp(async (app) => {
      const accounts = await list(app, workOnly.session.cookie);
      expect(accounts.statusCode).toBe(403);
      expect(JSON.parse(accounts.body)).toEqual({
        error: { code: 'MODULE_NOT_ENTITLED', module: 'crm', operation: 'read' },
      });

      // The shared client record is still reachable through Work, which holds
      // its own entitlement. The CRM module is not a dependency of Work.
      const projects = await app.inject({
        method: 'GET',
        url: '/v1/work/projects',
        headers: {
          cookie: workOnly.session.cookie,
          'user-agent': USER_AGENT,
        },
      });
      expect(projects.statusCode).toBe(200);
      expect((projects.json() as { items: unknown[] }).items).toEqual([]);
    });
  });
});
