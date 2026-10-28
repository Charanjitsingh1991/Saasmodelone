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
  insertLeadRow,
  provisionModuleTenant,
  type ClientRowFixture,
  type ContactRowFixture,
  type LeadRowFixture,
  type ModuleTenantFixture,
} from './support/module-fixtures.js';

const appOrigin = 'https://app.example.test';
const USER_AGENT = 'CRM lead test/1.0';

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

type CrmLeadTenants = {
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
let tenants: CrmLeadTenants | undefined;

let asterLead: LeadRowFixture | undefined;
let convertedAccount: ClientRowFixture | undefined;
let convertedContact: ContactRowFixture | undefined;
let otherAccount: ClientRowFixture | undefined;
let otherContact: ContactRowFixture | undefined;

function db(): TestDatabase {
  if (!database) {
    throw new Error('Test database has not been created');
  }
  return database;
}

function tenants_(): CrmLeadTenants {
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

async function withRuntime<T>(
  tenantId: string | null,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString: db().runtimeUrl });
  await client.connect();
  try {
    await client.query('begin');
    if (tenantId) {
      await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
    }
    try {
      return await fn(client);
    } finally {
      await client.query('rollback').catch(() => undefined);
    }
  } finally {
    await client.end();
  }
}

type PgError = { code?: string; message: string };

