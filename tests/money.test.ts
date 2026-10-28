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
  MONEY_LIST_DEFAULT_PAGE_SIZE,
  MONEY_LIST_MAX_PAGE_SIZE,
  MONEY_SEARCH_MAX_LENGTH,
  type InvoiceListResponse,
} from '@saasmodels/contracts';
import { createServer } from '@saasmodels/api';
import { createTestDatabase, type TestDatabase } from '@saasmodels/testkit';
import { randomToken } from './support/auth-fixtures.js';
import {
  insertClientRow,
  insertInvoiceRow,
  provisionModuleTenant,
  type ClientRowFixture,
  type InvoiceRowFixture,
  type ModuleTenantFixture,
} from './support/module-fixtures.js';

const appOrigin = 'https://app.example.test';
const USER_AGENT = 'Money read test/1.0';

// Above Number.MAX_SAFE_INTEGER: the exact digits are stored, and a
// JavaScript number cannot hold them.
const OVERSIZED_TOTAL = '9007199254740993';

type MoneyResponse = {
  statusCode: number;
  headers: OutgoingHttpHeaders;
  body: string;
  data: InvoiceListResponse;
};

type DenialRow = {
  action: string;
  entity_type: string;
  entity_id: string | null;
  actor_type: string;
  actor_user_id: string | null;
  metadata: Record<string, unknown>;
};

type MoneyTenants = {
  owner: ModuleTenantFixture;
  other: ModuleTenantFixture;
  unentitled: ModuleTenantFixture;
  hr: ModuleTenantFixture;
  employee: ModuleTenantFixture;
  auditor: ModuleTenantFixture;
  oversized: ModuleTenantFixture;
  empty: ModuleTenantFixture;
  retired: ModuleTenantFixture;
};

let database: TestDatabase | undefined;
let runtime: RuntimePool | undefined;
let auth: AuthPool | undefined;
let owner: Pool | undefined;
let tenants: MoneyTenants | undefined;
let ownerInvoices: InvoiceRowFixture[] | undefined;
let otherInvoice: InvoiceRowFixture | undefined;
let retiredClient: ClientRowFixture | undefined;
let retiredClientInvoice: InvoiceRowFixture | undefined;

function db(): TestDatabase {
  if (!database) {
    throw new Error('Test database has not been created');
  }
  return database;
}

