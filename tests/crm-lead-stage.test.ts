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
  type LeadRowFixture,
  type ModuleTenantFixture,
} from './support/module-fixtures.js';

const appOrigin = 'https://app.example.test';
const USER_AGENT = 'CRM lead stage test/1.0';

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

type StageTenants = {
  owner: ModuleTenantFixture;
  admin: ModuleTenantFixture;
  manager: ModuleTenantFixture;
  unentitled: ModuleTenantFixture;
  other: ModuleTenantFixture;
};

type LeadRow = {
  stage: string;
  name: string;
  company: string | null;
  phone: string | null;
  created_at: Date;
  updated_at: Date;
};

const LEAD_KEYS = [
  'company',
  'convertedAccountId',
  'convertedContactId',
  'email',
  'id',
  'name',
  'phone',
  'source',
  'stage',
];

let database: TestDatabase | undefined;
let runtime: RuntimePool | undefined;
let auth: AuthPool | undefined;
let owner: Pool | undefined;
let tenants: StageTenants | undefined;

let alpha: LeadRowFixture | undefined;
let beta: LeadRowFixture | undefined;
let gamma: LeadRowFixture | undefined;
let converted: LeadRowFixture | undefined;
let disqualified: LeadRowFixture | undefined;
let noop: LeadRowFixture | undefined;
let adminLead: LeadRowFixture | undefined;
let otherLead: LeadRowFixture | undefined;

function db(): TestDatabase {
  if (!database) {
    throw new Error('Test database has not been created');
  }
  return database;
}

