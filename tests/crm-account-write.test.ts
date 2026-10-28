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
  CRM_PAYMENT_TERMS_DAYS_MAX,
  type CrmAccountListItem,
} from '@saasmodels/contracts';
import { createServer } from '@saasmodels/api';
import { createTestDatabase, type TestDatabase } from '@saasmodels/testkit';
import { randomToken } from './support/auth-fixtures.js';
import {
  insertClientRow,
  insertInvoiceRow,
  insertProjectRow,
  provisionModuleTenant,
  type ClientRowFixture,
  type ModuleTenantFixture,
} from './support/module-fixtures.js';

const appOrigin = 'https://app.example.test';
const USER_AGENT = 'CRM account write test/1.0';

type WriteResponse = {
  statusCode: number;
  headers: OutgoingHttpHeaders;
  body: string;
  payload: Record<string, unknown> | null;
};

type DenialRow = {
  action: string;
  entity_type: string;
  entity_id: string | null;
  actor_type: string;
  actor_user_id: string | null;
  metadata: Record<string, unknown>;
};

type CrmWriteTenants = {
  owner: ModuleTenantFixture;
  admin: ModuleTenantFixture;
  manager: ModuleTenantFixture;
  finance: ModuleTenantFixture;
  hr: ModuleTenantFixture;
  employee: ModuleTenantFixture;
  auditor: ModuleTenantFixture;
  unentitled: ModuleTenantFixture;
  other: ModuleTenantFixture;
  work: ModuleTenantFixture;
};

let database: TestDatabase | undefined;
let runtime: RuntimePool | undefined;
let auth: AuthPool | undefined;
let owner: Pool | undefined;
let tenants: CrmWriteTenants | undefined;
let seededAccount: ClientRowFixture | undefined;
let otherAccount: ClientRowFixture | undefined;
let withdrawnAccount: ClientRowFixture | undefined;

function db(): TestDatabase {
  if (!database) {
    throw new Error('Test database has not been created');
  }
  return database;
}

