import { Client, Pool } from 'pg';
import type { OutgoingHttpHeaders } from 'node:http';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  createAuthPool,
  createRuntimePool,
  type AuthPool,
  type RuntimePool,
} from '@saasmodels/db';
import { createServer } from '@saasmodels/api';
import { createTestDatabase, type TestDatabase } from '@saasmodels/testkit';
import { randomToken } from './support/auth-fixtures.js';
import {
  insertClientRow,
  insertContactRow,
  provisionModuleTenant,
  type ClientRowFixture,
  type ContactRowFixture,
  type ModuleTenantFixture,
} from './support/module-fixtures.js';

const appOrigin = 'https://app.example.test';
const USER_AGENT = 'CRM contact test/1.0';

type WriteResponse = {
  statusCode: number;
  headers: OutgoingHttpHeaders;
  body: string;
  payload: Record<string, unknown> | null;
};

type AuditRow = {
  action: string;
  entity_type: string;
  entity_id: string | null;
  metadata: Record<string, unknown>;
};

type CrmContactTenants = {
  owner: ModuleTenantFixture;
  admin: ModuleTenantFixture;
  manager: ModuleTenantFixture;
  finance: ModuleTenantFixture;
  hr: ModuleTenantFixture;
  employee: ModuleTenantFixture;
  auditor: ModuleTenantFixture;
  unentitled: ModuleTenantFixture;
  other: ModuleTenantFixture;
};

let database: TestDatabase | undefined;
let runtime: RuntimePool | undefined;
let auth: AuthPool | undefined;
let owner: Pool | undefined;
let tenants: CrmContactTenants | undefined;
let account: ClientRowFixture | undefined;
let withdrawnAccount: ClientRowFixture | undefined;
let otherAccount: ClientRowFixture | undefined;
let primaryContact: ContactRowFixture | undefined;
let secondContact: ContactRowFixture | undefined;
let otherContact: ContactRowFixture | undefined;
// A second account in the same owner tenant, with its own contact. A contact
// of another tenant is not enough to prove the per-account boundary, because
// tenant isolation would hide it anyway.
let secondAccount: ClientRowFixture | undefined;
let sameTenantOtherContact: ContactRowFixture | undefined;
// Each reading workspace holds its own account, because a contact belongs to
// the account of the workspace that owns it.
let managerAccount: ClientRowFixture | undefined;
let financeAccount: ClientRowFixture | undefined;
let adminAccount: ClientRowFixture | undefined;

function db(): TestDatabase {
  if (!database) {
    throw new Error('Test database has not been created');
  }
  return database;
}