function tenants_(): StageTenants {
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

function fixture(lead: LeadRowFixture | undefined, label: string): LeadRowFixture {
  if (!lead) {
    throw new Error(`The ${label} fixture has not been inserted`);
  }
  return lead;
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

async function storedLead(id: string): Promise<LeadRow> {
  return withOwner(async (client) => {
    const result = await client.query<LeadRow>(
      `select stage, name, company, phone, created_at, updated_at
         from crm_lead
        where id = $1`,
      [id],
    );
    return one(result.rows);
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
  method: 'GET' | 'POST' | 'PATCH';
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

function patchLead(
  app: TestServer,
  tenant: ModuleTenantFixture,
  leadId: string | undefined,
  body: unknown,
  overrides: Partial<SendOptions> = {},
): Promise<WriteResponse> {
  return send(app, {
    method: 'PATCH',
    url: `/v1/crm/leads/${leadId ?? 'missing'}`,
    cookie: tenant.session.cookie,
    csrf: tenant.session.csrfToken,
    body,
    ...overrides,
  });
}

type LeadListBody = {
  items: Array<{ id: string; name: string; stage: string }>;
  total: number;
};

function listLeads(
  app: TestServer,
  tenant: ModuleTenantFixture,
  query: string,
): Promise<WriteResponse> {
  return send(app, {
    method: 'GET',
    url: `/v1/crm/leads${query}`,
    cookie: tenant.session.cookie,
  });
}

beforeAll(async () => {
  database = await createTestDatabase({ migrate: true, seed: true });
  runtime = createRuntimePool(database.runtimeUrl);
  auth = createAuthPool(database.authUrl);
  owner = new Pool({ connectionString: database.ownerUrl });

  const [ownerTenant, adminTenant, managerTenant, unentitled, otherTenant] =
    await Promise.all([
      provisionModuleTenant(db().ownerUrl, {
        label: 'crmstageowner',
        modules: ['crm'],
      }),
      provisionModuleTenant(db().ownerUrl, {
        label: 'crmstageadmin',
        modules: ['crm'],
        role: 'admin',
      }),
      provisionModuleTenant(db().ownerUrl, {
        label: 'crmstagemanager',
        modules: ['crm'],
        role: 'manager',
      }),
      provisionModuleTenant(db().ownerUrl, {
        label: 'crmstageunentitled',
        modules: ['people'],
      }),
      provisionModuleTenant(db().ownerUrl, {
        label: 'crmstageother',
        modules: ['crm'],
      }),
    ]);

  tenants = {
    owner: ownerTenant,
    admin: adminTenant,
    manager: managerTenant,
    unentitled,
    other: otherTenant,
  };

  await withOwner(async (client) => {
    alpha = await insertLeadRow(client, ownerTenant.tenantId, {
      name: 'Stage Alpha',
      email: 'alpha@example.test',
      stage: 'new',
    });
    beta = await insertLeadRow(client, ownerTenant.tenantId, {
      name: 'Stage Beta',
      company: 'Beta Holdings',
      phone: '+1-555-0401',
      stage: 'new',
    });
    gamma = await insertLeadRow(client, ownerTenant.tenantId, {
      name: 'Stage Gamma',
      stage: 'qualified',
    });
    noop = await insertLeadRow(client, ownerTenant.tenantId, {
      name: 'Stage Noop',
      company: 'Noop Trading',
      stage: 'new',
    });

    // A converted and a disqualified row, each pointing at real records where
    // the table demands it, so the terminal rules are tested over rows that
    // satisfy the table's own check.
    const account = await insertClientRow(client, ownerTenant.tenantId, {
      name: 'Stage Won Co',
      code: 'CL-STAGE',
    });
    const contact = await insertContactRow(client, ownerTenant.tenantId, {
      clientId: account.id,
      name: 'Stage Won Contact',
      isPrimary: true,
    });
    converted = await insertLeadRow(client, ownerTenant.tenantId, {
      name: 'Stage Converted',
      stage: 'converted',
      convertedAccountId: account.id,
      convertedContactId: contact.id,
      convertedAt: '2026-03-01',
    });
    disqualified = await insertLeadRow(client, ownerTenant.tenantId, {
      name: 'Stage Disqualified',
      stage: 'disqualified',
    });

    // The admin writes a lead of its own workspace: no member writes another
    // tenant's row, so a cross-tenant write would prove authorization rather
    // than the write path.
    adminLead = await insertLeadRow(client, adminTenant.tenantId, {
      name: 'Admin Stage Lead',
      stage: 'new',
    });

    otherLead = await insertLeadRow(client, otherTenant.tenantId, {
      name: 'Other Stage Lead',
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

describe('The CRM lead stage route', () => {
  test('refuses the route without a session, a CSRF token or the origin', async () => {
    const tenant = tenants_().owner;
    const lead = fixture(alpha, 'alpha');

    await withApp(async (app) => {
      const noSession = await send(app, {
        method: 'PATCH',
        url: `/v1/crm/leads/${lead.id}`,
        csrf: tenant.session.csrfToken,
        body: { stage: 'contacted' },
      });
      expect(noSession.statusCode).toBe(401);
      expect(noSession.payload).toEqual({ error: { code: 'UNAUTHENTICATED' } });

      const noCsrf = await send(app, {
        method: 'PATCH',
        url: `/v1/crm/leads/${lead.id}`,
        cookie: tenant.session.cookie,
        body: { stage: 'contacted' },
      });
      expect(noCsrf.statusCode).toBe(403);
      expect(noCsrf.payload).toEqual({ error: { code: 'CSRF_INVALID' } });

      const wrongCsrf = await send(app, {
        method: 'PATCH',
        url: `/v1/crm/leads/${lead.id}`,
        cookie: tenant.session.cookie,
        csrf: randomToken(),
        body: { stage: 'contacted' },
      });
      expect(wrongCsrf.statusCode).toBe(403);
      expect(wrongCsrf.payload).toEqual({ error: { code: 'CSRF_INVALID' } });

      const wrongOrigin = await send(app, {
        method: 'PATCH',
        url: `/v1/crm/leads/${lead.id}`,
        cookie: tenant.session.cookie,
        csrf: tenant.session.csrfToken,
        origin: 'https://evil.example.test',
        body: { stage: 'contacted' },
      });
      expect(wrongOrigin.statusCode).toBe(403);
      expect(wrongOrigin.payload).toEqual({ error: { code: 'ORIGIN_DENIED' } });

      const stored = await storedLead(lead.id);
      expect(stored.stage).toBe('new');
    });
  });

  test('moves an open lead and records the field names only', async () => {
    const tenant = tenants_().owner;
    const lead = fixture(alpha, 'alpha');
    const before = await auditRows(tenant.tenantId);
    const original = await storedLead(lead.id);

    await withApp(async (app) => {
      const response = await patchLead(app, tenant, lead.id, {
        stage: 'contacted',
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.payload).toMatchObject({
        id: lead.id,
        name: 'Stage Alpha',
        email: 'alpha@example.test',
        stage: 'contacted',
        convertedAccountId: null,
        convertedContactId: null,
      });
      expect(Object.keys(response.payload ?? {}).sort()).toEqual(LEAD_KEYS);
    });

    const after = await auditRows(tenant.tenantId);
    expect(after).toHaveLength(before.length + 1);
    const updated = one(after.slice(-1));
    expect(updated.action).toBe('crm.lead.updated');
    expect(updated.entity_type).toBe('crm_lead');
    expect(updated.entity_id).toBe(lead.id);
    expect(updated.metadata).toEqual({ fields: ['stage'] });

    const stored = await storedLead(lead.id);
    expect(stored.stage).toBe('contacted');
    // The updated_at trigger fired: the write is datable to its own
    // transaction rather than to the row's creation.
    expect(stored.updated_at.getTime()).toBeGreaterThan(
      original.updated_at.getTime(),
    );
  });

  test('writes an optional field, then clears it, and audits each change', async () => {
    const tenant = tenants_().owner;
    const lead = fixture(beta, 'beta');
    const before = await auditRows(tenant.tenantId);

    await withApp(async (app) => {
      const written = await patchLead(app, tenant, lead.id, {
        company: '  Vantage Co  ',
        phone: '+1-555-0499',
      });
      expect(written.statusCode).toBe(200);
      expect(written.payload).toMatchObject({
        company: 'Vantage Co',
        phone: '+1-555-0499',
        stage: 'new',
      });

      const cleared = await patchLead(app, tenant, lead.id, { company: '' });
      expect(cleared.statusCode).toBe(200);
      expect(cleared.payload).toMatchObject({
        company: null,
        phone: '+1-555-0499',
        stage: 'new',
      });

      const nulled = await patchLead(app, tenant, lead.id, { phone: null });
      expect(nulled.statusCode).toBe(200);
      expect(nulled.payload).toMatchObject({ company: null, phone: null });
    });

    const rows = await auditRows(tenant.tenantId);
    expect(
      rows
        .slice(before.length)
        .filter((row) => row.action === 'crm.lead.updated')
        .map((row) => row.metadata),
    ).toEqual([
      { fields: ['company', 'phone'] },
      { fields: ['company'] },
      { fields: ['phone'] },
    ]);

    const stored = await storedLead(lead.id);
    expect(stored.company).toBeNull();
    expect(stored.phone).toBeNull();
  });

  test('answers a true no-op with the stored row and writes nothing', async () => {
    const tenant = tenants_().owner;
    const lead = fixture(noop, 'noop');
    const before = await auditRows(tenant.tenantId);
    const original = await storedLead(lead.id);

    await withApp(async (app) => {
      const response = await patchLead(app, tenant, lead.id, {
        name: 'Stage Noop',
        stage: 'new',
        company: 'Noop Trading',
      });
      expect(response.statusCode).toBe(200);
      expect(response.payload).toMatchObject({
        id: lead.id,
        name: 'Stage Noop',
        company: 'Noop Trading',
        stage: 'new',
      });
    });

    expect(await auditRows(tenant.tenantId)).toHaveLength(before.length);
    const stored = await storedLead(lead.id);
    expect(stored.updated_at.getTime()).toBe(original.updated_at.getTime());
    expect(stored.stage).toBe('new');
  });

  test('refuses a stage move straight to converted and keeps the lead open', async () => {
    const tenant = tenants_().owner;
    const lead = fixture(gamma, 'gamma');
    const before = await auditRows(tenant.tenantId);

    await withApp(async (app) => {
      const response = await patchLead(app, tenant, lead.id, {
        stage: 'converted',
      });
      expect(response.statusCode).toBe(409);
      expect(response.payload).toEqual({
        error: { code: 'LEAD_CONVERSION_REQUIRED' },
      });
    });

    expect(await auditRows(tenant.tenantId)).toHaveLength(before.length);
    const stored = await storedLead(lead.id);
    expect(stored.stage).toBe('qualified');
  });

  test('refuses every change to a converted lead and still re-reads it', async () => {
    const tenant = tenants_().owner;
    const lead = fixture(converted, 'converted');
    const stored = await storedLead(lead.id);
    const before = await auditRows(tenant.tenantId);

    await withApp(async (app) => {
      for (const body of [
        { name: 'Renamed Converted' },
        { stage: 'new' },
        { stage: 'disqualified' },
        { company: 'New Co' },
      ]) {
        const response = await patchLead(app, tenant, lead.id, body);
        expect(response.statusCode).toBe(409);
        expect(response.payload).toEqual({ error: { code: 'LEAD_TERMINAL' } });
      }

      // The unchanged body is not a change, so it reads the row back instead of
      // being refused: a reader can still see what the lead became.
      const reread = await patchLead(app, tenant, lead.id, {
        name: 'Stage Converted',
        stage: 'converted',
      });
      expect(reread.statusCode).toBe(200);
      expect(reread.payload).toMatchObject({
        id: lead.id,
        stage: 'converted',
      });
    });

    expect(await auditRows(tenant.tenantId)).toHaveLength(before.length);
    expect((await storedLead(lead.id)).stage).toBe(stored.stage);
  });

  test('refuses every change to a disqualified lead, and a repeat writes nothing', async () => {
    const tenant = tenants_().owner;
    const lead = fixture(disqualified, 'disqualified');
    const before = await auditRows(tenant.tenantId);

    await withApp(async (app) => {
      for (const body of [
        { stage: 'new' },
        { stage: 'qualified' },
        { name: 'Reopened' },
      ]) {
        const response = await patchLead(app, tenant, lead.id, body);
        expect(response.statusCode).toBe(409);
        expect(response.payload).toEqual({ error: { code: 'LEAD_TERMINAL' } });
      }

      const repeat = await patchLead(app, tenant, lead.id, {
        stage: 'disqualified',
      });
      expect(repeat.statusCode).toBe(200);
      expect(repeat.payload).toMatchObject({ stage: 'disqualified' });
    });

    expect(await auditRows(tenant.tenantId)).toHaveLength(before.length);
    expect((await storedLead(lead.id)).stage).toBe('disqualified');
  });

  test('names no lead of another tenant and answers one 404 for every miss', async () => {
    const tenant = tenants_().owner;
    const before = await auditRows(tenant.tenantId);

    await withApp(async (app) => {
      for (const id of [
        fixture(otherLead, 'other').id,
        'f3b3b6f4-0000-4000-8000-000000000000',
        'not-a-uuid',
        undefined,
      ]) {
        const response = await patchLead(app, tenant, id, { stage: 'contacted' });
        expect(response.statusCode).toBe(404);
        expect(response.payload).toEqual({ error: { code: 'LEAD_NOT_FOUND' } });
      }
    });

    expect(await auditRows(tenant.tenantId)).toHaveLength(before.length);
    expect((await storedLead(fixture(otherLead, 'other').id)).stage).toBe('new');
  });

  test('refuses a body outside the closed shape', async () => {
    const tenant = tenants_().owner;
    const lead = fixture(noop, 'noop');
    const before = await auditRows(tenant.tenantId);

    await withApp(async (app) => {
      for (const body of [
        {},
        { name: '' },
        { name: '   ' },
        { name: 5 },
        { stage: 'won' },
        { stage: 'NEW' },
        { stage: null },
        { company: 5 },
        { phone: 5 },
        { stage: 'new', convertedAccountId: null },
        { convertedContactId: null },
        { convertedAt: '2026-03-01' },
        { tenantId: tenant.tenantId },
        { id: lead.id },
        { unknown: true },
      ]) {
        const response = await patchLead(app, tenant, lead.id, body);
        expect(response.statusCode).toBe(400);
        expect(response.payload).toEqual({ error: { code: 'INVALID_BODY' } });
      }
    });

    expect(await auditRows(tenant.tenantId)).toHaveLength(before.length);
    expect((await storedLead(lead.id)).stage).toBe('new');
  });

  test('lets an admin write, refuses a read-only role and an unentitled tenant', async () => {
    const adminRow = fixture(adminLead, 'admin');

    await withApp(async (app) => {
      const admin = await patchLead(app, tenants_().admin, adminRow.id, {
        stage: 'contacted',
      });
      expect(admin.statusCode).toBe(200);
      expect(admin.payload).toMatchObject({
        id: adminRow.id,
        stage: 'contacted',
      });

      const managerBefore = await auditRows(tenants_().manager.tenantId);
      const manager = await patchLead(
        app,
        tenants_().manager,
        adminRow.id,
        { stage: 'qualified' },
      );
      expect(manager.statusCode).toBe(403);
      expect(manager.payload).toEqual({
        error: { code: 'ROLE_DENIED', permission: 'crm.write' },
      });
      const managerAfter = await auditRows(tenants_().manager.tenantId);
      expect(managerAfter).toHaveLength(managerBefore.length + 1);
      expect(one(managerAfter.slice(-1)).action).toBe('authorization.denied');
      expect(one(managerAfter.slice(-1)).metadata).toMatchObject({
        module: 'crm',
        operation: 'write',
        reason: 'ROLE_DENIED',
        permission: 'crm.write',
      });

      const unentitledBefore = await auditRows(tenants_().unentitled.tenantId);
      const unentitled = await patchLead(
        app,
        tenants_().unentitled,
        adminRow.id,
        { stage: 'qualified' },
      );
      expect(unentitled.statusCode).toBe(403);
      expect(unentitled.payload).toEqual({
        error: { code: 'MODULE_NOT_ENTITLED', module: 'crm', operation: 'write' },
      });
      const unentitledAfter = await auditRows(tenants_().unentitled.tenantId);
      expect(unentitledAfter).toHaveLength(unentitledBefore.length + 1);
      expect(one(unentitledAfter.slice(-1)).metadata).toMatchObject({
        module: 'crm',
        operation: 'write',
        reason: 'MODULE_NOT_ENTITLED',
      });
    });
  });

  test('settles the write permission before it reads or parses the body', async () => {
    const lead = fixture(noop, 'noop');

    await withApp(async (app) => {
      // The body names a column the parser would refuse, and a lead id that
      // does not exist for this tenant: the answer is the permission, which
      // proves the gate runs before the parser and before the lead lookup.
      const response = await send(app, {
        method: 'PATCH',
        url: `/v1/crm/leads/${lead.id}`,
        cookie: tenants_().manager.session.cookie,
        csrf: tenants_().manager.session.csrfToken,
        body: { stage: 'won', convertedAt: '2026-03-01' },
      });
      expect(response.statusCode).toBe(403);
      expect(response.payload).toEqual({
        error: { code: 'ROLE_DENIED', permission: 'crm.write' },
      });

      const unknownLead = await send(app, {
        method: 'PATCH',
        url: '/v1/crm/leads/not-a-uuid',
        cookie: tenants_().unentitled.session.cookie,
        csrf: tenants_().unentitled.session.csrfToken,
        body: { unknown: true },
      });
      expect(unknownLead.statusCode).toBe(403);
      expect(unknownLead.payload).toEqual({
        error: { code: 'MODULE_NOT_ENTITLED', module: 'crm', operation: 'write' },
      });
    });
  });

  test('places a moved lead in its new stage group', async () => {
    const tenant = tenants_().owner;
    const lead = fixture(gamma, 'gamma');

    await withApp(async (app) => {
      const moved = await patchLead(app, tenant, lead.id, { stage: 'contacted' });
      expect(moved.statusCode).toBe(200);
      expect(moved.payload).toMatchObject({ stage: 'contacted' });

      // The list orders by stage, then the lowered name, so a lead that changed
      // stage is read in its new group rather than at its old position.
      const response = await listLeads(app, tenant, '?stage=contacted&q=stage');
      expect(response.statusCode).toBe(200);
      expect((response.payload as LeadListBody).items.map((item) => item.name)).toEqual([
        'Stage Alpha',
        'Stage Gamma',
      ]);
    });
  });
});
