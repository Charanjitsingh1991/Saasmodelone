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
const USER_AGENT = 'CRM lead conversion test/1.0';

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

type ConversionBody = {
  lead: {
    id: string;
    name: string;
    company: string | null;
    email: string | null;
    phone: string | null;
    source: string | null;
    stage: string;
    convertedAccountId: string | null;
    convertedContactId: string | null;
  };
  account: {
    id: string;
    name: string;
    code: string | null;
    status: string;
    billingEmail: string | null;
    phone: string | null;
    currency: string;
    paymentTermsDays: number;
  };
  contact: {
    id: string;
    name: string;
    email: string | null;
    phone: string | null;
    role: string | null;
    isPrimary: boolean;
  };
};

type ConvertTenants = {
  owner: ModuleTenantFixture;
  admin: ModuleTenantFixture;
  manager: ModuleTenantFixture;
  unentitled: ModuleTenantFixture;
  other: ModuleTenantFixture;
};

let database: TestDatabase | undefined;
let runtime: RuntimePool | undefined;
let auth: AuthPool | undefined;
let owner: Pool | undefined;
let tenants: ConvertTenants | undefined;

let companyLead: LeadRowFixture | undefined;
let bareLead: LeadRowFixture | undefined;
let namedLead: LeadRowFixture | undefined;
let convertedLead: LeadRowFixture | undefined;
let disqualifiedLead: LeadRowFixture | undefined;
let shapedLead: LeadRowFixture | undefined;
let auditLead: LeadRowFixture | undefined;
let racerLead: LeadRowFixture | undefined;
let adminLead: LeadRowFixture | undefined;
let otherLead: LeadRowFixture | undefined;

function db(): TestDatabase {
  if (!database) {
    throw new Error('Test database has not been created');
  }
  return database;
}