async function denied(
  tenantId: string | null,
  sql: string,
  params: unknown[] = [],
): Promise<PgError> {
  return withRuntime(tenantId, async (client) => {
    let error: PgError | undefined;
    try {
      await client.query(sql, params);
    } catch (caught) {
      error = caught as PgError;
    }
    if (!error) {
      throw new Error(`Expected the statement to be denied: ${sql}`);
    }
    return error;
  });
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

async function leadCount(tenantId: string): Promise<number> {
  return withOwner(async (client) => {
    const result = await client.query<{ total: string }>(
      'select count(*) as total from crm_lead where tenant_id = $1',
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

function listLeads(
  app: TestServer,
  tenant: ModuleTenantFixture,
  query = '',
  overrides: Partial<SendOptions> = {},
): Promise<WriteResponse> {
  return send(app, {
    method: 'GET',
    url: `/v1/crm/leads${query}`,
    cookie: tenant.session.cookie,
    ...overrides,
  });
}

function createLead(
  app: TestServer,
  tenant: ModuleTenantFixture,
  body: unknown,
  overrides: Partial<SendOptions> = {},
): Promise<WriteResponse> {
  return send(app, {
    method: 'POST',
    url: '/v1/crm/leads',
    cookie: tenant.session.cookie,
    csrf: tenant.session.csrfToken,
    body,
    ...overrides,
  });
}

type LeadListBody = {
  items: Array<{ id: string; name: string; stage: string }>;
  total: number;
  page: number;
  pageSize: number;
};

// The stored order is stage, then the lowered name, then the id. Six stages'
// worth of fixtures means the open-stage names, the converted row and the
// disqualified row all have a fixed place, so the order assertion is exact.
const STORED_ORDER = [
  'Beacon Prospect',
  'Won Deal',
  'Dormant Deal',
  'Aster Lead',
  'Paging One',
  'Paging Three',
  'Paging Two',
  'Zephyr Deal',
];

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
      label: 'crmleadsowner',
      modules: ['crm'],
    }),
    provisionModuleTenant(db().ownerUrl, {
      label: 'crmleadsadmin',
      modules: ['crm'],
      role: 'admin',
    }),
    provisionModuleTenant(db().ownerUrl, {
      label: 'crmleadsmanager',
      modules: ['crm'],
      role: 'manager',
    }),
    provisionModuleTenant(db().ownerUrl, {
      label: 'crmleadsfinance',
      modules: ['crm'],
      role: 'finance',
    }),
    provisionModuleTenant(db().ownerUrl, {
      label: 'crmleadshr',
      modules: ['crm'],
      role: 'hr',
    }),
    provisionModuleTenant(db().ownerUrl, {
      label: 'crmleadsemployee',
      modules: ['crm'],
      role: 'employee',
    }),
    provisionModuleTenant(db().ownerUrl, {
      label: 'crmleadsauditor',
      modules: ['crm'],
      role: 'auditor',
    }),
    // No CRM entitlement at all.
    provisionModuleTenant(db().ownerUrl, {
      label: 'crmleadsunentitled',
      modules: ['people'],
    }),
    provisionModuleTenant(db().ownerUrl, {
      label: 'crmleadsother',
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
    asterLead = await insertLeadRow(client, ownerTenant.tenantId, {
      name: 'Aster Lead',
      company: 'Aster Logistics',
      email: 'aster.lead@example.test',
      phone: '+1-555-0201',
      source: 'website',
      stage: 'new',
    });
    await insertLeadRow(client, ownerTenant.tenantId, {
      name: 'Beacon Prospect',
      company: 'Beacon Supplies',
      email: 'beacon@example.test',
      stage: 'contacted',
    });
    await insertLeadRow(client, ownerTenant.tenantId, {
      name: 'Zephyr Deal',
      stage: 'qualified',
    });
    await insertLeadRow(client, ownerTenant.tenantId, {
      name: 'Dormant Deal',
      stage: 'disqualified',
    });

    // A converted lead points at a real account and its primary contact, so
    // the composite foreign key and the terminality check are both satisfied.
    convertedAccount = await insertClientRow(client, ownerTenant.tenantId, {
      name: 'Won Co',
      code: 'CL-WON',
    });
    convertedContact = await insertContactRow(client, ownerTenant.tenantId, {
      clientId: convertedAccount.id,
      name: 'Won Contact',
      email: 'won@example.test',
      isPrimary: true,
    });
    await insertLeadRow(client, ownerTenant.tenantId, {
      name: 'Won Deal',
      company: 'Won Co',
      stage: 'converted',
      convertedAccountId: convertedAccount.id,
      convertedContactId: convertedContact.id,
      convertedAt: '2026-02-01',
    });

    for (const name of ['Paging One', 'Paging Two', 'Paging Three']) {
      await insertLeadRow(client, ownerTenant.tenantId, { name, stage: 'new' });
    }

    otherAccount = await insertClientRow(client, otherTenant.tenantId, {
      name: 'Other Co',
      code: 'CL-OTHER',
    });
    otherContact = await insertContactRow(client, otherTenant.tenantId, {
      clientId: otherAccount.id,
      name: 'Other Contact',
      isPrimary: true,
    });
    await insertLeadRow(client, otherTenant.tenantId, {
      name: 'Other Lead',
      company: 'Other Co',
      stage: 'new',
    });
  });
});

afterAll(async () => {
  await owner?.end();
  await auth?.end();
  await runtime?.end();
  await database?.drop();
});

describe('The CRM lead read', () => {
  test('refuses a request without a session', async () => {
    await withApp(async (app) => {
      const response = await send(app, { method: 'GET', url: '/v1/crm/leads' });
      expect(response.statusCode).toBe(401);
      expect(response.payload).toEqual({ error: { code: 'UNAUTHENTICATED' } });
    });
  });

  test('lists the leads of a CRM-only workspace in the stored order', async () => {
    const tenant = tenants_().owner;

    await withApp(async (app) => {
      const response = await listLeads(app, tenant);
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');

      const body = response.payload as LeadListBody;
      expect(body.total).toBe(8);
      expect(body.page).toBe(1);
      expect(body.pageSize).toBe(20);
      expect(body.items.map((item) => item.name)).toEqual(STORED_ORDER);

      const converted = body.items.find((item) => item.name === 'Won Deal');
      expect(converted).toMatchObject({
        stage: 'converted',
        convertedAccountId: convertedAccount?.id,
        convertedContactId: convertedContact?.id,
      });

      expect(Object.keys(one(body.items)).sort()).toEqual([
        'company',
        'convertedAccountId',
        'convertedContactId',
        'email',
        'id',
        'name',
        'phone',
        'source',
        'stage',
      ]);
    });
  });

  test('searches name, company and email as a literal substring', async () => {
    const tenant = tenants_().owner;

    await withApp(async (app) => {
      const byName = await listLeads(app, tenant, '?q=aster');
      expect((byName.payload as LeadListBody).items.map((item) => item.name)).toEqual([
        'Aster Lead',
      ]);

      const byCompany = await listLeads(app, tenant, '?q=beacon%20sup');
      expect((byCompany.payload as LeadListBody).items.map((item) => item.name)).toEqual([
        'Beacon Prospect',
      ]);

      const byEmail = await listLeads(app, tenant, '?q=aster.lead');
      expect((byEmail.payload as LeadListBody).items.map((item) => item.name)).toEqual([
        'Aster Lead',
      ]);

      // A percent sign and an underscore are text, not wildcards.
      const wildcard = await listLeads(app, tenant, '?q=%25');
      expect((wildcard.payload as LeadListBody).total).toBe(0);
      const underscore = await listLeads(app, tenant, '?q=_');
      expect((underscore.payload as LeadListBody).total).toBe(0);

      const missing = await listLeads(app, tenant, '?q=zzzz');
      expect((missing.payload as LeadListBody).total).toBe(0);
    });
  });

  test('filters by one stored stage and refuses anything else', async () => {
    const tenant = tenants_().owner;

    await withApp(async (app) => {
      const open = await listLeads(app, tenant, '?stage=new');
      expect((open.payload as LeadListBody).items.map((item) => item.name)).toEqual([
        'Aster Lead',
        'Paging One',
        'Paging Three',
        'Paging Two',
      ]);

      const converted = await listLeads(app, tenant, '?stage=converted');
      expect((converted.payload as LeadListBody).items.map((item) => item.name)).toEqual([
        'Won Deal',
      ]);
      const convertedItem = one((converted.payload as LeadListBody).items) as unknown as {
        stage: string;
        convertedAccountId: string | null;
        convertedContactId: string | null;
      };
      expect(convertedItem.stage).toBe('converted');
      expect(convertedItem.convertedAccountId).toBe(convertedAccount?.id);
      expect(convertedItem.convertedContactId).toBe(convertedContact?.id);

      for (const query of [
        '?stage=won',
        '?stage=NEW',
        '?stage=new&stage=new',
        '?stage=',
      ]) {
        const response = await listLeads(app, tenant, query);
        expect(response.statusCode).toBe(400);
        expect(response.payload).toEqual({ error: { code: 'INVALID_QUERY' } });
      }
    });
  });

  test('pages the same ordered list, and refuses a malformed page', async () => {
    const tenant = tenants_().owner;

    await withApp(async (app) => {
      const first = await listLeads(app, tenant, '?pageSize=3&page=1');
      expect((first.payload as LeadListBody).items.map((item) => item.name)).toEqual([
        'Beacon Prospect',
        'Won Deal',
        'Dormant Deal',
      ]);
      expect((first.payload as LeadListBody).total).toBe(8);

      const second = await listLeads(app, tenant, '?pageSize=3&page=2');
      expect((second.payload as LeadListBody).items.map((item) => item.name)).toEqual([
        'Aster Lead',
        'Paging One',
        'Paging Three',
      ]);
      expect((second.payload as LeadListBody).page).toBe(2);
      expect((second.payload as LeadListBody).pageSize).toBe(3);

      const last = await listLeads(app, tenant, '?pageSize=3&page=3');
      expect((last.payload as LeadListBody).items.map((item) => item.name)).toEqual([
        'Paging Two',
        'Zephyr Deal',
      ]);

      for (const query of ['?page=0', '?page=-1', '?page=abc', '?pageSize=51', '?pageSize=0']) {
        const response = await listLeads(app, tenant, query);
        expect(response.statusCode).toBe(400);
        expect(response.payload).toEqual({ error: { code: 'INVALID_QUERY' } });
      }
    });
  });

  test('names no lead of another tenant', async () => {
    await withApp(async (app) => {
      const ownerRead = await listLeads(app, tenants_().owner, '?q=other');
      expect((ownerRead.payload as LeadListBody).total).toBe(0);

      const otherRead = await listLeads(app, tenants_().other);
      expect((otherRead.payload as LeadListBody).total).toBe(1);
      expect((otherRead.payload as LeadListBody).items.map((item) => item.name)).toEqual([
        'Other Lead',
      ]);
    });
  });

  test('lets a reader read and refuses a role that holds no CRM permission', async () => {
    await withApp(async (app) => {
      for (const tenant of [tenants_().admin, tenants_().manager, tenants_().finance]) {
        const response = await listLeads(app, tenant);
        expect(response.statusCode).toBe(200);
        expect((response.payload as LeadListBody).total).toBe(0);
      }

      for (const tenant of [
        tenants_().hr,
        tenants_().employee,
        tenants_().auditor,
      ]) {
        const before = await auditRows(tenant.tenantId);
        const response = await listLeads(app, tenant);
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
      const response = await listLeads(app, tenant);
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
      const response = await listLeads(app, tenant);
      expect(response.statusCode).toBe(200);
    });

    expect(await auditRows(tenant.tenantId)).toHaveLength(before.length);
  });
});

describe('The CRM lead intake', () => {
  test('refuses the create route without a session, a CSRF token or the origin', async () => {
    const tenant = tenants_().owner;

    await withApp(async (app) => {
      const noSession = await send(app, {
        method: 'POST',
        url: '/v1/crm/leads',
        csrf: tenant.session.csrfToken,
        body: { name: 'No Session' },
      });
      expect(noSession.statusCode).toBe(401);
      expect(noSession.payload).toEqual({ error: { code: 'UNAUTHENTICATED' } });

      const noCsrf = await send(app, {
        method: 'POST',
        url: '/v1/crm/leads',
        cookie: tenant.session.cookie,
        body: { name: 'No Csrf' },
      });
      expect(noCsrf.statusCode).toBe(403);
      expect(noCsrf.payload).toEqual({ error: { code: 'CSRF_INVALID' } });

      const wrongCsrf = await send(app, {
        method: 'POST',
        url: '/v1/crm/leads',
        cookie: tenant.session.cookie,
        csrf: randomToken(),
        body: { name: 'Wrong Csrf' },
      });
      expect(wrongCsrf.statusCode).toBe(403);
      expect(wrongCsrf.payload).toEqual({ error: { code: 'CSRF_INVALID' } });

      const wrongOrigin = await send(app, {
        method: 'POST',
        url: '/v1/crm/leads',
        cookie: tenant.session.cookie,
        csrf: tenant.session.csrfToken,
        origin: 'https://evil.example.test',
        body: { name: 'Wrong Origin' },
      });
      expect(wrongOrigin.statusCode).toBe(403);
      expect(wrongOrigin.payload).toEqual({ error: { code: 'ORIGIN_DENIED' } });
    });
  });

  test('creates a lead in the database default stage with only the named fields', async () => {
    const tenant = tenants_().owner;
    const before = await leadCount(tenant.tenantId);

    await withApp(async (app) => {
      const response = await createLead(app, tenant, { name: '  Fresh Lead  ' });
      expect(response.statusCode).toBe(201);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.payload).toMatchObject({
        name: 'Fresh Lead',
        company: null,
        email: null,
        phone: null,
        source: null,
        stage: 'new',
        convertedAccountId: null,
        convertedContactId: null,
      });
      expect(Object.keys(response.payload ?? {}).sort()).toEqual([
        'company',
        'convertedAccountId',
        'convertedContactId',
        'email',
        'id',
        'name',
        'phone',
        'source',
        'stage',
      ]);
    });

    expect(await leadCount(tenant.tenantId)).toBe(before + 1);
  });

  test('creates a lead in an open stage and keeps every supplied value', async () => {
    const tenant = tenants_().owner;

    await withApp(async (app) => {
      const response = await createLead(app, tenant, {
        name: 'Qualified In',
        company: 'Qualified Co',
        email: 'qualified@example.test',
        phone: '+1-555-0301',
        source: 'referral',
        stage: 'qualified',
      });
      expect(response.statusCode).toBe(201);
      expect(response.payload).toMatchObject({
        name: 'Qualified In',
        company: 'Qualified Co',
        email: 'qualified@example.test',
        phone: '+1-555-0301',
        source: 'referral',
        stage: 'qualified',
      });
    });
  });

  test('refuses a lead born terminal and every body outside the closed shape', async () => {
    const tenant = tenants_().owner;
    const before = await leadCount(tenant.tenantId);

    await withApp(async (app) => {
      for (const body of [
        {},
        { name: '' },
        { name: '   ' },
        { name: 5 },
        { name: 'Typed', company: 5 },
        { name: 'Typed', email: 5 },
        { name: 'Typed', stage: 'converted' },
        { name: 'Typed', stage: 'disqualified' },
        { name: 'Typed', stage: 'won' },
        { name: 'Typed', convertedAccountId: convertedAccount?.id },
        { name: 'Typed', convertedContactId: convertedContact?.id },
        { name: 'Typed', convertedAt: '2026-02-01' },
        { name: 'Typed', tenantId: tenant.tenantId },
        { name: 'Typed', id: '00000000-0000-4000-8000-000000000000' },
        { name: 'Typed', unknown: true },
      ]) {
        const response = await createLead(app, tenant, body);
        expect(response.statusCode).toBe(400);
        expect(response.payload).toEqual({ error: { code: 'INVALID_BODY' } });
      }
    });

    expect(await leadCount(tenant.tenantId)).toBe(before);
  });

  test('records the field names the caller sent and no value at all', async () => {
    const tenant = tenants_().owner;
    const before = await auditRows(tenant.tenantId);

    await withApp(async (app) => {
      const response = await createLead(app, tenant, {
        name: 'Audited Lead',
        company: 'Audited Co',
        email: 'audited@example.test',
        source: 'event',
      });
      expect(response.statusCode).toBe(201);
    });

    const after = await auditRows(tenant.tenantId);
    const created = one(
      after
        .slice(before.length)
        .filter((row) => row.action === 'crm.lead.created'),
    );
    expect(created.entity_type).toBe('crm_lead');
    expect(created.metadata).toEqual({
      fields: ['company', 'email', 'name', 'source'],
    });
    const body = JSON.stringify(created.metadata);
    for (const detail of [
      'Audited Lead',
      'Audited Co',
      'audited@example.test',
      'event',
    ]) {
      expect(body).not.toContain(detail);
    }
  });

  test('lets an admin create and refuses a role that may read but not write', async () => {
    await withApp(async (app) => {
      const admin = await createLead(app, tenants_().admin, { name: 'Admin Lead' });
      expect(admin.statusCode).toBe(201);

      for (const tenant of [
        tenants_().manager,
        tenants_().finance,
        tenants_().hr,
        tenants_().employee,
        tenants_().auditor,
      ]) {
        const before = await auditRows(tenant.tenantId);
        const response = await createLead(app, tenant, { name: 'Denied Lead' });
        expect(response.statusCode).toBe(403);
        expect(response.payload).toEqual({
          error: { code: 'ROLE_DENIED', permission: 'crm.write' },
        });

        const after = await auditRows(tenant.tenantId);
        expect(after).toHaveLength(before.length + 1);
        expect(one(after.slice(-1)).metadata).toMatchObject({
          module: 'crm',
          operation: 'write',
          reason: 'ROLE_DENIED',
          permission: 'crm.write',
        });
      }
    });
  });

  test('settles the write permission before it reads the body', async () => {
    const tenant = tenants_().manager;

    await withApp(async (app) => {
      // A body the parser would refuse is answered with the authorization
      // refusal instead, which proves the gate runs first. The unknown key
      // matters: a body that reached the parser would be INVALID_BODY.
      const response = await createLead(app, tenant, {
        name: '',
        convertedAccountId: convertedAccount?.id,
      });
      expect(response.statusCode).toBe(403);
      expect(response.payload).toEqual({
        error: { code: 'ROLE_DENIED', permission: 'crm.write' },
      });
    });
  });

  test('refuses an unentitled tenant before the role check or the body', async () => {
    const tenant = tenants_().unentitled;
    const before = await auditRows(tenant.tenantId);

    await withApp(async (app) => {
      const response = await createLead(app, tenant, {
        name: '',
        convertedAccountId: convertedAccount?.id,
      });
      expect(response.statusCode).toBe(403);
      expect(response.payload).toEqual({
        error: { code: 'MODULE_NOT_ENTITLED', module: 'crm', operation: 'write' },
      });
    });

    const after = await auditRows(tenant.tenantId);
    expect(after).toHaveLength(before.length + 1);
    expect(one(after.slice(-1)).action).toBe('authorization.denied');
    expect(one(after.slice(-1)).metadata).toMatchObject({
      module: 'crm',
      operation: 'write',
      reason: 'MODULE_NOT_ENTITLED',
    });
  });

  test('keeps a new lead inside the tenant that wrote it', async () => {
    await withApp(async (app) => {
      const response = await createLead(app, tenants_().owner, {
        name: 'Tenant Kept Lead',
      });
      expect(response.statusCode).toBe(201);

      const otherRead = await listLeads(app, tenants_().other, '?q=tenant%20kept');
      expect((otherRead.payload as LeadListBody).total).toBe(0);
    });
  });
});

describe('The CRM lead table in the database', () => {
  test('refuses the runtime role a delete on a lead row', async () => {
    const tenant = tenants_().owner;

    const error = await denied(
      tenant.tenantId,
      'delete from crm_lead where id = $1',
      [asterLead?.id],
    );

    expect(error.code).toBe('42501');
    expect(error.message).toMatch(/permission denied for table crm_lead/);

    const after = await withOwner(async (client) => {
      const result = await client.query('select id from crm_lead where id = $1', [
        asterLead?.id,
      ]);
      return result.rows.length;
    });
    expect(after).toBe(1);
  });

  test('denies an insert in an unentitled workspace at the module policy, not the grant', async () => {
    const tenant = tenants_().unentitled;

    // The runtime holds INSERT on exactly these columns, so a refusal cannot
    // be blamed on a missing privilege: it is crm_write_insert answering false.
    const error = await denied(
      tenant.tenantId,
      `insert into crm_lead (id, tenant_id, name)
       values (gen_random_uuid(), $1, 'Denied lead')`,
      [tenant.tenantId],
    );

    expect(error.code).toBe('42501');
    expect(error.message).toMatch(/row-level security/);
    expect(error.message).not.toMatch(/permission denied for table crm_lead/);
  });

  test('shows an unentitled workspace no lead rows at all', async () => {
    const tenant = tenants_().unentitled;

    // The same columns are selectable, so the empty answer is crm_read.
    const rows = await withRuntime(tenant.tenantId, async (client) => {
      const result = await client.query('select id, name from crm_lead');
      return result.rows.length;
    });
    expect(rows).toBe(0);
  });

  test('refuses the runtime any write to the conversion columns', async () => {
    const tenant = tenants_().owner;

    // The INSERT grant names the eight intake columns only, so no route and no
    // direct runtime statement can create a converted lead: conversion is the
    // route that writes an account and a contact first, then updates the lead.
    const error = await denied(
      tenant.tenantId,
      `insert into crm_lead
         (tenant_id, name, stage, converted_client_id, converted_contact_id,
          converted_at)
       values ($1, 'Runtime converted', 'converted', $2, $3, now())`,
      [tenant.tenantId, convertedAccount?.id, convertedContact?.id],
    );

    expect(error.code).toBe('42501');
    expect(error.message).toMatch(/permission denied for table crm_lead/);
  });

  test('keeps converted and unconverted rows internally consistent', async () => {
    const tenant = tenants_().owner;

    const statements: Array<{ sql: string; params: unknown[] }> = [
      {
        sql: `insert into crm_lead (tenant_id, name, stage)
              values ($1, 'Bare converted', 'converted')`,
        params: [tenant.tenantId],
      },
      {
        sql: `insert into crm_lead
                (tenant_id, name, stage, converted_client_id, converted_contact_id)
              values ($1, 'No instant', 'converted', $2, $3)`,
        params: [tenant.tenantId, convertedAccount?.id, convertedContact?.id],
      },
      {
        sql: `insert into crm_lead
                (tenant_id, name, stage, converted_client_id,
                 converted_contact_id, converted_at)
              values ($1, 'Unconverted but converted', 'new', $2, $3, now())`,
        params: [tenant.tenantId, convertedAccount?.id, convertedContact?.id],
      },
    ];

    // Owner-side, where the grant cannot be the reason: the terminality check
    // is what refuses each combination.
    for (const { sql, params } of statements) {
      const error = await withOwner(async (client) => {
        try {
          await client.query(sql, params);
        } catch (caught) {
          return caught as PgError;
        }
        throw new Error(`Expected the terminality check to refuse: ${sql}`);
      });
      expect(error.code).toBe('23514');
    }
  });

  test('refuses a conversion that points at another tenant', async () => {
    const tenant = tenants_().owner;

    // The runtime holds no INSERT privilege on the three conversion columns,
    // which is itself the tighter rule, so this proof runs owner-side: what it
    // shows is that the composite foreign keys cannot be pointed across
    // tenants even by a writer that bypasses RLS.
    const error = await withOwner(async (client) => {
      try {
        await client.query(
          `insert into crm_lead
             (tenant_id, name, stage, converted_client_id, converted_contact_id,
              converted_at)
           values ($1, 'Cross tenant', 'converted', $2, $3, now())`,
          [tenant.tenantId, otherAccount?.id, otherContact?.id],
        );
      } catch (caught) {
        return caught as PgError;
      }
      throw new Error('Expected the cross-tenant conversion to be refused');
    });

    expect(error.code).toBe('23503');
  });
});
