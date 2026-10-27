import type { OutgoingHttpHeaders } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  createAuthPool,
  createRuntimePool,
  recordAccessDenial,
  setMembershipScope,
  type AuthPool,
  type RuntimePool,
} from '@saasmodels/db';
import type {
  CompensationItem,
  CompensationListResponse,
  CompensationPayFrequency,
  MembershipRole,
} from '@saasmodels/contracts';
import { PERMISSIONS, permissionFor } from '@saasmodels/contracts';
import { createServer } from '@saasmodels/api';
import { createTestDatabase, type TestDatabase } from '@saasmodels/testkit';
import {
  createAccessFixtures,
  type AccessFixtures,
} from './support/access-fixtures.js';
import {
  createSessionFixture,
  randomToken,
  type SessionFixture,
} from './support/auth-fixtures.js';

const appOrigin = 'https://app.example.test';
const USER_AGENT = 'People compensation test/1.0';

// The seven keys the contract exposes, in the order Object.keys().sort()
// produces. Anything else - the structure jsonb, the source columns, the
// timestamps, even tenant_id - must not reach the caller, and this array is what
// proves it.
const ITEM_KEYS = [
  'ctcMinor',
  'currency',
  'effectiveFrom',
  'effectiveTo',
  'id',
  'payFrequency',
  'personId',
];

const LIST_KEYS = ['items', 'total'];

// The seven columns packages/db/sql/runtime-grants.sql names, alphabetically.
// Nothing wider: no structure, no source_system, no import batch, no timestamps.
const COMPENSATION_COLUMNS = [
  'ctc_minor',
  'currency',
  'effective_from',
  'effective_to',
  'id',
  'pay_frequency',
  'person_id',
];

const COMPENSATION_PERMISSION = 'people.compensation.read';

type CompensationResponse = {
  statusCode: number;
  headers: OutgoingHttpHeaders;
  body: string;
  payload: Record<string, unknown> | null;
  list: CompensationListResponse;
};

type AuditRow = {
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
  other: SessionFixture;
  finance: SessionFixture;
  hr: SessionFixture;
  hrEntity: SessionFixture;
  hrOther: SessionFixture;
  manager: SessionFixture;
  auditor: SessionFixture;
  employee: SessionFixture;
};

type Membership = { userId: string; membershipId: string };

type Subject = { id: string; displayName: string };

type CompensationSeed = {
  effectiveFrom: string;
  effectiveTo?: string | null;
  ctcMinor: number;
  currency?: string;
  payFrequency?: CompensationPayFrequency;
};

let database: TestDatabase | undefined;
let fixtures: AccessFixtures | undefined;
let runtime: RuntimePool | undefined;
let auth: AuthPool | undefined;
let owner: Pool | undefined;
let sessions: Sessions | undefined;
let memberships:
  | Record<'finance' | 'hr' | 'hrEntity' | 'hrOther' | 'manager' | 'auditor', Membership>
  | undefined;
let org: { entityA: string; entityB: string } | undefined;
let subjectCounter = 0;

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

function membership(
  name: 'finance' | 'hr' | 'hrEntity' | 'hrOther' | 'manager' | 'auditor',
): Membership {
  if (!memberships) {
    throw new Error('Compensation members have not been created');
  }
  return memberships[name];
}

