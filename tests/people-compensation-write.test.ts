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
import {
  COMPENSATION_CTC_MINOR_MAX,
  PERMISSIONS,
  permissionFor,
} from '@saasmodels/contracts';
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
const USER_AGENT = 'People compensation write test/1.0';

// The write answer carries the same seven keys as the read answer, in the same
// order, because both are built from the same select fragment. Anything wider -
// the structure jsonb, the import provenance, the clock, tenant_id - must not
// reach the caller on a write either.
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

const COMPENSATION_PERMISSION = 'people.compensation.write';

// The only columns a salary row can hold, read owner-side so a write can be
// proven to have touched the one value it named and nothing else. id, tenant_id
// and person_id are in the list because a create states them and an update must
// not be able to.
const STORED_COLUMNS = [
  'id',
  'tenant_id',
  'person_id',
  'effective_from',
  'effective_to',
  'ctc_minor',
  'currency',
  'pay_frequency',
  'structure',
  'source_system',
  'source_id',
  'import_batch_id',
  'imported_at',
] as const;

type AuditRow = {
  action: string;
  entity_type: string;
  entity_id: string | null;
  actor_type: string;
  actor_user_id: string | null;
  metadata: Record<string, unknown>;
};

type CompensationResponse = {
  statusCode: number;
  headers: OutgoingHttpHeaders;
  body: string;
  payload: Record<string, unknown> | null;
  item: CompensationItem;
  list: CompensationListResponse;
};

type Sessions = {
  a: SessionFixture;
  b: SessionFixture;
  other: SessionFixture;
  hr: SessionFixture;
  finance: SessionFixture;
  manager: SessionFixture;
  auditor: SessionFixture;
  hrEntity: SessionFixture;
  hrSelfOutside: SessionFixture;
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
  | Record<'hr' | 'finance' | 'manager' | 'auditor' | 'hrEntity' | 'hrSelfOutside', Membership>
  | undefined;
let org: { entityA: string; entityB: string } | undefined;
// The hr member's own directory row, placed on the entity their scope does not
// cover. app.person_visible answers yes to it because it is theirs and
// app.person_in_scope answers no: the read half of the panel opens and the write
// half refuses, which is the asymmetry 0014 exists to enforce.
let selfOutside: { personId: string; compensationId: string } | undefined;
// createAccessFixtures never sets person.user_id, so its own employee row is
// unlinked and app.person_visible answers no for the self exception. This row is
// linked to the employee account, which is what makes the read/write oracle
// asymmetry real rather than assumed.
let employeeSelf: { personId: string; compensationId: string } | undefined;
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
  name: 'hr' | 'finance' | 'manager' | 'auditor' | 'hrEntity' | 'hrSelfOutside',
): Membership {
  if (!memberships) {
    throw new Error('Compensation write members have not been created');
  }
  return memberships[name];
}

function structure() {
  if (!org) {
    throw new Error('Compensation write structure has not been created');
  }
  return org;
}

function selfOutsidePerson() {
  if (!selfOutside) {
    throw new Error('The out-of-scope self person has not been created');
  }
  return selfOutside;
}

function employeeSelfPerson() {
  if (!employeeSelf) {
    throw new Error('The employee self person has not been created');
  }
  return employeeSelf;
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

/**
 * The runtime role inside an explicit tenant and user context, always rolled
 * back. This is the raw RLS-and-grant path: no entitlement and no role gate, so
 * what it refuses is the database half of the rule and nothing else.
 */
async function withMember<T>(
  tenantId: string | null,
  userId: string | null,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString: db().runtimeUrl });
  await client.connect();
  try {
    await client.query('begin');
    if (tenantId) {
      await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
    }
    if (userId) {
      await client.query("select set_config('app.user_id', $1, true)", [userId]);
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

type PgError = { code?: string; message: string; constraint?: string };

async function expectRuntimeError(
  tenantId: string,
  userId: string,
  sql: string,
  params: unknown[] = [],
): Promise<PgError> {
  return withMember(tenantId, userId, async (client) => {
    let error: PgError | undefined;
    try {
      await client.query(sql, params);
    } catch (caught) {
      error = caught as PgError;
    }
    if (!error) {
      throw new Error(`Expected the statement to fail: ${sql}`);
    }
    return error;
  });
}

async function compensationCountFor(personId: string): Promise<number> {
  return withOwner(async (client) => {
    const result = await client.query<{ total: string }>(
      'select count(*) as total from compensation where person_id = $1',
      [personId],
    );
    return Number(one(result.rows).total);
  });
}

async function ownerCompensationRow(id: string): Promise<Record<string, unknown> | null> {
  return withOwner(async (client) => {
    // The two date columns come back as text. A `date` is a calendar day, and
    // the driver would otherwise hand back a local-midnight Date that compares
    // equal to a UTC literal only in one timezone.
    const result = await client.query<Record<string, unknown>>(
      `select id, tenant_id, person_id,
              effective_from::text as effective_from,
              effective_to::text as effective_to,
              ctc_minor, currency, pay_frequency, structure,
              source_system, source_id, import_batch_id, imported_at
         from compensation
        where id = $1`,
      [id],
    );
    return result.rows[0] ?? null;
  });
}

/** The stored values a write is allowed to change, and everything it is not, as
 *  one comparable object. created_at and updated_at are left out because the
 *  clock is not a claim this slice makes. */
function storedValues(row: Record<string, unknown> | null): Record<string, unknown> {
  if (!row) {
    return {};
  }
  const picked: Record<string, unknown> = {};
  for (const column of STORED_COLUMNS) {
    if (column in row) {
      picked[column] = row[column];
    }
  }
  return picked;
}

async function compensationAuditRows(tenantId: string): Promise<AuditRow[]> {
  return withOwner(async (client) => {
    const result = await client.query<AuditRow>(
      `select action, entity_type, entity_id, actor_type, actor_user_id, metadata
         from audit_event
        where tenant_id = $1
          and action in ('compensation.created', 'compensation.updated')
        order by occurred_at, id`,
      [tenantId],
    );
    return result.rows;
  });
}

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
async function newPerson(
  tenantId: string,
  legalEntityId: string | null,
  options: { userId?: string; label?: string } = {},
): Promise<Subject> {
  subjectCounter += 1;
  const label = options.label ?? `subject${subjectCounter}`;
  const displayName = `Compensation write ${label}`;
  return withOwner(async (client) => {
    const result = await client.query<{ id: string }>(
      `insert into person
         (tenant_id, employee_code, first_name, display_name, work_email, phone,
          legal_entity_id, org_unit_id, user_id)
       values ($1, $2, 'Subject', $3, $4, '+1 555 0600', $5, null, $6)
       returning id`,
      [
        tenantId,
        `CW-${label}-${randomBytes(3).toString('hex')}`,
        displayName,
        `${label}_${randomToken().slice(0, 8)}@example.test`,
        legalEntityId,
        options.userId ?? null,
      ],
    );
    return { id: one(result.rows).id, displayName };
  });
}

function newSubject(
  legalEntityId: string | null,
  options: { userId?: string } = {},
): Promise<Subject> {
  return newPerson(fx().a.tenantId, legalEntityId, options);
}

/** A salary row the product did not write, so an amendment is tested against
 *  history that predates the screen. */
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

async function send(app: TestServer, options: SendOptions): Promise<CompensationResponse> {
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
    item: payload as unknown as CompensationItem,
    list: payload as unknown as CompensationListResponse,
  };
}

function history(
  app: TestServer,
  which: keyof Sessions,
  personId: string,
): Promise<CompensationResponse> {
  return send(app, {
    method: 'GET',
    url: `/v1/people/${personId}/compensations`,
    cookie: session(which).cookie,
  });
}

function addCompensation(
  app: TestServer,
  which: keyof Sessions,
  personId: string,
  body: unknown,
): Promise<CompensationResponse> {
  const s = session(which);
  return send(app, {
    method: 'POST',
    url: `/v1/people/${personId}/compensations`,
    cookie: s.cookie,
    csrf: s.csrfToken,
    body,
  });
}

function patchCompensation(
  app: TestServer,
  which: keyof Sessions,
  personId: string,
  compensationId: string,
  body: unknown,
): Promise<CompensationResponse> {
  const s = session(which);
  return send(app, {
    method: 'PATCH',
    url: `/v1/people/${personId}/compensations/${compensationId}`,
    cookie: s.cookie,
    csrf: s.csrfToken,
    body,
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
    [`${label}_${randomToken().slice(0, 8)}@example.test`, `Compensation write ${label}`],
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
      `cw_${randomToken().slice(0, 8)}`,
      one(jurisdiction.rows).jurisdiction_id,
    ],
  );
  return one(result.rows).id;
}

/** One body that every writer must be able to send, so the shape tests are read
 *  against a single create and only the refusals vary. */
function createBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    effectiveFrom: '2024-04-01',
    ctcMinor: 1234567,
    currency: 'INR',
    payFrequency: 'monthly',
    ...overrides,
  };
}