function tenants_(): MoneyTenants {
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

// The soft-deleted row is counted in the table itself, so a route proof
// cannot pass on an empty table.
async function softDeletedClientCount(tenantId: string): Promise<number> {
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
): Promise<MoneyResponse> {
  const response = await app.inject({
    method: 'GET',
    url: `/v1/money/invoices${query}`,
    headers: { cookie, 'user-agent': USER_AGENT },
  });
  return {
    statusCode: response.statusCode,
    headers: response.headers,
    body: response.body,
    data: response.json() as InvoiceListResponse,
  };
}

beforeAll(async () => {
  database = await createTestDatabase({ migrate: true, seed: true });
  runtime = createRuntimePool(database.runtimeUrl);
  auth = createAuthPool(database.authUrl);
  owner = new Pool({ connectionString: database.ownerUrl });

  const [
    ownerTenant,
    otherTenant,
    unentitled,
    hr,
    employee,
    auditor,
    oversized,
    empty,
    retired,
  ] = await Promise.all([
    provisionModuleTenant(db().ownerUrl, {
      label: 'moneyowner',
      modules: ['people', 'work', 'money', 'content'],
    }),
    provisionModuleTenant(db().ownerUrl, {
      label: 'moneyother',
      modules: ['people', 'work', 'money', 'content'],
    }),
    // No Money entitlement, and a role that holds no Money permission either:
    // the entitlement is answered before the role.
    provisionModuleTenant(db().ownerUrl, {
      label: 'moneyunentitled',
      modules: ['people'],
      role: 'employee',
    }),
    provisionModuleTenant(db().ownerUrl, {
      label: 'moneyhr',
      modules: ['people', 'work', 'money', 'content'],
      role: 'hr',
    }),
    provisionModuleTenant(db().ownerUrl, {
      label: 'moneyemployee',
      modules: ['people', 'work', 'money', 'content'],
      role: 'employee',
    }),
    // The auditor is entitled to Money but its role holds no money.read. The
    // exclusion is recorded as a residual, so it is proved here rather than
    // assumed.
    provisionModuleTenant(db().ownerUrl, {
      label: 'moneyauditor',
      modules: ['people', 'work', 'money', 'content'],
      role: 'auditor',
    }),
    provisionModuleTenant(db().ownerUrl, {
      label: 'moneyoversized',
      modules: ['people', 'work', 'money', 'content'],
    }),
    provisionModuleTenant(db().ownerUrl, {
      label: 'moneyempty',
      modules: ['people', 'work', 'money', 'content'],
    }),
    // A workspace of its own, so a retired client can be proved without
    // disturbing the owner page's totals.
    provisionModuleTenant(db().ownerUrl, {
      label: 'moneyretired',
      modules: ['people', 'work', 'money', 'content'],
    }),
  ]);

  tenants = {
    owner: ownerTenant,
    other: otherTenant,
    unentitled,
    hr,
    employee,
    auditor,
    oversized,
    empty,
    retired,
  };

  await withOwner(async (client) => {
    const clientRow = await insertClientRow(client, ownerTenant.tenantId, {
      name: 'Aster Logistics',
      code: 'CL-ASTER',
    });
    ownerInvoices = [
      await insertInvoiceRow(client, ownerTenant.tenantId, {
        clientId: clientRow.id,
        number: 'INV-2026-0001',
        status: 'sent',
        currency: 'ZZZ',
        issueDate: '2026-01-15',
        dueDate: '2026-02-14',
        subtotalMinor: '1000000',
        taxMinor: '180000',
        totalMinor: '1180000',
        amountPaidMinor: '500000',
      }),
      await insertInvoiceRow(client, ownerTenant.tenantId, {
        clientId: clientRow.id,
        number: 'INV-2026-0002',
        status: 'overdue',
        currency: 'EUR',
        issueDate: '2025-11-01',
        dueDate: '2025-12-01',
        subtotalMinor: '250000',
        taxMinor: '45000',
        totalMinor: '295000',
        amountPaidMinor: '0',
      }),
    ];

    const otherClient = await insertClientRow(client, otherTenant.tenantId, {
      name: 'Zephyr Holdings',
      code: 'CL-ZEPHYR',
    });
    otherInvoice = await insertInvoiceRow(client, otherTenant.tenantId, {
      clientId: otherClient.id,
      number: 'INV-2026-9001',
      status: 'draft',
      currency: 'ZZZ',
      subtotalMinor: '75000',
      taxMinor: '0',
      totalMinor: '75000',
      amountPaidMinor: '0',
    });

    const oversizedClient = await insertClientRow(
      client,
      oversized.tenantId,
      { name: 'Oversized Trading', code: 'CL-OVER' },
    );
    await insertInvoiceRow(client, oversized.tenantId, {
      clientId: oversizedClient.id,
      number: 'INV-OVER-1',
      status: 'sent',
      currency: 'ZZZ',
      subtotalMinor: '10000',
      taxMinor: '1800',
      totalMinor: OVERSIZED_TOTAL,
      amountPaidMinor: '0',
    });

    // A retired client in a workspace of its own. The invoice stays visible
    // and keeps the client id, and the client name is neither disclosed nor
    // searchable through the join.
    retiredClient = await insertClientRow(client, retired.tenantId, {
      name: 'Meridian Systems',
      code: 'CL-MERIDIAN',
      deletedAt: '2026-03-01',
    });
    retiredClientInvoice = await insertInvoiceRow(client, retired.tenantId, {
      clientId: retiredClient.id,
      number: 'INV-2026-7001',
      status: 'sent',
      currency: 'ZZZ',
      issueDate: '2026-03-01',
      dueDate: '2026-03-31',
      subtotalMinor: '640000',
      taxMinor: '115200',
      totalMinor: '755200',
      amountPaidMinor: '0',
    });
  });
});

afterAll(async () => {
  await owner?.end();
  await auth?.end();
  await runtime?.end();
  await database?.drop();
});

describe('Money invoice read path', () => {
  test('rejects requests without a valid session', async () => {
    await withApp(async (app) => {
      for (const headers of [
        {},
        { cookie: `saas_session=${randomToken()}` },
      ]) {
        const response = await app.inject({
          method: 'GET',
          url: '/v1/money/invoices',
          headers,
        });
        expect(response.statusCode).toBe(401);
        expect(response.json()).toEqual({ error: { code: 'UNAUTHENTICATED' } });
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.body).not.toContain('INV-2026-0001');
      }
    });
  });

  test('returns the stored figures beside their own currency', async () => {
    const session = tenants_().owner.session;
    const invoices = ownerInvoices ?? [];

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
      expect(body.pageSize).toBe(MONEY_LIST_DEFAULT_PAGE_SIZE);
      expect(body.items).toHaveLength(2);

      for (const item of body.items) {
        expect(Object.keys(item).sort()).toEqual([
          'amountPaidMinor',
          'clientId',
          'clientName',
          'currency',
          'dueDate',
          'id',
          'issueDate',
          'number',
          'status',
          'subtotalMinor',
          'taxMinor',
          'totalMinor',
        ]);
      }

      // The invoice is ordered by its number, and every amount is the stored
      // figure: no total is derived, no rate is applied and no currency is
      // converted.
      expect(one(body.items)).toEqual({
        id: one(invoices).id,
        number: 'INV-2026-0001',
        clientId: one(invoices).clientId,
        clientName: 'Aster Logistics',
        status: 'sent',
        issueDate: '2026-01-15',
        dueDate: '2026-02-14',
        currency: 'ZZZ',
        subtotalMinor: 1000000,
        taxMinor: 180000,
        totalMinor: 1180000,
        amountPaidMinor: 500000,
      });

      // The stored status is the stored status, including one the route does
      // not interpret.
      expect(body.items[1]).toMatchObject({
        number: 'INV-2026-0002',
        status: 'overdue',
        currency: 'EUR',
        subtotalMinor: 250000,
        taxMinor: 45000,
        totalMinor: 295000,
        amountPaidMinor: 0,
      });

      // The tax column is the stored tax amount. No jurisdiction, no rate and
      // no jurisdiction-specific word appears in the answer.
      for (const forbidden of [
        'taxRate',
        'tax_rate',
        'vat',
        'gst',
        'jurisdiction',
        'tax_jurisdiction_id',
        'notes',
      ]) {
        expect(result.body.toLowerCase()).not.toContain(forbidden);
      }

      for (const disclosure of [
        'project_id',
        'projectId',
        'engagement_id',
        'engagementId',
        'contract_id',
        'contractId',
        'tenant_id',
        'tenantId',
        'source_system',
        'sourceSystem',
        'import_batch_id',
      ]) {
        expect(result.body).not.toContain(disclosure);
      }
    });
  });

  test('never discloses another tenant invoices', async () => {
    const ownerSession = tenants_().owner.session;
    const otherSession = tenants_().other.session;
    const foreign = otherInvoice;

    await withApp(async (app) => {
      const result = await list(app, ownerSession.cookie);
      expect(result.statusCode).toBe(200);
      expect(result.data.total).toBe(2);
      expect(result.body).not.toContain('INV-2026-9001');
      expect(result.body).not.toContain('Zephyr Holdings');
      if (foreign) {
        expect(result.body).not.toContain(foreign.id);
      }

      const otherView = await list(app, otherSession.cookie);
      expect(otherView.statusCode).toBe(200);
      expect(otherView.data.total).toBe(1);
      expect(otherView.data.items).toHaveLength(1);
      expect(one(otherView.data.items)).toMatchObject({
        id: foreign?.id,
        number: 'INV-2026-9001',
      });
      expect(otherView.body).not.toContain('INV-2026-0001');
    });
  });

  test('denies an unentitled tenant before the role is considered', async () => {
    const unentitled = tenants_().unentitled;
    const before = await denialRows(unentitled.tenantId);

    await withApp(async (app) => {
      const result = await list(app, unentitled.session.cookie);
      expect(result.statusCode).toBe(403);
      expect(JSON.parse(result.body)).toEqual({
        error: { code: 'MODULE_NOT_ENTITLED', module: 'money', operation: 'read' },
      });
      expect(result.headers['cache-control']).toBe('no-store');
      expect(result.body).not.toContain('INV-2026-0001');
    });

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
        path: '/v1/money/invoices',
        module: 'money',
        operation: 'read',
      },
    });
  });

  test('denies every role that does not hold money.read', async () => {
    for (const key of ['hr', 'employee', 'auditor'] as const) {
      const tenant = tenants_()[key];
      const before = await denialRows(tenant.tenantId);

      await withApp(async (app) => {
        const result = await list(app, tenant.session.cookie);
        expect(result.statusCode).toBe(403);
        expect(JSON.parse(result.body)).toEqual({
          error: { code: 'ROLE_DENIED', permission: 'money.read' },
        });
        expect(result.headers['cache-control']).toBe('no-store');
        expect(result.body).not.toContain('INV-2026-0001');
      });

      const after = await denialRows(tenant.tenantId);
      expect(after).toHaveLength(before.length + 1);
      expect(one(after.slice(-1))).toMatchObject({
        action: 'authorization.denied',
        actor_user_id: tenant.userId,
        metadata: {
          reason: 'ROLE_DENIED',
          method: 'GET',
          path: '/v1/money/invoices',
          module: 'money',
          operation: 'read',
          permission: 'money.read',
        },
      });
    }
  });

  test('matches the invoice number and client name literally', async () => {
    await withApp(async (app) => {
      const cookie = tenants_().owner.session.cookie;

      const byNumber = await list(app, cookie, '?q=inv-2026-0002');
      expect(byNumber.statusCode).toBe(200);
      expect(byNumber.data.total).toBe(1);
      expect(one(byNumber.data.items).number).toBe('INV-2026-0002');

      const byClient = await list(app, cookie, '?q=aster');
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

      const embedded = await list(app, cookie, '?q=INV%252026');
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
      `?pageSize=${MONEY_LIST_MAX_PAGE_SIZE + 1}`,
      '?pageSize=abc',
      '?pageSize=50&pageSize=50',
      `?q=${'x'.repeat(MONEY_SEARCH_MAX_LENGTH + 1)}`,
      '?q=a&q=b',
    ];

    await withApp(async (app) => {
      for (const query of invalid) {
        const response = await app.inject({
          method: 'GET',
          url: `/v1/money/invoices${query}`,
          headers: { cookie: tenants_().owner.session.cookie },
        });
        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({ error: { code: 'INVALID_QUERY' } });
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.body).not.toContain('INV-2026-0001');
      }
    });
  });

  test('marks every invoice response uncacheable', async () => {
    await withApp(async (app) => {
      const allowed = await list(app, tenants_().owner.session.cookie);
      expect(allowed.statusCode).toBe(200);
      expect(allowed.headers['cache-control']).toBe('no-store');

      const denied = await list(app, tenants_().auditor.session.cookie);
      expect(denied.statusCode).toBe(403);
      expect(denied.headers['cache-control']).toBe('no-store');
    });
  });

  test('writes no audit row for a successful invoice read', async () => {
    const tenant = tenants_().owner;
    const before = await auditRows(tenant.tenantId);

    await withApp(async (app) => {
      for (const query of ['', '?q=inv-2026', '?page=2&pageSize=1']) {
        const result = await list(app, tenant.session.cookie, query);
        expect(result.statusCode).toBe(200);
      }
    });

    expect(await auditRows(tenant.tenantId)).toHaveLength(before.length);
  });

  test('refuses a stored total a JavaScript number cannot hold', async () => {
    const oversized = tenants_().oversized;

    await withApp(async (app) => {
      const result = await list(app, oversized.session.cookie);
      expect(result.statusCode).toBe(500);
      expect(JSON.parse(result.body)).toEqual({ error: { code: 'INTERNAL_ERROR' } });
      expect(result.headers['cache-control']).toBe('no-store');
      // Neither the exact digits nor the neighbour a rounded number would
      // carry appears in the answer.
      expect(result.body).not.toContain(OVERSIZED_TOTAL);
      expect(result.body).not.toContain('9007199254740992');
    });
  });

  test('answers an empty list for a workspace with no invoices', async () => {
    const empty = tenants_().empty;

    await withApp(async (app) => {
      const result = await list(app, empty.session.cookie);
      expect(result.statusCode).toBe(200);
      expect(result.data).toMatchObject({ items: [], total: 0, page: 1 });
      expect(result.data.pageSize).toBe(MONEY_LIST_DEFAULT_PAGE_SIZE);
    });
  });

  test('keeps an invoice whose client is retired and names no client', async () => {
    const client = retiredClient;
    const invoice = retiredClientInvoice;
    const tenant = tenants_().retired;

    // The client is in the table and it is soft deleted.
    expect(await softDeletedClientCount(tenant.tenantId)).toBe(1);

    await withApp(async (app) => {
      const cookie = tenants_().retired.session.cookie;
      const result = await list(app, cookie);
      expect(result.statusCode).toBe(200);

      // The invoice is live, so it is listed, and the client id it was
      // recorded with is kept so the row stays traceable.
      expect(result.data.total).toBe(1);
      expect(result.data.items).toHaveLength(1);
      expect(one(result.data.items)).toMatchObject({
        id: invoice?.id,
        number: 'INV-2026-7001',
        clientId: client?.id,
        clientName: null,
        totalMinor: 755200,
      });

      // The retired client is not named: the join skips a soft-deleted
      // client, so there is no name to disclose.
      expect(result.body).not.toContain('Meridian Systems');

      // And it is not searchable through the join either.
      const byClient = await list(app, cookie, '?q=meridian');
      expect(byClient.statusCode).toBe(200);
      expect(byClient.data).toMatchObject({ items: [], total: 0 });

      // The invoice's own number still finds it.
      const byNumber = await list(app, cookie, '?q=inv-2026-7001');
      expect(byNumber.statusCode).toBe(200);
      expect(byNumber.data.total).toBe(1);
      expect(one(byNumber.data.items).clientName).toBeNull();
    });
  });
});