function tenants_(): CrmContactTenants {
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

async function auditRows(tenantId: string): Promise<AuditRow[]> {
  return withOwner(async (client) => {
    const result = await client.query<AuditRow>(
      `select action, entity_type, entity_id, metadata
         from audit_event
        where tenant_id = $1
        order by occurred_at, id`,
      [tenantId],
    );
    return result.rows;
  });
}

async function contactRows(tenantId: string): Promise<ContactRowFixture[]> {
  return withOwner(async (client) => {
    const result = await client.query<ContactRowFixture>(
      `select id,
              client_id as "clientId",
              name,
              email::text as email,
              phone,
              role,
              is_primary as "isPrimary"
         from client_contact
        where tenant_id = $1
        order by is_primary desc, lower(name), id`,
      [tenantId],
    );
    return result.rows;
  });
}

async function contactCount(tenantId: string): Promise<number> {
  return withOwner(async (client) => {
    const result = await client.query<{ total: string }>(
      'select count(*) as total from client_contact where tenant_id = $1',
      [tenantId],
    );
    return Number(result.rows[0]?.total ?? '0');
  });
}

// The concurrency proof releases the two writes in stages and reads when the
// expected backends are waiting, so no stage is released while a write is
// still anywhere else. The contact table's SHARE lock stops both at the
// demotion statement; the account row lock then stops both at the foreign key
// check of the insert, which waits on the barrier transaction and is reached
// only after each write has run its own demotion.
async function waitForBlockedWrites(
  stage: 'demotion' | 'insert',
  expected: number,
  timeoutMs = 5_000,
): Promise<void> {
  const predicate =
    stage === 'demotion'
      ? `c.relname = 'client_contact' and not l.granted`
      : `l.locktype = 'transactionid' and not l.granted`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const waiting = await withOwner(async (client) => {
      const result = await client.query<{ total: string }>(
        `select count(*) as total
           from pg_locks l
           left join pg_class c on c.oid = l.relation
          where ${predicate}`,
      );
      return Number(result.rows[0]?.total ?? '0');
    });
    if (waiting >= expected) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`The concurrent contact writes never blocked at the ${stage}`);
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
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT';
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

function listContacts(
  app: TestServer,
  tenant: ModuleTenantFixture,
  accountId: string,
  overrides: Partial<SendOptions> = {},
): Promise<WriteResponse> {
  return send(app, {
    method: 'GET',
    url: `/v1/crm/accounts/${encodeURIComponent(accountId)}/contacts`,
    cookie: tenant.session.cookie,
    ...overrides,
  });
}

function createContact(
  app: TestServer,
  tenant: ModuleTenantFixture,
  accountId: string,
  body: unknown,
  overrides: Partial<SendOptions> = {},
): Promise<WriteResponse> {
  return send(app, {
    method: 'POST',
    url: `/v1/crm/accounts/${encodeURIComponent(accountId)}/contacts`,
    cookie: tenant.session.cookie,
    csrf: tenant.session.csrfToken,
    body,
    ...overrides,
  });
}

function patchContact(
  app: TestServer,
  tenant: ModuleTenantFixture,
  accountId: string,
  contactId: string,
  body: unknown,
  overrides: Partial<SendOptions> = {},
): Promise<WriteResponse> {
  return send(app, {
    method: 'PATCH',
    url: `/v1/crm/accounts/${encodeURIComponent(accountId)}/contacts/${encodeURIComponent(contactId)}`,
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
  ] = await Promise.all([
    // A CRM-only workspace: no People entitlement at all.
    provisionModuleTenant(db().ownerUrl, {
      label: 'crmcontactsowner',
      modules: ['crm'],
    }),
    provisionModuleTenant(db().ownerUrl, {
      label: 'crmcontactsadmin',
      modules: ['crm'],
      role: 'admin',
    }),
    provisionModuleTenant(db().ownerUrl, {
      label: 'crmcontactsmanager',
      modules: ['crm'],
      role: 'manager',
    }),
    provisionModuleTenant(db().ownerUrl, {
      label: 'crmcontactsfinance',
      modules: ['crm'],
      role: 'finance',
    }),
    provisionModuleTenant(db().ownerUrl, {
      label: 'crmcontactshr',
      modules: ['crm'],
      role: 'hr',
    }),
    provisionModuleTenant(db().ownerUrl, {
      label: 'crmcontactsemployee',
      modules: ['crm'],
      role: 'employee',
    }),
    // The audit role reads People and Work and deliberately holds no CRM
    // permission.
    provisionModuleTenant(db().ownerUrl, {
      label: 'crmcontactsauditor',
      modules: ['crm'],
      role: 'auditor',
    }),
    // No CRM entitlement at all.
    provisionModuleTenant(db().ownerUrl, {
      label: 'crmcontactsunentitled',
      modules: ['people'],
    }),
    provisionModuleTenant(db().ownerUrl, {
      label: 'crmcontactsother',
      modules: ['crm'],
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
  };

  await withOwner(async (client) => {
    account = await insertClientRow(client, ownerTenant.tenantId, {
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

    primaryContact = await insertContactRow(client, ownerTenant.tenantId, {
      clientId: account.id,
      name: 'Dana Primary',
      email: 'dana@aster.example.test',
      phone: '+1-555-0111',
      role: 'Billing',
      isPrimary: true,
    });

    secondContact = await insertContactRow(client, ownerTenant.tenantId, {
      clientId: account.id,
      name: 'Chris Contact',
      email: 'chris@aster.example.test',
    });

    // A second account in the same tenant. Its contact names a different
    // account, and the account in the path is the only thing that decides
    // which contacts a request can reach.
    secondAccount = await insertClientRow(client, ownerTenant.tenantId, {
      name: 'Beacon Supplies',
      code: 'CL-BEACON',
    });
    sameTenantOtherContact = await insertContactRow(client, ownerTenant.tenantId, {
      clientId: secondAccount.id,
      name: 'Sam Beacon',
      email: 'sam@beacon.example.test',
    });

    const other = await insertClientRow(client, otherTenant.tenantId, {
      name: 'Zephyr Holdings',
      code: 'CL-ZEPHYR',
    });
    otherAccount = other;
    otherContact = await insertContactRow(client, otherTenant.tenantId, {
      clientId: other.id,
      name: 'Zoe Other',
      email: 'zoe@zephyr.example.test',
      isPrimary: true,
    });

    managerAccount = await insertClientRow(client, managerTenant.tenantId, {
      name: 'Manager Account',
      code: 'CL-MANAGER',
    });
    await insertContactRow(client, managerTenant.tenantId, {
      clientId: managerAccount.id,
      name: 'Morgan Manager',
      email: 'morgan@manager.example.test',
      isPrimary: true,
    });

    financeAccount = await insertClientRow(client, financeTenant.tenantId, {
      name: 'Finance Account',
      code: 'CL-FINANCE',
    });
    await insertContactRow(client, financeTenant.tenantId, {
      clientId: financeAccount.id,
      name: 'Frank Finance',
      email: 'frank@finance.example.test',
      isPrimary: true,
    });

    adminAccount = await insertClientRow(client, adminTenant.tenantId, {
      name: 'Admin Account',
      code: 'CL-ADMIN',
    });
    await insertContactRow(client, adminTenant.tenantId, {
      clientId: adminAccount.id,
      name: 'Ada Admin',
      email: 'ada@admin.example.test',
      isPrimary: true,
    });
  });
});

afterAll(async () => {
  await owner?.end();
  await auth?.end();
  await runtime?.end();
  await database?.drop();
});

describe('The CRM contact read', () => {
  test('refuses a request without a session', async () => {
    await withApp(async (app) => {
      const response = await send(app, {
        method: 'GET',
        url: `/v1/crm/accounts/${account?.id}/contacts`,
      });
      expect(response.statusCode).toBe(401);
      expect(response.payload).toEqual({ error: { code: 'UNAUTHENTICATED' } });
    });
  });

  test('lists the contacts of a CRM-only workspace in a stable order', async () => {
    const tenant = tenants_().owner;

    await withApp(async (app) => {
      const response = await listContacts(app, tenant, account?.id ?? '');
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');

      const body = response.payload as {
        items: Array<Record<string, unknown>>;
        total: number;
      };
      expect(body.total).toBe(2);
      expect(Object.keys(body).sort()).toEqual(['items', 'total']);
      // The primary contact first, then the rest by lower(name) and id.
      expect(body.items.map((item) => item.name)).toEqual([
        'Dana Primary',
        'Chris Contact',
      ]);

      // The item carries exactly the six fields the surface names.
      for (const item of body.items) {
        expect(Object.keys(item).sort()).toEqual([
          'email',
          'id',
          'isPrimary',
          'name',
          'phone',
          'role',
        ]);
      }
      expect(body.items[0]).toMatchObject({
        id: primaryContact?.id,
        name: 'Dana Primary',
        email: 'dana@aster.example.test',
        phone: '+1-555-0111',
        role: 'Billing',
        isPrimary: true,
      });
      expect(body.items[1]).toMatchObject({
        id: secondContact?.id,
        name: 'Chris Contact',
        email: 'chris@aster.example.test',
        phone: null,
        role: null,
        isPrimary: false,
      });
    });
  });

  test('names no contact of another account and no contact of another tenant', async () => {
    const tenant = tenants_().owner;

    await withApp(async (app) => {
      const response = await listContacts(app, tenant, account?.id ?? '');
      const body = response.payload as { items: Array<Record<string, unknown>> };
      const ids = body.items.map((item) => item.id);
      const names = body.items.map((item) => item.name);
      // The contact of a second account in this same tenant is excluded too:
      // tenant isolation alone would have hidden the other tenant's contact.
      expect(ids).not.toContain(sameTenantOtherContact?.id);
      expect(names).not.toContain('Sam Beacon');
      expect(ids).not.toContain(otherContact?.id);
      expect(names).not.toContain('Zoe Other');
    });
  });

  test('answers 404 ACCOUNT_NOT_FOUND before it looks for a contact', async () => {
    const tenant = tenants_().owner;

    await withApp(async (app) => {
      for (const accountId of [
        'not-a-uuid',
        '3f0d4b2a-1c8e-4d5f-9a7b-2c3d4e5f6a7b',
        withdrawnAccount?.id ?? '',
        otherAccount?.id ?? '',
      ]) {
        const response = await listContacts(app, tenant, accountId);
        expect(response.statusCode).toBe(404);
        expect(response.payload).toEqual({ error: { code: 'ACCOUNT_NOT_FOUND' } });
        expect(response.headers['cache-control']).toBe('no-store');
      }
    });
  });

  test('lets a reader read and refuses a role that holds no CRM permission', async () => {
    await withApp(async (app) => {
      const admin = await listContacts(
        app,
        tenants_().admin,
        adminAccount?.id ?? '',
      );
      expect(admin.statusCode).toBe(200);
      expect((admin.payload as { total: number }).total).toBe(1);

      const manager = await listContacts(
        app,
        tenants_().manager,
        managerAccount?.id ?? '',
      );
      expect(manager.statusCode).toBe(200);
      const finance = await listContacts(
        app,
        tenants_().finance,
        financeAccount?.id ?? '',
      );
      expect(finance.statusCode).toBe(200);

      for (const tenant of [
        tenants_().hr,
        tenants_().employee,
        tenants_().auditor,
      ]) {
        const before = await auditRows(tenant.tenantId);
        const response = await listContacts(app, tenant, account?.id ?? '');
        expect(response.statusCode).toBe(403);
        expect(response.payload).toEqual({
          error: { code: 'ROLE_DENIED', permission: 'crm.read' },
        });
        expect(response.headers['cache-control']).toBe('no-store');

        const after = await auditRows(tenant.tenantId);
        expect(after).toHaveLength(before.length + 1);
        expect(after[after.length - 1]?.action).toBe('authorization.denied');
        expect(after[after.length - 1]?.metadata).toMatchObject({
          module: 'crm',
          operation: 'read',
          reason: 'ROLE_DENIED',
        });
      }
    });
  });

  test('refuses an unentitled tenant before the role check', async () => {
    const tenant = tenants_().unentitled;
    const before = await auditRows(tenant.tenantId);

    await withApp(async (app) => {
      const response = await listContacts(app, tenant, account?.id ?? '');
      expect(response.statusCode).toBe(403);
      expect(response.payload).toEqual({
        error: { code: 'MODULE_NOT_ENTITLED', module: 'crm', operation: 'read' },
      });
    });

    const after = await auditRows(tenant.tenantId);
    expect(after).toHaveLength(before.length + 1);
    expect(one(after.slice(-1)).action).toBe('authorization.denied');
    expect(one(after.slice(-1)).metadata).toMatchObject({
      module: 'crm',
      operation: 'read',
      reason: 'MODULE_NOT_ENTITLED',
    });
  });

  test('writes no audit row for a read that succeeded', async () => {
    const tenant = tenants_().owner;
    const before = await auditRows(tenant.tenantId);

    await withApp(async (app) => {
      const response = await listContacts(app, tenant, account?.id ?? '');
      expect(response.statusCode).toBe(200);
    });

    expect(await auditRows(tenant.tenantId)).toHaveLength(before.length);
  });
});

describe('The CRM contact create', () => {
  test('refuses the create route without a session, a CSRF token or the origin', async () => {
    const tenant = tenants_().owner;

    await withApp(async (app) => {
      const noSession = await send(app, {
        method: 'POST',
        url: `/v1/crm/accounts/${account?.id}/contacts`,
        csrf: tenant.session.csrfToken,
        body: { name: 'No Session' },
      });
      expect(noSession.statusCode).toBe(401);
      expect(noSession.payload).toEqual({ error: { code: 'UNAUTHENTICATED' } });

      const noCsrf = await send(app, {
        method: 'POST',
        url: `/v1/crm/accounts/${account?.id}/contacts`,
        cookie: tenant.session.cookie,
        body: { name: 'No Csrf' },
      });
      expect(noCsrf.statusCode).toBe(403);
      expect(noCsrf.payload).toEqual({ error: { code: 'CSRF_INVALID' } });

      const wrongCsrf = await send(app, {
        method: 'POST',
        url: `/v1/crm/accounts/${account?.id}/contacts`,
        cookie: tenant.session.cookie,
        csrf: randomToken(),
        body: { name: 'Wrong Csrf' },
      });
      expect(wrongCsrf.statusCode).toBe(403);
      expect(wrongCsrf.payload).toEqual({ error: { code: 'CSRF_INVALID' } });

      const wrongOrigin = await send(app, {
        method: 'POST',
        url: `/v1/crm/accounts/${account?.id}/contacts`,
        cookie: tenant.session.cookie,
        csrf: tenant.session.csrfToken,
        origin: 'https://evil.example.test',
        body: { name: 'Wrong Origin' },
      });
      expect(wrongOrigin.statusCode).toBe(403);
      expect(wrongOrigin.payload).toEqual({ error: { code: 'ORIGIN_DENIED' } });
    });
  });

  test('creates a contact with only the six fields the surface names', async () => {
    const tenant = tenants_().owner;
    const before = await contactCount(tenant.tenantId);

    await withApp(async (app) => {
      const response = await createContact(app, tenant, account?.id ?? '', {
        name: 'Robin New',
        email: 'robin@aster.example.test',
        phone: '+1-555-0122',
        role: 'Operations',
      });
      expect(response.statusCode).toBe(201);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.payload).toMatchObject({
        name: 'Robin New',
        email: 'robin@aster.example.test',
        phone: '+1-555-0122',
        role: 'Operations',
        isPrimary: false,
      });
      expect(Object.keys(response.payload ?? {}).sort()).toEqual([
        'email',
        'id',
        'isPrimary',
        'name',
        'phone',
        'role',
      ]);
    });

    expect(await contactCount(tenant.tenantId)).toBe(before + 1);
  });

  test('records the field names the caller sent and no value at all', async () => {
    const tenant = tenants_().owner;
    const before = await auditRows(tenant.tenantId);

    await withApp(async (app) => {
      const response = await createContact(app, tenant, account?.id ?? '', {
        name: 'Audited Contact',
        email: 'audited@aster.example.test',
        role: 'Finance',
      });
      expect(response.statusCode).toBe(201);
    });

    const after = await auditRows(tenant.tenantId);
    const created = one(
      after
        .slice(before.length)
        .filter((row) => row.action === 'crm.contact.created'),
    );
    expect(created.entity_type).toBe('crm_contact');
    expect(created.metadata).toEqual({
      fields: ['email', 'name', 'role'],
    });
    const body = JSON.stringify(created.metadata);
    for (const detail of [
      'Audited Contact',
      'audited@aster.example.test',
      'Finance',
    ]) {
      expect(body).not.toContain(detail);
    }
  });

  test('demotes the account’s other primary when a new primary is written', async () => {
    const tenant = tenants_().owner;
    const before = await auditRows(tenant.tenantId);

    await withApp(async (app) => {
      const response = await createContact(app, tenant, account?.id ?? '', {
        name: 'Primary New',
        isPrimary: true,
      });
      expect(response.statusCode).toBe(201);
      expect(response.payload).toMatchObject({ isPrimary: true });
    });

    const rows = await contactRows(tenant.tenantId);
    const primaries = rows.filter((row) => row.isPrimary);
    expect(primaries).toHaveLength(1);
    expect(primaries[0]?.name).toBe('Primary New');
    // The old primary is demoted, not deleted.
    expect(rows.filter((row) => row.id === primaryContact?.id)).toHaveLength(1);
    expect(
      rows.find((row) => row.id === primaryContact?.id)?.isPrimary,
    ).toBe(false);

    const after = await auditRows(tenant.tenantId);
    const written = after.slice(before.length);
    const demotion = one(
      written.filter(
        (row) =>
          row.action === 'crm.contact.updated' &&
          row.entity_id === primaryContact?.id,
      ),
    );
    expect(demotion.metadata).toEqual({ fields: ['isPrimary'] });
    // The demotion is audited in its own right, beside the created contact.
    expect(
      written.filter((row) => row.action === 'crm.contact.created'),
    ).toHaveLength(1);
  });

  test('refuses every body that is not the closed create shape', async () => {
    const tenant = tenants_().owner;
    const before = await contactCount(tenant.tenantId);

    const invalid = [
      {},
      { name: '' },
      { name: '   ' },
      { name: null },
      { name: 42 },
      { name: 'Bad Email', email: 42 },
      { name: 'Bad Phone', phone: 42 },
      { name: 'Bad Role', role: 42 },
      { name: 'Bad Primary', isPrimary: 'yes' },
      { name: 'Null Primary', isPrimary: null },
      { name: 'Extra Key', clientId: 'nope' },
      { name: 'Extra Key', tenantId: 'nope' },
    ];

    await withApp(async (app) => {
      for (const body of invalid) {
        const response = await createContact(app, tenant, account?.id ?? '', body);
        expect(response.statusCode).toBe(400);
        expect(response.payload).toEqual({ error: { code: 'INVALID_BODY' } });
        expect(response.headers['cache-control']).toBe('no-store');
      }
    });

    expect(await contactCount(tenant.tenantId)).toBe(before);
  });

  test('refuses a role that may read but not write', async () => {
    await withApp(async (app) => {
      for (const tenant of [tenants_().manager, tenants_().finance]) {
        const response = await createContact(app, tenant, account?.id ?? '', {
          name: 'Refused Contact',
        });
        expect(response.statusCode).toBe(403);
        expect(response.payload).toEqual({
          error: { code: 'ROLE_DENIED', permission: 'crm.write' },
        });
      }
    });
  });

  test('lets an admin create and amend a contact', async () => {
    const tenant = tenants_().admin;

    await withApp(async (app) => {
      const created = await createContact(app, tenant, adminAccount?.id ?? '', {
        name: 'Admin Contact',
        email: 'admin.contact@example.test',
      });
      expect(created.statusCode).toBe(201);
      const id = (created.payload as { id: string }).id;

      const amended = await patchContact(
        app,
        tenant,
        adminAccount?.id ?? '',
        id,
        { role: 'Owner' },
      );
      expect(amended.statusCode).toBe(200);
      expect(amended.payload).toMatchObject({
        id,
        name: 'Admin Contact',
        role: 'Owner',
      });
    });
  });

  test('refuses hr, employee and auditor on create and update', async () => {
    await withApp(async (app) => {
      for (const tenant of [
        tenants_().hr,
        tenants_().employee,
        tenants_().auditor,
      ]) {
        const created = await createContact(
          app,
          tenant,
          account?.id ?? '',
          { name: 'Refused Contact' },
        );
        expect(created.statusCode).toBe(403);
        expect(created.payload).toEqual({
          error: { code: 'ROLE_DENIED', permission: 'crm.write' },
        });

        const amended = await patchContact(
          app,
          tenant,
          account?.id ?? '',
          secondContact?.id ?? '',
          { role: 'Refused' },
        );
        expect(amended.statusCode).toBe(403);
        expect(amended.payload).toEqual({
          error: { code: 'ROLE_DENIED', permission: 'crm.write' },
        });
      }
    });
  });

  test('refuses an unentitled tenant before the role check', async () => {
    const tenant = tenants_().unentitled;

    await withApp(async (app) => {
      const response = await createContact(app, tenant, account?.id ?? '', {
        name: 'Refused Contact',
      });
      expect(response.statusCode).toBe(403);
      expect(response.payload).toEqual({
        error: { code: 'MODULE_NOT_ENTITLED', module: 'crm', operation: 'write' },
      });
    });
  });

  test('answers 404 ACCOUNT_NOT_FOUND for an account this tenant cannot see', async () => {
    const tenant = tenants_().owner;

    await withApp(async (app) => {
      for (const accountId of [
        'not-a-uuid',
        '3f0d4b2a-1c8e-4d5f-9a7b-2c3d4e5f6a7b',
        withdrawnAccount?.id ?? '',
        otherAccount?.id ?? '',
      ]) {
        const response = await createContact(app, tenant, accountId, {
          name: 'Refused Contact',
        });
        expect(response.statusCode).toBe(404);
        expect(response.payload).toEqual({ error: { code: 'ACCOUNT_NOT_FOUND' } });
      }
    });
  });
});

describe('The CRM contact update', () => {
  test('rejects the update route without a session, a CSRF token or the origin', async () => {
    const tenant = tenants_().owner;
    const contactId = secondContact?.id ?? '';
    const url = `/v1/crm/accounts/${account?.id}/contacts/${contactId}`;

    await withApp(async (app) => {
      const noSession = await send(app, {
        method: 'PATCH',
        url,
        csrf: tenant.session.csrfToken,
        body: { role: 'Changed' },
      });
      expect(noSession.statusCode).toBe(401);
      expect(noSession.payload).toEqual({ error: { code: 'UNAUTHENTICATED' } });

      const noCsrf = await send(app, {
        method: 'PATCH',
        url,
        cookie: tenant.session.cookie,
        body: { role: 'Changed' },
      });
      expect(noCsrf.statusCode).toBe(403);
      expect(noCsrf.payload).toEqual({ error: { code: 'CSRF_INVALID' } });

      const wrongCsrf = await send(app, {
        method: 'PATCH',
        url,
        cookie: tenant.session.cookie,
        csrf: randomToken(),
        body: { role: 'Changed' },
      });
      expect(wrongCsrf.statusCode).toBe(403);
      expect(wrongCsrf.payload).toEqual({ error: { code: 'CSRF_INVALID' } });

      const wrongOrigin = await send(app, {
        method: 'PATCH',
        url,
        cookie: tenant.session.cookie,
        csrf: tenant.session.csrfToken,
        origin: 'https://evil.example.test',
        body: { role: 'Changed' },
      });
      expect(wrongOrigin.statusCode).toBe(403);
      expect(wrongOrigin.payload).toEqual({ error: { code: 'ORIGIN_DENIED' } });
    });
  });

  test('amends one value and leaves every other column where it was', async () => {
    const tenant = tenants_().owner;

    await withApp(async (app) => {
      const response = await patchContact(
        app,
        tenant,
        account?.id ?? '',
        secondContact?.id ?? '',
        { role: 'Procurement' },
      );
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.payload).toMatchObject({
        id: secondContact?.id,
        name: 'Chris Contact',
        email: 'chris@aster.example.test',
        phone: null,
        role: 'Procurement',
        isPrimary: false,
      });
    });
  });

  test('closes and reopens the three nullable columns', async () => {
    const tenant = tenants_().owner;

    await withApp(async (app) => {
      const cleared = await patchContact(
        app,
        tenant,
        account?.id ?? '',
        secondContact?.id ?? '',
        { email: null, phone: null, role: null },
      );
      expect(cleared.statusCode).toBe(200);
      expect(cleared.payload).toMatchObject({
        email: null,
        phone: null,
        role: null,
      });

      const restored = await patchContact(
        app,
        tenant,
        account?.id ?? '',
        secondContact?.id ?? '',
        {
          email: 'chris@aster.example.test',
          phone: '+1-555-0123',
          role: 'Procurement',
        },
      );
      expect(restored.statusCode).toBe(200);
      expect(restored.payload).toMatchObject({
        email: 'chris@aster.example.test',
        phone: '+1-555-0123',
        role: 'Procurement',
      });
    });
  });

  test('refuses null for the two values a row always holds', async () => {
    const tenant = tenants_().owner;

    await withApp(async (app) => {
      for (const body of [{ name: null }, { isPrimary: null }]) {
        const response = await patchContact(
          app,
          tenant,
          account?.id ?? '',
          secondContact?.id ?? '',
          body,
        );
        expect(response.statusCode).toBe(400);
        expect(response.payload).toEqual({ error: { code: 'INVALID_BODY' } });
      }
    });
  });

  test('refuses a patch that names no field or a field the route does not write', async () => {
    const tenant = tenants_().owner;

    await withApp(async (app) => {
      const empty = await patchContact(
        app,
        tenant,
        account?.id ?? '',
        secondContact?.id ?? '',
        {},
      );
      expect(empty.statusCode).toBe(400);
      expect(empty.payload).toEqual({ error: { code: 'INVALID_BODY' } });

      const extra = await patchContact(
        app,
        tenant,
        account?.id ?? '',
        secondContact?.id ?? '',
        { clientId: 'nope' },
      );
      expect(extra.statusCode).toBe(400);
      expect(extra.payload).toEqual({ error: { code: 'INVALID_BODY' } });
    });
  });

  test('treats a change-free patch as a no-op with no write and no audit', async () => {
    const tenant = tenants_().owner;
    const before = await auditRows(tenant.tenantId);
    const beforeRow = one(
      (await contactRows(tenant.tenantId)).filter(
        (row) => row.id === secondContact?.id,
      ),
    );

    await withApp(async (app) => {
      const response = await patchContact(
        app,
        tenant,
        account?.id ?? '',
        secondContact?.id ?? '',
        {
          name: beforeRow.name,
          email: beforeRow.email,
          phone: beforeRow.phone,
          role: beforeRow.role,
          isPrimary: beforeRow.isPrimary,
        },
      );
      expect(response.statusCode).toBe(200);
      expect(response.payload).toMatchObject({ id: secondContact?.id });
    });

    const after = await auditRows(tenant.tenantId);
    expect(after).toHaveLength(before.length);
    expect(
      one(
        (await contactRows(tenant.tenantId)).filter(
          (row) => row.id === secondContact?.id,
        ),
      ),
    ).toEqual(beforeRow);
  });

  test('audits the changed field names only and never a value', async () => {
    const tenant = tenants_().owner;
    const before = await auditRows(tenant.tenantId);

    await withApp(async (app) => {
      const response = await patchContact(
        app,
        tenant,
        account?.id ?? '',
        secondContact?.id ?? '',
        { name: 'Chris Renamed', role: 'Renewed' },
      );
      expect(response.statusCode).toBe(200);
    });

    const after = await auditRows(tenant.tenantId);
    const updated = one(
      after
        .slice(before.length)
        .filter(
          (row) =>
            row.action === 'crm.contact.updated' &&
            row.entity_id === secondContact?.id,
        ),
    );
    expect(updated.entity_type).toBe('crm_contact');
    expect(updated.metadata).toEqual({ fields: ['name', 'role'] });
    const body = JSON.stringify(updated.metadata);
    expect(body).not.toContain('Chris Renamed');
    expect(body).not.toContain('Renewed');
  });

  test('makes the contact primary and demotes the account’s other primary', async () => {
    const tenant = tenants_().owner;

    await withApp(async (app) => {
      const response = await patchContact(
        app,
        tenant,
        account?.id ?? '',
        secondContact?.id ?? '',
        { isPrimary: true },
      );
      expect(response.statusCode).toBe(200);
      expect(response.payload).toMatchObject({ isPrimary: true });
    });

    const rows = await contactRows(tenant.tenantId);
    const primaries = rows.filter((row) => row.isPrimary);
    expect(primaries).toHaveLength(1);
    expect(primaries[0]?.id).toBe(secondContact?.id);

    const audited = await auditRows(tenant.tenantId);
    const demotion = one(
      audited.filter(
        (row) =>
          row.action === 'crm.contact.updated' &&
          row.entity_id !== secondContact?.id &&
          row.metadata && (row.metadata as { fields?: string[] }).fields?.includes('isPrimary'),
      ),
    );
    expect(demotion.metadata).toEqual({ fields: ['isPrimary'] });
  });

  test('answers 404 CONTACT_NOT_FOUND for every way a contact can fail', async () => {
    const tenant = tenants_().owner;

    await withApp(async (app) => {
      // A contact of another account in the same tenant gets the same answer
      // as a contact of another tenant: the account in the path decides, and
      // the reply names neither.
      for (const contactId of [
        'not-a-uuid',
        '3f0d4b2a-1c8e-4d5f-9a7b-2c3d4e5f6a7b',
        sameTenantOtherContact?.id ?? '',
        otherContact?.id ?? '',
      ]) {
        const response = await patchContact(
          app,
          tenant,
          account?.id ?? '',
          contactId,
          { role: 'Refused' },
        );
        expect(response.statusCode).toBe(404);
        expect(response.payload).toEqual({ error: { code: 'CONTACT_NOT_FOUND' } });
        expect(response.headers['cache-control']).toBe('no-store');
      }
    });
  });

  test('answers 404 ACCOUNT_NOT_FOUND before it looks for the contact', async () => {
    const tenant = tenants_().owner;

    await withApp(async (app) => {
      for (const accountId of [
        'not-a-uuid',
        withdrawnAccount?.id ?? '',
        otherAccount?.id ?? '',
      ]) {
        const response = await patchContact(
          app,
          tenant,
          accountId,
          secondContact?.id ?? '',
          { role: 'Refused' },
        );
        expect(response.statusCode).toBe(404);
        expect(response.payload).toEqual({ error: { code: 'ACCOUNT_NOT_FOUND' } });
      }
    });
  });

  test('has no delete route, and no delete path at all', async () => {
    const tenant = tenants_().owner;
    const before = await contactCount(tenant.tenantId);

    await withApp(async (app) => {
      for (const url of [
        `/v1/crm/accounts/${account?.id}/contacts/${secondContact?.id}`,
        `/v1/crm/accounts/${account?.id}/contacts`,
      ]) {
        const response = await send(app, {
          method: 'DELETE',
          url,
          cookie: tenant.session.cookie,
          csrf: tenant.session.csrfToken,
        });
        // Fastify's own route-not-found answer: there is no delete route to
        // decide.
        expect(response.statusCode).toBe(404);
        expect(response.body).not.toContain('CONTACT_NOT_FOUND');
        expect(response.payload?.error).toBe('Not Found');
      }
    });

    expect(await contactCount(tenant.tenantId)).toBe(before);
  });
});

describe('The CRM contact write in the database', () => {
  test('fails closed with a sanitized 500 when the audit write fails', async () => {
    const tenant = tenants_().owner;
    const before = await contactCount(tenant.tenantId);
    const beforeAudit = await auditRows(tenant.tenantId);

    await withOwner(async (client) => {
      await client.query('revoke insert on table public.audit_event from saas_runtime');
    });
    try {
      await withApp(async (app) => {
        const response = await createContact(app, tenant, account?.id ?? '', {
          name: 'Never Stored',
        });
        expect(response.statusCode).toBe(500);
        expect(response.payload).toEqual({ error: { code: 'INTERNAL_ERROR' } });
        expect(response.headers['cache-control']).toBe('no-store');
        for (const detail of [
          'permission denied',
          'audit_event',
          'insert into',
          'saas_runtime',
          'contact',
          'PostgreSQL',
          'Never Stored',
        ]) {
          expect(response.body.toLowerCase()).not.toContain(detail.toLowerCase());
        }
      });
    } finally {
      await withOwner(async (client) => {
        await client.query('grant insert on table public.audit_event to saas_runtime');
      });
    }

    // The transaction rolled back with its audit row: the contact never
    // survived, and the trail kept no record of the attempt.
    expect(await contactCount(tenant.tenantId)).toBe(before);
    expect(await auditRows(tenant.tenantId)).toHaveLength(beforeAudit.length);
  });

  test('settles two concurrent primary creates as one write and one typed conflict', async () => {
    const tenant = tenants_().owner;

    let freshAccountId = '';
    await withApp(async (app) => {
      const createdAccount = await send(app, {
        method: 'POST',
        url: '/v1/crm/accounts',
        cookie: tenant.session.cookie,
        csrf: tenant.session.csrfToken,
        body: { name: 'Concurrent Account', currency: 'ZZZ' },
      });
      expect(createdAccount.statusCode).toBe(201);
      freshAccountId = (createdAccount.payload as { id: string }).id;

      // Both writes are stopped inside their own transaction before either
      // has inserted: first at the demotion, then at the insert. Neither can
      // demote the other's row, because neither row exists yet when the pair
      // is released together. The partial unique index, not the demotion, is
      // what decides the outcome.
      const tableBarrier = new Client({ connectionString: db().ownerUrl });
      const rowBarrier = new Client({ connectionString: db().ownerUrl });
      await tableBarrier.connect();
      await rowBarrier.connect();
      let tableReleased = false;
      let rowReleased = false;
      let pending: Promise<WriteResponse[]> | undefined;
      try {
        await tableBarrier.query('begin');
        await tableBarrier.query('lock table public.client_contact in share mode');

        await rowBarrier.query('begin');
        await rowBarrier.query(
          'select id from public.client where id = $1 for update',
          [freshAccountId],
        );

        pending = Promise.all([
          createContact(app, tenant, freshAccountId, {
            name: 'Racer One',
            isPrimary: true,
          }),
          createContact(app, tenant, freshAccountId, {
            name: 'Racer Two',
            isPrimary: true,
          }),
        ]);

        await waitForBlockedWrites('demotion', 2);

        // Release the table lock only. Both writes now run their demotion
        // against a table with no primary, then wait inside the insert.
        await tableBarrier.query('commit');
        tableReleased = true;

        await waitForBlockedWrites('insert', 2);

        await rowBarrier.query('commit');
        rowReleased = true;

        const [first, second] = await pending;
        if (!first || !second) {
          throw new Error('Expected two write responses');
        }
        expect([first.statusCode, second.statusCode].sort()).toEqual([201, 409]);

        const conflict = first.statusCode === 409 ? first : second;
        expect(conflict.payload).toEqual({
          error: { code: 'CONTACT_PRIMARY_TAKEN' },
        });
        expect(conflict.headers['cache-control']).toBe('no-store');
        for (const detail of [
          'duplicate key',
          'client_contact',
          '23505',
          'postgres',
          'constraint',
        ]) {
          expect(conflict.body.toLowerCase()).not.toContain(detail);
        }
      } finally {
        if (!tableReleased) {
          try {
            await tableBarrier.query('rollback');
          } catch {
            // The barrier transaction is already gone.
          }
        }
        if (!rowReleased) {
          try {
            await rowBarrier.query('rollback');
          } catch {
            // The barrier transaction is already gone.
          }
        }
        await tableBarrier.end();
        await rowBarrier.end();
        if (pending) {
          await pending.catch(() => undefined);
        }
      }
    });

    const rows = (await contactRows(tenant.tenantId)).filter(
      (row) => row.clientId === freshAccountId,
    );
    // Exactly one write survived, and it is the account's only primary: one
    // 201 and one 409, never two rows and never two primaries.
    expect(rows).toHaveLength(1);
    expect(rows.filter((row) => row.isPrimary)).toHaveLength(1);
  });

  test('rolls back a primary-changing write and its demotion when the audit write fails', async () => {
    const tenant = tenants_().owner;

    const seeded = await withOwner(async (client) => {
      const rollbackAccount = await insertClientRow(client, tenant.tenantId, {
        name: 'Rollback Account',
        code: 'CL-ROLLBACK',
      });
      const rollbackPrimary = await insertContactRow(client, tenant.tenantId, {
        clientId: rollbackAccount.id,
        name: 'Rollback Primary',
        isPrimary: true,
      });
      const rollbackSecond = await insertContactRow(client, tenant.tenantId, {
        clientId: rollbackAccount.id,
        name: 'Rollback Second',
      });
      return { account: rollbackAccount, primary: rollbackPrimary, second: rollbackSecond };
    });

    const beforeCount = await contactCount(tenant.tenantId);
    const beforeAudit = await auditRows(tenant.tenantId);

    await withOwner(async (client) => {
      await client.query('revoke insert on table public.audit_event from saas_runtime');
    });
    try {
      await withApp(async (app) => {
        // Promoting the second contact demotes the primary in the same
        // transaction. The audit insert then fails, so both moves have to
        // roll back together.
        const response = await patchContact(
          app,
          tenant,
          seeded.account.id,
          seeded.second.id,
          { isPrimary: true },
        );
        expect(response.statusCode).toBe(500);
        expect(response.payload).toEqual({ error: { code: 'INTERNAL_ERROR' } });
        expect(response.headers['cache-control']).toBe('no-store');
        for (const detail of [
          'permission denied',
          'audit_event',
          'insert into',
          'saas_runtime',
          'postgresql',
          'is_primary',
        ]) {
          expect(response.body.toLowerCase()).not.toContain(detail.toLowerCase());
        }
      });
    } finally {
      await withOwner(async (client) => {
        await client.query('grant insert on table public.audit_event to saas_runtime');
      });
    }

    expect(await contactCount(tenant.tenantId)).toBe(beforeCount);
    const rows = (await contactRows(tenant.tenantId)).filter(
      (row) => row.clientId === seeded.account.id,
    );
    // Neither the promotion nor the demotion survived the failed audit.
    expect(rows.find((row) => row.id === seeded.primary.id)?.isPrimary).toBe(true);
    expect(rows.find((row) => row.id === seeded.second.id)?.isPrimary).toBe(false);
    expect(await auditRows(tenant.tenantId)).toHaveLength(beforeAudit.length);
  });

  test('refuses the runtime role a delete on a contact row', async () => {
    const runtimeDelete = new Client({
      connectionString: db().runtimeUrl,
    });
    await runtimeDelete.connect();
    try {
      let runtimeError: { code?: string } | null = null;
      try {
        await runtimeDelete.query(
          'delete from client_contact where id = $1',
          [secondContact?.id],
        );
      } catch (caught) {
        runtimeError = caught as { code?: string };
      }
      expect(runtimeError?.code).toBe('42501');
    } finally {
      await runtimeDelete.end();
    }
  });

  test('keeps the table on tenant isolation alone, with no module policy', async () => {
    const policies = await withOwner(async (client) => {
      const result = await client.query<{ policyname: string; cmd: string }>(
        `select policyname, cmd
           from pg_policies
          where schemaname = 'public'
            and tablename = 'client_contact'`,
      );
      return result.rows;
    });

    // A module policy here would break a standalone Work or Money read, so
    // the module gate on the route is the only thing that keeps an unlicensed
    // module from naming a contact.
    expect(policies.map((policy) => policy.policyname).sort()).toEqual([
      'tenant_isolation',
    ]);
    expect(policies[0]?.cmd).toBe('ALL');
  });

  test('keeps every contact on the account it was written for', async () => {
    const grouped = await withOwner(async (client) => {
      const result = await client.query<{ client_id: string; count: string }>(
        `select client_id, count(*) as count
           from client_contact
          where tenant_id = $1
          group by client_id`,
        [tenants_().owner.tenantId],
      );
      return result.rows;
    });

    const byAccount = new Map(
      grouped.map((row) => [row.client_id, Number(row.count)]),
    );

    // The second account's contact stayed on the second account: a write
    // through the first account can never move it.
    expect(byAccount.get(secondAccount?.id ?? '')).toBe(1);
    expect(
      (await contactRows(tenants_().owner.tenantId))
        .filter((row) => row.clientId === secondAccount?.id)
        .map((row) => row.id),
    ).toEqual([sameTenantOtherContact?.id]);

    // The first account kept its own contacts, so the two groups are distinct.
    expect(byAccount.get(account?.id ?? '')).toBeGreaterThan(1);
  });
});