beforeAll(async () => {
  database = await createTestDatabase({ migrate: true, seed: true });
  runtime = createRuntimePool(database.runtimeUrl);
  auth = createAuthPool(database.authUrl);
  owner = new Pool({ connectionString: database.ownerUrl });

  await withOwner(async (client) => {
    fixtures = await createAccessFixtures(client);
    const a = fixtures.a;

    const entityB = await insertLegalEntity(client, 'Compensation write beta');
    org = { entityA: a.legalEntityId, entityB };

    const hrMember = await insertMember(client, 'hr', 'hr');
    const financeMember = await insertMember(client, 'finance', 'finance');
    const managerMember = await insertMember(client, 'manager', 'manager');
    const auditorMember = await insertMember(client, 'auditor', 'auditor');
    const hrEntityMember = await insertMember(client, 'hr', 'hrentity');
    const hrSelfMember = await insertMember(client, 'hr', 'hrself');
    memberships = {
      hr: hrMember,
      finance: financeMember,
      manager: managerMember,
      auditor: auditorMember,
      hrEntity: hrEntityMember,
      hrSelfOutside: hrSelfMember,
    };

    // The member's own directory row, placed on entity A while their own scope
    // covers only entity B, with a history already on it. The panel opens for
    // them and the write does not.
    const selfPerson = await newPerson(a.tenantId, org.entityA, {
      userId: hrSelfMember.userId,
      label: 'selfout',
    });
    const selfCompensation = await newCompensation(a.tenantId, selfPerson.id, {
      effectiveFrom: '2019-01-01',
      ctcMinor: 4444001,
    });
    selfOutside = { personId: selfPerson.id, compensationId: selfCompensation };

    // A person in the employee's own tenant, linked to the employee account, so
    // the self exception at the read oracle really is in play when the write
    // oracle refuses.
    const employeeLinked = await newPerson(fixtures.employee.tenantId, fixtures.employee.legalEntityId, {
      userId: fixtures.employee.userId,
      label: 'employeelink',
    });
    const employeeLinkedRow = await newCompensation(fixtures.employee.tenantId, employeeLinked.id, {
      effectiveFrom: '2024-04-01',
      ctcMinor: 5555001,
    });
    employeeSelf = { personId: employeeLinked.id, compensationId: employeeLinkedRow };

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
      hr: await createSessionFixture(client, {
        userId: hrMember.userId,
        tenantId: a.tenantId,
      }),
      finance: await createSessionFixture(client, {
        userId: financeMember.userId,
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
      hrEntity: await createSessionFixture(client, {
        userId: hrEntityMember.userId,
        tenantId: a.tenantId,
      }),
      hrSelfOutside: await createSessionFixture(client, {
        userId: hrSelfMember.userId,
        tenantId: a.tenantId,
      }),
      employee: await createSessionFixture(client, {
        userId: fixtures.employee.userId,
        tenantId: fixtures.employee.tenantId,
      }),
    };

    // Histories that must stay out of reach of tenant A: the employee's own
    // salary in its own entitled tenant (seeded above, on the linked row), and a
    // row in a second People-entitled tenant.
    await newCompensation(fixtures.dualModule.tenantId, fixtures.dualModule.personId, {
      effectiveFrom: '2024-07-01',
      ctcMinor: 7777777,
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
    membershipId: membership('hrSelfOutside').membershipId,
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

describe('Compensation create', () => {
  test('rejects the create route without a session, a CSRF token or the origin', async () => {
    const a = fx().a;
    const s = structure();
    const subject = await newSubject(s.entityA);
    const body = createBody();
    const beforeAudit = await compensationAuditRows(a.tenantId);

    await withApp(async (app) => {
      const noSession = await send(app, {
        method: 'POST',
        url: `/v1/people/${subject.id}/compensations`,
        csrf: session('a').csrfToken,
        body,
      });
      expect(noSession.statusCode).toBe(401);
      expect(noSession.payload).toEqual({ error: { code: 'UNAUTHENTICATED' } });
      expect(noSession.headers['cache-control']).toBe('no-store');

      for (const csrf of [undefined, 'wrong-token']) {
        const noCsrf = await send(app, {
          method: 'POST',
          url: `/v1/people/${subject.id}/compensations`,
          cookie: session('a').cookie,
          csrf,
          body,
        });
        expect(noCsrf.statusCode).toBe(403);
        expect(noCsrf.payload).toEqual({ error: { code: 'CSRF_INVALID' } });
        expect(noCsrf.headers['cache-control']).toBe('no-store');
      }

      const badOrigin = await send(app, {
        method: 'POST',
        url: `/v1/people/${subject.id}/compensations`,
        cookie: session('a').cookie,
        csrf: session('a').csrfToken,
        origin: 'https://evil.example.test',
        body,
      });
      expect(badOrigin.statusCode).toBe(403);
      expect(badOrigin.payload).toEqual({ error: { code: 'ORIGIN_DENIED' } });
      expect(badOrigin.headers['cache-control']).toBe('no-store');
    });

    expect(await compensationCountFor(subject.id)).toBe(0);
    expect(await compensationAuditRows(a.tenantId)).toHaveLength(beforeAudit.length);
  });

  test('creates for the three roles the permission names and answers the seven keys', async () => {
    const a = fx().a;
    const s = structure();

    for (const which of ['a', 'hr', 'finance'] as const) {
      const subject = await newSubject(s.entityA);
      const beforeAudit = await compensationAuditRows(a.tenantId);

      await withApp(async (app) => {
        const created = await addCompensation(app, which, subject.id, createBody());
        expect(created.statusCode).toBe(201);
        expect(created.headers['cache-control']).toBe('no-store');
        expect(Object.keys(created.item).sort()).toEqual(ITEM_KEYS);
        expect(created.item).toEqual({
          id: expect.any(String),
          personId: subject.id,
          effectiveFrom: '2024-04-01',
          effectiveTo: null,
          ctcMinor: 1234567,
          currency: 'INR',
          payFrequency: 'monthly',
        });

        // The answer is the row: the same select the list route uses returns the
        // same object, so a write cannot report a figure the history then hides.
        const list = await history(app, 'a', subject.id);
        expect(list.statusCode).toBe(200);
        expect(Object.keys(list.list).sort()).toEqual(LIST_KEYS);
        expect(list.list.total).toBe(1);
        expect(list.list.items).toEqual([created.item]);
      });

      const rows = await compensationAuditRows(a.tenantId);
      expect(rows).toHaveLength(beforeAudit.length + 1);
      const written = one(rows.slice(-1));
      expect(written).toMatchObject({
        action: 'compensation.created',
        entity_type: 'compensation',
        actor_type: 'user',
        metadata: { fields: ['ctcMinor', 'currency', 'effectiveFrom', 'payFrequency'] },
      });
      expect(Object.keys(written.metadata)).toEqual(['fields']);
    }
  });

  test('records every field name the caller sent and no value at all', async () => {
    const a = fx().a;
    const s = structure();
    const subject = await newSubject(s.entityA);
    const beforeAudit = await compensationAuditRows(a.tenantId);

    await withApp(async (app) => {
      const created = await addCompensation(
        app,
        'a',
        subject.id,
        createBody({ effectiveTo: '2025-03-31', ctcMinor: 9876543, payFrequency: 'weekly' }),
      );
      expect(created.statusCode).toBe(201);
    });

    const rows = await compensationAuditRows(a.tenantId);
    expect(rows).toHaveLength(beforeAudit.length + 1);
    const written = one(rows.slice(-1));
    // Sorted, and complete: the five names a create may send, and nothing beside
    // them. The amount, the two dates, the currency and the frequency all stay on
    // the row - an audit trail that copied them would be a second place a salary
    // could leak from.
    expect(written.metadata).toEqual({
      fields: ['ctcMinor', 'currency', 'effectiveFrom', 'effectiveTo', 'payFrequency'],
    });
    const serialized = JSON.stringify(written.metadata);
    expect(serialized).not.toContain('9876543');
    expect(serialized).not.toContain('2025-03-31');
    expect(serialized).not.toContain('2024-04-01');
    expect(serialized).not.toContain('INR');
    expect(serialized).not.toContain('weekly');
    expect(serialized).not.toContain(subject.id);
  });

  test('refuses manager, auditor and employee with one denial row each', async () => {
    const a = fx().a;
    const s = structure();
    const subject = await newSubject(s.entityA);
    const amount = 8765432;
    const body = createBody({ ctcMinor: amount });

    for (const which of ['manager', 'auditor'] as const) {
      const before = await denialRows(a.tenantId);
      const beforeAudit = await auditRowCount(a.tenantId);

      await withApp(async (app) => {
        const response = await addCompensation(app, which, subject.id, body);
        expect(response.statusCode).toBe(403);
        expect(response.payload).toEqual({
          error: { code: 'ROLE_DENIED', permission: COMPENSATION_PERMISSION },
        });
        expect(response.headers['cache-control']).toBe('no-store');
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
          operation: 'write',
          permission: COMPENSATION_PERMISSION,
          method: 'POST',
          path: '/v1/people/:id/compensations',
        },
      });
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

    expect(await compensationCountFor(subject.id)).toBe(0);
  });

  test('refuses an employee writing against their own linked directory row', async () => {
    const employee = fx().employee;
    const own = employeeSelfPerson();
    const before = await denialRows(employee.tenantId);

    await withApp(async (app) => {
      // This is the person row app.person_visible answers yes to: it is linked to
      // the caller's own user id. The role gate answers first, so the route never
      // reaches app.person_in_scope - and the write oracle would have refused too.
      const read = await history(app, 'employee', own.personId);
      expect(read.statusCode).toBe(403);
      expect(read.payload).toEqual({
        error: { code: 'ROLE_DENIED', permission: 'people.compensation.read' },
      });

      const response = await addCompensation(
        app,
        'employee',
        own.personId,
        createBody({ ctcMinor: 5555002 }),
      );
      expect(response.statusCode).toBe(403);
      expect(response.payload).toEqual({
        error: { code: 'ROLE_DENIED', permission: COMPENSATION_PERMISSION },
      });
      expect(response.body).not.toContain('5555001');
    });

    const after = await denialRows(employee.tenantId);
    expect(after).toHaveLength(before.length + 2);
    expect(after.slice(before.length).map((row) => row.metadata.permission)).toEqual([
      'people.compensation.read',
      COMPENSATION_PERMISSION,
    ]);
    expect(await compensationCountFor(own.personId)).toBe(1);
  });

  test('refuses a tenant without the People entitlement before the role check', async () => {
    const b = fx().b;
    const before = await denialRows(b.tenantId);

    await withApp(async (app) => {
      // An admin, so the role would pass: only the entitlement can be answering,
      // and it has to answer first.
      expect(b.role).toBe('admin');
      const response = await addCompensation(
        app,
        'b',
        b.personId,
        createBody({ ctcMinor: 3333001 }),
      );
      expect(response.statusCode).toBe(403);
      expect(response.payload).toEqual({
        error: { code: 'MODULE_NOT_ENTITLED', module: 'people', operation: 'write' },
      });
      expect(response.headers['cache-control']).toBe('no-store');
    });

    const after = await denialRows(b.tenantId);
    expect(after).toHaveLength(before.length + 1);
    expect(one(after.slice(-1)).metadata.reason).toBe('MODULE_NOT_ENTITLED');
    expect(await compensationCountFor(b.personId)).toBe(0);
  });

  test('answers 403 SCOPE_DENIED where the person is visible but not maintainable', async () => {
    const a = fx().a;
    const self = selfOutsidePerson();
    const beforeAudit = await compensationAuditRows(a.tenantId);
    const before = await ownerCompensationRow(self.compensationId);

    await withApp(async (app) => {
      // The read half opens: this is the caller's own directory row, so
      // app.person_visible answers yes and the history is theirs to see.
      const read = await history(app, 'hrSelfOutside', self.personId);
      expect(read.statusCode).toBe(200);
      expect(read.list.total).toBe(1);

      // The write half refuses, and says so rather than pretending the person
      // does not exist: app.person_in_scope has no self exception.
      const created = await addCompensation(
        app,
        'hrSelfOutside',
        self.personId,
        createBody({ effectiveFrom: '2026-01-01', ctcMinor: 2222002 }),
      );
      expect(created.statusCode).toBe(403);
      expect(created.payload).toEqual({ error: { code: 'SCOPE_DENIED' } });
      expect(created.headers['cache-control']).toBe('no-store');

      const patched = await patchCompensation(
        app,
        'hrSelfOutside',
        self.personId,
        self.compensationId,
        { ctcMinor: 2222003 },
      );
      expect(patched.statusCode).toBe(403);
      expect(patched.payload).toEqual({ error: { code: 'SCOPE_DENIED' } });
    });

    expect(await compensationCountFor(self.personId)).toBe(1);
    expect(await ownerCompensationRow(self.compensationId)).toEqual(before);
    expect(await compensationAuditRows(a.tenantId)).toHaveLength(beforeAudit.length);
  });

  test('lets an entity-scoped hr write inside the entity and keeps the rest invisible', async () => {
    const a = fx().a;
    const s = structure();
    const onA = await newSubject(s.entityA);
    const onB = await newSubject(s.entityB);
    const unplaced = await newSubject(null);
    const beforeAudit = await compensationAuditRows(a.tenantId);

    await withApp(async (app) => {
      const inside = await addCompensation(
        app,
        'hrEntity',
        onA.id,
        createBody({ ctcMinor: 6161001 }),
      );
      expect(inside.statusCode).toBe(201);

      // Outside the entity the directory itself is closed to this member: the
      // person is read under app.person_visible, which a scope row narrows, so
      // the answer is the uniform person miss and not a scope refusal. The
      // 403 SCOPE_DENIED belongs to the case where the read oracle is wider than
      // the write oracle - tested above with a member's own out-of-scope row.
      for (const [personId, marker] of [
        [onB.id, '6161002'],
        [unplaced.id, '6161003'],
      ] as const) {
        const outside = await addCompensation(
          app,
          'hrEntity',
          personId,
          createBody({ ctcMinor: Number(marker) }),
        );
        expect(outside.statusCode).toBe(404);
        expect(outside.payload).toEqual({ error: { code: 'PERSON_NOT_FOUND' } });
        expect(outside.body).not.toContain(marker);
      }
    });

    expect(await compensationCountFor(onA.id)).toBe(1);
    expect(await compensationCountFor(onB.id)).toBe(0);
    expect(await compensationCountFor(unplaced.id)).toBe(0);
    expect(await compensationAuditRows(a.tenantId)).toHaveLength(beforeAudit.length + 1);
  });

  test('keeps another tenant person invisible and answers the same 404', async () => {
    const a = fx().a;
    const other = fx().dualModule;

    await withApp(async (app) => {
      // The same member, the same permission and the same body: in its own tenant
      // the create works, so the 404 below can only come from isolation.
      const own = await addCompensation(
        app,
        'other',
        other.personId,
        createBody({ effectiveFrom: '2025-01-01', ctcMinor: 7777778 }),
      );
      expect(own.statusCode).toBe(201);

      for (const [which, personId] of [
        ['other', a.personId],
        ['a', other.personId],
      ] as const) {
        const response = await addCompensation(app, which, personId, createBody());
        expect(response.statusCode).toBe(404);
        expect(response.payload).toEqual({ error: { code: 'PERSON_NOT_FOUND' } });
        expect(response.headers['cache-control']).toBe('no-store');
      }
    });

    expect(await compensationCountFor(other.personId)).toBe(2);
    expect(await compensationCountFor(a.personId)).toBe(0);
  });

  test('answers 404 for an unknown, a malformed and a soft-deleted person', async () => {
    const a = fx().a;
    const s = structure();
    const beforeAudit = await compensationAuditRows(a.tenantId);

    await withApp(async (app) => {
      for (const personId of [
        randomUUID(),
        'not-a-uuid',
        s.entityA,
        fx().softDeletedPerson.id,
      ]) {
        const created = await addCompensation(app, 'a', personId, createBody());
        expect(created.statusCode).toBe(404);
        expect(created.payload).toEqual({ error: { code: 'PERSON_NOT_FOUND' } });
        expect(created.headers['cache-control']).toBe('no-store');

        const patched = await patchCompensation(
          app,
          'a',
          personId,
          randomUUID(),
          { ctcMinor: 1 },
        );
        expect(patched.statusCode).toBe(404);
        expect(patched.payload).toEqual({ error: { code: 'PERSON_NOT_FOUND' } });
      }
    });

    expect(await compensationCountFor(fx().softDeletedPerson.id)).toBe(0);
    expect(await compensationAuditRows(a.tenantId)).toHaveLength(beforeAudit.length);
  });

  test('decides the person and the scope before it reads the body', async () => {
    const s = structure();
    const subject = await newSubject(s.entityA);
    const broken = { effectiveFrom: 'not-a-day', ctcMinor: -5, extra: true };

    await withApp(async (app) => {
      // A role that may not write gets the same answer whatever the body says,
      // so a malformed payload cannot be used to probe which people a member may
      // maintain.
      const role = await addCompensation(app, 'manager', subject.id, broken);
      expect(role.statusCode).toBe(403);
      expect(role.payload).toEqual({
        error: { code: 'ROLE_DENIED', permission: COMPENSATION_PERMISSION },
      });

      const missing = await addCompensation(app, 'a', randomUUID(), broken);
      expect(missing.statusCode).toBe(404);
      expect(missing.payload).toEqual({ error: { code: 'PERSON_NOT_FOUND' } });

      // The scope question is asked with the person, before the body is read. The
      // caller here can see the person - it is their own directory row - but may
      // not maintain it, which is the only shape that reaches SCOPE_DENIED at all.
      const self = selfOutsidePerson();
      const outside = await addCompensation(
        app,
        'hrSelfOutside',
        self.personId,
        { ...broken, effectiveFrom: '2027-02-03' },
      );
      expect(outside.statusCode).toBe(403);
      expect(outside.payload).toEqual({ error: { code: 'SCOPE_DENIED' } });

      // Only a caller who may write this person is told their body is wrong.
      const written = await addCompensation(app, 'a', subject.id, broken);
      expect(written.statusCode).toBe(400);
      expect(written.payload).toEqual({ error: { code: 'INVALID_BODY' } });
    });

    expect(await compensationCountFor(subject.id)).toBe(0);
  });

  test('refuses a second row for the same day with COMPENSATION_PERIOD_EXISTS', async () => {
    const a = fx().a;
    const s = structure();
    const subject = await newSubject(s.entityA);
    const beforeAudit = await compensationAuditRows(a.tenantId);

    await withApp(async (app) => {
      const first = await addCompensation(
        app,
        'a',
        subject.id,
        createBody({ effectiveFrom: '2024-01-01', ctcMinor: 5000000 }),
      );
      expect(first.statusCode).toBe(201);

      // Same person, same day, different figure: the key the table holds is the
      // day, not the amount, so the second row has nowhere to go.
      const second = await addCompensation(
        app,
        'a',
        subject.id,
        createBody({ effectiveFrom: '2024-01-01', ctcMinor: 5999999 }),
      );
      expect(second.statusCode).toBe(409);
      expect(second.payload).toEqual({ error: { code: 'COMPENSATION_PERIOD_EXISTS' } });
      expect(second.headers['cache-control']).toBe('no-store');
      expect(second.body).not.toContain('5999999');

      // A different person may hold the same day: the key is per person.
      const otherSubject = await newSubject(s.entityA);
      const elsewhere = await addCompensation(
        app,
        'a',
        otherSubject.id,
        createBody({ effectiveFrom: '2024-01-01', ctcMinor: 5000000 }),
      );
      expect(elsewhere.statusCode).toBe(201);
    });

    expect(await compensationCountFor(subject.id)).toBe(1);
    expect(await compensationAuditRows(a.tenantId)).toHaveLength(beforeAudit.length + 2);
  });

  test('accepts two rows whose periods overlap and keeps the rule to the stored key', async () => {
    const a = fx().a;
    const s = structure();
    const subject = await newSubject(s.entityA);
    const beforeAudit = await compensationAuditRows(a.tenantId);

    await withApp(async (app) => {
      const open = await addCompensation(
        app,
        'a',
        subject.id,
        createBody({ effectiveFrom: '2024-01-01', effectiveTo: null, ctcMinor: 4000000 }),
      );
      expect(open.statusCode).toBe(201);

      // Overlapping days, neither of them equal: nothing here decides which of the
      // two figures is the one in force. The table has no rule to break and the
      // route invents none - the documented residual in ADR 0012.
      const overlapping = await addCompensation(
        app,
        'a',
        subject.id,
        createBody({
          effectiveFrom: '2024-06-01',
          effectiveTo: '2024-12-31',
          ctcMinor: 4500000,
        }),
      );
      expect(overlapping.statusCode).toBe(201);

      const list = await history(app, 'a', subject.id);
      expect(list.list.total).toBe(2);
      expect(list.list.items.map((item) => item.effectiveFrom)).toEqual([
        '2024-06-01',
        '2024-01-01',
      ]);
    });

    const rows = await compensationAuditRows(a.tenantId);
    expect(rows).toHaveLength(beforeAudit.length + 2);
    // The names the caller sent, in sorted order, and nothing else: the open row
    // stated effective_to as null, so null is still a field the caller named.
    expect(rows.slice(beforeAudit.length).map((row) => row.metadata)).toEqual([
      { fields: ['ctcMinor', 'currency', 'effectiveFrom', 'effectiveTo', 'payFrequency'] },
      { fields: ['ctcMinor', 'currency', 'effectiveFrom', 'effectiveTo', 'payFrequency'] },
    ]);
  });

  test('refuses every body that is not the closed create shape', async () => {
    const a = fx().a;
    const s = structure();
    const subject = await newSubject(s.entityA);
    const beforeAudit = await compensationAuditRows(a.tenantId);

    const refusals: unknown[] = [
      {},
      [],
      null,
      'monthly',
      { effectiveFrom: '2024-04-01', ctcMinor: 100, currency: 'INR' },
      { ctcMinor: 100, currency: 'INR', payFrequency: 'monthly' },
      { effectiveFrom: '2024-04-01', currency: 'INR', payFrequency: 'monthly' },
      { effectiveFrom: '2024-04-01', ctcMinor: 100, payFrequency: 'monthly' },
      { effectiveFrom: '2024-04-01', ctcMinor: 100, currency: 'INR', payFrequency: 'monthly', personId: subject.id },
      { effectiveFrom: '2024-04-01', ctcMinor: 100, currency: 'INR', payFrequency: 'monthly', tenant_id: a.tenantId },
      { effectiveFrom: '2024-04-01', ctcMinor: 100, currency: 'INR', payFrequency: 'monthly', structure: { basic: 80 } },
      { effectiveFrom: '2024-04-01', ctcMinor: 100, currency: 'INR', payFrequency: 'monthly', source_system: 'sheets' },
      { effectiveFrom: '2024-04-01', ctcMinor: 100, currency: 'INR', payFrequency: 'monthly', effective_to: null },
      // Not a real day, and not the shape of one.
      { effectiveFrom: '2024-02-30', ctcMinor: 100, currency: 'INR', payFrequency: 'monthly' },
      { effectiveFrom: '2024-13-01', ctcMinor: 100, currency: 'INR', payFrequency: 'monthly' },
      { effectiveFrom: '2024-4-1', ctcMinor: 100, currency: 'INR', payFrequency: 'monthly' },
      { effectiveFrom: '2024-04-01T00:00:00Z', ctcMinor: 100, currency: 'INR', payFrequency: 'monthly' },
      { effectiveFrom: null, ctcMinor: 100, currency: 'INR', payFrequency: 'monthly' },
      // A period that ends before it begins, in both directions of the pair.
      { effectiveFrom: '2024-04-01', effectiveTo: '2024-03-31', ctcMinor: 100, currency: 'INR', payFrequency: 'monthly' },
      { effectiveFrom: '2024-04-02', effectiveTo: '2024-04-01', ctcMinor: 100, currency: 'INR', payFrequency: 'monthly' },
      { effectiveTo: 'not-a-day', ctcMinor: 100, currency: 'INR', payFrequency: 'monthly', effectiveFrom: '2024-04-01' },
      // Money and its currency, each refused on its own terms.
      { effectiveFrom: '2024-04-01', ctcMinor: -1, currency: 'INR', payFrequency: 'monthly' },
      { effectiveFrom: '2024-04-01', ctcMinor: 100.5, currency: 'INR', payFrequency: 'monthly' },
      { effectiveFrom: '2024-04-01', ctcMinor: '100000', currency: 'INR', payFrequency: 'monthly' },
      { effectiveFrom: '2024-04-01', ctcMinor: null, currency: 'INR', payFrequency: 'monthly' },
      { effectiveFrom: '2024-04-01', ctcMinor: 1e21, currency: 'INR', payFrequency: 'monthly' },
      { effectiveFrom: '2024-04-01', ctcMinor: 100, currency: 'inr', payFrequency: 'monthly' },
      { effectiveFrom: '2024-04-01', ctcMinor: 100, currency: 'IN', payFrequency: 'monthly' },
      { effectiveFrom: '2024-04-01', ctcMinor: 100, currency: 'INRR', payFrequency: 'monthly' },
      { effectiveFrom: '2024-04-01', ctcMinor: 100, currency: 'IN1', payFrequency: 'monthly' },
      { effectiveFrom: '2024-04-01', ctcMinor: 100, currency: ' In', payFrequency: 'monthly' },
      { effectiveFrom: '2024-04-01', ctcMinor: 100, currency: null, payFrequency: 'monthly' },
      { effectiveFrom: '2024-04-01', ctcMinor: 100, currency: 'INR', payFrequency: 'yearly' },
      { effectiveFrom: '2024-04-01', ctcMinor: 100, currency: 'INR', payFrequency: 'Monthly' },
      { effectiveFrom: '2024-04-01', ctcMinor: 100, currency: 'INR', payFrequency: 1 },
      { effectiveFrom: '2024-04-01', ctcMinor: 100, currency: 'INR', payFrequency: null },
    ];

    await withApp(async (app) => {
      for (const body of refusals) {
        const response = await addCompensation(app, 'a', subject.id, body);
        expect(response.statusCode).toBe(400);
        expect(response.payload).toEqual({ error: { code: 'INVALID_BODY' } });
        expect(response.headers['cache-control']).toBe('no-store');
      }

      // A currency is stored exactly as sent or not at all: nothing upper-cases it
      // on the caller's behalf.
      const lower = await addCompensation(
        app,
        'a',
        subject.id,
        createBody({ currency: 'inr', ctcMinor: 7654321 }),
      );
      expect(lower.statusCode).toBe(400);
      expect(await compensationCountFor(subject.id)).toBe(0);
    });

    expect(await compensationCountFor(subject.id)).toBe(0);
    expect(await compensationAuditRows(a.tenantId)).toHaveLength(beforeAudit.length);
  });

  test('holds the amount to what a JavaScript number can carry exactly', async () => {
    const s = structure();
    const subject = await newSubject(s.entityA);

    await withApp(async (app) => {
      const zero = await addCompensation(app, 'a', subject.id, createBody({ ctcMinor: 0 }));
      expect(zero.statusCode).toBe(201);
      expect(zero.item.ctcMinor).toBe(0);

      const largest = await addCompensation(
        app,
        'a',
        subject.id,
        createBody({ effectiveFrom: '2025-01-01', ctcMinor: COMPENSATION_CTC_MINOR_MAX }),
      );
      expect(largest.statusCode).toBe(201);
      // The figure crosses the wire whole: no rounding, no float, no truncation.
      expect(largest.item.ctcMinor).toBe(COMPENSATION_CTC_MINOR_MAX);

      // One minor unit past what a Number can hold is refused, not tidied. The
      // route cannot answer a safe integer for it and will not invent one.
      const pastSafe = await addCompensation(
        app,
        'a',
        subject.id,
        createBody({ effectiveFrom: '2026-01-01', ctcMinor: 9007199254740992 }),
      );
      expect(pastSafe.statusCode).toBe(400);
      expect(pastSafe.payload).toEqual({ error: { code: 'INVALID_BODY' } });

      // The list is read with the same fragments the write answer uses, so the
      // two rows come back exactly as stored: the bigint whole, newest first.
      const stored = await history(app, 'a', subject.id);
      expect(stored.list.total).toBe(2);
      expect(stored.list.items.map((item) => item.ctcMinor)).toEqual([
        COMPENSATION_CTC_MINOR_MAX,
        0,
      ]);
    });
  });

  test('marks every create outcome uncacheable', async () => {
    const s = structure();
    const subject = await newSubject(s.entityA);
    const otherSubject = await newSubject(s.entityA);
    await newCompensation(fx().a.tenantId, otherSubject.id, {
      effectiveFrom: '2024-04-01',
      ctcMinor: 1234567,
      currency: 'INR',
    });
    const statuses: number[] = [];

    await withApp(async (app) => {
      const ok = await addCompensation(app, 'a', subject.id, createBody());
      statuses.push(ok.statusCode);
      statuses.push((await addCompensation(app, 'a', subject.id, {})).statusCode);
      statuses.push(
        (await send(app, { method: 'POST', url: `/v1/people/${subject.id}/compensations`, body: createBody() }))
          .statusCode,
      );
      statuses.push(
        (await send(app, {
          method: 'POST',
          url: `/v1/people/${subject.id}/compensations`,
          cookie: session('a').cookie,
          csrf: session('a').csrfToken,
          origin: 'https://evil.example.test',
          body: createBody(),
        })).statusCode,
      );
      statuses.push(
        (await addCompensation(app, 'manager', subject.id, createBody())).statusCode,
      );
      statuses.push(
        (await addCompensation(app, 'a', randomUUID(), createBody())).statusCode,
      );
      statuses.push(
        (await addCompensation(app, 'a', otherSubject.id, createBody())).statusCode,
      );
    });

    expect(statuses).toEqual([201, 400, 401, 403, 403, 404, 409]);
  });
});

describe('Compensation update', () => {
  test('rejects the update route without a session, a CSRF token or the origin', async () => {
    const a = fx().a;
    const s = structure();
    const subject = await newSubject(s.entityA);
    const compensationId = await newCompensation(a.tenantId, subject.id, {
      effectiveFrom: '2023-01-01',
      ctcMinor: 3000000,
      currency: 'INR',
    });
    const before = await compensationAuditRows(a.tenantId);

    await withApp(async (app) => {
      const noSession = await send(app, {
        method: 'PATCH',
        url: `/v1/people/${subject.id}/compensations/${compensationId}`,
        csrf: session('a').csrfToken,
        body: { ctcMinor: 3100000 },
      });
      expect(noSession.statusCode).toBe(401);

      for (const csrf of [undefined, 'wrong-token']) {
        const noCsrf = await send(app, {
          method: 'PATCH',
          url: `/v1/people/${subject.id}/compensations/${compensationId}`,
          cookie: session('a').cookie,
          csrf,
          body: { ctcMinor: 3100000 },
        });
        expect(noCsrf.statusCode).toBe(403);
        expect(noCsrf.payload).toEqual({ error: { code: 'CSRF_INVALID' } });
      }

      const badOrigin = await send(app, {
        method: 'PATCH',
        url: `/v1/people/${subject.id}/compensations/${compensationId}`,
        cookie: session('a').cookie,
        csrf: session('a').csrfToken,
        origin: 'https://evil.example.test',
        body: { ctcMinor: 3100000 },
      });
      expect(badOrigin.statusCode).toBe(403);
      expect(badOrigin.payload).toEqual({ error: { code: 'ORIGIN_DENIED' } });
    });

    expect(await compensationCountFor(subject.id)).toBe(1);
    expect(storedValues(await ownerCompensationRow(compensationId))).toMatchObject({
      ctc_minor: '3000000',
    });
    expect(await compensationAuditRows(a.tenantId)).toHaveLength(before.length);
  });

  test('amends one value and leaves every other column where it was', async () => {
    const a = fx().a;
    const s = structure();
    const subject = await newSubject(s.entityA);
    const compensationId = await newCompensation(a.tenantId, subject.id, {
      effectiveFrom: '2024-04-01',
      effectiveTo: '2025-03-31',
      ctcMinor: 5432100,
      currency: 'USD',
      payFrequency: 'semi_monthly',
    });
    const before = storedValues(await ownerCompensationRow(compensationId));
    const beforeAudit = await compensationAuditRows(a.tenantId);

    await withApp(async (app) => {
      const response = await patchCompensation(app, 'a', subject.id, compensationId, {
        ctcMinor: 5432101,
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(Object.keys(response.item).sort()).toEqual(ITEM_KEYS);
      expect(response.item).toEqual({
        id: compensationId,
        personId: subject.id,
        effectiveFrom: '2024-04-01',
        effectiveTo: '2025-03-31',
        ctcMinor: 5432101,
        currency: 'USD',
        payFrequency: 'semi_monthly',
      });
    });

    const after = storedValues(await ownerCompensationRow(compensationId));
    expect(after).toEqual({ ...before, ctc_minor: '5432101' });

    const rows = await compensationAuditRows(a.tenantId);
    expect(rows).toHaveLength(beforeAudit.length + 1);
    expect(one(rows.slice(-1))).toMatchObject({
      action: 'compensation.updated',
      entity_type: 'compensation',
      entity_id: compensationId,
      actor_user_id: fx().a.userId,
      metadata: { fields: ['ctcMinor'] },
    });
  });

  test('treats a change-free patch as a no-op with no write and no audit', async () => {
    const a = fx().a;
    const s = structure();
    const subject = await newSubject(s.entityA);
    const compensationId = await newCompensation(a.tenantId, subject.id, {
      effectiveFrom: '2024-04-01',
      ctcMinor: 2345678,
      currency: 'INR',
      payFrequency: 'weekly',
    });
    const before = await ownerCompensationRow(compensationId);
    const beforeAudit = await compensationAuditRows(a.tenantId);

    await withApp(async (app) => {
      // The same values, sent as a full patch: nothing moved, so nothing is
      // written and nothing is recorded.
      const same = await patchCompensation(app, 'a', subject.id, compensationId, {
        effectiveFrom: '2024-04-01',
        ctcMinor: 2345678,
        currency: 'INR',
        payFrequency: 'weekly',
      });
      expect(same.statusCode).toBe(200);
      expect(same.item.ctcMinor).toBe(2345678);

      // An open period patched to open again: effective_to is the one key a null
      // may state, and null against null changes nothing.
      const openAgain = await patchCompensation(app, 'hr', subject.id, compensationId, {
        effectiveTo: null,
      });
      expect(openAgain.statusCode).toBe(200);
      expect(openAgain.item.effectiveTo).toBeNull();
    });

    expect(await ownerCompensationRow(compensationId)).toEqual(before);
    expect(await compensationAuditRows(a.tenantId)).toHaveLength(beforeAudit.length);
  });

  test('closes and reopens a period with the one key a null may state', async () => {
    const a = fx().a;
    const s = structure();
    const subject = await newSubject(s.entityA);
    const compensationId = await newCompensation(a.tenantId, subject.id, {
      effectiveFrom: '2024-04-01',
      ctcMinor: 6543210,
      currency: 'INR',
    });
    const beforeAudit = await compensationAuditRows(a.tenantId);

    await withApp(async (app) => {
      const closed = await patchCompensation(app, 'finance', subject.id, compensationId, {
        effectiveTo: '2024-09-30',
      });
      expect(closed.statusCode).toBe(200);
      expect(closed.item.effectiveTo).toBe('2024-09-30');

      const reopened = await patchCompensation(app, 'finance', subject.id, compensationId, {
        effectiveTo: null,
      });
      expect(reopened.statusCode).toBe(200);
      expect(reopened.item.effectiveTo).toBeNull();
    });

    const rows = await compensationAuditRows(a.tenantId);
    expect(rows.map((row) => row.metadata)).toEqual([
      ...beforeAudit.map((row) => row.metadata),
      { fields: ['effectiveTo'] },
      { fields: ['effectiveTo'] },
    ]);
    expect(storedValues(await ownerCompensationRow(compensationId))).toMatchObject({
      effective_to: null,
    });
  });

  test('refuses null for the four values a row always holds', async () => {
    const s = structure();
    const subject = await newSubject(s.entityA);
    const compensationId = await newCompensation(fx().a.tenantId, subject.id, {
      effectiveFrom: '2024-04-01',
      ctcMinor: 1112223,
      currency: 'INR',
    });
    const before = await ownerCompensationRow(compensationId);

    await withApp(async (app) => {
      for (const key of ['effectiveFrom', 'ctcMinor', 'currency', 'payFrequency'] as const) {
        const response = await patchCompensation(app, 'a', subject.id, compensationId, {
          [key]: null,
        });
        expect(response.statusCode).toBe(400);
        expect(response.payload).toEqual({ error: { code: 'INVALID_BODY' } });
      }
    });

    expect(await ownerCompensationRow(compensationId)).toEqual(before);
  });

  test('decides the merged pair, not the two sent halves', async () => {
    const s = structure();
    const subject = await newSubject(s.entityA);
    const compensationId = await newCompensation(fx().a.tenantId, subject.id, {
      effectiveFrom: '2024-06-01',
      effectiveTo: '2024-12-31',
      ctcMinor: 7000000,
      currency: 'INR',
    });
    const before = await ownerCompensationRow(compensationId);

    await withApp(async (app) => {
      // Each half is a valid day; only the row they merge into is impossible.
      const tooEarly = await patchCompensation(app, 'a', subject.id, compensationId, {
        effectiveTo: '2024-05-31',
      });
      expect(tooEarly.statusCode).toBe(400);

      const tooLate = await patchCompensation(app, 'a', subject.id, compensationId, {
        effectiveFrom: '2025-01-01',
      });
      expect(tooLate.statusCode).toBe(400);

      // A patch that moves both halves at once is a normal write.
      const moved = await patchCompensation(app, 'a', subject.id, compensationId, {
        effectiveFrom: '2025-01-01',
        effectiveTo: '2025-06-30',
      });
      expect(moved.statusCode).toBe(200);
      expect(moved.item).toMatchObject({
        effectiveFrom: '2025-01-01',
        effectiveTo: '2025-06-30',
        ctcMinor: 7000000,
      });
    });

    expect(storedValues(await ownerCompensationRow(compensationId))).not.toEqual(
      storedValues(before),
    );
  });

  test('answers 404 COMPENSATION_NOT_FOUND for a row this caller cannot reach', async () => {
    const a = fx().a;
    const s = structure();
    const mine = await newSubject(s.entityA);
    const theirs = await newSubject(s.entityA);
    const myRow = await newCompensation(a.tenantId, mine.id, {
      effectiveFrom: '2024-04-01',
      ctcMinor: 8100000,
      currency: 'INR',
    });
    const theirRow = await newCompensation(a.tenantId, theirs.id, {
      effectiveFrom: '2024-04-01',
      ctcMinor: 8200000,
      currency: 'INR',
    });
    const beforeTheirs = await ownerCompensationRow(theirRow);

    await withApp(async (app) => {
      // Their person, my row id, and the two answers the route is allowed to give
      // are one: a caller cannot use this path to find out whose row an id is.
      const wrongPerson = await patchCompensation(app, 'a', mine.id, theirRow, {
        ctcMinor: 8999999,
      });
      expect(wrongPerson.statusCode).toBe(404);
      expect(wrongPerson.payload).toEqual({ error: { code: 'COMPENSATION_NOT_FOUND' } });
      expect(wrongPerson.body).not.toContain('8200000');

      for (const id of [randomUUID(), 'not-a-uuid', s.entityA]) {
        const missing = await patchCompensation(app, 'a', mine.id, id, { ctcMinor: 1 });
        expect(missing.statusCode).toBe(404);
        expect(missing.payload).toEqual({ error: { code: 'COMPENSATION_NOT_FOUND' } });
      }

      // A soft-deleted person's row is answered as the person miss, because the
      // directory is checked first.
      const deletedPerson = fx().softDeletedPerson.id;
      const onDeleted = await patchCompensation(app, 'a', deletedPerson, myRow, {
        ctcMinor: 1,
      });
      expect(onDeleted.statusCode).toBe(404);
      expect(onDeleted.payload).toEqual({ error: { code: 'PERSON_NOT_FOUND' } });
    });

    // Neither refusal touched the row it named.
    expect(await ownerCompensationRow(theirRow)).toEqual(beforeTheirs);
    expect(storedValues(await ownerCompensationRow(myRow))).toMatchObject({
      ctc_minor: '8100000',
    });
  });

  test('answers the person miss before the row miss', async () => {
    const a = fx().a;
    const s = structure();
    const subject = await newSubject(s.entityA);
    const compensationId = await newCompensation(a.tenantId, subject.id, {
      effectiveFrom: '2024-04-01',
      ctcMinor: 9100000,
      currency: 'INR',
    });

    await withApp(async (app) => {
      // A real row addressed through a person who is not in the directory at all:
      // the directory answers first, so the row is never looked up and the caller
      // gets the person miss, not the row miss.
      const response = await patchCompensation(
        app,
        'a',
        randomUUID(),
        compensationId,
        { ctcMinor: 9200000 },
      );
      expect(response.statusCode).toBe(404);
      expect(response.payload).toEqual({ error: { code: 'PERSON_NOT_FOUND' } });

      // The same row, addressed through a person that exists but does not hold it:
      // the directory passes, and now the row miss is the answer.
      const rowMiss = await patchCompensation(
        app,
        'a',
        (await newSubject(s.entityA)).id,
        compensationId,
        { ctcMinor: 9200000 },
      );
      expect(rowMiss.statusCode).toBe(404);
      expect(rowMiss.payload).toEqual({ error: { code: 'COMPENSATION_NOT_FOUND' } });
    });

    expect(storedValues(await ownerCompensationRow(compensationId))).toMatchObject({
      ctc_minor: '9100000',
    });
  });

  test('refuses a patch that names no field or a field the route does not write', async () => {
    const s = structure();
    const subject = await newSubject(s.entityA);
    const compensationId = await newCompensation(fx().a.tenantId, subject.id, {
      effectiveFrom: '2024-04-01',
      ctcMinor: 1500000,
      currency: 'INR',
    });
    const before = await ownerCompensationRow(compensationId);

    await withApp(async (app) => {
      for (const body of [
        {},
        [],
        null,
        { structure: { basic: 90 } },
        { personId: subject.id },
        { tenant_id: fx().a.tenantId },
        { source_id: 'row-7' },
        { imported_at: '2024-04-01T00:00:00Z' },
        { ctcMinor: 1600000, id: compensationId },
        { effective_to: '2024-09-30' },
      ]) {
        const response = await patchCompensation(app, 'a', subject.id, compensationId, body);
        expect(response.statusCode).toBe(400);
        expect(response.payload).toEqual({ error: { code: 'INVALID_BODY' } });
      }
    });

    expect(await ownerCompensationRow(compensationId)).toEqual(before);
  });

  test('refuses a patch that would collide with a stored day', async () => {
    const a = fx().a;
    const s = structure();
    const subject = await newSubject(s.entityA);
    const first = await newCompensation(a.tenantId, subject.id, {
      effectiveFrom: '2024-01-01',
      ctcMinor: 1000000,
      currency: 'INR',
    });
    const second = await newCompensation(a.tenantId, subject.id, {
      effectiveFrom: '2025-01-01',
      ctcMinor: 2000000,
      currency: 'INR',
    });
    const beforeAudit = await compensationAuditRows(a.tenantId);

    await withApp(async (app) => {
      const collision = await patchCompensation(app, 'a', subject.id, second, {
        effectiveFrom: '2024-01-01',
      });
      expect(collision.statusCode).toBe(409);
      expect(collision.payload).toEqual({ error: { code: 'COMPENSATION_PERIOD_EXISTS' } });
      expect(collision.headers['cache-control']).toBe('no-store');

      // The same day on a different person is not a collision: the key the table
      // holds is (tenant, person, day), so person two may open a row on the day
      // person one already occupies.
      const elsewhereSubject = await newSubject(s.entityA);
      const elsewhereRow = await newCompensation(a.tenantId, elsewhereSubject.id, {
        effectiveFrom: '2024-06-01',
        ctcMinor: 3000000,
        currency: 'INR',
      });
      const elsewhere = await patchCompensation(app, 'a', elsewhereSubject.id, elsewhereRow, {
        effectiveFrom: '2024-01-01',
      });
      expect(elsewhere.statusCode).toBe(200);
      expect(elsewhere.item.effectiveFrom).toBe('2024-01-01');
    });

    expect(storedValues(await ownerCompensationRow(second))).toMatchObject({
      effective_from: '2025-01-01',
    });
    expect(storedValues(await ownerCompensationRow(first))).toMatchObject({
      effective_from: '2024-01-01',
    });
    expect(await compensationCountFor(subject.id)).toBe(2);
    expect(await compensationAuditRows(a.tenantId)).toHaveLength(beforeAudit.length + 1);
  });

  test('audits the changed field names only and never an amount', async () => {
    const a = fx().a;
    const s = structure();
    const subject = await newSubject(s.entityA);
    const compensationId = await newCompensation(a.tenantId, subject.id, {
      effectiveFrom: '2024-04-01',
      ctcMinor: 1234567,
      currency: 'INR',
      payFrequency: 'monthly',
    });
    const beforeAudit = await compensationAuditRows(a.tenantId);

    await withApp(async (app) => {
      const response = await patchCompensation(app, 'hr', subject.id, compensationId, {
        ctcMinor: 7654321,
        currency: 'EUR',
      });
      expect(response.statusCode).toBe(200);
      // The answer carries both figures; the audit carries both names and nothing
      // else, so the trail records that a pay row changed without becoming a
      // second copy of pay history.
      expect(response.item).toMatchObject({ ctcMinor: 7654321, currency: 'EUR' });
    });

    const rows = await compensationAuditRows(a.tenantId);
    expect(rows).toHaveLength(beforeAudit.length + 1);
    const written = one(rows.slice(-1));
    expect(written.metadata).toEqual({ fields: ['ctcMinor', 'currency'] });
    expect(Object.keys(written.metadata)).toEqual(['fields']);
    const serialized = JSON.stringify(written.metadata);
    for (const leak of ['1234567', '7654321', 'INR', 'EUR', subject.id]) {
      expect(serialized).not.toContain(leak);
    }
  });

  test('marks every update outcome uncacheable', async () => {
    const a = fx().a;
    const s = structure();
    const subject = await newSubject(s.entityA);
    const compensationId = await newCompensation(a.tenantId, subject.id, {
      effectiveFrom: '2024-04-01',
      ctcMinor: 4100000,
      currency: 'INR',
    });
    const statuses: number[] = [];

    await withApp(async (app) => {
      statuses.push(
        (await patchCompensation(app, 'a', subject.id, compensationId, { ctcMinor: 4200000 }))
          .statusCode,
      );
      statuses.push(
        (await patchCompensation(app, 'a', subject.id, compensationId, { ctcMinor: 4200000 }))
          .statusCode,
      );
      statuses.push((await patchCompensation(app, 'a', subject.id, compensationId, {})).statusCode);
      statuses.push(
        (await send(app, {
          method: 'PATCH',
          url: `/v1/people/${subject.id}/compensations/${compensationId}`,
          body: { ctcMinor: 4300000 },
        })).statusCode,
      );
      statuses.push(
        (await send(app, {
          method: 'PATCH',
          url: `/v1/people/${subject.id}/compensations/${compensationId}`,
          cookie: session('a').cookie,
          csrf: session('a').csrfToken,
          origin: 'https://evil.example.test',
          body: { ctcMinor: 4300000 },
        })).statusCode,
      );
      statuses.push(
        (await patchCompensation(app, 'manager', subject.id, compensationId, { ctcMinor: 4400000 }))
          .statusCode,
      );
      // The same shape as the create refusals: a member who can see the row
      // because it is theirs, but may not maintain it because their scope covers
      // the other legal entity.
      const self = selfOutsidePerson();
      statuses.push(
        (await patchCompensation(app, 'hrSelfOutside', self.personId, self.compensationId, {
          ctcMinor: 4500000,
        })).statusCode,
      );
      statuses.push(
        (await patchCompensation(app, 'a', randomUUID(), compensationId, { ctcMinor: 4600000 }))
          .statusCode,
      );
      statuses.push(
        (await patchCompensation(app, 'a', subject.id, randomUUID(), { ctcMinor: 4700000 }))
          .statusCode,
      );
    });

    expect(statuses).toEqual([200, 200, 400, 401, 403, 403, 403, 404, 404]);
  });
});

describe('Compensation write failures', () => {
  test('fails closed with a sanitized 500 when the audit write fails, leaving no row', async () => {
    const a = fx().a;
    const s = structure();
    const subject = await newSubject(s.entityA);
    const compensationId = await newCompensation(a.tenantId, subject.id, {
      effectiveFrom: '2024-04-01',
      ctcMinor: 3456789,
      currency: 'INR',
    });
    const before = await compensationCountFor(subject.id);
    const beforeAudit = await compensationAuditRows(a.tenantId);
    const beforeRow = await ownerCompensationRow(compensationId);

    await withOwner(async (client) => {
      await client.query('revoke insert on table public.audit_event from saas_runtime');
    });
    try {
      await withApp(async (app) => {
        const responses = [
          await addCompensation(
            app,
            'a',
            subject.id,
            createBody({ effectiveFrom: '2025-04-01', ctcMinor: 3456790 }),
          ),
          await patchCompensation(app, 'a', subject.id, compensationId, { ctcMinor: 3456791 }),
        ];
        for (const response of responses) {
          expect(response.statusCode).toBe(500);
          expect(response.payload).toEqual({ error: { code: 'INTERNAL_ERROR' } });
          expect(response.headers['cache-control']).toBe('no-store');
          for (const detail of [
            'permission denied',
            'audit_event',
            'insert into',
            'saas_runtime',
            'compensation',
            'PostgreSQL',
            '3456790',
            '3456791',
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

    // The transaction rolled back with its audit row: neither the new period nor
    // the amendment survived, and the trail kept no record of either attempt.
    expect(await compensationCountFor(subject.id)).toBe(before);
    expect(await ownerCompensationRow(compensationId)).toEqual(beforeRow);
    expect(await compensationAuditRows(a.tenantId)).toHaveLength(beforeAudit.length);
  });

  test('has no delete route, and no delete path at all', async () => {
    const a = fx().a;
    const s = structure();
    const subject = await newSubject(s.entityA);
    const compensationId = await newCompensation(a.tenantId, subject.id, {
      effectiveFrom: '2024-04-01',
      ctcMinor: 765432,
      currency: 'INR',
    });

    await withApp(async (app) => {
      for (const url of [
        `/v1/people/${subject.id}/compensations/${compensationId}`,
        `/v1/people/${subject.id}/compensations`,
      ]) {
        // Fastify's own route-not-found answer, which is a different shape from
        // any decision the product makes: there is no delete route to decide.
        const response = await send(app, {
          method: 'DELETE',
          url,
          cookie: session('a').cookie,
          csrf: session('a').csrfToken,
        });
        expect(response.statusCode).toBe(404);
        expect(response.body).not.toContain('COMPENSATION_NOT_FOUND');
        expect(response.payload?.error).toBe('Not Found');
      }

      // PUT is not a verb this API offers either.
      const put = await send(app, {
        method: 'PUT',
        url: `/v1/people/${subject.id}/compensations/${compensationId}`,
        cookie: session('a').cookie,
        csrf: session('a').csrfToken,
        body: createBody(),
      });
      expect(put.statusCode).toBe(404);
      expect(put.payload?.error).toBe('Not Found');
    });

    expect(await compensationCountFor(subject.id)).toBe(1);
  });
});

describe('The compensation write in the database', () => {
  test('refuses the runtime role a delete on a salary row', async () => {
    const a = fx().a;
    const s = structure();
    const subject = await newSubject(s.entityA);
    const compensationId = await newCompensation(a.tenantId, subject.id, {
      effectiveFrom: '2024-04-01',
      ctcMinor: 876543,
      currency: 'INR',
    });

    const error = await expectRuntimeError(
      a.tenantId,
      a.userId,
      'delete from compensation where id = $1',
      [compensationId],
    );
    expect(error.code).toBe('42501');
    expect(error.message).toContain('permission denied for table compensation');

    // The grant is the refusal, so the missing scope_delete policy is never
    // reached: there is no delete to narrow.
    expect(await compensationCountFor(subject.id)).toBe(1);
  });

  test('answers INSERT ... RETURNING here, unlike on the directory', async () => {
    const a = fx().a;
    const s = structure();
    const subject = await newSubject(s.entityA);
    const id = randomUUID();

    // The compensation scope policies read app.person_visible(person_id) and
    // app.person_in_scope(person_id) - the person a row hangs off, which already
    // exists - so a RETURNING clause on a new row is evaluated against a person
    // the member may maintain and is allowed. On person the same clause reads
    // app.person_visible(id) for the row being created, which cannot observe
    // itself, and every INSERT ... RETURNING is refused (ADR 0008). This is the
    // difference the write route's own read-back does not depend on: the route
    // reads back so the answer is built from the same select fragments as the
    // list, not because the database forces it to.
    const returned = await withMember(a.tenantId, a.userId, async (client) => {
      const result = await client.query<{ id: string; amount: string }>(
        `insert into compensation
           (id, tenant_id, person_id, effective_from, ctc_minor, currency, pay_frequency)
         values ($1, $2, $3, '2024-04-01', 987654, 'INR', 'monthly')
         returning id, ctc_minor::text as amount`,
        [id, a.tenantId, subject.id],
      );
      const visible = await client.query<{ total: string }>(
        'select count(*)::text as total from compensation where person_id = $1',
        [subject.id],
      );
      return { rows: result.rows, visible: one(visible.rows).total };
    });
    expect(returned.rows).toEqual([{ id, amount: '987654' }]);
    expect(returned.visible).toBe('1');

    // The transaction rolled back, so the row this probe proved was writable is
    // not left behind for the rest of the suite to trip over.
    expect(await compensationCountFor(subject.id)).toBe(0);
  });

  test('refuses an out-of-scope insert and an employee insert on their own row by policy', async () => {
    const a = fx().a;
    const s = structure();
    const onB = await newSubject(s.entityB);
    const employee = fx().employee;
    const own = employeeSelfPerson();

    const scoped = await expectRuntimeError(
      a.tenantId,
      membership('hrEntity').userId,
      `insert into compensation
         (id, tenant_id, person_id, effective_from, ctc_minor, currency, pay_frequency)
       values ($1, $2, $3, '2024-04-01', 100, 'INR', 'monthly')`,
      [randomUUID(), a.tenantId, onB.id],
    );
    expect(scoped.code).toBe('42501');
    expect(scoped.message).toContain('row-level security');
    expect(scoped.message).toContain('scope_insert');

    // The employee role is refused its own directory row by the write oracle even
    // though the read oracle admits it: this is the asymmetry the routes rely on,
    // taken without a session, a gate or an entitlement in the way. The two
    // oracles are asked directly first, so the refusal below cannot be a side
    // effect of the row being invisible.
    const oracles = await withMember(employee.tenantId, employee.userId, async (client) => {
      const visible = await client.query<{ answer: boolean }>(
        'select app.person_visible($1) as answer',
        [own.personId],
      );
      const maintainable = await client.query<{ answer: boolean }>(
        'select app.person_in_scope($1) as answer',
        [own.personId],
      );
      return { visible: one(visible.rows).answer, maintainable: one(maintainable.rows).answer };
    });
    expect(oracles).toEqual({ visible: true, maintainable: false });

    const asEmployee = await expectRuntimeError(
      employee.tenantId,
      employee.userId,
      `insert into compensation
         (id, tenant_id, person_id, effective_from, ctc_minor, currency, pay_frequency)
       values ($1, $2, $3, '2024-04-01', 100, 'INR', 'monthly')`,
      [randomUUID(), employee.tenantId, own.personId],
    );
    expect(asEmployee.code).toBe('42501');
    expect(asEmployee.message).toContain('scope_insert');

    expect(await compensationCountFor(onB.id)).toBe(0);
    expect(await compensationCountFor(own.personId)).toBe(1);
  });

  test('keeps a salary write inside the tenant without a scope clause in the statement', async () => {
    const a = fx().a;
    const other = fx().dualModule;
    const beforeOther = await compensationCountFor(other.personId);

    // The routes never filter on tenant_id: isolation is the policy's job. A row
    // named for a person in another tenant cannot even be addressed here, because
    // the person is not visible in this one.
    const insert = await expectRuntimeError(
      a.tenantId,
      a.userId,
      `insert into compensation
         (id, tenant_id, person_id, effective_from, ctc_minor, currency, pay_frequency)
       values ($1, $2, $3, '2024-04-01', 100, 'INR', 'monthly')`,
      [randomUUID(), a.tenantId, other.personId],
    );
    expect(insert.code).toBe('42501');

    // And a tenant_id that does not match the session is refused by
    // tenant_isolation, which is the permissive layer every one of these commands
    // still has to pass.
    const foreign = await expectRuntimeError(
      a.tenantId,
      a.userId,
      `insert into compensation
         (id, tenant_id, person_id, effective_from, ctc_minor, currency, pay_frequency)
       values ($1, $2, $3, '2024-04-01', 100, 'INR', 'monthly')`,
      [randomUUID(), other.tenantId, other.personId],
    );
    expect(foreign.code).toBe('42501');

    expect(await compensationCountFor(other.personId)).toBe(beforeOther);
  });

  test('blocks the re-parenting of a row by grant as well as by policy', async () => {
    const a = fx().a;
    const s = structure();
    const onA = await newSubject(s.entityA);
    const onB = await newSubject(s.entityB);
    const compensationId = await newCompensation(a.tenantId, onA.id, {
      effectiveFrom: '2024-04-01',
      ctcMinor: 555000,
      currency: 'INR',
    });

    // The scope_update policy's WITH CHECK clause is what refuses a re-parented
    // row; the grant is the first line, so a tenant-wide member cannot even
    // attempt it. Both halves are pinned: the clause text in
    // tests/people-compensation-write.test.ts's inventory group, the privilege
    // here.
    const error = await expectRuntimeError(
      a.tenantId,
      a.userId,
      'update compensation set person_id = $1 where id = $2',
      [onB.id, compensationId],
    );
    expect(error.code).toBe('42501');
    expect(error.message).toContain('permission denied for table compensation');

    expect(storedValues(await ownerCompensationRow(compensationId))).toMatchObject({
      person_id: onA.id,
    });
  });
});

describe('Compensation write inventory', () => {
  test('lands the fourteenth migration and no other ledger change', async () => {
    const ledger = await withOwner(async (client) => {
      const result = await client.query<{ version: string; status: string }>(
        `select version, status from infra.schema_migration
          where status = 'applied'
          order by version`,
      );
      return result.rows;
    });

    expect(ledger).toHaveLength(14);
    expect(ledger.every((row) => row.status === 'applied')).toBe(true);
    expect(ledger[0]?.version).toBe('0001_core.sql');
    expect(ledger[ledger.length - 1]?.version).toBe('0014_compensation_write.sql');
  });

  test('adds two restrictive write policies, no delete policy, and leaves the read alone', async () => {
    await withOwner(async (client) => {
      const policies = await client.query<{
        polname: string;
        polcmd: string;
        permissive: boolean;
        using_clause: string | null;
        check_clause: string | null;
      }>(
        `select p.polname, p.polcmd::text as polcmd, p.polpermissive as permissive,
                pg_get_expr(p.polqual, p.polrelid) as using_clause,
                pg_get_expr(p.polwithcheck, p.polrelid) as check_clause
           from pg_policy p
           join pg_class c on c.oid = p.polrelid
          where c.relname = 'compensation' and p.polname like 'scope_%'
          order by p.polname`,
      );

      // 0014's whole executable body, next to 0013's read policy it narrows
      // further. Both write names are restrictive - they can only ever take away
      // what tenant_isolation and the module_people_* set allow - and the update
      // carries the same predicate twice, once for the row it finds and once for
      // the row it would leave behind.
      expect(policies.rows).toEqual([
        {
          polname: 'scope_insert',
          polcmd: 'a',
          permissive: false,
          using_clause: null,
          check_clause: 'app.person_in_scope(person_id)',
        },
        {
          polname: 'scope_read',
          polcmd: 'r',
          permissive: false,
          using_clause: 'app.person_visible(person_id)',
          check_clause: null,
        },
        {
          polname: 'scope_update',
          polcmd: 'w',
          permissive: false,
          using_clause: 'app.person_in_scope(person_id)',
          check_clause: 'app.person_in_scope(person_id)',
        },
      ]);

      // The write oracle for both, never the read oracle: a member may list a
      // colleague's pay without being able to maintain it.
      const commands = await client.query<{ cmd: string }>(
        `select p.polcmd::text as cmd
           from pg_policy p
           join pg_class c on c.oid = p.polrelid
          where c.relname = 'compensation' and p.polname = 'scope_delete'`,
      );
      expect(commands.rows).toEqual([]);

      const allPolicies = await client.query<{ polname: string; permissive: boolean }>(
        `select p.polname, p.polpermissive as permissive
           from pg_policy p
           join pg_class c on c.oid = p.polrelid
          where c.relname = 'compensation'
          order by p.polname`,
      );
      expect(allPolicies.rows.map((row) => row.polname)).toEqual([
        'module_people_read',
        'module_people_write_delete',
        'module_people_write_insert',
        'module_people_write_update',
        'scope_insert',
        'scope_read',
        'scope_update',
        'tenant_isolation',
      ]);
    });
  });

  test('grants exactly the two write commands, by column, and keeps the table ungranted', async () => {
    await withOwner(async (client) => {
      const granted = await client.query<{ column_name: string; privilege_type: string }>(
        `select column_name, privilege_type
           from information_schema.column_privileges
          where grantee = 'saas_runtime' and table_name = 'compensation'
            and privilege_type = 'INSERT'
          order by 1`,
      );
      expect(granted.rows.map((row) => row.column_name)).toEqual([
        'ctc_minor',
        'currency',
        'effective_from',
        'effective_to',
        'id',
        'pay_frequency',
        'person_id',
        'tenant_id',
      ]);

      const updatable = await client.query<{ column_name: string }>(
        `select column_name
           from information_schema.column_privileges
          where grantee = 'saas_runtime' and table_name = 'compensation'
            and privilege_type = 'UPDATE'
          order by 1`,
      );
      expect(updatable.rows.map((row) => row.column_name)).toEqual([
        'ctc_minor',
        'currency',
        'effective_from',
        'effective_to',
        'pay_frequency',
      ]);

      // The seven read columns from 0013 are unchanged: the write added no column
      // to the SELECT list, and no column outside the five the routes name.
      const readable = await client.query<{ column_name: string }>(
        `select column_name
           from information_schema.column_privileges
          where grantee = 'saas_runtime' and table_name = 'compensation'
            and privilege_type = 'SELECT'
          order by 1`,
      );
      expect(readable.rows.map((row) => row.column_name)).toEqual([
        'ctc_minor',
        'currency',
        'effective_from',
        'effective_to',
        'id',
        'pay_frequency',
        'person_id',
      ]);

      // Nothing outside those commands and columns: no table-level privilege, so
      // the twelve reviewed grants are still twelve, and no DELETE at any level.
      const privileges = await client.query<{ privilege: string; allowed: boolean }>(
        `select p as privilege,
                has_table_privilege('saas_runtime', 'public.compensation', p) as allowed
           from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p`,
      );
      expect(privileges.rows.every((row) => !row.allowed)).toBe(true);

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

      // The pay breakdown stays ungranted: an unreviewed split of a salary has no
      // route, no column and no name in the contract. These are seven of the
      // table's nine columns outside the eight the routes name; compensation has
      // no deleted_at, so a soft delete is not even a shape this table could hold.
      const untouched = await client.query<{ column_name: string; any_privilege: boolean }>(
        `select c as column_name,
                has_column_privilege('saas_runtime', 'public.compensation', c, 'SELECT')
                  or has_column_privilege('saas_runtime', 'public.compensation', c, 'INSERT')
                  or has_column_privilege('saas_runtime', 'public.compensation', c, 'UPDATE') as any_privilege
           from unnest(array['structure','source_system','source_id','import_batch_id',
                             'imported_at','created_at','updated_at']) c`,
      );
      expect(untouched.rows.filter((row) => row.any_privilege).map((row) => row.column_name)).toEqual(
        [],
      );
    });
  });

  test('publishes nine permissions and never answers a module operation with either compensation name', () => {
    expect(PERMISSIONS).toEqual([
      'people.read',
      'people.write',
      'people.compensation.read',
      'people.compensation.write',
      'crm.read',
      'crm.write',
      'work.read',
      'money.read',
      'content.read',
    ]);
    expect(PERMISSIONS.indexOf(COMPENSATION_PERMISSION)).toBe(
      PERMISSIONS.indexOf('people.compensation.read') + 1,
    );

    // Neither compensation permission is reachable from a gate that only names a
    // module and an operation, which is what keeps a People write from widening
    // into a salary write by accident.
    expect(permissionFor('people', 'read')).toBe('people.read');
    expect(permissionFor('people', 'write')).toBe('people.write');
    expect(permissionFor('work', 'read')).toBe('work.read');
    // work.write was withdrawn on 27 October 2026, so no gate can ask for it.
    expect(permissionFor('work', 'write')).toBeNull();
    expect(permissionFor('people', 'read')).not.toBe(COMPENSATION_PERMISSION);
    expect(permissionFor('people', 'write')).not.toBe(COMPENSATION_PERMISSION);
  });

  test('audits a denial that names the compensation write permission', async () => {
    const a = fx().a;
    const before = await denialRows(a.tenantId);

    // The dotted name has three segments, which a shape-based validator that
    // assumed module.operation would reject - and the caller only logs a
    // rejection, so the symptom would be a missing audit row rather than an error.
    await recordAccessDenial(runtimePool(), {
      tenantId: a.tenantId,
      userId: a.userId,
      reason: 'ROLE_DENIED',
      method: 'POST',
      path: '/v1/people/:id/compensations',
      module: 'people',
      operation: 'write',
      permission: COMPENSATION_PERMISSION,
    });

    const after = await denialRows(a.tenantId);
    expect(after).toHaveLength(before.length + 1);
    expect(one(after.slice(-1)).metadata).toMatchObject({
      reason: 'ROLE_DENIED',
      module: 'people',
      operation: 'write',
      permission: COMPENSATION_PERMISSION,
    });
  });

  test('leaves the read path, the directory and the export untouched', async () => {
    const s = structure();
    const subject = await newSubject(s.entityA);

    await withApp(async (app) => {
      const exportBefore = await exportDirectory(app);
      const readBefore = await history(app, 'a', subject.id);
      expect(readBefore.list).toEqual({ items: [], total: 0 });

      const created = await addCompensation(
        app,
        'finance',
        subject.id,
        createBody({ ctcMinor: 1357911 }),
      );
      expect(created.statusCode).toBe(201);

      const patched = await patchCompensation(app, 'finance', subject.id, created.item.id, {
        currency: 'SGD',
        ctcMinor: 1357912,
      });
      expect(patched.statusCode).toBe(200);

      // The write answer and the read answer are one shape: the panel's list is
      // the row, byte for byte.
      const readAfter = await history(app, 'a', subject.id);
      expect(readAfter.statusCode).toBe(200);
      expect(readAfter.list.total).toBe(1);
      expect(one(readAfter.list.items)).toEqual(patched.item);

      // A salary row is not a directory row: the CSV a member exports says nothing
      // about pay, before or after a write.
      const exportAfter = await exportDirectory(app);
      expect(exportAfter).toBe(exportBefore);
      expect(exportAfter).not.toContain('ctc');
      expect(exportAfter).not.toContain('1357911');
      expect(exportAfter).not.toContain('SGD');
    });
  });
});