function structure() {
  if (!org) {
    throw new Error('Compensation structure has not been created');
  }
  return org;
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

/** A count of every audit row in the tenant. A salary read is not an event, so
 *  the whole count - not only the access rows - has to stay level. */
async function auditRowCount(tenantId: string): Promise<number> {
  return withOwner(async (client) => {
    const result = await client.query<{ total: string }>(
      'select count(*) as total from audit_event where tenant_id = $1',
      [tenantId],
    );
    return Number(one(result.rows).total);
  });
}

async function denialRows(tenantId: string): Promise<AuditRow[]> {
  return withOwner(async (client) => {
    const result = await client.query<AuditRow>(
      `select action, entity_type, entity_id, actor_type, actor_user_id, metadata
         from audit_event
        where tenant_id = $1
          and action = 'authorization.denied'
        order by occurred_at, id`,
      [tenantId],
    );
    return result.rows;
  });
}

/** Each test writes to its own person, so no assertion depends on the order the
 *  tests ran in. */
async function newSubject(
  legalEntityId: string | null,
  options: { userId?: string } = {},
): Promise<Subject> {
  subjectCounter += 1;
  const label = `subject${subjectCounter}`;
  const displayName = `Compensation ${label}`;
  return withOwner(async (client) => {
    const result = await client.query<{ id: string }>(
      `insert into person
         (tenant_id, employee_code, first_name, display_name, work_email, phone,
          legal_entity_id, org_unit_id, user_id)
       values ($1, $2, 'Subject', $3, $4, '+1 555 0500', $5, null, $6)
       returning id`,
      [
        fx().a.tenantId,
        `CMP-${label}-${randomBytes(3).toString('hex')}`,
        displayName,
        `${label}_${randomToken().slice(0, 8)}@example.test`,
        legalEntityId,
        options.userId ?? null,
      ],
    );
    return { id: one(result.rows).id, displayName };
  });
}

/** A salary history the read route did not write. Seeding owner-side is how the
 *  read half is tested independently of the write half: the rows exist before any
 *  POST runs, so a read answer cannot be a row this file just created. The write
 *  routes are covered by tests/people-compensation-write.test.ts; this file never
 *  calls them.
 *  The caller names the tenant, because a seeded person lives in more than one
 *  and tenant_id is not derivable from the runtime role. */
async function newCompensation(
  tenantId: string,
  personId: string,
  seed: CompensationSeed,
): Promise<string> {
  return withOwner(async (client) => {
    const result = await client.query<{ id: string }>(
      `insert into compensation
         (tenant_id, person_id, effective_from, effective_to, ctc_minor, currency,
          pay_frequency)
       values ($1, $2, $3, $4, $5, $6, $7)
       returning id`,
      [
        tenantId,
        personId,
        seed.effectiveFrom,
        seed.effectiveTo ?? null,
        seed.ctcMinor,
        seed.currency ?? 'ZZZ',
        seed.payFrequency ?? 'monthly',
      ],
    );
    return one(result.rows).id;
  });
}

/** The same row, but a figure too large for a JavaScript number, written through
 *  the cast so the literal survives the driver. */
async function newOversizedCompensation(
  tenantId: string,
  personId: string,
  minorUnits: string,
): Promise<string> {
  return withOwner(async (client) => {
    const result = await client.query<{ id: string }>(
      `insert into compensation
         (tenant_id, person_id, effective_from, ctc_minor, currency, pay_frequency)
       values ($1, $2, '2024-01-01', $3::bigint, 'ZZZ', 'monthly')
       returning id`,
      [tenantId, personId, minorUnits],
    );
    return one(result.rows).id;
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
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  url: string;
  cookie?: string;
  csrf?: string | null;
  origin?: string;
  body?: unknown;
};

async function send(
  app: TestServer,
  options: SendOptions,
): Promise<CompensationResponse> {
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
    list: payload as unknown as CompensationListResponse,
  };
}

/** Deliberately sends no CSRF header: a read needs none, and every request in
 *  this file proves it by returning 200 or a decision code rather than 403. */
function history(
  app: TestServer,
  which: keyof Sessions,
  personId: string,
  origin?: string,
): Promise<CompensationResponse> {
  const s = session(which);
  return send(app, {
    method: 'GET',
    url: `/v1/people/${personId}/compensations`,
    cookie: s.cookie,
    origin,
  });
}

async function exportDirectory(app: TestServer): Promise<string> {
  const response = await app.inject({
    method: 'GET',
    url: '/v1/people/export',
    headers: { cookie: session('a').cookie, 'user-agent': USER_AGENT },
  });
  expect(response.statusCode).toBe(200);
  return response.body;
}

async function insertMember(
  client: Client,
  role: MembershipRole,
  label: string,
): Promise<Membership> {
  const user = await client.query<{ id: string }>(
    `insert into app_user (email, display_name, status)
     values ($1, $2, 'active')
     returning id`,
    [`${label}_${randomToken().slice(0, 8)}@example.test`, `Compensation ${label}`],
  );
  const membershipRow = await client.query<{ id: string }>(
    `insert into membership (tenant_id, user_id, role, status)
     values ($1, $2, $3, 'active')
     returning id`,
    [fx().a.tenantId, one(user.rows).id, role],
  );
  return { userId: one(user.rows).id, membershipId: one(membershipRow.rows).id };
}

async function insertLegalEntity(client: Client, name: string): Promise<string> {
  const jurisdiction = await client.query<{ jurisdiction_id: string }>(
    'select jurisdiction_id from legal_entity where id = $1',
    [fx().a.legalEntityId],
  );
  const result = await client.query<{ id: string }>(
    `insert into legal_entity
       (tenant_id, name, code, jurisdiction_id, currency, timezone)
     values ($1, $2, $3, $4, 'ZZZ', 'UTC')
     returning id`,
    [
      fx().a.tenantId,
      name,
      `cp_${randomToken().slice(0, 8)}`,
      one(jurisdiction.rows).jurisdiction_id,
    ],
  );
  return one(result.rows).id;
}

async function functionGrant(
  client: Client,
  role: string,
  signature: string,
): Promise<boolean> {
  const result = await client.query<{ allowed: boolean }>(
    `select has_function_privilege($1, $2, 'EXECUTE') as allowed`,
    [role, signature],
  );
  return one(result.rows).allowed;
}

beforeAll(async () => {
  database = await createTestDatabase({ migrate: true, seed: true });
  runtime = createRuntimePool(database.runtimeUrl);
  auth = createAuthPool(database.authUrl);
  owner = new Pool({ connectionString: database.ownerUrl });

  await withOwner(async (client) => {
    fixtures = await createAccessFixtures(client);
    const a = fixtures.a;

    const entityB = await insertLegalEntity(client, 'Compensation beta');
    org = { entityA: a.legalEntityId, entityB };

    const financeMember = await insertMember(client, 'finance', 'finance');
    const hrMember = await insertMember(client, 'hr', 'hr');
    const hrEntityMember = await insertMember(client, 'hr', 'hrentity');
    const hrOtherMember = await insertMember(client, 'hr', 'hrother');
    const managerMember = await insertMember(client, 'manager', 'manager');
    const auditorMember = await insertMember(client, 'auditor', 'auditor');
    memberships = {
      finance: financeMember,
      hr: hrMember,
      hrEntity: hrEntityMember,
      hrOther: hrOtherMember,
      manager: managerMember,
      auditor: auditorMember,
    };

    sessions = {
      a: await createSessionFixture(client, { userId: a.userId, tenantId: a.tenantId }),
      b: await createSessionFixture(client, {
        userId: fixtures.b.userId,
        tenantId: fixtures.b.tenantId,
      }),
      other: await createSessionFixture(client, {
        userId: fixtures.dualModule.userId,
        tenantId: fixtures.dualModule.tenantId,
      }),
      finance: await createSessionFixture(client, {
        userId: financeMember.userId,
        tenantId: a.tenantId,
      }),
      hr: await createSessionFixture(client, {
        userId: hrMember.userId,
        tenantId: a.tenantId,
      }),
      hrEntity: await createSessionFixture(client, {
        userId: hrEntityMember.userId,
        tenantId: a.tenantId,
      }),
      hrOther: await createSessionFixture(client, {
        userId: hrOtherMember.userId,
        tenantId: a.tenantId,
      }),
      manager: await createSessionFixture(client, {
        userId: managerMember.userId,
        tenantId: a.tenantId,
      }),
      auditor: await createSessionFixture(client, {
        userId: auditorMember.userId,
        tenantId: a.tenantId,
      }),
      // The permissionless employee role, in its own entitled tenant, whose
      // person row is the one its own SQL scope would let it read.
      employee: await createSessionFixture(client, {
        userId: fixtures.employee.userId,
        tenantId: fixtures.employee.tenantId,
      }),
    };

    // Histories that must stay invisible to tenant a: a row on the employee
    // fixture's person (whose role does not hold the permission at all), and a
    // row in a second, People-entitled tenant.
    await newCompensation(fx().employee.tenantId, fx().employee.personId, {
      effectiveFrom: '2024-04-01',
      ctcMinor: 5555001,
    });
    await newCompensation(fx().dualModule.tenantId, fx().dualModule.personId, {
      effectiveFrom: '2024-07-01',
      ctcMinor: 7777777,
    });
    // A history against a soft-deleted directory row, in tenant a.
    await newCompensation(a.tenantId, fx().softDeletedPerson.id, {
      effectiveFrom: '2019-01-01',
      ctcMinor: 6666001,
    });
  });

  // Scope rows go through the owner-only authoring path, as an operator sets
  // them; no test inserts into membership_scope itself.
  await setMembershipScope(ownerPool(), {
    tenantId: fx().a.tenantId,
    membershipId: membership('hrEntity').membershipId,
    scopes: [{ scopeType: 'legal_entity', scopeId: structure().entityA }],
    actorUserId: fx().a.userId,
  });
  await setMembershipScope(ownerPool(), {
    tenantId: fx().a.tenantId,
    membershipId: membership('hrOther').membershipId,
    scopes: [{ scopeType: 'legal_entity', scopeId: structure().entityB }],
    actorUserId: fx().a.userId,
  });
}, 240_000);

afterAll(async () => {
  await owner?.end();
  await auth?.end();
  await runtime?.end();
  await database?.drop();
});

describe('Compensation history read', () => {
  test('rejects the history route without a valid session', async () => {
    const s = structure();
    await withApp(async (app) => {
      for (const cookie of [undefined, `saas_session=${randomToken()}`]) {
        const response = await send(app, {
          method: 'GET',
          url: `/v1/people/${s.entityA}/compensations`,
          cookie,
        });
        expect(response.statusCode).toBe(401);
        expect(response.payload).toEqual({ error: { code: 'UNAUTHENTICATED' } });
        expect(response.headers['cache-control']).toBe('no-store');
      }
    });
  });

  test('answers the owner with exactly the seven keys, newest period first', async () => {
    const a = fx().a;
    const s = structure();
    const subject = await newSubject(s.entityA);
    const oldest = await newCompensation(a.tenantId, subject.id, {
      effectiveFrom: '2021-04-01',
      effectiveTo: '2022-03-31',
      ctcMinor: 1000000,
      currency: 'INR',
    });
    const middle = await newCompensation(a.tenantId, subject.id, {
      effectiveFrom: '2022-04-01',
      effectiveTo: '2023-03-31',
      ctcMinor: 1234567,
      currency: 'INR',
      payFrequency: 'semi_monthly',
    });
    const current = await newCompensation(a.tenantId, subject.id, {
      effectiveFrom: '2023-04-01',
      effectiveTo: null,
      ctcMinor: 1500000,
      currency: 'USD',
      payFrequency: 'biweekly',
    });
    const beforeAudit = await auditRowCount(a.tenantId);

    await withApp(async (app) => {
      const response = await history(app, 'a', subject.id);
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(Object.keys(response.list).sort()).toEqual(LIST_KEYS);
      expect(response.list.total).toBe(3);
      expect(response.list.items).toHaveLength(3);

      const ids = response.list.items.map((item) => item.id);
      // effective_from desc. The route also orders by id, but the table's
      // unique (tenant_id, person_id, effective_from) constraint means one
      // person can never hold two rows for the same day, so the tie-breaker is
      // unexercisable through a person-scoped read and stays as written.
      expect(ids).toEqual([current, middle, oldest]);
      expect(response.list.items.map((item) => item.effectiveFrom)).toEqual([
        '2023-04-01',
        '2022-04-01',
        '2021-04-01',
      ]);

      for (const item of response.list.items) {
        expect(Object.keys(item).sort()).toEqual(ITEM_KEYS);
        expect(item.personId).toBe(subject.id);
      }
      const byId = new Map<string, CompensationItem>(
        response.list.items.map((item) => [item.id, item]),
      );
      expect(byId.get(oldest)).toEqual({
        id: oldest,
        personId: subject.id,
        effectiveFrom: '2021-04-01',
        effectiveTo: '2022-03-31',
        ctcMinor: 1000000,
        currency: 'INR',
        payFrequency: 'monthly',
      });
      expect(byId.get(middle)).toMatchObject({
        effectiveTo: '2023-03-31',
        ctcMinor: 1234567,
        payFrequency: 'semi_monthly',
      });
      // An open-ended period reads back as null, never as a date.
      expect(byId.get(current)).toMatchObject({
        effectiveTo: null,
        currency: 'USD',
        payFrequency: 'biweekly',
      });
    });

    // A read is not an event: nothing is written, and nothing is audited.
    expect(await auditRowCount(a.tenantId)).toBe(beforeAudit);
  });

  test('answers an empty history as an empty, successful list', async () => {
    const s = structure();
    const subject = await newSubject(s.entityA);
    const beforeAudit = await auditRowCount(fx().a.tenantId);

    await withApp(async (app) => {
      const response = await history(app, 'a', subject.id);
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(Object.keys(response.list).sort()).toEqual(LIST_KEYS);
      expect(response.list).toEqual({ items: [], total: 0 });
    });

    expect(await auditRowCount(fx().a.tenantId)).toBe(beforeAudit);
  });

  test('admits finance and hr, the other two roles the permission names', async () => {
    const a = fx().a;
    const s = structure();
    const subject = await newSubject(s.entityA);
    const row = await newCompensation(a.tenantId, subject.id, {
      effectiveFrom: '2024-01-01',
      ctcMinor: 4200000,
      currency: 'INR',
    });

    await withApp(async (app) => {
      for (const which of ['finance', 'hr'] as const) {
        const response = await history(app, which, subject.id);
        expect(response.statusCode).toBe(200);
        expect(response.list.total).toBe(1);
        expect(one(response.list.items)).toMatchObject({
          id: row,
          ctcMinor: 4200000,
          currency: 'INR',
          effectiveTo: null,
        });
      }
    });
  });

  test('refuses manager and auditor by permission, not by scope', async () => {
    const a = fx().a;
    const s = structure();
    // A tenant-wide member: the SQL scope would answer yes for this person, so
    // the only thing standing between the caller and the salary is the role
    // permission check.
    const subject = await newSubject(s.entityA);
    const amount = 9876543;
    await newCompensation(a.tenantId, subject.id, {
      effectiveFrom: '2024-01-01',
      ctcMinor: amount,
    });

    for (const which of ['manager', 'auditor'] as const) {
      const before = await denialRows(a.tenantId);
      const beforeAudit = await auditRowCount(a.tenantId);

      await withApp(async (app) => {
        const response = await history(app, which, subject.id);
        expect(response.statusCode).toBe(403);
        expect(response.payload).toEqual({
          error: { code: 'ROLE_DENIED', permission: COMPENSATION_PERMISSION },
        });
        expect(response.headers['cache-control']).toBe('no-store');
        // The refusal happens before the history is read, so the figure cannot
        // appear anywhere in the answer even by accident.
        expect(response.body).not.toContain(String(amount));
      });

      const after = await denialRows(a.tenantId);
      expect(after).toHaveLength(before.length + 1);
      const denial = one(after.slice(-1));
      expect(denial).toMatchObject({
        action: 'authorization.denied',
        entity_type: 'request',
        actor_user_id: membership(which).userId,
        metadata: {
          reason: 'ROLE_DENIED',
          module: 'people',
          operation: 'read',
          permission: COMPENSATION_PERMISSION,
          method: 'GET',
          path: '/v1/people/:id/compensations',
        },
      });
      // Exact keys, not a subset: toMatchObject cannot prove an absence, and the
      // claim this row exists to hold is that a refusal to read pay records
      // nothing else — no person id, no amount, no currency.
      expect(Object.keys(denial.metadata).sort()).toEqual([
        'method',
        'module',
        'operation',
        'path',
        'permission',
        'reason',
      ]);
      expect(JSON.stringify(denial.metadata)).not.toContain(subject.id);
      expect(JSON.stringify(denial.metadata)).not.toContain(String(amount));
      expect(await auditRowCount(a.tenantId)).toBe(beforeAudit + 1);
    }
  });

  test('refuses the employee role at the gate, before any row is read', async () => {
    const employee = fx().employee;
    const before = await denialRows(employee.tenantId);

    await withApp(async (app) => {
      // The person id is the employee fixture's own directory row, which
      // createAccessFixtures leaves unlinked to any user id, so
      // app.person_visible would answer no for this caller anyway. It is never
      // asked: the permission gate is what answers, so the route stops before the
      // row. (The linked-row case, where the read oracle does answer yes, is
      // covered in tests/people-compensation-write.test.ts.)
      const response = await history(app, 'employee', employee.personId);
      expect(response.statusCode).toBe(403);
      expect(response.payload).toEqual({
        error: { code: 'ROLE_DENIED', permission: COMPENSATION_PERMISSION },
      });
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body).not.toContain('5555001');
    });

    const after = await denialRows(employee.tenantId);
    expect(after).toHaveLength(before.length + 1);
    expect(one(after.slice(-1)).metadata.reason).toBe('ROLE_DENIED');
  });

  test('refuses a tenant without the People entitlement before the role check', async () => {
    const b = fx().b;
    const before = await denialRows(b.tenantId);

    await withApp(async (app) => {
      // This member is an admin - a role that does hold the permission - so the
      // answer can only come from the entitlement, and it has to come first.
      expect(b.role).toBe('admin');
      const response = await history(app, 'b', b.personId);
      expect(response.statusCode).toBe(403);
      expect(response.payload).toEqual({
        error: { code: 'MODULE_NOT_ENTITLED', module: 'people', operation: 'read' },
      });
      expect(response.headers['cache-control']).toBe('no-store');
    });

    const after = await denialRows(b.tenantId);
    expect(after).toHaveLength(before.length + 1);
    expect(one(after.slice(-1)).metadata.reason).toBe('MODULE_NOT_ENTITLED');
  });

  test('keeps another tenant history invisible and answers the same 404', async () => {
    const a = fx().a;
    const other = fx().dualModule;

    await withApp(async (app) => {
      // A second, People-entitled tenant whose owner holds the permission: the
      // entitlement and the role both pass, and tenant isolation is the only
      // thing left.
      const own = await history(app, 'other', other.personId);
      expect(own.statusCode).toBe(200);
      expect(own.list.total).toBe(1);
      expect(one(own.list.items).ctcMinor).toBe(7777777);

      for (const [which, personId, marker] of [
        ['other', a.personId, '7777777'],
        ['a', other.personId, '5555001'],
      ] as const) {
        const response = await history(app, which, personId);
        expect(response.statusCode).toBe(404);
        expect(response.payload).toEqual({ error: { code: 'PERSON_NOT_FOUND' } });
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.body).not.toContain(marker);
      }
    });
  });

  test('narrows a scoped hr to its entity and answers out-of-scope as 404', async () => {
    const a = fx().a;
    const s = structure();
    const onA = await newSubject(s.entityA);
    const onB = await newSubject(s.entityB);
    const unplaced = await newSubject(null);
    const amountA = 1110001;
    const amountB = 2220002;
    const amountUnplaced = 3330003;
    await newCompensation(a.tenantId, onA.id, { effectiveFrom: '2024-01-01', ctcMinor: amountA });
    await newCompensation(a.tenantId, onB.id, { effectiveFrom: '2024-01-01', ctcMinor: amountB });
    await newCompensation(a.tenantId, unplaced.id, {
      effectiveFrom: '2024-01-01',
      ctcMinor: amountUnplaced,
    });

    await withApp(async (app) => {
      // In scope: the history is there.
      const scoped = await history(app, 'hrEntity', onA.id);
      expect(scoped.statusCode).toBe(200);
      expect(scoped.list.total).toBe(1);
      expect(one(scoped.list.items).ctcMinor).toBe(amountA);

      // Out of scope, and an unplaced person a scoped member cannot reach: the
      // same 404 as an id that never existed. Scope stays invisible to the
      // caller, so it cannot be probed for.
      for (const [personId, amount] of [
        [onB.id, amountB],
        [unplaced.id, amountUnplaced],
      ] as const) {
        const response = await history(app, 'hrEntity', personId);
        expect(response.statusCode).toBe(404);
        expect(response.payload).toEqual({ error: { code: 'PERSON_NOT_FOUND' } });
        expect(response.body).not.toContain(String(amount));
      }

      // The other hr member, scoped to the second entity, sees its own history
      // and not the first one's.
      const other = await history(app, 'hrOther', onB.id);
      expect(other.statusCode).toBe(200);
      expect(one(other.list.items).ctcMinor).toBe(amountB);
      const otherDenied = await history(app, 'hrOther', onA.id);
      expect(otherDenied.statusCode).toBe(404);

      // A tenant-wide hr - same role, same permission, no scope rows - reaches
      // all three, which is what proves the difference is scope and not role.
      for (const [personId, amount] of [
        [onA.id, amountA],
        [onB.id, amountB],
        [unplaced.id, amountUnplaced],
      ] as const) {
        const wide = await history(app, 'hr', personId);
        expect(wide.statusCode).toBe(200);
        expect(one(wide.list.items).ctcMinor).toBe(amount);
      }
    });
  });

  test('answers one uniform 404 for unknown, malformed and soft-deleted ids', async () => {
    const s = structure();
    await withApp(async (app) => {
      for (const id of [
        s.entityA,
        'not-a-uuid',
        randomUUID(),
        fx().softDeletedPerson.id,
      ]) {
        const response = await history(app, 'a', id);
        expect(response.statusCode).toBe(404);
        expect(response.payload).toEqual({ error: { code: 'PERSON_NOT_FOUND' } });
        expect(response.headers['cache-control']).toBe('no-store');
        // The soft-deleted person really does have a history; the directory read
        // that gates the route is what hides it, and no stored figure leaks
        // through the 404.
        expect(response.body).not.toContain('6666001');
      }
    });
  });

  test('refuses a bigint amount the runtime can read rather than round it', async () => {
    const a = fx().a;
    const s = structure();
    const subject = await newSubject(s.entityA);
    // Above Number.MAX_SAFE_INTEGER: pg would hand back the exact digits, and a
    // JavaScript number cannot hold them.
    const huge = '9007199254740993';
    await newOversizedCompensation(a.tenantId, subject.id, huge);

    await withApp(async (app) => {
      const response = await history(app, 'a', subject.id);
      expect(response.statusCode).toBe(500);
      expect(response.payload).toEqual({ error: { code: 'INTERNAL_ERROR' } });
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body).not.toContain(huge);
      expect(response.body).not.toContain('9007199254740992');
    });
  });

  test('writes nothing from the read route, and offers no delete path', async () => {
    const a = fx().a;
    const s = structure();
    const subject = await newSubject(s.entityA);
    const beforeAudit = await auditRowCount(a.tenantId);

    await withApp(async (app) => {
      // The person has no history at all, so any answer that carried a row would
      // have had to invent one. The GET is the read half of this slice and it
      // writes nothing: the same call twice gives the same empty answer.
      const read = await history(app, 'a', subject.id);
      expect(read.statusCode).toBe(200);
      expect(read.list).toEqual({ items: [], total: 0 });

      // A salary row is superseded by a later one, never erased, so there is no
      // DELETE route and no DELETE verb anywhere on this path. Each method below
      // is Fastify's own route-not-found answer, which is a different shape from
      // any decision the product makes. The create and amend verbs are not in
      // this list: 0014 gave them routes of their own, under their own
      // permission, and tests/people-compensation-write.test.ts covers them.
      for (const [method, url] of [
        ['DELETE', `/v1/people/${subject.id}/compensations`],
        ['DELETE', `/v1/people/${subject.id}/compensations/${randomUUID()}`],
        ['PUT', `/v1/people/${subject.id}/compensations`],
      ] as const) {
        const response = await send(app, {
          method,
          url,
          cookie: session('a').cookie,
          csrf: session('a').csrfToken,
          body: {},
        });
        expect(response.statusCode).toBe(404);
        expect(response.body).not.toContain('PERSON_NOT_FOUND');
        expect(response.payload?.error).toBe('Not Found');
      }

      const again = await history(app, 'a', subject.id);
      expect(again.list).toEqual({ items: [], total: 0 });
    });

    expect(await auditRowCount(a.tenantId)).toBe(beforeAudit);
  });

  test('leaves the directory CSV export byte-identical', async () => {
    const a = fx().a;
    const s = structure();
    const subject = await newSubject(s.entityA);
    // The subjects above this point are already in the export, so the baseline is
    // taken after them and only the compensation rows are new.
    await withApp(async (app) => {
      const exportBefore = await exportDirectory(app);
      await newCompensation(a.tenantId, subject.id, {
        effectiveFrom: '2024-01-01',
        ctcMinor: 12345678,
        currency: 'INR',
      });
      await newCompensation(a.tenantId, subject.id, {
        effectiveFrom: '2025-01-01',
        effectiveTo: null,
        ctcMinor: 23456789,
        currency: 'INR',
        payFrequency: 'weekly',
      });
      const exportAfter = await exportDirectory(app);
      expect(exportAfter).toBe(exportBefore);
      expect(exportAfter).not.toContain('ctc');
      expect(exportAfter).not.toContain('12345678');
    });
  });
});