function tenants_(): ConvertTenants {
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

async function counts(tenantId: string): Promise<{
  accounts: number;
  contacts: number;
}> {
  return withOwner(async (client) => {
    const result = await client.query<{ accounts: string; contacts: string }>(
      `select (select count(*) from client where tenant_id = $1) as accounts,
              (select count(*) from client_contact where tenant_id = $1) as contacts`,
      [tenantId],
    );
    const row = one(result.rows);
    return {
      accounts: Number(row.accounts),
      contacts: Number(row.contacts),
    };
  });
}

async function accountsForEmail(
  tenantId: string,
  email: string,
): Promise<Array<{ id: string; name: string }>> {
  return withOwner(async (client) => {
    const result = await client.query<{ id: string; name: string }>(
      `select id, name
         from client
        where tenant_id = $1
          and billing_email = $2::citext
        order by id`,
      [tenantId, email],
    );
    return result.rows;
  });
}

async function contactsForEmail(
  tenantId: string,
  email: string,
): Promise<Array<{ id: string; client_id: string; is_primary: boolean }>> {
  return withOwner(async (client) => {
    const result = await client.query<{
      id: string;
      client_id: string;
      is_primary: boolean;
    }>(
      `select id, client_id, is_primary
         from client_contact
        where tenant_id = $1
          and email = $2::citext
        order by id`,
      [tenantId, email],
    );
    return result.rows;
  });
}

type StoredLead = {
  stage: string;
  converted_client_id: string | null;
  converted_contact_id: string | null;
  converted_at: Date | null;
};

async function storedLead(id: string): Promise<StoredLead> {
  return withOwner(async (client) => {
    const result = await client.query<StoredLead>(
      `select stage, converted_client_id, converted_contact_id, converted_at
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

function convertLead(
  app: TestServer,
  tenant: ModuleTenantFixture,
  leadId: string | undefined,
  body: unknown,
  overrides: Partial<SendOptions> = {},
): Promise<WriteResponse> {
  return send(app, {
    method: 'POST',
    url: `/v1/crm/leads/${leadId ?? 'missing'}/convert`,
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

// A row lock that is being waited on does not appear as an ungranted row in
// pg_locks on this server; the waiter shows in pg_stat_activity with a Lock
// wait event. PostgreSQL blanks those columns for another user's sessions, so
// the watcher connects as the runtime role the requests themselves use: a role
// may always see the wait state of its own sessions. The count is scoped to this
// test's database, so a suite running in parallel cannot satisfy it.
async function waitForBlockedWrites(
  expected: number,
  timeoutMs = 5_000,
): Promise<void> {
  const watcher = new Client({ connectionString: db().runtimeUrl });
  await watcher.connect();
  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const result = await watcher.query<{ total: string }>(
        `select count(*) as total
           from pg_stat_activity
          where datname = current_database()
            and pid <> pg_backend_pid()
            and wait_event_type = 'Lock'`,
      );
      if (Number(result.rows[0]?.total ?? '0') >= expected) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('The concurrent conversions never blocked');
  } finally {
    await watcher.end();
  }
}

beforeAll(async () => {
  database = await createTestDatabase({ migrate: true, seed: true });
  runtime = createRuntimePool(database.runtimeUrl);
  auth = createAuthPool(database.authUrl);
  owner = new Pool({ connectionString: database.ownerUrl });

  const [ownerTenant, adminTenant, managerTenant, unentitled, otherTenant] =
    await Promise.all([
      provisionModuleTenant(db().ownerUrl, {
        label: 'crmconvertowner',
        modules: ['crm'],
      }),
      provisionModuleTenant(db().ownerUrl, {
        label: 'crmconvertadmin',
        modules: ['crm'],
        role: 'admin',
      }),
      provisionModuleTenant(db().ownerUrl, {
        label: 'crmconvertmanager',
        modules: ['crm'],
        role: 'manager',
      }),
      provisionModuleTenant(db().ownerUrl, {
        label: 'crmconvertunentitled',
        modules: ['people'],
      }),
      provisionModuleTenant(db().ownerUrl, {
        label: 'crmconvertother',
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
    companyLead = await insertLeadRow(client, ownerTenant.tenantId, {
      name: 'Convert Alpha',
      company: 'Alpha Co',
      email: 'alpha.convert@example.test',
      phone: '+1-555-0601',
      source: 'website',
      stage: 'contacted',
    });
    bareLead = await insertLeadRow(client, ownerTenant.tenantId, {
      name: 'Convert Bare',
      email: 'bare.convert@example.test',
      stage: 'new',
    });
    namedLead = await insertLeadRow(client, ownerTenant.tenantId, {
      name: 'Convert Named',
      company: 'Named Co',
      email: 'named.convert@example.test',
      stage: 'qualified',
    });

    const account = await insertClientRow(client, ownerTenant.tenantId, {
      name: 'Already Won Co',
      code: 'CL-CONVWON',
    });
    const contact = await insertContactRow(client, ownerTenant.tenantId, {
      clientId: account.id,
      name: 'Already Won Contact',
      isPrimary: true,
    });
    convertedLead = await insertLeadRow(client, ownerTenant.tenantId, {
      name: 'Convert Already',
      stage: 'converted',
      convertedAccountId: account.id,
      convertedContactId: contact.id,
      convertedAt: '2026-04-01',
    });
    disqualifiedLead = await insertLeadRow(client, ownerTenant.tenantId, {
      name: 'Convert Disqualified',
      stage: 'disqualified',
    });

    shapedLead = await insertLeadRow(client, ownerTenant.tenantId, {
      name: 'Convert Shaped',
      email: 'shaped.convert@example.test',
      stage: 'new',
    });
    auditLead = await insertLeadRow(client, ownerTenant.tenantId, {
      name: 'Convert Audit',
      email: 'audit.convert@example.test',
      stage: 'new',
    });
    racerLead = await insertLeadRow(client, ownerTenant.tenantId, {
      name: 'Convert Racer',
      company: 'Racer Co',
      email: 'racer.convert@example.test',
      stage: 'new',
    });

    adminLead = await insertLeadRow(client, adminTenant.tenantId, {
      name: 'Admin Convert',
      email: 'admin.convert@example.test',
      stage: 'new',
    });

    otherLead = await insertLeadRow(client, otherTenant.tenantId, {
      name: 'Other Convert',
      email: 'other.convert@example.test',
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

describe('The CRM lead conversion', () => {
  test('refuses the route without a session, a CSRF token or the origin', async () => {
    const tenant = tenants_().owner;
    const lead = fixture(companyLead, 'company');

    await withApp(async (app) => {
      const noSession = await send(app, {
        method: 'POST',
        url: `/v1/crm/leads/${lead.id}/convert`,
        csrf: tenant.session.csrfToken,
        body: { currency: 'USD' },
      });
      expect(noSession.statusCode).toBe(401);
      expect(noSession.payload).toEqual({ error: { code: 'UNAUTHENTICATED' } });

      const noCsrf = await send(app, {
        method: 'POST',
        url: `/v1/crm/leads/${lead.id}/convert`,
        cookie: tenant.session.cookie,
        body: { currency: 'USD' },
      });
      expect(noCsrf.statusCode).toBe(403);
      expect(noCsrf.payload).toEqual({ error: { code: 'CSRF_INVALID' } });

      const wrongCsrf = await send(app, {
        method: 'POST',
        url: `/v1/crm/leads/${lead.id}/convert`,
        cookie: tenant.session.cookie,
        csrf: randomToken(),
        body: { currency: 'USD' },
      });
      expect(wrongCsrf.statusCode).toBe(403);
      expect(wrongCsrf.payload).toEqual({ error: { code: 'CSRF_INVALID' } });

      const wrongOrigin = await send(app, {
        method: 'POST',
        url: `/v1/crm/leads/${lead.id}/convert`,
        cookie: tenant.session.cookie,
        csrf: tenant.session.csrfToken,
        origin: 'https://evil.example.test',
        body: { currency: 'USD' },
      });
      expect(wrongOrigin.statusCode).toBe(403);
      expect(wrongOrigin.payload).toEqual({ error: { code: 'ORIGIN_DENIED' } });
    });

    expect((await storedLead(lead.id)).stage).toBe('contacted');
  });

  test('writes the account, its primary contact and a terminal lead in one answer', async () => {
    const tenant = tenants_().owner;
    const lead = fixture(companyLead, 'company');
    const before = await counts(tenant.tenantId);
    const beforeAudit = await auditRows(tenant.tenantId);

    let response: WriteResponse | undefined;
    await withApp(async (app) => {
      response = await convertLead(app, tenant, lead.id, { currency: 'GBP' });
    });

    const answer = response as WriteResponse;
    expect(answer.statusCode).toBe(200);
    expect(answer.headers['cache-control']).toBe('no-store');

    const body = answer.payload as ConversionBody;
    expect(Object.keys(body).sort()).toEqual(['account', 'contact', 'lead']);

    // The lead keeps its own record and gains the terminal state.
    expect(body.lead).toMatchObject({
      id: lead.id,
      name: 'Convert Alpha',
      company: 'Alpha Co',
      email: 'alpha.convert@example.test',
      phone: '+1-555-0601',
      source: 'website',
      stage: 'converted',
    });
    expect(body.lead.convertedAccountId).toBe(body.account.id);
    expect(body.lead.convertedContactId).toBe(body.contact.id);

    // The account is the shared client record, named from the lead's company,
    // with the database's own status and payment terms and no code.
    expect(body.account).toMatchObject({
      name: 'Alpha Co',
      code: null,
      status: 'active',
      billingEmail: 'alpha.convert@example.test',
      phone: '+1-555-0601',
      currency: 'GBP',
      paymentTermsDays: 30,
    });

    expect(body.contact).toMatchObject({
      name: 'Convert Alpha',
      email: 'alpha.convert@example.test',
      phone: '+1-555-0601',
      role: null,
      isPrimary: true,
    });
    expect(body.contact.id).not.toBe(body.account.id);

    // One account and one contact were created, in this tenant, and the
    // contact belongs to the account the lead names.
    const after = await counts(tenant.tenantId);
    expect(after.accounts).toBe(before.accounts + 1);
    expect(after.contacts).toBe(before.contacts + 1);

    const tenantOfAccount = await withOwner(async (client) => {
      const result = await client.query<{ tenant_id: string }>(
        'select tenant_id from client where id = $1',
        [body.account.id],
      );
      return one(result.rows).tenant_id;
    });
    expect(tenantOfAccount).toBe(tenant.tenantId);

    const contactRows = await contactsForEmail(
      tenant.tenantId,
      'alpha.convert@example.test',
    );
    expect(contactRows).toHaveLength(1);
    expect(one(contactRows).client_id).toBe(body.account.id);
    expect(one(contactRows).is_primary).toBe(true);

    const stored = await storedLead(lead.id);
    expect(stored.stage).toBe('converted');
    expect(stored.converted_client_id).toBe(body.account.id);
    expect(stored.converted_contact_id).toBe(body.contact.id);
    expect(stored.converted_at).not.toBeNull();

    // The audit names the lead, the fields and nothing of their values.
    const afterAudit = await auditRows(tenant.tenantId);
    const convertedRows = afterAudit
      .slice(beforeAudit.length)
      .filter((row) => row.action === 'crm.lead.converted');
    expect(convertedRows).toHaveLength(1);
    const event = one(convertedRows);
    expect(event.entity_type).toBe('crm_lead');
    expect(event.entity_id).toBe(lead.id);
    expect(event.metadata).toEqual({
      fields: ['convertedAccountId', 'convertedContactId', 'stage'],
    });
    const trail = JSON.stringify(event.metadata);
    for (const detail of [
      'Convert Alpha',
      'Alpha Co',
      'alpha.convert@example.test',
      'GBP',
      body.account.id,
      body.contact.id,
    ]) {
      expect(trail).not.toContain(detail);
    }
  });

  test('names the account from the company, then the lead, unless a name is given', async () => {
    const tenant = tenants_().owner;

    await withApp(async (app) => {
      const fromLead = await convertLead(app, tenant, fixture(bareLead, 'bare').id, {
        currency: 'usd',
      });
      // A lowercase code is refused: the account stores the casing it was given
      // and the rest of the product reads a three-letter uppercase code.
      expect(fromLead.statusCode).toBe(400);
      expect(fromLead.payload).toEqual({ error: { code: 'INVALID_BODY' } });

      const bare = await convertLead(app, tenant, fixture(bareLead, 'bare').id, {
        currency: 'USD',
      });
      expect(bare.statusCode).toBe(200);
      expect((bare.payload as ConversionBody).account.name).toBe('Convert Bare');

      const named = await convertLead(app, tenant, fixture(namedLead, 'named').id, {
        currency: 'USD',
        accountName: '  Chosen Name  ',
      });
      expect(named.statusCode).toBe(200);
      const namedBody = named.payload as ConversionBody;
      expect(namedBody.account.name).toBe('Chosen Name');
      // The contact keeps the person's name, never the account's.
      expect(namedBody.contact.name).toBe('Convert Named');

      const blank = await send(app, {
        method: 'POST',
        url: `/v1/crm/leads/${fixture(shapedLead, 'shaped').id}/convert`,
        cookie: tenant.session.cookie,
        csrf: tenant.session.csrfToken,
        body: { currency: 'EUR', accountName: '   ' },
      });
      // A blank name states nothing, so the lead's own name is used.
      expect(blank.statusCode).toBe(200);
      expect((blank.payload as ConversionBody).account.name).toBe('Convert Shaped');
    });

    const storedBare = await storedLead(fixture(bareLead, 'bare').id);
    expect(storedBare.stage).toBe('converted');
  });

  test('refuses a converted lead and a disqualified lead without writing anything', async () => {
    const tenant = tenants_().owner;
    const before = await counts(tenant.tenantId);

    await withApp(async (app) => {
      const already = await convertLead(
        app,
        tenant,
        fixture(convertedLead, 'converted').id,
        { currency: 'USD' },
      );
      expect(already.statusCode).toBe(409);
      expect(already.payload).toEqual({
        error: { code: 'LEAD_ALREADY_CONVERTED' },
      });
      expect(already.headers['cache-control']).toBe('no-store');

      const terminal = await convertLead(
        app,
        tenant,
        fixture(disqualifiedLead, 'disqualified').id,
        { currency: 'USD' },
      );
      expect(terminal.statusCode).toBe(409);
      expect(terminal.payload).toEqual({ error: { code: 'LEAD_TERMINAL' } });
    });

    const after = await counts(tenant.tenantId);
    expect(after).toEqual(before);
    expect((await storedLead(fixture(convertedLead, 'converted').id)).stage).toBe(
      'converted',
    );
    expect(
      (await storedLead(fixture(disqualifiedLead, 'disqualified').id)).stage,
    ).toBe('disqualified');
  });

  test('refuses a body outside the closed shape and a currency that is not three capitals', async () => {
    const tenant = tenants_().owner;
    const lead = fixture(racerLead, 'racer');
    const before = await counts(tenant.tenantId);
    const beforeAudit = await auditRows(tenant.tenantId);

    await withApp(async (app) => {
      for (const body of [
        {},
        { currency: 'usd' },
        { currency: 'US' },
        { currency: 'USDX' },
        { currency: 'U5D' },
        { currency: 5 },
        { currency: null },
        { currency: 'USD', accountName: 5 },
        { currency: 'USD', tenantId: tenant.tenantId },
        { currency: 'USD', accountId: 'f3b3b6f4-0000-4000-8000-000000000000' },
        { currency: 'USD', stage: 'converted' },
        { currency: 'USD', unknown: true },
      ]) {
        const response = await convertLead(app, tenant, lead.id, body);
        expect(response.statusCode).toBe(400);
        expect(response.payload).toEqual({ error: { code: 'INVALID_BODY' } });
      }
    });

    expect(await counts(tenant.tenantId)).toEqual(before);
    expect(await auditRows(tenant.tenantId)).toHaveLength(beforeAudit.length);
    const stored = await storedLead(lead.id);
    expect(stored.stage).toBe('new');
    expect(stored.converted_client_id).toBeNull();
  });

  test('rolls back the account, the contact and the lead when the audit write fails', async () => {
    const tenant = tenants_().owner;
    const lead = fixture(auditLead, 'audit');
    const before = await counts(tenant.tenantId);
    const beforeAudit = await auditRows(tenant.tenantId);

    await withOwner(async (client) => {
      await client.query('revoke insert on table public.audit_event from saas_runtime');
    });
    try {
      await withApp(async (app) => {
        const response = await convertLead(app, tenant, lead.id, {
          currency: 'USD',
          accountName: 'Audit Failure Co',
        });
        expect(response.statusCode).toBe(500);
        expect(response.payload).toEqual({ error: { code: 'INTERNAL_ERROR' } });
        expect(response.headers['cache-control']).toBe('no-store');
        for (const detail of [
          'permission denied',
          'audit_event',
          'crm_lead',
          'saas_runtime',
          'postgresql',
        ]) {
          expect(response.body.toLowerCase()).not.toContain(detail.toLowerCase());
        }
      });
    } finally {
      await withOwner(async (client) => {
        await client.query('grant insert on table public.audit_event to saas_runtime');
      });
    }

    // The account, the contact and the lead's terminal state all unwound: the
    // lead is still open and no account carries the name or the email.
    expect(await counts(tenant.tenantId)).toEqual(before);
    expect(await auditRows(tenant.tenantId)).toHaveLength(beforeAudit.length);
    const stored = await storedLead(lead.id);
    expect(stored.stage).toBe('new');
    expect(stored.converted_client_id).toBeNull();
    expect(stored.converted_contact_id).toBeNull();
    expect(stored.converted_at).toBeNull();
    expect(
      await accountsForEmail(tenant.tenantId, 'audit.convert@example.test'),
    ).toHaveLength(0);
  });

  test('settles two concurrent conversions as one conversion and one typed conflict', async () => {
    const tenant = tenants_().owner;
    const lead = fixture(racerLead, 'racer');
    const before = await counts(tenant.tenantId);

    // The barrier holds the lead's row lock, so both requests pass the gate and
    // the body and stop at their own locking read. Neither has written anything
    // when the pair is released together.
    const barrier = new Client({ connectionString: db().ownerUrl });
    await barrier.connect();
    let released = false;
    let pending: Promise<WriteResponse[]> | undefined;
    try {
      await barrier.query('begin');
      await barrier.query('select id from public.crm_lead where id = $1 for update', [
        lead.id,
      ]);

      await withApp(async (app) => {
        pending = Promise.all([
          convertLead(app, tenant, lead.id, { currency: 'USD' }),
          convertLead(app, tenant, lead.id, { currency: 'USD' }),
        ]);

        await waitForBlockedWrites(2);

        await barrier.query('commit');
        released = true;

        const [first, second] = await pending;
        if (!first || !second) {
          throw new Error('Expected two conversion responses');
        }
        expect([first.statusCode, second.statusCode].sort()).toEqual([200, 409]);

        const conflict = first.statusCode === 409 ? first : second;
        expect(conflict.payload).toEqual({
          error: { code: 'LEAD_ALREADY_CONVERTED' },
        });
        const winner = (first.statusCode === 200 ? first : second)
          .payload as ConversionBody;
        expect(winner.lead.id).toBe(lead.id);
        expect(winner.account.name).toBe('Racer Co');
      });
    } finally {
      if (!released) {
        try {
          await barrier.query('rollback');
        } catch {
          // The barrier transaction is already gone.
        }
      }
      await barrier.end();
      if (pending) {
        await pending.catch(() => undefined);
      }
    }

    // Exactly one account and one contact exist for the lead, both named by the
    // single winning conversion.
    const after = await counts(tenant.tenantId);
    expect(after.accounts).toBe(before.accounts + 1);
    expect(after.contacts).toBe(before.contacts + 1);
    const accounts = await accountsForEmail(
      tenant.tenantId,
      'racer.convert@example.test',
    );
    expect(accounts).toHaveLength(1);
    const contacts = await contactsForEmail(
      tenant.tenantId,
      'racer.convert@example.test',
    );
    expect(contacts).toHaveLength(1);
    expect(one(contacts).client_id).toBe(one(accounts).id);

    const stored = await storedLead(lead.id);
    expect(stored.stage).toBe('converted');
    expect(stored.converted_client_id).toBe(one(accounts).id);
  });

  test('names no lead of another tenant and answers one 404 for every miss', async () => {
    const tenant = tenants_().owner;
    const before = await counts(tenant.tenantId);

    await withApp(async (app) => {
      for (const id of [
        fixture(otherLead, 'other').id,
        'f3b3b6f4-0000-4000-8000-000000000000',
        'not-a-uuid',
        undefined,
      ]) {
        const response = await convertLead(app, tenant, id, { currency: 'USD' });
        expect(response.statusCode).toBe(404);
        expect(response.payload).toEqual({ error: { code: 'LEAD_NOT_FOUND' } });
      }

      const other = await convertLead(
        app,
        tenants_().other,
        fixture(companyLead, 'company').id,
        { currency: 'USD' },
      );
      expect(other.statusCode).toBe(404);
      expect(other.payload).toEqual({ error: { code: 'LEAD_NOT_FOUND' } });
    });

    expect(await counts(tenant.tenantId)).toEqual(before);
    expect((await storedLead(fixture(otherLead, 'other').id)).stage).toBe('new');
  });

  test('lets an admin convert a lead of its own workspace', async () => {
    const lead = fixture(adminLead, 'admin');

    await withApp(async (app) => {
      const response = await convertLead(app, tenants_().admin, lead.id, {
        currency: 'AUD',
      });
      expect(response.statusCode).toBe(200);
      const body = response.payload as ConversionBody;
      expect(body.account.name).toBe('Admin Convert');
      expect(body.account.currency).toBe('AUD');

      const tenantOfAccount = await withOwner(async (client) => {
        const result = await client.query<{ tenant_id: string }>(
          'select tenant_id from client where id = $1',
          [body.account.id],
        );
        return one(result.rows).tenant_id;
      });
      expect(tenantOfAccount).toBe(tenants_().admin.tenantId);
    });
  });

  test('settles the write permission before it reads the body or the lead', async () => {
    await withApp(async (app) => {
      const manager = await convertLead(
        app,
        tenants_().manager,
        fixture(racerLead, 'racer').id,
        { currency: 'usd', unknown: true },
      );
      expect(manager.statusCode).toBe(403);
      expect(manager.payload).toEqual({
        error: { code: 'ROLE_DENIED', permission: 'crm.write' },
      });

      const unentitled = await send(app, {
        method: 'POST',
        url: '/v1/crm/leads/not-a-uuid/convert',
        cookie: tenants_().unentitled.session.cookie,
        csrf: tenants_().unentitled.session.csrfToken,
        body: { currency: 'usd' },
      });
      expect(unentitled.statusCode).toBe(403);
      expect(unentitled.payload).toEqual({
        error: { code: 'MODULE_NOT_ENTITLED', module: 'crm', operation: 'write' },
      });
    });
  });

  test('shows the converted lead in the list with the records it became', async () => {
    const tenant = tenants_().owner;
    const lead = fixture(companyLead, 'company');
    const stored = await storedLead(lead.id);

    await withApp(async (app) => {
      const response = await send(app, {
        method: 'GET',
        url: '/v1/crm/leads?stage=converted&q=convert%20alpha',
        cookie: tenant.session.cookie,
      });
      expect(response.statusCode).toBe(200);
      const list = response.payload as LeadListBody;
      expect(list.total).toBe(1);
      expect(one(list.items)).toMatchObject({
        id: lead.id,
        name: 'Convert Alpha',
        stage: 'converted',
      });
    });

    expect(stored.stage).toBe('converted');
  });
});