function tenants_(): CrmWriteTenants {
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

async function clientRows(tenantId: string): Promise<ClientRowFixture[]> {
  return withOwner(async (client) => {
    const result = await client.query<ClientRowFixture>(
      `select id,
              name,
              code,
              status,
              billing_email::text as "billingEmail",
              phone,
              currency::text as currency,
              payment_terms_days as "paymentTermsDays"
         from client
        where tenant_id = $1
        order by name, id`,
      [tenantId],
    );
    return result.rows;
  });
}

async function clientRowCount(tenantId: string): Promise<number> {
  return withOwner(async (client) => {
    const result = await client.query<{ total: string }>(
      'select count(*) as total from client where tenant_id = $1',
      [tenantId],
    );
    return Number(result.rows[0]?.total ?? '0');
  });
}

// The platform columns of one account: the owner, the provenance of an import
// and the import stamp. A CRM write names none of them, so they stay empty.
async function clientPlatformColumns(
  tenantId: string,
  id: string,
): Promise<Record<string, unknown> | null> {
  return withOwner(async (client) => {
    const result = await client.query<Record<string, unknown>>(
      `select owner_user_id,
              source_system,
              source_id,
              import_batch_id,
              imported_at
         from client
        where tenant_id = $1
          and id = $2`,
      [tenantId, id],
    );
    return result.rows[0] ?? null;
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

type SendOptions = {
  method: 'POST' | 'PATCH' | 'DELETE' | 'PUT' | 'GET';
  url: string;
  cookie?: string | null;
  csrf?: string | null;
  origin?: string;
  body?: unknown;
};

async function send(app: TestServer, options: SendOptions): Promise<WriteResponse> {
  const headers: Record<string, string> = { 'user-agent': USER_AGENT };
  headers.origin = options.origin ?? appOrigin;
  if (options.cookie) {
    headers.cookie = options.cookie;
  }
  if (options.csrf) {
    headers['x-csrf-token'] = options.csrf;
  }
  const payloadKnown = Object.hasOwn(options, 'body');
  if (payloadKnown) {
    headers['content-type'] = 'application/json';
  }

  const response = await app.inject({
    method: options.method,
    url: options.url,
    headers,
    ...(payloadKnown ? { payload: JSON.stringify(options.body) } : {}),
  });

  let payload: Record<string, unknown> | null;
  try {
    payload = response.json() as Record<string, unknown>;
  } catch {
    payload = null;
  }

  return {
    statusCode: response.statusCode,
    headers: response.headers,
    body: response.body,
    payload,
  };
}

function create(
  app: TestServer,
  tenant: ModuleTenantFixture,
  body: unknown,
  overrides: Partial<SendOptions> = {},
): Promise<WriteResponse> {
  return send(app, {
    method: 'POST',
    url: '/v1/crm/accounts',
    cookie: tenant.session.cookie,
    csrf: tenant.session.csrfToken,
    body,
    ...overrides,
  });
}

function patch(
  app: TestServer,
  tenant: ModuleTenantFixture,
  id: string,
  body: unknown,
  overrides: Partial<SendOptions> = {},
): Promise<WriteResponse> {
  return send(app, {
    method: 'PATCH',
    url: `/v1/crm/accounts/${encodeURIComponent(id)}`,
    cookie: tenant.session.cookie,
    csrf: tenant.session.csrfToken,
    body,
    ...overrides,
  });
}

beforeAll(async () => {
  database = await createTestDatabase({ migrate: true, seed: true });
  runtime = createRuntimePool(database.runtimeUrl);
  auth = createAuthPool(database.authUrl);
  owner = new Pool({ connectionString: database.ownerUrl });

  const [
    ownerTenant,
    adminTenant,
    managerTenant,
    financeTenant,
    hrTenant,
    employeeTenant,
    auditorTenant,
    unentitled,
    otherTenant,
    workTenant,
  ] = await Promise.all([
    provisionModuleTenant(db().ownerUrl, {
      label: 'crmwowner',
      modules: ['crm'],
    }),
    provisionModuleTenant(db().ownerUrl, {
      label: 'crmwadmin',
      modules: ['crm'],
      role: 'admin',
    }),
    provisionModuleTenant(db().ownerUrl, {
      label: 'crmwmanager',
      modules: ['crm'],
      role: 'manager',
    }),
    provisionModuleTenant(db().ownerUrl, {
      label: 'crmwfinance',
      modules: ['crm'],
      role: 'finance',
    }),
    provisionModuleTenant(db().ownerUrl, {
      label: 'crmwhr',
      modules: ['crm'],
      role: 'hr',
    }),
    provisionModuleTenant(db().ownerUrl, {
      label: 'crmwemployee',
      modules: ['crm'],
      role: 'employee',
    }),
    // The audit role reads People and Work and deliberately holds no CRM
    // permission.
    provisionModuleTenant(db().ownerUrl, {
      label: 'crmwauditor',
      modules: ['crm'],
      role: 'auditor',
    }),
    // No CRM entitlement at all.
    provisionModuleTenant(db().ownerUrl, {
      label: 'crmwunentitled',
      modules: ['people'],
    }),
    provisionModuleTenant(db().ownerUrl, {
      label: 'crmwother',
      modules: ['crm'],
    }),
    // A Work workspace, to prove a CRM-created account is the same record the
    // Work and Money reads name.
    provisionModuleTenant(db().ownerUrl, {
      label: 'crmwwork',
      modules: ['crm', 'work', 'money'],
    }),
  ]);

  tenants = {
    owner: ownerTenant,
    admin: adminTenant,
    manager: managerTenant,
    finance: financeTenant,
    hr: hrTenant,
    employee: employeeTenant,
    auditor: auditorTenant,
    unentitled,
    other: otherTenant,
    work: workTenant,
  };

  await withOwner(async (client) => {
    seededAccount = await insertClientRow(client, ownerTenant.tenantId, {
      name: 'Aster Logistics',
      code: 'CL-ASTER',
      status: 'active',
      billingEmail: 'billing@aster.example.test',
      phone: '+1-555-0101',
      currency: 'ZZZ',
      paymentTermsDays: 30,
    });

    withdrawnAccount = await insertClientRow(client, ownerTenant.tenantId, {
      name: 'Retired Traders',
      code: 'CL-RETIRED',
      deletedAt: '2026-03-01',
    });

    const other = await insertClientRow(client, otherTenant.tenantId, {
      name: 'Zephyr Holdings',
      code: 'CL-ZEPHYR',
    });
    otherAccount = other;
  });
});

afterAll(async () => {
  await owner?.end();
  await auth?.end();
  await runtime?.end();
  await database?.drop();
});

describe('CRM account create', () => {
  test('rejects the create route without a session, a CSRF token or the origin', async () => {
    const tenant = tenants_().owner;

    await withApp(async (app) => {
      const noSession = await send(app, {
        method: 'POST',
        url: '/v1/crm/accounts',
        csrf: tenant.session.csrfToken,
        body: { name: 'No Session', currency: 'ZZZ' },
      });
      expect(noSession.statusCode).toBe(401);
      expect(noSession.payload).toEqual({ error: { code: 'UNAUTHENTICATED' } });

      const badSession = await send(app, {
        method: 'POST',
        url: '/v1/crm/accounts',
        cookie: `saas_session=${randomToken()}`,
        csrf: tenant.session.csrfToken,
        body: { name: 'No Session', currency: 'ZZZ' },
      });
      expect(badSession.statusCode).toBe(401);

      const noCsrf = await send(app, {
        method: 'POST',
        url: '/v1/crm/accounts',
        cookie: tenant.session.cookie,
        body: { name: 'No Csrf', currency: 'ZZZ' },
      });
      expect(noCsrf.statusCode).toBe(403);
      expect(noCsrf.payload).toEqual({ error: { code: 'CSRF_INVALID' } });

      const wrongCsrf = await send(app, {
        method: 'POST',
        url: '/v1/crm/accounts',
        cookie: tenant.session.cookie,
        csrf: randomToken(),
        body: { name: 'No Csrf', currency: 'ZZZ' },
      });
      expect(wrongCsrf.statusCode).toBe(403);
      expect(wrongCsrf.payload).toEqual({ error: { code: 'CSRF_INVALID' } });

      const wrongOrigin = await send(app, {
        method: 'POST',
        url: '/v1/crm/accounts',
        cookie: tenant.session.cookie,
        csrf: tenant.session.csrfToken,
        origin: 'https://evil.example.test',
        body: { name: 'Wrong Origin', currency: 'ZZZ' },
      });
      expect(wrongOrigin.statusCode).toBe(403);
      expect(wrongOrigin.payload).toEqual({ error: { code: 'ORIGIN_DENIED' } });

      // None of the refusals wrote a row.
      expect(await clientRowCount(tenant.tenantId)).toBe(2);
    });
  });

  test('creates an account with only the eight fields the surface names', async () => {
    const tenant = tenants_().owner;

    await withApp(async (app) => {
      const result = await create(app, tenant, {
        name: 'Kestrel Freight',
        code: 'CL-KESTREL',
        status: 'prospect',
        billingEmail: 'billing@kestrel.example.test',
        phone: '+1-555-0142',
        currency: 'EUR',
        paymentTermsDays: 45,
      });
      expect(result.statusCode).toBe(201);
      expect(result.headers['cache-control']).toBe('no-store');

      const item = result.payload as unknown as CrmAccountListItem;
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
      expect(item).toMatchObject({
        name: 'Kestrel Freight',
        code: 'CL-KESTREL',
        status: 'prospect',
        billingEmail: 'billing@kestrel.example.test',
        phone: '+1-555-0142',
        currency: 'EUR',
        paymentTermsDays: 45,
      });
      expect(item.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );

      // The row holds nothing else: the platform columns are absent because
      // the route never wrote them, not because the answer hid them.
      const platform = await clientPlatformColumns(tenant.tenantId, item.id);
      expect(platform).not.toBeNull();
      expect(platform?.owner_user_id).toBeNull();
      expect(platform?.source_system).toBeNull();
      expect(platform?.source_id).toBeNull();
      expect(platform?.import_batch_id).toBeNull();
      expect(platform?.imported_at).toBeNull();
    });
  });

  test('takes the database defaults for the two omitted columns', async () => {
    const tenant = tenants_().owner;

    await withApp(async (app) => {
      const result = await create(app, tenant, {
        name: 'Pinewood Studio',
        currency: 'ZZZ',
      });
      expect(result.statusCode).toBe(201);
      expect(result.payload).toMatchObject({
        name: 'Pinewood Studio',
        code: null,
        status: 'active',
        billingEmail: null,
        phone: null,
        currency: 'ZZZ',
        paymentTermsDays: 30,
      });
    });
  });

  test('records every field name the caller sent and no value at all', async () => {
    const tenant = tenants_().owner;
    const before = await auditRows(tenant.tenantId);

    await withApp(async (app) => {
      const result = await create(app, tenant, {
        name: 'Audited Account',
        code: 'CL-AUDIT',
        billingEmail: 'audit@example.test',
        currency: 'ZZZ',
      });
      expect(result.statusCode).toBe(201);
    });

    const after = await auditRows(tenant.tenantId);
    const event = one(
      after
        .slice(before.length)
        .filter((row) => row.action === 'crm.account.created'),
    );
    expect(event.entity_type).toBe('crm_account');
    expect(event.actor_type).toBe('user');
    expect(event.actor_user_id).toBe(tenant.userId);
    expect(event.metadata).toEqual({
      fields: ['billingEmail', 'code', 'currency', 'name'],
    });

    // Not one value of the account is in the trail.
    expect(event.metadata?.name).toBeUndefined();
    expect(event.metadata?.billingEmail).toBeUndefined();
    expect(event.metadata?.code).toBeUndefined();
  });

  test('refuses manager, finance, hr, employee and auditor with one denial row each', async () => {
    await withApp(async (app) => {
      for (const role of ['manager', 'finance', 'hr', 'employee', 'auditor'] as const) {
        const tenant = tenants_()[role];
        const before = await denialRows(tenant.tenantId);

        const result = await create(app, tenant, {
          name: `Refused ${role}`,
          currency: 'ZZZ',
        });
        expect(result.statusCode).toBe(403);
        expect(result.payload).toEqual({
          error: { code: 'ROLE_DENIED', permission: 'crm.write' },
        });
        expect(result.headers['cache-control']).toBe('no-store');

        const after = await denialRows(tenant.tenantId);
        expect(after).toHaveLength(before.length + 1);
        expect(one(after.slice(-1))).toMatchObject({
          action: 'authorization.denied',
          actor_user_id: tenant.userId,
          metadata: {
            reason: 'ROLE_DENIED',
            method: 'POST',
            path: '/v1/crm/accounts',
            module: 'crm',
            operation: 'write',
            permission: 'crm.write',
          },
        });
      }
    });
  });

  test('lets an admin create and amend an account', async () => {
    const tenant = tenants_().admin;

    await withApp(async (app) => {
      const created = await create(app, tenant, {
        name: 'Admin Account',
        code: 'CL-ADMIN',
        currency: 'ZZZ',
      });
      expect(created.statusCode).toBe(201);
      const id = (created.payload as unknown as CrmAccountListItem).id;

      const amended = await patch(app, tenant, id, { status: 'dormant' });
      expect(amended.statusCode).toBe(200);
      expect(amended.payload).toMatchObject({
        id,
        name: 'Admin Account',
        status: 'dormant',
      });
    });
  });

  test('settles the write permission before it reads the body', async () => {
    const account = seededAccount;

    await withApp(async (app) => {
      // Each body below is one the closed shape rejects. A caller that holds
      // no crm.write permission gets the authorization refusal instead, which
      // proves the gate is settled before the body is parsed.
      const deniedCreate = await create(app, tenants_().manager, {
        tenantId: 'nope',
      });
      expect(deniedCreate.statusCode).toBe(403);
      expect(deniedCreate.payload).toEqual({
        error: { code: 'ROLE_DENIED', permission: 'crm.write' },
      });

      const deniedPatch = await patch(
        app,
        tenants_().manager,
        account?.id ?? '',
        { tenantId: 'nope' },
      );
      expect(deniedPatch.statusCode).toBe(403);
      expect(deniedPatch.payload).toEqual({
        error: { code: 'ROLE_DENIED', permission: 'crm.write' },
      });

      const unentitledCreate = await create(app, tenants_().unentitled, {
        name: '',
        currency: 'zzz',
      });
      expect(unentitledCreate.statusCode).toBe(403);
      expect(unentitledCreate.payload).toEqual({
        error: { code: 'MODULE_NOT_ENTITLED', module: 'crm', operation: 'write' },
      });
    });
  });

  test('refuses a tenant without the CRM entitlement before the role check', async () => {
    const tenant = tenants_().unentitled;
    const before = await denialRows(tenant.tenantId);

    await withApp(async (app) => {
      const result = await create(app, tenant, {
        name: 'Unentitled',
        currency: 'ZZZ',
      });
      expect(result.statusCode).toBe(403);
      expect(result.payload).toEqual({
        error: { code: 'MODULE_NOT_ENTITLED', module: 'crm', operation: 'write' },
      });
    });

    const after = await denialRows(tenant.tenantId);
    expect(after).toHaveLength(before.length + 1);
    expect(one(after.slice(-1)).metadata).toMatchObject({
      reason: 'MODULE_NOT_ENTITLED',
      module: 'crm',
      operation: 'write',
    });
  });

  test('refuses every body that is not the closed create shape', async () => {
    const tenant = tenants_().owner;
    const before = await clientRowCount(tenant.tenantId);

    const invalid = [
      {},
      { currency: 'ZZZ' },
      { name: 'No Currency' },
      { name: '', currency: 'ZZZ' },
      { name: '   ', currency: 'ZZZ' },
      { name: 42, currency: 'ZZZ' },
      { name: 'Lower Currency', currency: 'zzz' },
      { name: 'Long Currency', currency: 'ZZZZ' },
      { name: 'Short Currency', currency: 'ZZ' },
      { name: 'Wrong Status', currency: 'ZZZ', status: 'closed' },
      { name: 'Wrong Status Type', currency: 'ZZZ', status: 3 },
      { name: 'Negative Terms', currency: 'ZZZ', paymentTermsDays: -1 },
      { name: 'Fractional Terms', currency: 'ZZZ', paymentTermsDays: 1.5 },
      { name: 'Huge Terms', currency: 'ZZZ', paymentTermsDays: 2 ** 40 },
      { name: null, currency: 'ZZZ' },
      { name: 'Null Currency', currency: null },
      { name: 'Null Status', currency: 'ZZZ', status: null },
      { name: 'Extra Key', currency: 'ZZZ', tenantId: 'nope' },
      { name: 'Extra Key', currency: 'ZZZ', ownerUserId: 'nope' },
      { name: 'Extra Key', currency: 'ZZZ', deletedAt: '2026-01-01' },
    ];

    await withApp(async (app) => {
      for (const body of invalid) {
        const result = await create(app, tenant, body);
        expect(result.statusCode).toBe(400);
        expect(result.payload).toEqual({ error: { code: 'INVALID_BODY' } });
        expect(result.headers['cache-control']).toBe('no-store');
      }
    });

    expect(await clientRowCount(tenant.tenantId)).toBe(before);
  });

  test('holds the payment terms to the integer range the column can carry', async () => {
    const tenant = tenants_().owner;

    await withApp(async (app) => {
      const atLimit = await create(app, tenant, {
        name: 'Large Terms',
        currency: 'ZZZ',
        paymentTermsDays: CRM_PAYMENT_TERMS_DAYS_MAX,
      });
      expect(atLimit.statusCode).toBe(201);
      expect(
        (atLimit.payload as unknown as CrmAccountListItem).paymentTermsDays,
      ).toBe(CRM_PAYMENT_TERMS_DAYS_MAX);

      const overLimit = await create(app, tenant, {
        name: 'Too Large Terms',
        currency: 'ZZZ',
        paymentTermsDays: CRM_PAYMENT_TERMS_DAYS_MAX + 1,
      });
      expect(overLimit.statusCode).toBe(400);
      expect(overLimit.payload).toEqual({ error: { code: 'INVALID_BODY' } });
    });
  });

  test('refuses a code the tenant already holds without echoing it', async () => {
    const tenant = tenants_().owner;
    const before = await clientRowCount(tenant.tenantId);

    await withApp(async (app) => {
      const result = await create(app, tenant, {
        name: 'Duplicate Code',
        code: 'CL-ASTER',
        currency: 'ZZZ',
      });
      expect(result.statusCode).toBe(409);
      expect(result.payload).toEqual({ error: { code: 'ACCOUNT_CODE_TAKEN' } });
      expect(result.headers['cache-control']).toBe('no-store');
      expect(result.body).not.toContain('CL-ASTER');
      expect(result.body.toLowerCase()).not.toContain('duplicate key');
      expect(result.body.toLowerCase()).not.toContain('client_');
    });

    expect(await clientRowCount(tenant.tenantId)).toBe(before);
  });

  test('marks every create outcome uncacheable', async () => {
    const tenant = tenants_().owner;

    await withApp(async (app) => {
      const created = await create(app, tenant, { name: 'Cached', currency: 'ZZZ' });
      expect(created.statusCode).toBe(201);
      expect(created.headers['cache-control']).toBe('no-store');

      const refused = await create(app, tenant, { name: '' });
      expect(refused.statusCode).toBe(400);
      expect(refused.headers['cache-control']).toBe('no-store');
    });
  });
});

describe('CRM account update', () => {
  test('rejects the update route without a session, a CSRF token or the origin', async () => {
    const tenant = tenants_().owner;
    const account = seededAccount;

    await withApp(async (app) => {
      const noSession = await send(app, {
        method: 'PATCH',
        url: `/v1/crm/accounts/${account?.id}`,
        csrf: tenant.session.csrfToken,
        body: { name: 'Changed' },
      });
      expect(noSession.statusCode).toBe(401);

      const noCsrf = await send(app, {
        method: 'PATCH',
        url: `/v1/crm/accounts/${account?.id}`,
        cookie: tenant.session.cookie,
        body: { name: 'Changed' },
      });
      expect(noCsrf.statusCode).toBe(403);
      expect(noCsrf.payload).toEqual({ error: { code: 'CSRF_INVALID' } });

      const wrongOrigin = await send(app, {
        method: 'PATCH',
        url: `/v1/crm/accounts/${account?.id}`,
        cookie: tenant.session.cookie,
        csrf: tenant.session.csrfToken,
        origin: 'https://evil.example.test',
        body: { name: 'Changed' },
      });
      expect(wrongOrigin.statusCode).toBe(403);
      expect(wrongOrigin.payload).toEqual({ error: { code: 'ORIGIN_DENIED' } });
    });
  });

  test('amends one value and leaves every other column where it was', async () => {
    const tenant = tenants_().owner;
    const account = seededAccount;

    await withApp(async (app) => {
      const result = await patch(app, tenant, account?.id ?? '', {
        billingEmail: 'accounts@aster.example.test',
      });
      expect(result.statusCode).toBe(200);
      expect(result.headers['cache-control']).toBe('no-store');
      expect(result.payload).toMatchObject({
        id: account?.id,
        name: 'Aster Logistics',
        code: 'CL-ASTER',
        status: 'active',
        billingEmail: 'accounts@aster.example.test',
        phone: '+1-555-0101',
        currency: 'ZZZ',
        paymentTermsDays: 30,
      });
    });
  });

  test('treats a change-free patch as a no-op with no write and no audit', async () => {
    const tenant = tenants_().owner;
    const account = seededAccount;
    const before = await auditRows(tenant.tenantId);
    const beforeRow = one(
      (await clientRows(tenant.tenantId)).filter(
        (row) => row.id === account?.id,
      ),
    );

    await withApp(async (app) => {
      // The body states the values the row already holds, so nothing moves.
      const result = await patch(app, tenant, account?.id ?? '', {
        name: beforeRow.name,
        code: beforeRow.code,
        status: beforeRow.status,
        billingEmail: beforeRow.billingEmail,
        phone: beforeRow.phone,
        currency: beforeRow.currency,
        paymentTermsDays: beforeRow.paymentTermsDays,
      });
      expect(result.statusCode).toBe(200);
      expect(result.payload).toMatchObject({ id: account?.id });
    });

    const after = await auditRows(tenant.tenantId);
    expect(after).toHaveLength(before.length);
    expect(
      after.filter((row) => row.action === 'crm.account.updated'),
    ).toHaveLength(
      before.filter((row) => row.action === 'crm.account.updated').length,
    );
    expect(
      one((await clientRows(tenant.tenantId)).filter((row) => row.id === account?.id)),
    ).toEqual(beforeRow);
  });

  test('closes and reopens the three nullable columns with the one key a null may state', async () => {
    const tenant = tenants_().owner;
    const account = seededAccount;

    await withApp(async (app) => {
      const cleared = await patch(app, tenant, account?.id ?? '', {
        code: null,
        billingEmail: null,
        phone: null,
      });
      expect(cleared.statusCode).toBe(200);
      expect(cleared.payload).toMatchObject({
        code: null,
        billingEmail: null,
        phone: null,
      });

      const restored = await patch(app, tenant, account?.id ?? '', {
        code: 'CL-ASTER',
        billingEmail: 'billing@aster.example.test',
        phone: '+1-555-0101',
      });
      expect(restored.statusCode).toBe(200);
      expect(restored.payload).toMatchObject({
        code: 'CL-ASTER',
        billingEmail: 'billing@aster.example.test',
        phone: '+1-555-0101',
      });
    });
  });

  test('refuses null for the four values a row always holds', async () => {
    const tenant = tenants_().owner;
    const account = seededAccount;

    await withApp(async (app) => {
      for (const body of [
        { name: null },
        { status: null },
        { currency: null },
        { paymentTermsDays: null },
      ]) {
        const result = await patch(app, tenant, account?.id ?? '', body);
        expect(result.statusCode).toBe(400);
        expect(result.payload).toEqual({ error: { code: 'INVALID_BODY' } });
      }
    });
  });

  test('decides the merged record, not the sent half', async () => {
    const tenant = tenants_().owner;
    const account = seededAccount;

    await withApp(async (app) => {
      // The sent half is a legal currency on its own, and the merged record is
      // legal too, so this is a plain amendment.
      const fine = await patch(app, tenant, account?.id ?? '', {
        currency: 'EUR',
      });
      expect(fine.statusCode).toBe(200);
      expect(fine.payload).toMatchObject({ currency: 'EUR' });

      // A half that is not legal on its own never reaches the merge.
      const bad = await patch(app, tenant, account?.id ?? '', {
        currency: 'eur',
      });
      expect(bad.statusCode).toBe(400);
      expect(bad.payload).toEqual({ error: { code: 'INVALID_BODY' } });
    });
  });

  test('answers 404 ACCOUNT_NOT_FOUND for every way an id can fail', async () => {
    const tenant = tenants_().owner;
    const foreign = otherAccount;
    const withdrawn = withdrawnAccount;

    await withApp(async (app) => {
      const ids = [
        'not-a-uuid',
        '00000000-0000-0000-0000-000000000000',
        foreign?.id ?? '',
        withdrawn?.id ?? '',
      ];

      for (const id of ids) {
        const result = await patch(app, tenant, id, { name: 'Changed' });
        expect(result.statusCode).toBe(404);
        expect(result.payload).toEqual({ error: { code: 'ACCOUNT_NOT_FOUND' } });
        expect(result.headers['cache-control']).toBe('no-store');
      }
    });
  });

  test('refuses a patch that names no field or a field the route does not write', async () => {
    const tenant = tenants_().owner;
    const account = seededAccount;

    await withApp(async (app) => {
      const empty = await patch(app, tenant, account?.id ?? '', {});
      expect(empty.statusCode).toBe(400);
      expect(empty.payload).toEqual({ error: { code: 'INVALID_BODY' } });

      const extra = await patch(app, tenant, account?.id ?? '', {
        name: 'Changed',
        tenantId: 'nope',
      });
      expect(extra.statusCode).toBe(400);
      expect(extra.payload).toEqual({ error: { code: 'INVALID_BODY' } });
    });
  });

  test('refuses a patch that would collide with a stored code', async () => {
    const tenant = tenants_().owner;
    const account = seededAccount;

    await withApp(async (app) => {
      const result = await patch(app, tenant, account?.id ?? '', {
        code: 'CL-RETIRED',
      });
      expect(result.statusCode).toBe(409);
      expect(result.payload).toEqual({ error: { code: 'ACCOUNT_CODE_TAKEN' } });
      expect(result.body).not.toContain('CL-RETIRED');
    });
  });

  test('audits the changed field names only and never a value', async () => {
    const tenant = tenants_().owner;
    const account = seededAccount;
    const before = await auditRows(tenant.tenantId);

    await withApp(async (app) => {
      const result = await patch(app, tenant, account?.id ?? '', {
        name: 'Aster Logistics Group',
        status: 'dormant',
      });
      expect(result.statusCode).toBe(200);
    });

    const after = await auditRows(tenant.tenantId);
    const event = one(
      after
        .slice(before.length)
        .filter((row) => row.action === 'crm.account.updated'),
    );
    expect(event.entity_type).toBe('crm_account');
    expect(event.entity_id).toBe(account?.id);
    expect(event.metadata).toEqual({ fields: ['name', 'status'] });
    expect(event.metadata?.name).toBeUndefined();
    expect(event.metadata?.status).toBeUndefined();
  });

  test('has no delete route and no delete path at all', async () => {
    const tenant = tenants_().owner;
    const account = seededAccount;
    const before = await clientRowCount(tenant.tenantId);

    await withApp(async (app) => {
      for (const method of ['DELETE', 'PUT'] as const) {
        const response = await send(app, {
          method,
          url: `/v1/crm/accounts/${account?.id}`,
          cookie: tenant.session.cookie,
          csrf: tenant.session.csrfToken,
          body: { name: 'Changed' },
        });
        expect(response.statusCode).toBe(404);
        expect(response.payload?.error).toBe('Not Found');
      }
    });

    expect(await clientRowCount(tenant.tenantId)).toBe(before);
  });
});

describe('CRM account write failures', () => {
  test('fails closed with a sanitized 500 when the audit write fails', async () => {
    const tenant = tenants_().owner;
    const account = seededAccount;
    const before = await clientRowCount(tenant.tenantId);
    const beforeAudit = await auditRows(tenant.tenantId);
    const beforeRow = one(
      (await clientRows(tenant.tenantId)).filter(
        (row) => row.id === account?.id,
      ),
    );

    await withOwner(async (client) => {
      await client.query('revoke insert on table public.audit_event from saas_runtime');
    });
    try {
      await withApp(async (app) => {
        const created = await create(app, tenant, {
          name: 'Rolled Back',
          currency: 'ZZZ',
        });
        const amended = await patch(app, tenant, account?.id ?? '', {
          name: 'Rolled Back Too',
        });

        for (const response of [created, amended]) {
          expect(response.statusCode).toBe(500);
          expect(response.payload).toEqual({ error: { code: 'INTERNAL_ERROR' } });
          expect(response.headers['cache-control']).toBe('no-store');
          for (const detail of [
            'permission denied',
            'audit_event',
            'insert into',
            'saas_runtime',
            'Rolled Back',
            'PostgreSQL',
          ]) {
            expect(response.body.toLowerCase()).not.toContain(detail.toLowerCase());
          }
        }
      });
    } finally {
      await withOwner(async (client) => {
        await client.query('grant insert on table public.audit_event to saas_runtime');
      });
    }

    // The transaction rolled back with its audit row: neither the new account
    // nor the amendment survived.
    expect(await clientRowCount(tenant.tenantId)).toBe(before);
    expect(
      one((await clientRows(tenant.tenantId)).filter((row) => row.id === account?.id)),
    ).toEqual(beforeRow);
    expect(await auditRows(tenant.tenantId)).toHaveLength(beforeAudit.length);
  });
});

describe('The CRM account write in the database', () => {
  test('writes one shared record that the Work and Money reads name', async () => {
    const work = tenants_().work;

    let accountId = '';
    await withApp(async (app) => {
      const result = await create(app, work, {
        name: 'Shared Account',
        code: 'CL-SHARED',
        currency: 'ZZZ',
      });
      expect(result.statusCode).toBe(201);
      accountId = (result.payload as unknown as CrmAccountListItem).id;
    });

    // The account is a client row, so an owner-side project and invoice may
    // name it and be read through the Work and Money surfaces.
    await withOwner(async (client) => {
      await insertProjectRow(client, work.tenantId, {
        clientId: accountId,
        name: 'Shared rollout',
        code: 'PR-SHARED-1',
        status: 'active',
        currency: 'ZZZ',
      });
      await insertInvoiceRow(client, work.tenantId, {
        clientId: accountId,
        number: 'INV-SHARED-1',
        status: 'sent',
        currency: 'ZZZ',
      });
    });

    await withApp(async (app) => {
      const projects = await send(app, {
        method: 'GET',
        url: '/v1/work/projects',
        cookie: work.session.cookie,
      });
      expect(projects.statusCode).toBe(200);
      expect(projects.body).toContain('Shared Account');
      expect(projects.body).toContain('Shared rollout');

      const invoices = await send(app, {
        method: 'GET',
        url: '/v1/money/invoices',
        cookie: work.session.cookie,
      });
      expect(invoices.statusCode).toBe(200);
      expect(invoices.body).toContain('Shared Account');
      expect(invoices.body).toContain('INV-SHARED-1');

      // One record, not two: the account the CRM write made is the account
      // the Work read names.
      const accounts = await send(app, {
        method: 'GET',
        url: '/v1/crm/accounts',
        cookie: work.session.cookie,
      });
      expect(accounts.statusCode).toBe(200);
      expect(accounts.body.match(/Shared Account/g)).toHaveLength(1);
    });

    const stored = await withOwner(async (client) => {
      const result = await client.query<{ total: string }>(
        `select count(*) as total from client
          where tenant_id = $1 and name = 'Shared Account'`,
        [work.tenantId],
      );
      return Number(result.rows[0]?.total ?? '0');
    });
    expect(stored).toBe(1);
  });

  test('refuses the runtime role a delete on a client row', async () => {
    const account = seededAccount;

    const error = await withOwner(async (client) => {
      try {
        await client.query('delete from client where id = $1', [account?.id]);
        return null;
      } catch (caught) {
        return caught as { code?: string };
      }
    });

    // The owner role owns the table and may delete; the runtime role may not.
    // The grant file gives the runtime role no DELETE on this table.
    expect(error).toBeNull();

    const runtimeDelete = await new Client({
      connectionString: db().runtimeUrl,
    });
    await runtimeDelete.connect();
    try {
      let runtimeError: { code?: string } | null = null;
      try {
        await runtimeDelete.query('delete from client where id = $1', [
          account?.id,
        ]);
      } catch (caught) {
        runtimeError = caught as { code?: string };
      }
      expect(runtimeError?.code).toBe('42501');
    } finally {
      await runtimeDelete.end();
    }
  });
});