describe('Compensation read inventory', () => {
  test('lands the thirteenth migration and leaves the ledger otherwise unchanged', async () => {
    const ledger = await withOwner(async (client) => {
      const result = await client.query<{ version: string; status: string }>(
        `select version, status from infra.schema_migration
          where status = 'applied'
          order by version`,
      );
      return result.rows;
    });

    // Fourteen versions are applied, and 0013 is the thirteenth of them. The
    // fourteenth is this table's write half - 0014_compensation_write.sql, pinned
    // by tests/people-compensation-write.test.ts, which also proves it is the
    // newest and that nothing else in the ledger moved.
    expect(ledger).toHaveLength(14);
    expect(ledger.every((row) => row.status === 'applied')).toBe(true);
    expect(ledger[0]?.version).toBe('0001_core.sql');
    expect(ledger[12]?.version).toBe('0013_compensation_read.sql');
  });

  test('gives the runtime the compensation columns it needs and no table privilege', async () => {
    await withOwner(async (client) => {
      const columns = await client.query<{ column_name: string }>(
        `select distinct column_name
           from information_schema.column_privileges
          where grantee = 'saas_runtime' and table_name = 'compensation'
          order by 1`,
      );
      // The seven the read answers with, plus tenant_id, which a create has to
      // state. tests/schema-inventory.test.ts and
      // tests/people-compensation-write.test.ts pin which command sits on which
      // column; this test only proves the reach is still column-shaped.
      expect(columns.rows.map((row) => row.column_name)).toEqual([
        ...COMPENSATION_COLUMNS,
        'tenant_id',
      ].sort());

      // The table-level grants are unchanged: a column-only grant does not appear
      // in role_table_grants, and compensation is absent from it.
      const tables = await client.query<{ table_name: string }>(
        `select distinct table_name
           from information_schema.role_table_grants
          where grantee = 'saas_runtime' and table_schema = 'public'
          order by 1`,
      );
      expect(tables.rows.map((row) => row.table_name)).toEqual([
        'audit_event',
        'employment',
        'module_entitlement',
        'platform_module',
        'platform_module_dependency',
        'project',
      ]);

      // A column grant is not a table privilege, and there is still no DELETE at
      // any level: the read route cannot write, and no route can erase a row.
      const privileges = await client.query<{ privilege: string; allowed: boolean }>(
        `select p as privilege,
                has_table_privilege('saas_runtime', 'public.compensation', p) as allowed
           from unnest(array['SELECT','INSERT','UPDATE','DELETE']) p`,
      );
      expect(privileges.rows.every((row) => !row.allowed)).toBe(true);

      const acl = await client.query<{ entries: string[] | null }>(
        `select array_agg(item::text) as entries
           from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
          cross join lateral unnest(c.relacl) as item
          where n.nspname = 'public' and c.relname = 'compensation'`,
      );
      expect(one(acl.rows).entries).toEqual(['saas_owner=arwdDxtm/saas_owner']);

      // Nothing new is executable: 0013 adds no function and changes no helper.
      expect(await functionGrant(client, 'saas_runtime', 'app.person_visible(uuid)')).toBe(
        true,
      );
      expect(await functionGrant(client, 'saas_worker', 'app.person_visible(uuid)')).toBe(
        false,
      );
    });
  });

  test('pins the restrictive compensation read policy and the absence of any delete policy', async () => {
    await withOwner(async (client) => {
      const policies = await client.query<{
        polname: string;
        polcmd: string;
        permissive: boolean;
        using_clause: string | null;
      }>(
        `select p.polname, p.polcmd, p.polpermissive as permissive,
                pg_get_expr(p.polqual, p.polrelid) as using_clause
           from pg_policy p
           join pg_class c on c.oid = p.polrelid
          where c.relname = 'compensation' and p.polname like 'scope_%'
          order by p.polname`,
      );

      // Read-only by construction on the read side: the one predicate that gates
      // which salary rows a member can list is the directory's own visibility
      // oracle, and it is restrictive, so it can only ever narrow the tenant and
      // module layers in front of it. The two write policies below it arrived
      // with 0014 and are pinned there; the tenant-wide policy and grant
      // inventory stays in tests/schema-inventory.test.ts and tests/scope.test.ts,
      // which count every table. What this slice still insists on is the absence:
      // no scope_delete, because a salary row is superseded, never erased.
      expect(policies.rows.map((row) => row.polname)).toEqual([
        'scope_insert',
        'scope_read',
        'scope_update',
      ]);
      expect(policies.rows.filter((row) => row.polcmd === 'd')).toEqual([]);
      expect(
        policies.rows.filter((row) => row.polname === 'scope_read'),
      ).toEqual([
        {
          polname: 'scope_read',
          polcmd: 'r',
          permissive: false,
          using_clause: 'app.person_visible(person_id)',
        },
      ]);
    });
  });

  test('audits a denial that names the compensation permission', async () => {
    const a = fx().a;
    const before = await denialRows(a.tenantId);

    // The dotted name has three segments, which a shape-based validator that
    // assumed module.operation would reject - and the caller only logs a
    // rejection, so the symptom would be a missing audit row rather than an
    // error. This is the direct proof that the row lands.
    await recordAccessDenial(runtimePool(), {
      tenantId: a.tenantId,
      userId: a.userId,
      reason: 'ROLE_DENIED',
      method: 'GET',
      path: '/v1/people/:id/compensations',
      module: 'people',
      operation: 'read',
      permission: COMPENSATION_PERMISSION,
    });

    const after = await denialRows(a.tenantId);
    expect(after).toHaveLength(before.length + 1);
    expect(one(after.slice(-1))).toMatchObject({
      action: 'authorization.denied',
      entity_type: 'request',
      actor_user_id: a.userId,
      metadata: {
        reason: 'ROLE_DENIED',
        module: 'people',
        operation: 'read',
        permission: COMPENSATION_PERMISSION,
        method: 'GET',
        path: '/v1/people/:id/compensations',
      },
    });
  });

  test('keeps the permission set published and never answers a module operation with the compensation read', () => {
    expect(PERMISSIONS).toEqual([
      'people.read',
      'people.write',
      'people.compensation.read',
      'people.compensation.write',
      'work.read',
      'work.write',
    ]);
    // No module operation answers with the compensation permission: only a gate
    // that names it explicitly can ask for it.
    expect(permissionFor('people', 'read')).toBe('people.read');
    expect(permissionFor('people', 'write')).toBe('people.write');
    expect(permissionFor('work', 'read')).toBe('work.read');
    expect(permissionFor('work', 'write')).toBe('work.write');
  });
});
