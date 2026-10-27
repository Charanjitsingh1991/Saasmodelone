import type { OutgoingHttpHeaders } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  createAuthPool,
  createRuntimePool,
  setMembershipScope,
  type AuthPool,
  type RuntimePool,
} from '@saasmodels/db';
import type {
  EmploymentItem,
  EmploymentListResponse,
  MembershipRole,
} from '@saasmodels/contracts';
import { EMPLOYMENT_NOTICE_DAYS_MAX } from '@saasmodels/contracts';
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
const USER_AGENT = 'People employment test/1.0';

// The ten keys and nothing else, on the list item, the create answer and the
// update answer alike. Listed in the order Object.keys().sort() produces, so a
// compared array can be read against it directly.
const ITEM_KEYS = [
  'employmentType',
  'endDate',
  'id',
  'legalEntityId',
  'legalEntityName',
  'noticeDays',
  'personId',
  'probationEndDate',
  'startDate',
  'status',
];

const LIST_KEYS = ['items', 'total'];

type EmploymentResponse = {
  statusCode: number;
  headers: OutgoingHttpHeaders;
  body: string;
  payload: Record<string, unknown> | null;
  item: EmploymentItem;
  list: EmploymentListResponse;
};

type AuditRow = {
  action: string;
  entity_type: string;
  entity_id: string | null;
  actor_type: string;
  actor_user_id: string | null;
  before_state: unknown;
  after_state: unknown;
  metadata: Record<string, unknown>;
};

type Sessions = {
  a: SessionFixture;
  b: SessionFixture;
  manager: SessionFixture;
  hrEntity: SessionFixture;
  hrOther: SessionFixture;
  selfHr: SessionFixture;
  employee: SessionFixture;
};

type Membership = { userId: string; membershipId: string };

type Subject = { id: string; displayName: string };

type EmploymentSeed = {
  employmentType?: 'full_time' | 'part_time' | 'contract' | 'intern' | 'consultant';
  startDate: string;
  endDate?: string | null;
  probationEndDate?: string | null;
  noticeDays?: number | null;
  status?: 'active' | 'ended' | 'cancelled';
};

let database: TestDatabase | undefined;
let fixtures: AccessFixtures | undefined;
let runtime: RuntimePool | undefined;
let auth: AuthPool | undefined;
let owner: Pool | undefined;
let sessions: Sessions | undefined;
let memberships:
  | Record<'manager' | 'hrEntity' | 'hrOther' | 'selfHr', Membership>
  | undefined;
let org:
  | {
      entityA: string;
      entityAName: string;
      entityB: string;
      entityBName: string;
      entityRetired: string;
      entityRetiredName: string;
    }
  | undefined;
// The member whose own person row sits outside their scope, plus that person and
// the one employment row already recorded against them. This is the case the read
// predicate answers yes to and the write predicate answers no.
let selfLinked: { personId: string; employmentId: string } | undefined;
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
  name: 'manager' | 'hrEntity' | 'hrOther' | 'selfHr',
): Membership {
  if (!memberships) {
    throw new Error('Employment members have not been created');
  }
  return memberships[name];
}

function structure() {
  if (!org) {
    throw new Error('Employment structure has not been created');
  }
  return org;
}

function linked() {
  if (!selfLinked) {
    throw new Error('The self-linked person has not been created');
  }
  return selfLinked;
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

/** The whole stored row, owner-side, so an employment write can be proven to have
 *  touched nothing except the columns it named and the clock. */
async function ownerEmploymentRow(id: string): Promise<Record<string, unknown> | null> {
  return withOwner(async (client) => {
    const result = await client.query<Record<string, unknown>>(
      'select * from employment where id = $1',
      [id],
    );
    return result.rows[0] ?? null;
  });
}

async function ownerPersonRow(id: string): Promise<Record<string, unknown> | null> {
  return withOwner(async (client) => {
    const result = await client.query<Record<string, unknown>>(
      'select * from person where id = $1',
      [id],
    );
    return result.rows[0] ?? null;
  });
}

/** A count, not a list: a refused write has to leave no row at all behind, and
 *  the count is the owner-side proof of that. */
async function employmentCountFor(personId: string): Promise<number> {
  return withOwner(async (client) => {
    const result = await client.query<{ total: string }>(
      'select count(*) as total from employment where person_id = $1',
      [personId],
    );
    return Number(one(result.rows).total);
  });
}

async function employmentAuditRows(tenantId: string): Promise<AuditRow[]> {
  return withOwner(async (client) => {
    const result = await client.query<AuditRow>(
      `select action, entity_type, entity_id, actor_type, actor_user_id,
              before_state, after_state, metadata
         from audit_event
        where tenant_id = $1
          and action in ('employment.created', 'employment.updated')
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
async function newSubject(
  legalEntityId: string | null,
  options: { userId?: string } = {},
): Promise<Subject> {
  subjectCounter += 1;
  const label = `subject${subjectCounter}`;
  const displayName = `Employment ${label}`;
  return withOwner(async (client) => {
    const result = await client.query<{ id: string }>(
      `insert into person
         (tenant_id, employee_code, first_name, display_name, work_email, phone,
          legal_entity_id, org_unit_id, user_id)
       values ($1, $2, 'Subject', $3, $4, '+1 555 0400', $5, null, $6)
       returning id`,
      [
        fx().a.tenantId,
        `EMP-${label}-${randomToken().slice(0, 6)}`,
        displayName,
        `${label}_${randomToken().slice(0, 8)}@example.test`,
        legalEntityId,
        options.userId ?? null,
      ],
    );
    return { id: one(result.rows).id, displayName };
  });
}

/** Employment rows the product did not write. Legal entity and org unit
 *  administration is not a route in this milestone and the tests must not imply
 *  that it is; the same holds for a history that predates the screen. */
async function newEmployment(
  personId: string,
  legalEntityId: string,
  seed: EmploymentSeed,
): Promise<string> {
  return withOwner(async (client) => {
    const result = await client.query<{ id: string }>(
      `insert into employment
         (tenant_id, person_id, legal_entity_id, employment_type, start_date,
          end_date, probation_end_date, notice_days, status)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       returning id`,
      [
        fx().a.tenantId,
        personId,
        legalEntityId,
        seed.employmentType ?? 'full_time',
        seed.startDate,
        seed.endDate ?? null,
        seed.probationEndDate ?? null,
        seed.noticeDays ?? null,
        seed.status ?? 'active',
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
  method: 'GET' | 'POST' | 'PATCH';
  url: string;
  cookie?: string;
  csrf?: string | null;
  origin?: string;
  body?: unknown;
};

async function send(
  app: TestServer,
  options: SendOptions,
): Promise<EmploymentResponse> {
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
    item: payload as unknown as EmploymentItem,
    list: payload as unknown as EmploymentListResponse,
  };
}

function history(
  app: TestServer,
  which: keyof Sessions,
  personId: string,
  origin?: string,
): Promise<EmploymentResponse> {
  const s = session(which);
  return send(app, {
    method: 'GET',
    url: `/v1/people/${personId}/employments`,
    cookie: s.cookie,
    origin,
  });
}

function addEmployment(
  app: TestServer,
  which: keyof Sessions,
  personId: string,
  body: unknown,
): Promise<EmploymentResponse> {
  const s = session(which);
  return send(app, {
    method: 'POST',
    url: `/v1/people/${personId}/employments`,
    cookie: s.cookie,
    csrf: s.csrfToken,
    body,
  });
}

function patchEmployment(
  app: TestServer,
  which: keyof Sessions,
  personId: string,
  employmentId: string,
  body: unknown,
): Promise<EmploymentResponse> {
  const s = session(which);
  return send(app, {
    method: 'PATCH',
    url: `/v1/people/${personId}/employments/${employmentId}`,
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
    [`${label}_${randomToken().slice(0, 8)}@example.test`, `Employment ${label}`],
  );
  const membershipRow = await client.query<{ id: string }>(
    `insert into membership (tenant_id, user_id, role, status)
     values ($1, $2, $3, 'active')
     returning id`,
    [fx().a.tenantId, one(user.rows).id, role],
  );
  return { userId: one(user.rows).id, membershipId: one(membershipRow.rows).id };
}

async function insertLegalEntity(
  client: Client,
  name: string,
  deleted: boolean,
): Promise<string> {
  const jurisdiction = await client.query<{ jurisdiction_id: string }>(
    'select jurisdiction_id from legal_entity where id = $1',
    [fx().a.legalEntityId],
  );
  const result = await client.query<{ id: string }>(
    `insert into legal_entity
       (tenant_id, name, code, jurisdiction_id, currency, timezone, deleted_at)
     values ($1, $2, $3, $4, 'ZZZ', 'UTC', $5)
     returning id`,
    [
      fx().a.tenantId,
      name,
      `em_${randomToken().slice(0, 8)}`,
      one(jurisdiction.rows).jurisdiction_id,
      deleted ? new Date() : null,
    ],
  );
  return one(result.rows).id;
}

beforeAll(async () => {
  database = await createTestDatabase({ migrate: true, seed: true });
  runtime = createRuntimePool(database.runtimeUrl);
  auth = createAuthPool(database.authUrl);
  owner = new Pool({ connectionString: database.ownerUrl });

  await withOwner(async (client) => {
    fixtures = await createAccessFixtures(client);
    const a = fixtures.a;

    // A second live entity and a retired one, both written owner-side: an
    // operator's own SQL, not a screen this milestone does not have.
    const entityBName = 'Employment beta';
    const entityRetiredName = 'Employment retired entity';
    const entityB = await insertLegalEntity(client, entityBName, false);
    const entityRetired = await insertLegalEntity(client, entityRetiredName, true);

    const managerMember = await insertMember(client, 'manager', 'manager');
    const hrEntityMember = await insertMember(client, 'hr', 'hrentity');
    const hrOtherMember = await insertMember(client, 'hr', 'hrother');
    const selfHrMember = await insertMember(client, 'hr', 'selfhr');
    memberships = {
      manager: managerMember,
      hrEntity: hrEntityMember,
      hrOther: hrOtherMember,
      selfHr: selfHrMember,
    };

    // The hr member who is also a person: their own directory row is placed on
    // an entity their scope does not cover. app.person_visible answers yes to
    // that row because it is theirs, and app.person_in_scope answers no.
    const selfPerson = await newSubject(a.legalEntityId, {
      userId: selfHrMember.userId,
    });
    const selfEmploymentId = await newEmployment(selfPerson.id, a.legalEntityId, {
      startDate: '2018-02-01',
    });
    selfLinked = { personId: selfPerson.id, employmentId: selfEmploymentId };

    sessions = {
      a: await createSessionFixture(client, { userId: a.userId, tenantId: a.tenantId }),
      b: await createSessionFixture(client, {
        userId: fixtures.b.userId,
        tenantId: fixtures.b.tenantId,
      }),
      manager: await createSessionFixture(client, {
        userId: managerMember.userId,
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
      selfHr: await createSessionFixture(client, {
        userId: selfHrMember.userId,
        tenantId: a.tenantId,
      }),
      // A different tenant, whose People membership is the permissionless
      // employee role. The self-visible person is proven at the SQL level in
      // tests/scope.test.ts; here the role gate is what answers.
      employee: await createSessionFixture(client, {
        userId: fixtures.employee.userId,
        tenantId: fixtures.employee.tenantId,
      }),
    };

    org = {
      entityA: a.legalEntityId,
      entityAName: 'Legal a',
      entityB,
      entityBName,
      entityRetired,
      entityRetiredName,
    };
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
  await setMembershipScope(ownerPool(), {
    tenantId: fx().a.tenantId,
    membershipId: membership('selfHr').membershipId,
    // Deliberately the entity this member's own person row is NOT placed on.
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

describe('People employment history read', () => {
  test('rejects the history route without a valid session', async () => {
    const s = structure();
    await withApp(async (app) => {
      for (const cookie of [undefined, `saas_session=${randomToken()}`]) {
        const response = await send(app, {
          method: 'GET',
          url: `/v1/people/${s.entityA}/employments`,
          cookie,
        });
        expect(response.statusCode).toBe(401);
        expect(response.payload).toEqual({ error: { code: 'UNAUTHENTICATED' } });
        expect(response.headers['cache-control']).toBe('no-store');
      }
    });
  });

  test('refuses a role without people.read before it looks at any row', async () => {
    const employee = fx().employee;
    const before = await denialRows(employee.tenantId);
    const beforeAudit = await employmentAuditRows(employee.tenantId);

    await withApp(async (app) => {
      // An employment row for this person really exists, and the caller is the
      // user that row's tenant would let them see at the SQL level. The role gate
      // answers first, so the route never reads a history it may not disclose.
      const response = await history(app, 'employee', employee.personId);
      expect(response.statusCode).toBe(403);
      expect(response.payload).toEqual({
        error: { code: 'ROLE_DENIED', permission: 'people.read' },
      });
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body).not.toContain(employee.employmentStartDate);
    });

    const after = await denialRows(employee.tenantId);
    expect(after).toHaveLength(before.length + 1);
    expect(one(after.slice(-1))).toMatchObject({
      action: 'authorization.denied',
      entity_type: 'request',
      actor_user_id: employee.userId,
      metadata: {
        reason: 'ROLE_DENIED',
        module: 'people',
        operation: 'read',
        method: 'GET',
        path: '/v1/people/:id/employments',
      },
    });
    expect(await employmentAuditRows(employee.tenantId)).toHaveLength(
      beforeAudit.length,
    );
  });

  test('refuses a tenant without the People entitlement before the role check', async () => {
    const b = fx().b;
    const before = await denialRows(b.tenantId);

    await withApp(async (app) => {
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

  test('answers an empty history as an empty, successful list', async () => {
    const s = structure();
    const subject = await newSubject(s.entityA);
    const beforeAudit = await employmentAuditRows(fx().a.tenantId);

    await withApp(async (app) => {
      const response = await history(app, 'a', subject.id);
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(Object.keys(response.list).sort()).toEqual(LIST_KEYS);
      expect(response.list).toEqual({ items: [], total: 0 });
    });

    expect(await employmentCountFor(subject.id)).toBe(0);
    expect(await employmentAuditRows(fx().a.tenantId)).toHaveLength(beforeAudit.length);
  });

  test('answers every row with exactly the ten keys, newest start first then id', async () => {
    const a = fx().a;
    const s = structure();
    const subject = await newSubject(s.entityA);
    const older = await newEmployment(subject.id, s.entityA, {
      startDate: '2020-01-01',
      endDate: '2023-12-31',
      status: 'ended',
      noticeDays: 14,
    });
    const tieOne = await newEmployment(subject.id, s.entityA, {
      startDate: '2024-09-10',
      employmentType: 'contract',
    });
    const tieTwo = await newEmployment(subject.id, s.entityA, {
      startDate: '2024-09-10',
      employmentType: 'part_time',
      probationEndDate: '2024-12-09',
      noticeDays: 30,
    });
    const beforeAudit = await employmentAuditRows(a.tenantId);
    const beforeAnyAudit = await auditRowCount(a.tenantId);

    await withApp(async (app) => {
      const response = await history(app, 'a', subject.id);
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(Object.keys(response.list).sort()).toEqual(LIST_KEYS);
      expect(response.list.total).toBe(3);
      expect(response.list.items).toHaveLength(3);
      for (const item of response.list.items) {
        expect(Object.keys(item).sort()).toEqual(ITEM_KEYS);
        expect(item.personId).toBe(subject.id);
      }

      // start_date desc, then id: the tie is broken by the id, so the list is a
      // stable order and not the accident of an index scan.
      const ids = response.list.items.map((item) => item.id);
      const newestTwo = [tieOne, tieTwo].sort((x, y) => (x < y ? -1 : 1));
      expect(ids).toEqual([...newestTwo, older]);
      expect(response.list.items.map((item) => item.startDate)).toEqual([
        '2024-09-10',
        '2024-09-10',
        '2020-01-01',
      ]);

      // Every stored value reads back as the same shape a create or an update
      // would answer with, dates as calendar days rather than timestamps.
      const byId = new Map(response.list.items.map((item) => [item.id, item]));
      expect(byId.get(tieOne)).toMatchObject({
        employmentType: 'contract',
        legalEntityId: s.entityA,
        legalEntityName: s.entityAName,
        endDate: null,
        status: 'active',
      });
      expect(byId.get(tieTwo)).toMatchObject({
        employmentType: 'part_time',
        probationEndDate: '2024-12-09',
        noticeDays: 30,
      });
      expect(byId.get(older)).toMatchObject({
        status: 'ended',
        endDate: '2023-12-31',
        noticeDays: 14,
      });
    });

    // A read authorizes and never audits: not one row of any kind is added.
    expect(await employmentAuditRows(a.tenantId)).toHaveLength(beforeAudit.length);
    expect(await auditRowCount(a.tenantId)).toBe(beforeAnyAudit);
  });

  test('keeps the entity id of a retired legal entity and drops only its name', async () => {
    const s = structure();
    const subject = await newSubject(s.entityA);
    const retiredRow = await newEmployment(subject.id, s.entityRetired, {
      startDate: '2017-05-05',
      endDate: '2019-05-04',
      status: 'ended',
    });
    await newEmployment(subject.id, s.entityA, { startDate: '2021-01-01' });

    await withApp(async (app) => {
      const response = await history(app, 'a', subject.id);
      expect(response.statusCode).toBe(200);
      const item = one(response.list.items.filter((row) => row.id === retiredRow));
      // The history still names the entity it was written against; only the
      // reference row's name is gone.
      expect(item).toMatchObject({
        legalEntityId: s.entityRetired,
        legalEntityName: null,
      });
      expect(response.body).not.toContain(s.entityRetiredName);
    });
  });

  test('answers one uniform 404 for every person this caller cannot see', async () => {
    const a = fx().a;
    const s = structure();
    const beforeAudit = await employmentAuditRows(a.tenantId);

    await withApp(async (app) => {
      for (const id of [
        randomUUID(),
        'not-a-uuid',
        s.entityB,
        a.employmentId,
        fx().b.personId,
        fx().softDeletedPerson.id,
      ]) {
        const response = await history(app, 'a', id);
        expect([id, response.statusCode, response.payload]).toEqual([
          id,
          404,
          { error: { code: 'PERSON_NOT_FOUND' } },
        ]);
        expect(response.headers['cache-control']).toBe('no-store');
      }

      // Another tenant's history is not disclosed by its own person id either.
      const foreign = await history(app, 'a', fx().b.personId);
      expect(foreign.body).not.toContain(fx().b.employmentStartDate);
    });

    // One answer for all six cases, so the route cannot be used to enumerate the
    // people a member may not list.
    expect(await employmentAuditRows(a.tenantId)).toHaveLength(beforeAudit.length);
  });

  test('shows a scoped member only the histories their scope allows', async () => {
    const s = structure();
    const inA = await newSubject(s.entityA);
    const inB = await newSubject(s.entityB);
    await newEmployment(inA.id, s.entityA, { startDate: '2022-02-02' });
    await newEmployment(inB.id, s.entityB, { startDate: '2023-03-03' });

    await withApp(async (app) => {
      const own = await history(app, 'hrEntity', inA.id);
      expect(own.statusCode).toBe(200);
      expect(own.list.items.map((item) => item.personId)).toEqual([inA.id]);

      // A colleague outside the scope is the same answer as nobody at all, and
      // never an empty list that would confirm the person exists.
      const outside = await history(app, 'hrEntity', inB.id);
      expect(outside.statusCode).toBe(404);
      expect(outside.payload).toEqual({ error: { code: 'PERSON_NOT_FOUND' } });
      expect(outside.body).not.toContain('2023-03-03');

      const mirrored = await history(app, 'hrOther', inB.id);
      expect(mirrored.statusCode).toBe(200);
      expect(mirrored.list.total).toBe(1);
      expect(one(mirrored.list.items).legalEntityId).toBe(s.entityB);
      expect((await history(app, 'hrOther', inA.id)).statusCode).toBe(404);
    });
  });

  test('lets a member read their own visible person but not maintain it', async () => {
    const s = structure();
    const subject = await newSubject(s.entityA);
    await newEmployment(subject.id, s.entityA, { startDate: '2019-09-09' });

    await withApp(async (app) => {
      // The self-linked person is readable: app.person_visible answers yes.
      const self = await history(app, 'selfHr', linked().personId);
      expect(self.statusCode).toBe(200);
      expect(self.list.total).toBe(1);
      expect(one(self.list.items).id).toBe(linked().employmentId);

      // A colleague outside that member's scope stays a uniform miss.
      const other = await history(app, 'selfHr', subject.id);
      expect(other.statusCode).toBe(404);
      expect(other.payload).toEqual({ error: { code: 'PERSON_NOT_FOUND' } });
    });
  });

  test('lets a people.read-only role open a history their role may not write', async () => {
    const s = structure();
    const subject = await newSubject(s.entityA);
    await newEmployment(subject.id, s.entityA, { startDate: '2016-06-01' });

    await withApp(async (app) => {
      const read = await history(app, 'manager', subject.id);
      expect(read.statusCode).toBe(200);
      expect(read.list.total).toBe(1);

      const written = await addEmployment(app, 'manager', subject.id, {
        employmentType: 'full_time',
        startDate: '2017-07-01',
      });
      expect(written.statusCode).toBe(403);
      expect(written.payload).toEqual({
        error: { code: 'ROLE_DENIED', permission: 'people.write' },
      });
      expect(await employmentCountFor(subject.id)).toBe(1);
    });
  });

  test('needs no CSRF token for the history GET and never caches it', async () => {
    const s = structure();
    const subject = await newSubject(s.entityA);
    await newEmployment(subject.id, s.entityA, { startDate: '2015-01-01' });

    await withApp(async (app) => {
      const noCsrf = await send(app, {
        method: 'GET',
        url: `/v1/people/${subject.id}/employments`,
        cookie: session('a').cookie,
      });
      expect(noCsrf.statusCode).toBe(200);
      expect(noCsrf.headers['cache-control']).toBe('no-store');

      // The origin hook guards unsafe methods only, so a cross-origin GET reads
      // this caller's own history and discloses nothing new.
      const crossOrigin = await history(app, 'a', subject.id, 'https://evil.example.test');
      expect(crossOrigin.statusCode).toBe(200);
      expect(crossOrigin.list).toEqual(noCsrf.list);
    });
  });
});

describe('People employment create', () => {
  test('rejects the create route without a session, a CSRF token or the origin', async () => {
    const a = fx().a;
    const s = structure();
    const subject = await newSubject(s.entityA);
    const beforeAudit = await employmentAuditRows(a.tenantId);
    const body = { employmentType: 'full_time', startDate: '2020-01-01' };

    await withApp(async (app) => {
      const noSession = await send(app, {
        method: 'POST',
        url: `/v1/people/${subject.id}/employments`,
        csrf: session('a').csrfToken,
        body,
      });
      expect(noSession.statusCode).toBe(401);
      expect(noSession.payload).toEqual({ error: { code: 'UNAUTHENTICATED' } });
      expect(noSession.headers['cache-control']).toBe('no-store');

      for (const csrf of [undefined, 'wrong-token']) {
        const noCsrf = await send(app, {
          method: 'POST',
          url: `/v1/people/${subject.id}/employments`,
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
        url: `/v1/people/${subject.id}/employments`,
        cookie: session('a').cookie,
        csrf: session('a').csrfToken,
        origin: 'https://evil.example.test',
        body,
      });
      expect(badOrigin.statusCode).toBe(403);
      expect(badOrigin.payload).toEqual({ error: { code: 'ORIGIN_DENIED' } });
      expect(badOrigin.headers['cache-control']).toBe('no-store');
    });

    expect(await employmentCountFor(subject.id)).toBe(0);
    expect(await employmentAuditRows(a.tenantId)).toHaveLength(beforeAudit.length);
  });

  test('derives the entity from the placement and lets the database choose the status', async () => {
    const a = fx().a;
    const s = structure();
    const subject = await newSubject(s.entityA);
    const person = await ownerPersonRow(subject.id);
    const beforeAudit = await employmentAuditRows(a.tenantId);

    await withApp(async (app) => {
      const response = await addEmployment(app, 'a', subject.id, {
        employmentType: 'full_time',
        startDate: '2019-03-04',
      });
      expect(response.statusCode).toBe(201);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(Object.keys(response.item).sort()).toEqual(ITEM_KEYS);
      expect(response.item).toMatchObject({
        personId: subject.id,
        legalEntityId: s.entityA,
        legalEntityName: s.entityAName,
        employmentType: 'full_time',
        startDate: '2019-03-04',
        endDate: null,
        probationEndDate: null,
        noticeDays: null,
        status: 'active',
      });

      const row = await ownerEmploymentRow(response.item.id);
      expect(row).toMatchObject({
        tenant_id: a.tenantId,
        person_id: subject.id,
        legal_entity_id: s.entityA,
        start_date: expect.any(Date),
        status: 'active',
        // Nothing the client could name reaches these: no jurisdiction, no
        // source system, no import batch.
        work_jurisdiction_id: null,
        source_system: null,
        source_id: null,
        import_batch_id: null,
      });

      // The person row is untouched: an employment is not a placement.
      expect(await ownerPersonRow(subject.id)).toEqual(person);

      const audit = await employmentAuditRows(a.tenantId);
      expect(audit).toHaveLength(beforeAudit.length + 1);
      const event = one(audit.slice(-1));
      expect(event).toMatchObject({
        action: 'employment.created',
        entity_type: 'employment',
        entity_id: response.item.id,
        actor_type: 'user',
        actor_user_id: a.userId,
        before_state: null,
        after_state: null,
        metadata: { module: 'people', fields: ['employmentType', 'startDate'] },
      });

      // Field names only: no date, no notice period, no status and no entity
      // name is copied into the trail, because all of it is still on the row.
      const serialized = JSON.stringify(event);
      for (const value of [
        '2019-03-04',
        'active',
        'full_time',
        s.entityAName,
        subject.displayName,
      ]) {
        expect(serialized).not.toContain(value);
      }
    });
  });

  test('audits exactly the field names the caller sent, sorted', async () => {
    const a = fx().a;
    const s = structure();
    const subject = await newSubject(s.entityA);
    const beforeAudit = await employmentAuditRows(a.tenantId);

    await withApp(async (app) => {
      const response = await addEmployment(app, 'a', subject.id, {
        noticeDays: 77,
        startDate: '2011-01-01',
        employmentType: 'intern',
        probationEndDate: '2011-04-01',
        endDate: '2011-12-31',
      });
      expect(response.statusCode).toBe(201);
      expect(response.item).toMatchObject({ noticeDays: 77, status: 'active' });

      const event = one(
        (await employmentAuditRows(a.tenantId)).slice(beforeAudit.length),
      );
      expect(event.metadata).toEqual({
        module: 'people',
        fields: [
          'employmentType',
          'endDate',
          'noticeDays',
          'probationEndDate',
          'startDate',
        ],
      });
      // The recorded value never reaches the trail. The check is scoped to the
      // metadata, because the row's own identifiers are UUIDs and can contain
      // any digit sequence.
      const serializedMetadata = JSON.stringify(event.metadata);
      for (const value of ['77', '2011-01-01', '2011-04-01', '2011-12-31']) {
        expect(serializedMetadata).not.toContain(value);
      }
      expect(JSON.stringify(event)).not.toContain('intern');
    });
  });

  test('refuses every body that is not the closed create shape', async () => {
    const a = fx().a;
    const s = structure();
    const subject = await newSubject(s.entityA);
    const beforeAudit = await employmentAuditRows(a.tenantId);
    const valid = { employmentType: 'full_time', startDate: '2020-01-01' };

    const invalidBodies: unknown[] = [
      null,
      'not-an-object',
      42,
      [],
      [valid],
      {},
      // A type and a start date are both required here.
      { employmentType: 'full_time' },
      { startDate: '2020-01-01' },
      { employmentType: null, startDate: '2020-01-01' },
      { employmentType: 'full_time', startDate: null },
      // The client cannot choose a status, an entity, a person or an id.
      { ...valid, status: 'ended' },
      { ...valid, status: 'cancelled' },
      { ...valid, legalEntityId: s.entityB },
      { ...valid, personId: subject.id },
      { ...valid, id: randomUUID() },
      // Columns this slice deliberately does not write.
      { ...valid, workJurisdictionId: randomUUID() },
      { ...valid, sourceSystem: 'spreadsheet' },
      { ...valid, createdAt: '2020-01-01' },
      { ...valid, firstName: 'Sneak' },
      // An enum value outside the contract never reaches the column CHECK.
      { employmentType: 'freelance', startDate: '2020-01-01' },
      { employmentType: 7, startDate: '2020-01-01' },
    ];

    await withApp(async (app) => {
      for (const body of invalidBodies) {
        const response = await addEmployment(app, 'a', subject.id, body);
        expect([JSON.stringify(body), response.statusCode, response.payload]).toEqual([
          JSON.stringify(body),
          400,
          { error: { code: 'INVALID_BODY' } },
        ]);
        expect(response.headers['cache-control']).toBe('no-store');
        // Nothing echoed back, so a rejected value cannot be reflected.
        expect(response.body).not.toContain('freelance');
        expect(response.body).not.toContain('spreadsheet');
      }

      const missingBody = await send(app, {
        method: 'POST',
        url: `/v1/people/${subject.id}/employments`,
        cookie: session('a').cookie,
        csrf: session('a').csrfToken,
      });
      expect(missingBody.statusCode).toBe(400);
      expect(missingBody.payload).toEqual({ error: { code: 'INVALID_BODY' } });
    });

    expect(await employmentCountFor(subject.id)).toBe(0);
    expect(await employmentAuditRows(a.tenantId)).toHaveLength(beforeAudit.length);
  });

  test('refuses a date that is not a real day, a pair out of order and a notice period out of range', async () => {
    const a = fx().a;
    const s = structure();
    const subject = await newSubject(s.entityA);
    const beforeAudit = await employmentAuditRows(a.tenantId);

    const rejected: Record<string, unknown>[] = [
      // Shape and calendar both checked: 2026-02-30 and 2025-02-29 are shaped
      // like dates and are not dates.
      { employmentType: 'full_time', startDate: '2026-02-30' },
      { employmentType: 'full_time', startDate: '2025-02-29' },
      { employmentType: 'full_time', startDate: '2020-13-01' },
      { employmentType: 'full_time', startDate: '2020-03-0' },
      { employmentType: 'full_time', startDate: '20-03-01' },
      { employmentType: 'full_time', startDate: '2020-00-10' },
      { employmentType: 'full_time', startDate: '2020-01-32' },
      { employmentType: 'full_time', startDate: 20200101 },
      { employmentType: 'full_time', startDate: true },
      // An end or a probation date cannot precede the start.
      {
        employmentType: 'full_time',
        startDate: '2020-01-01',
        endDate: '2019-12-31',
      },
      {
        employmentType: 'full_time',
        startDate: '2020-01-01',
        probationEndDate: '2019-12-31',
      },
      // notice_days is an integer from 0 to the contract ceiling.
      { employmentType: 'full_time', startDate: '2020-01-01', noticeDays: -1 },
      { employmentType: 'full_time', startDate: '2020-01-01', noticeDays: 1.5 },
      {
        employmentType: 'full_time',
        startDate: '2020-01-01',
        noticeDays: EMPLOYMENT_NOTICE_DAYS_MAX + 1,
      },
      { employmentType: 'full_time', startDate: '2020-01-01', noticeDays: '30' },
    ];

    await withApp(async (app) => {
      for (const body of rejected) {
        const response = await addEmployment(app, 'a', subject.id, body);
        expect([JSON.stringify(body), response.statusCode]).toEqual([
          JSON.stringify(body),
          400,
        ]);
        expect(response.payload).toEqual({ error: { code: 'INVALID_BODY' } });
      }

      // The two boundaries the contract does allow, so the ceiling is a real
      // limit and not an off-by-one.
      for (const noticeDays of [0, EMPLOYMENT_NOTICE_DAYS_MAX]) {
        const ok = await addEmployment(app, 'a', subject.id, {
          employmentType: 'consultant',
          startDate: '2020-01-01',
          noticeDays,
        });
        expect(ok.statusCode).toBe(201);
        expect(ok.item.noticeDays).toBe(noticeDays);
      }

      // A real 29 February is a real day.
      const leap = await addEmployment(app, 'a', subject.id, {
        employmentType: 'full_time',
        startDate: '2024-02-29',
      });
      expect(leap.statusCode).toBe(201);
      expect(leap.item.startDate).toBe('2024-02-29');
    });

    expect(await employmentCountFor(subject.id)).toBe(3);
    expect(await employmentAuditRows(a.tenantId)).toHaveLength(beforeAudit.length + 3);
  });

  test('refuses an unplaced person with EMPLOYMENT_ENTITY_REQUIRED', async () => {
    const a = fx().a;
    const subject = await newSubject(null);
    const beforeAudit = await employmentAuditRows(a.tenantId);

    await withApp(async (app) => {
      const response = await addEmployment(app, 'a', subject.id, {
        employmentType: 'full_time',
        startDate: '2020-01-01',
      });
      expect(response.statusCode).toBe(409);
      expect(response.payload).toEqual({
        error: { code: 'EMPLOYMENT_ENTITY_REQUIRED' },
      });
      expect(response.headers['cache-control']).toBe('no-store');
    });

    expect(await employmentCountFor(subject.id)).toBe(0);
    expect(await employmentAuditRows(a.tenantId)).toHaveLength(beforeAudit.length);
  });

  test('refuses a person placed on a retired legal entity with the same refusal', async () => {
    const a = fx().a;
    const s = structure();
    const subject = await newSubject(s.entityRetired);
    const beforeAudit = await employmentAuditRows(a.tenantId);

    await withApp(async (app) => {
      // The person is still readable, so this is not a miss dressed up as one.
      const read = await history(app, 'a', subject.id);
      expect(read.statusCode).toBe(200);

      const response = await addEmployment(app, 'a', subject.id, {
        employmentType: 'full_time',
        startDate: '2020-01-01',
      });
      expect(response.statusCode).toBe(409);
      expect(response.payload).toEqual({
        error: { code: 'EMPLOYMENT_ENTITY_REQUIRED' },
      });
    });

    expect(await employmentCountFor(subject.id)).toBe(0);
    expect(await employmentAuditRows(a.tenantId)).toHaveLength(beforeAudit.length);
  });

  test('keeps the legal entity chosen at creation when the placement moves later', async () => {
    const s = structure();
    const subject = await newSubject(s.entityA);

    const createdId = await withApp(async (app) => {
      const response = await addEmployment(app, 'a', subject.id, {
        employmentType: 'full_time',
        startDate: '2019-01-01',
      });
      expect(response.statusCode).toBe(201);
      expect(response.item.legalEntityId).toBe(s.entityA);
      return response.item.id;
    });

    // An operator moves the person, as a transfer would: the recorded history
    // stays under the entity it was written against.
    await withOwner(async (client) => {
      await client.query('update person set legal_entity_id = $1 where id = $2', [
        s.entityB,
        subject.id,
      ]);
    });
    expect(await ownerPersonRow(subject.id)).toMatchObject({
      legal_entity_id: s.entityB,
    });

    await withApp(async (app) => {
      const row = await ownerEmploymentRow(createdId);
      expect(row?.legal_entity_id).toBe(s.entityA);

      const response = await history(app, 'a', subject.id);
      expect(response.list.total).toBe(1);
      expect(one(response.list.items)).toMatchObject({
        legalEntityId: s.entityA,
        legalEntityName: s.entityAName,
      });

      // A new record after the move names the new entity: the derivation is the
      // placement at the moment of writing, not the first placement ever.
      const second = await addEmployment(app, 'a', subject.id, {
        employmentType: 'part_time',
        startDate: '2024-06-01',
      });
      expect(second.statusCode).toBe(201);
      expect(second.item).toMatchObject({
        legalEntityId: s.entityB,
        legalEntityName: s.entityBName,
      });
    });
  });

  test('answers 403 SCOPE_DENIED where the person is visible but not writable', async () => {
    const a = fx().a;
    const beforeAudit = await employmentAuditRows(a.tenantId);
    const before = await employmentCountFor(linked().personId);
    expect(before).toBe(1);

    await withApp(async (app) => {
      // app.person_visible says this member may see the row because it is their
      // own; app.person_in_scope says they may not maintain it, because the
      // placement is outside their scope. The route asks the write helper, so the
      // answer is a typed 403 and not a database rejection dressed up as a 500.
      const response = await addEmployment(app, 'selfHr', linked().personId, {
        employmentType: 'full_time',
        startDate: '2021-01-01',
      });
      expect(response.statusCode).toBe(403);
      expect(response.payload).toEqual({ error: { code: 'SCOPE_DENIED' } });
      expect(response.headers['cache-control']).toBe('no-store');
    });

    expect(await employmentCountFor(linked().personId)).toBe(before);
    expect(await employmentAuditRows(a.tenantId)).toHaveLength(beforeAudit.length);
  });

  test('allows a second row for the same person, because there is no uniqueness rule', async () => {
    const s = structure();
    const subject = await newSubject(s.entityA);

    await withApp(async (app) => {
      const first = await addEmployment(app, 'a', subject.id, {
        employmentType: 'full_time',
        startDate: '2010-01-01',
        endDate: '2012-12-31',
      });
      expect(first.statusCode).toBe(201);

      const second = await addEmployment(app, 'a', subject.id, {
        employmentType: 'contract',
        startDate: '2013-01-01',
      });
      expect(second.statusCode).toBe(201);

      const overlap = await addEmployment(app, 'a', subject.id, {
        employmentType: 'consultant',
        startDate: '2011-06-01',
      });
      expect(overlap.statusCode).toBe(201);

      const response = await history(app, 'a', subject.id);
      expect(response.list.total).toBe(3);
      expect(response.list.items.map((item) => item.startDate)).toEqual([
        '2013-01-01',
        '2011-06-01',
        '2010-01-01',
      ]);
    });
  });

  test('gates before the person id and the body', async () => {
    const s = structure();
    const body = { employmentType: 'full_time', startDate: '2020-01-01' };

    await withApp(async (app) => {
      // A role that may not write is refused before the id shape or the body is
      // looked at, so a denial never depends on the caller guessing a UUID.
      const deniedByRole = await addEmployment(app, 'manager', 'not-a-uuid', body);
      expect(deniedByRole.statusCode).toBe(403);
      expect(deniedByRole.payload).toEqual({
        error: { code: 'ROLE_DENIED', permission: 'people.write' },
      });

      const deniedByBody = await addEmployment(app, 'manager', s.entityA, {});
      expect(deniedByBody.statusCode).toBe(403);

      const deniedByEntitlement = await addEmployment(app, 'b', 'not-a-uuid', body);
      expect(deniedByEntitlement.statusCode).toBe(403);
      expect(deniedByEntitlement.payload).toEqual({
        error: { code: 'MODULE_NOT_ENTITLED', module: 'people', operation: 'write' },
      });
    });
  });

  test('lets an entity-scoped member create inside their entity and not outside it', async () => {
    const s = structure();
    const inA = await newSubject(s.entityA);
    const inB = await newSubject(s.entityB);
    const beforeAudit = await employmentAuditRows(fx().a.tenantId);

    await withApp(async (app) => {
      const inside = await addEmployment(app, 'hrEntity', inA.id, {
        employmentType: 'full_time',
        startDate: '2020-02-02',
      });
      expect(inside.statusCode).toBe(201);
      expect(inside.item.legalEntityId).toBe(s.entityA);

      const outside = await addEmployment(app, 'hrEntity', inB.id, {
        employmentType: 'full_time',
        startDate: '2020-02-02',
      });
      expect(outside.statusCode).toBe(404);
      expect(outside.payload).toEqual({ error: { code: 'PERSON_NOT_FOUND' } });
    });

    expect(await employmentCountFor(inA.id)).toBe(1);
    expect(await employmentCountFor(inB.id)).toBe(0);

    // Exactly the one successful write was audited, by the scoped member.
    const audit = await employmentAuditRows(fx().a.tenantId);
    expect(audit).toHaveLength(beforeAudit.length + 1);
    expect(one(audit.slice(-1)).actor_user_id).toBe(membership('hrEntity').userId);
  });

  test('fails closed with a sanitized 500 when the audit write fails, leaving no row', async () => {
    const a = fx().a;
    const s = structure();
    const subject = await newSubject(s.entityA);
    const before = await employmentCountFor(subject.id);
    const beforeAudit = await employmentAuditRows(a.tenantId);

    await withOwner(async (client) => {
      await client.query('revoke insert on table public.audit_event from saas_runtime');
    });
    try {
      await withApp(async (app) => {
        const response = await addEmployment(app, 'a', subject.id, {
          employmentType: 'full_time',
          startDate: '2020-01-01',
        });
        expect(response.statusCode).toBe(500);
        expect(response.payload).toEqual({ error: { code: 'INTERNAL_ERROR' } });
        expect(response.headers['cache-control']).toBe('no-store');
        for (const detail of [
          'permission denied',
          'audit_event',
          'insert into',
          'saas_runtime',
          'employment',
          'PostgreSQL',
        ]) {
          expect(response.body.toLowerCase()).not.toContain(detail.toLowerCase());
        }
      });
    } finally {
      await withOwner(async (client) => {
        await client.query('grant insert on table public.audit_event to saas_runtime');
      });
    }

    // The transaction rolled back with the audit row: the history kept no record.
    expect(await employmentCountFor(subject.id)).toBe(before);
    expect(await employmentAuditRows(a.tenantId)).toHaveLength(beforeAudit.length);
  });

  test('marks every create outcome uncacheable', async () => {
    const s = structure();
    const subject = await newSubject(s.entityA);
    const unplaced = await newSubject(null);
    const statuses: number[] = [];

    await withApp(async (app) => {
      const ok = await addEmployment(app, 'a', subject.id, {
        employmentType: 'full_time',
        startDate: '2020-01-01',
      });
      statuses.push(ok.statusCode);

      statuses.push((await addEmployment(app, 'a', subject.id, {})).statusCode);

      statuses.push(
        (await addEmployment(app, 'a', randomUUID(), {
          employmentType: 'full_time',
          startDate: '2020-01-01',
        })).statusCode,
      );

      statuses.push(
        (await addEmployment(app, 'a', unplaced.id, {
          employmentType: 'full_time',
          startDate: '2020-01-01',
        })).statusCode,
      );

      statuses.push(
        (await addEmployment(app, 'manager', subject.id, {
          employmentType: 'full_time',
          startDate: '2020-01-01',
        })).statusCode,
      );

      statuses.push(
        (await send(app, {
          method: 'POST',
          url: `/v1/people/${subject.id}/employments`,
          cookie: session('a').cookie,
          csrf: session('a').csrfToken,
          origin: 'https://evil.example.test',
          body: { employmentType: 'full_time', startDate: '2020-01-01' },
        })).statusCode,
      );
    });

    expect(statuses).toEqual([201, 400, 404, 409, 403, 403]);
  });
});

describe('People employment update', () => {
  test('rejects the update route without a session, a CSRF token or the origin', async () => {
    const s = structure();
    const subject = await newSubject(s.entityA);
    const employmentId = await newEmployment(subject.id, s.entityA, {
      startDate: '2020-01-01',
    });
    const before = await ownerEmploymentRow(employmentId);
    const beforeAudit = await employmentAuditRows(fx().a.tenantId);

    await withApp(async (app) => {
      const url = `/v1/people/${subject.id}/employments/${employmentId}`;

      const noSession = await send(app, {
        method: 'PATCH',
        url,
        csrf: session('a').csrfToken,
        body: { noticeDays: 60 },
      });
      expect(noSession.statusCode).toBe(401);
      expect(noSession.payload).toEqual({ error: { code: 'UNAUTHENTICATED' } });

      for (const csrf of [undefined, 'wrong-token']) {
        const noCsrf = await send(app, {
          method: 'PATCH',
          url,
          cookie: session('a').cookie,
          csrf,
          body: { noticeDays: 60 },
        });
        expect(noCsrf.statusCode).toBe(403);
        expect(noCsrf.payload).toEqual({ error: { code: 'CSRF_INVALID' } });
        expect(noCsrf.headers['cache-control']).toBe('no-store');
      }

      const badOrigin = await send(app, {
        method: 'PATCH',
        url,
        cookie: session('a').cookie,
        csrf: session('a').csrfToken,
        origin: 'https://evil.example.test',
        body: { noticeDays: 60 },
      });
      expect(badOrigin.statusCode).toBe(403);
      expect(badOrigin.payload).toEqual({ error: { code: 'ORIGIN_DENIED' } });
      expect(badOrigin.headers['cache-control']).toBe('no-store');
    });

    expect(await ownerEmploymentRow(employmentId)).toEqual(before);
    expect(await employmentAuditRows(fx().a.tenantId)).toHaveLength(beforeAudit.length);
  });

  test('changes only the field it names and answers the read-back with the joined name', async () => {
    const a = fx().a;
    const s = structure();
    const subject = await newSubject(s.entityA);
    const employmentId = await newEmployment(subject.id, s.entityA, {
      startDate: '2019-01-01',
      endDate: '2021-01-01',
      probationEndDate: '2019-04-01',
      noticeDays: 15,
    });
    const before = await ownerEmploymentRow(employmentId);
    const beforeAudit = await employmentAuditRows(a.tenantId);

    await withApp(async (app) => {
      const response = await patchEmployment(app, 'a', subject.id, employmentId, {
        noticeDays: 90,
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(Object.keys(response.item).sort()).toEqual(ITEM_KEYS);
      expect(response.item).toMatchObject({
        id: employmentId,
        personId: subject.id,
        legalEntityId: s.entityA,
        legalEntityName: s.entityAName,
        startDate: '2019-01-01',
        endDate: '2021-01-01',
        probationEndDate: '2019-04-01',
        noticeDays: 90,
        status: 'active',
      });

      const after = await ownerEmploymentRow(employmentId);
      expect(after?.notice_days).toBe(90);
      expect((after?.updated_at as Date).getTime()).toBeGreaterThan(
        (before?.updated_at as Date).getTime(),
      );
      // Only the named column and the clock moved: not the entity, not the
      // tenant, not the identity the route does not write.
      expect(after).toMatchObject({
        tenant_id: a.tenantId,
        legal_entity_id: s.entityA,
        person_id: subject.id,
        end_date: expect.any(Date),
      });
      expect((after?.created_at as Date).getTime()).toBe(
        (before?.created_at as Date).getTime(),
      );

      const event = one(
        (await employmentAuditRows(a.tenantId)).slice(beforeAudit.length),
      );
      expect(event).toMatchObject({
        action: 'employment.updated',
        entity_type: 'employment',
        entity_id: employmentId,
        actor_user_id: a.userId,
        before_state: null,
        after_state: null,
        metadata: { module: 'people', changedFields: ['noticeDays'] },
      });
      // The stored value is not copied into the trail. The short number is
      // checked against the metadata alone, because the row's own UUIDs and
      // timestamps are digit soup.
      expect(JSON.stringify(event.metadata)).not.toContain('90');
      expect(JSON.stringify(event)).not.toContain('2019-01-01');
    });
  });

  test('treats a change-free update as a no-op with no write and no audit', async () => {
    const a = fx().a;
    const s = structure();
    const subject = await newSubject(s.entityA);
    const employmentId = await newEmployment(subject.id, s.entityA, {
      startDate: '2019-01-01',
      endDate: '2020-01-01',
      probationEndDate: '2019-04-01',
      noticeDays: 15,
      employmentType: 'contract',
    });
    const before = await ownerEmploymentRow(employmentId);
    const beforeAudit = await employmentAuditRows(a.tenantId);

    await withApp(async (app) => {
      const response = await patchEmployment(app, 'a', subject.id, employmentId, {
        employmentType: 'contract',
        startDate: '2019-01-01',
        endDate: '2020-01-01',
        probationEndDate: '2019-04-01',
        noticeDays: 15,
        status: 'active',
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.item).toMatchObject({
        employmentType: 'contract',
        noticeDays: 15,
        status: 'active',
      });

      // The clock is the proof: an UPDATE that changes nothing would still
      // advance updated_at through the trigger.
      expect(await ownerEmploymentRow(employmentId)).toEqual(before);
      expect(await employmentAuditRows(a.tenantId)).toHaveLength(beforeAudit.length);

      // A scoped member who can reach the row gets the same no-op.
      const scoped = await patchEmployment(app, 'hrEntity', subject.id, employmentId, {
        noticeDays: 15,
      });
      expect(scoped.statusCode).toBe(200);
      expect(await employmentAuditRows(a.tenantId)).toHaveLength(beforeAudit.length);
    });
  });

  test('moves active forward to ended and to cancelled, with an end date when it ends', async () => {
    const a = fx().a;
    const s = structure();
    const endSubject = await newSubject(s.entityA);
    const endId = await newEmployment(endSubject.id, s.entityA, {
      startDate: '2020-01-01',
    });
    const cancelSubject = await newSubject(s.entityA);
    const cancelId = await newEmployment(cancelSubject.id, s.entityA, {
      startDate: '2020-01-01',
    });
    const beforeAudit = await employmentAuditRows(a.tenantId);

    await withApp(async (app) => {
      // A status change that leaves the row ended without an end date is a bad
      // request, and the same PATCH naming both is accepted.
      const alone = await patchEmployment(app, 'a', endSubject.id, endId, {
        status: 'ended',
      });
      expect(alone.statusCode).toBe(400);
      expect(alone.payload).toEqual({ error: { code: 'INVALID_BODY' } });
      expect((await ownerEmploymentRow(endId))?.status).toBe('active');

      const together = await patchEmployment(app, 'a', endSubject.id, endId, {
        status: 'ended',
        endDate: '2024-12-31',
      });
      expect(together.statusCode).toBe(200);
      expect(together.item).toMatchObject({ status: 'ended', endDate: '2024-12-31' });

      const cancelled = await patchEmployment(app, 'a', cancelSubject.id, cancelId, {
        status: 'cancelled',
      });
      expect(cancelled.statusCode).toBe(200);
      // A cancelled record never needed an end date, because it states that the
      // employment did not happen as recorded.
      expect(cancelled.item).toMatchObject({ status: 'cancelled', endDate: null });

      const audit = await employmentAuditRows(a.tenantId);
      expect(audit).toHaveLength(beforeAudit.length + 2);
      expect(audit[beforeAudit.length]?.metadata).toEqual({
        module: 'people',
        changedFields: ['endDate', 'status'],
      });
      expect(audit[beforeAudit.length + 1]?.metadata).toEqual({
        module: 'people',
        changedFields: ['status'],
      });
    });

    expect(await ownerEmploymentRow(endId)).toMatchObject({ status: 'ended' });
    expect(await ownerEmploymentRow(cancelId)).toMatchObject({ status: 'cancelled' });
  });

  test('refuses every transition for a row that has already ended or been cancelled', async () => {
    const a = fx().a;
    const s = structure();
    const endedSubject = await newSubject(s.entityA);
    const endedId = await newEmployment(endedSubject.id, s.entityA, {
      startDate: '2018-01-01',
      endDate: '2019-01-01',
      status: 'ended',
    });
    const cancelledSubject = await newSubject(s.entityA);
    const cancelledId = await newEmployment(cancelledSubject.id, s.entityA, {
      startDate: '2018-01-01',
      status: 'cancelled',
    });
    const beforeEnded = await ownerEmploymentRow(endedId);
    const beforeCancelled = await ownerEmploymentRow(cancelledId);
    const beforeAudit = await employmentAuditRows(a.tenantId);

    await withApp(async (app) => {
      const refusals: { label: string; id: string; body: Record<string, unknown> }[] = [
        { label: 'ended back to active', id: endedId, body: { status: 'active' } },
        { label: 'ended to cancelled', id: endedId, body: { status: 'cancelled' } },
        {
          label: 'ended to active with a start date',
          id: endedId,
          body: { status: 'active', startDate: '2018-01-02' },
        },
        { label: 'cancelled back to active', id: cancelledId, body: { status: 'active' } },
        { label: 'cancelled to ended', id: cancelledId, body: { status: 'ended', endDate: '2020-01-01' } },
      ];

      for (const refusal of refusals) {
        const personId = refusal.id === endedId ? endedSubject.id : cancelledSubject.id;
        const response = await patchEmployment(
          app,
          'a',
          personId,
          refusal.id,
          refusal.body,
        );
        expect([refusal.label, response.statusCode, response.payload]).toEqual([
          refusal.label,
          409,
          { error: { code: 'EMPLOYMENT_STATUS_TRANSITION_INVALID' } },
        ]);
        expect(response.headers['cache-control']).toBe('no-store');
      }

      // Repeating the stored status is not a transition at all: it is the no-op.
      const sameEnded = await patchEmployment(app, 'a', endedSubject.id, endedId, {
        status: 'ended',
      });
      expect(sameEnded.statusCode).toBe(200);
      expect(sameEnded.item.status).toBe('ended');

      const sameCancelled = await patchEmployment(
        app,
        'a',
        cancelledSubject.id,
        cancelledId,
        { status: 'cancelled' },
      );
      expect(sameCancelled.statusCode).toBe(200);
      expect(sameCancelled.item.status).toBe('cancelled');
    });

    // The refusals wrote nothing, so the stored lifecycle is exactly as it was.
    expect(await ownerEmploymentRow(endedId)).toEqual(beforeEnded);
    expect(await ownerEmploymentRow(cancelledId)).toEqual(beforeCancelled);
    expect(await employmentAuditRows(a.tenantId)).toHaveLength(beforeAudit.length);
  });

  test('refuses an update that would break the stored date order', async () => {
    const a = fx().a;
    const s = structure();
    const subject = await newSubject(s.entityA);
    const employmentId = await newEmployment(subject.id, s.entityA, {
      startDate: '2020-01-01',
      endDate: '2022-01-01',
      probationEndDate: '2020-06-01',
      status: 'ended',
    });
    const before = await ownerEmploymentRow(employmentId);
    const beforeAudit = await employmentAuditRows(a.tenantId);

    await withApp(async (app) => {
      for (const body of [
        // The end date already stored, so a later start contradicts it.
        { startDate: '2022-01-02' },
        { startDate: '2024-01-01', probationEndDate: '2020-06-01' },
        // Clearing the end date would leave a row that says it ended without
        // saying when.
        { endDate: null },
        // A probation date before the new start date.
        { startDate: '2021-01-01', probationEndDate: '2020-06-01' },
      ]) {
        const response = await patchEmployment(
          app,
          'a',
          subject.id,
          employmentId,
          body,
        );
        expect([JSON.stringify(body), response.statusCode]).toEqual([
          JSON.stringify(body),
          400,
        ]);
        expect(response.payload).toEqual({ error: { code: 'INVALID_BODY' } });
      }

      // Naming the pair together is a coherent statement, so it is accepted.
      const moved = await patchEmployment(app, 'a', subject.id, employmentId, {
        startDate: '2021-01-01',
        endDate: '2023-01-01',
        probationEndDate: '2021-04-01',
      });
      expect(moved.statusCode).toBe(200);
      expect(moved.item).toMatchObject({
        startDate: '2021-01-01',
        endDate: '2023-01-01',
        probationEndDate: '2021-04-01',
        status: 'ended',
      });
    });

    expect(await ownerEmploymentRow(employmentId)).not.toEqual(before);
    const audit = await employmentAuditRows(a.tenantId);
    expect(audit).toHaveLength(beforeAudit.length + 1);
    expect(one(audit.slice(-1)).metadata.changedFields).toEqual([
      'endDate',
      'probationEndDate',
      'startDate',
    ]);
  });

  test('clears an optional value with null and refuses null for the three a row always has', async () => {
    const a = fx().a;
    const s = structure();
    const subject = await newSubject(s.entityA);
    const employmentId = await newEmployment(subject.id, s.entityA, {
      startDate: '2020-01-01',
      endDate: '2021-01-01',
      probationEndDate: '2020-04-01',
      noticeDays: 21,
    });

    await withApp(async (app) => {
      for (const body of [
        { employmentType: null },
        { startDate: null },
        { status: null },
        { employmentType: 'freelance' },
        { status: 'terminated' },
        { employmentType: 4 },
      ]) {
        const response = await patchEmployment(app, 'a', subject.id, employmentId, body);
        expect([JSON.stringify(body), response.statusCode]).toEqual([
          JSON.stringify(body),
          400,
        ]);
        expect(response.payload).toEqual({ error: { code: 'INVALID_BODY' } });
      }

      const cleared = await patchEmployment(app, 'a', subject.id, employmentId, {
        endDate: null,
        probationEndDate: null,
        noticeDays: null,
      });
      expect(cleared.statusCode).toBe(200);
      expect(cleared.item).toMatchObject({
        endDate: null,
        probationEndDate: null,
        noticeDays: null,
        startDate: '2020-01-01',
        status: 'active',
      });
      expect(await ownerEmploymentRow(employmentId)).toMatchObject({
        end_date: null,
        probation_end_date: null,
        notice_days: null,
      });
    });

    const audit = await employmentAuditRows(a.tenantId);
    expect(one(audit.slice(-1)).metadata).toEqual({
      module: 'people',
      changedFields: ['endDate', 'noticeDays', 'probationEndDate'],
    });
  });

  test('answers one 404 EMPLOYMENT_NOT_FOUND for every row this caller cannot reach', async () => {
    const a = fx().a;
    const s = structure();
    const subject = await newSubject(s.entityA);
    const other = await newSubject(s.entityA);
    const employmentId = await newEmployment(subject.id, s.entityA, {
      startDate: '2020-01-01',
    });
    const otherEmployment = await newEmployment(other.id, s.entityA, {
      startDate: '2020-01-01',
    });
    const before = await ownerEmploymentRow(employmentId);
    const beforeAudit = await employmentAuditRows(a.tenantId);

    await withApp(async (app) => {
      for (const id of [
        randomUUID(),
        'not-a-uuid',
        subject.id,
        // Another person's row addressed under this person: the same answer, so
        // no caller can probe whether an id belongs to a colleague.
        otherEmployment,
        // A row in another tenant, reached through a real person of this one.
        a.employmentId,
        fx().b.employmentId,
      ]) {
        const response = await patchEmployment(app, 'a', subject.id, id, {
          noticeDays: 5,
        });
        expect([id, response.statusCode, response.payload]).toEqual([
          id,
          404,
          { error: { code: 'EMPLOYMENT_NOT_FOUND' } },
        ]);
        expect(response.headers['cache-control']).toBe('no-store');
      }
    });

    expect(await ownerEmploymentRow(employmentId)).toEqual(before);
    expect(await employmentAuditRows(a.tenantId)).toHaveLength(beforeAudit.length);
  });

  test('answers the person miss before the row miss', async () => {
    const s = structure();
    const inA = await newSubject(s.entityA);
    const employmentId = await newEmployment(inA.id, s.entityA, {
      startDate: '2020-01-01',
    });
    const beforeAudit = await employmentAuditRows(fx().a.tenantId);

    await withApp(async (app) => {
      // A member whose scope does not reach this colleague gets the directory's
      // miss, not a verdict about the history row.
      for (const personId of [
        inA.id,
        fx().b.personId,
        fx().softDeletedPerson.id,
        'not-a-uuid',
      ]) {
        const response = await patchEmployment(
          app,
          personId === inA.id ? 'hrOther' : 'a',
          personId,
          employmentId,
          { noticeDays: 5 },
        );
        expect([personId, response.statusCode, response.payload]).toEqual([
          personId,
          404,
          { error: { code: 'PERSON_NOT_FOUND' } },
        ]);
      }

      // A malformed person id is the same miss, and the row id is never reached.
      const malformedPerson = await patchEmployment(
        app,
        'a',
        'not-a-uuid',
        employmentId,
        { noticeDays: 5 },
      );
      expect(malformedPerson.payload).toEqual({ error: { code: 'PERSON_NOT_FOUND' } });
    });

    expect(await ownerEmploymentRow(employmentId)).toMatchObject({ notice_days: null });
    expect(await employmentAuditRows(fx().a.tenantId)).toHaveLength(beforeAudit.length);
  });

  test('refuses an empty body and a key the route does not write', async () => {
    const a = fx().a;
    const s = structure();
    const subject = await newSubject(s.entityA);
    const employmentId = await newEmployment(subject.id, s.entityA, {
      startDate: '2020-01-01',
    });
    const before = await ownerEmploymentRow(employmentId);
    const beforeAudit = await employmentAuditRows(a.tenantId);

    await withApp(async (app) => {
      for (const body of [
        {},
        [],
        'not-an-object',
        null,
        { note: 'a free-text note' },
        { legalEntityId: s.entityB },
        { personId: subject.id },
        { workJurisdictionId: randomUUID() },
        { created_at: '2020-01-01' },
      ]) {
        const response = await patchEmployment(app, 'a', subject.id, employmentId, body);
        expect([JSON.stringify(body), response.statusCode]).toEqual([
          JSON.stringify(body),
          400,
        ]);
        expect(response.payload).toEqual({ error: { code: 'INVALID_BODY' } });
        expect(response.body).not.toContain('free-text');
      }

      const missingBody = await send(app, {
        method: 'PATCH',
        url: `/v1/people/${subject.id}/employments/${employmentId}`,
        cookie: session('a').cookie,
        csrf: session('a').csrfToken,
      });
      expect(missingBody.statusCode).toBe(400);
      expect(missingBody.payload).toEqual({ error: { code: 'INVALID_BODY' } });
    });

    expect(await ownerEmploymentRow(employmentId)).toEqual(before);
    expect(await employmentAuditRows(a.tenantId)).toHaveLength(beforeAudit.length);
  });

  test('answers 403 SCOPE_DENIED on an update of a visible but unwritable person', async () => {
    const a = fx().a;
    const before = await ownerEmploymentRow(linked().employmentId);
    const beforeAudit = await employmentAuditRows(a.tenantId);

    await withApp(async (app) => {
      // The row is readable by this member and the update policy refuses it, so
      // without the helper first the statement would match nothing and the route
      // would answer a sanitized 500 for what is a scope decision.
      const response = await patchEmployment(
        app,
        'selfHr',
        linked().personId,
        linked().employmentId,
        { noticeDays: 5 },
      );
      expect(response.statusCode).toBe(403);
      expect(response.payload).toEqual({ error: { code: 'SCOPE_DENIED' } });
      expect(response.headers['cache-control']).toBe('no-store');
    });

    expect(await ownerEmploymentRow(linked().employmentId)).toEqual(before);
    expect(await employmentAuditRows(a.tenantId)).toHaveLength(beforeAudit.length);
  });

  test('lets a scoped member update inside their entity and refuses one outside it', async () => {
    const s = structure();
    const inA = await newSubject(s.entityA);
    const inB = await newSubject(s.entityB);
    const inAId = await newEmployment(inA.id, s.entityA, { startDate: '2020-01-01' });
    const inBId = await newEmployment(inB.id, s.entityB, { startDate: '2020-01-01' });

    await withApp(async (app) => {
      const inside = await patchEmployment(app, 'hrEntity', inA.id, inAId, {
        noticeDays: 45,
      });
      expect(inside.statusCode).toBe(200);
      expect(inside.item.noticeDays).toBe(45);

      const outside = await patchEmployment(app, 'hrEntity', inB.id, inBId, {
        noticeDays: 45,
      });
      expect(outside.statusCode).toBe(404);
      expect(outside.payload).toEqual({ error: { code: 'PERSON_NOT_FOUND' } });
    });

    expect(await ownerEmploymentRow(inBId)).toMatchObject({ notice_days: null });
  });

  test('audits the changed field names only, never a value', async () => {
    const a = fx().a;
    const s = structure();
    const subject = await newSubject(s.entityA);
    const employmentId = await newEmployment(subject.id, s.entityA, {
      startDate: '2015-01-01',
      noticeDays: 7,
    });
    const beforeAudit = await employmentAuditRows(a.tenantId);

    await withApp(async (app) => {
      const response = await patchEmployment(app, 'a', subject.id, employmentId, {
        employmentType: 'consultant',
        probationEndDate: '2015-10-10',
        status: 'cancelled',
      });
      expect(response.statusCode).toBe(200);

      const audit = await employmentAuditRows(a.tenantId);
      expect(audit).toHaveLength(beforeAudit.length + 1);
      const event = one(audit.slice(-1));
      expect(event).toMatchObject({
        action: 'employment.updated',
        entity_type: 'employment',
        entity_id: employmentId,
        actor_type: 'user',
        actor_user_id: a.userId,
      });
      expect(event.metadata).toEqual({
        module: 'people',
        changedFields: ['employmentType', 'probationEndDate', 'status'],
      });

      // Distinctive values are absent from the whole row; the short numeric
      // notice period is checked against the metadata only, since the row's
      // UUIDs can contain any digit sequence.
      expect(JSON.stringify(event.metadata)).not.toContain('7');
      const serialized = JSON.stringify(event);
      for (const value of ['2015-10-10', '2015-01-01', 'consultant', 'cancelled']) {
        expect(serialized).not.toContain(value);
      }
    });
  });

  test('marks every update outcome uncacheable', async () => {
    const s = structure();
    const subject = await newSubject(s.entityA);
    const employmentId = await newEmployment(subject.id, s.entityA, {
      startDate: '2020-01-01',
    });
    const statuses: number[] = [];

    await withApp(async (app) => {
      statuses.push(
        (await patchEmployment(app, 'a', subject.id, employmentId, { noticeDays: 3 }))
          .statusCode,
      );
      statuses.push(
        (await patchEmployment(app, 'a', subject.id, employmentId, {})).statusCode,
      );
      statuses.push(
        (
          await patchEmployment(app, 'a', subject.id, randomUUID(), {
            noticeDays: 3,
          })
        ).statusCode,
      );
      statuses.push(
        (await patchEmployment(app, 'a', randomUUID(), employmentId, { noticeDays: 3 }))
          .statusCode,
      );
      statuses.push(
        (await patchEmployment(app, 'manager', subject.id, employmentId, { noticeDays: 3 }))
          .statusCode,
      );
      statuses.push(
        (await patchEmployment(app, 'a', subject.id, employmentId, { status: 'active' }))
          .statusCode,
      );
      statuses.push(
        (await patchEmployment(app, 'selfHr', linked().personId, linked().employmentId, {
          noticeDays: 3,
        })).statusCode,
      );
    });

    // 200, 400, 404 EMPLOYMENT_NOT_FOUND, 404 PERSON_NOT_FOUND, 403 ROLE_DENIED,
    // 200 no-op (the status named is the one stored), 403 SCOPE_DENIED.
    expect(statuses).toEqual([200, 400, 404, 404, 403, 200, 403]);
  });
});

describe('Employment grants and the directory it sits beside', () => {
  test('adds no grant: the runtime holds exactly the twelve reviewed table privileges', async () => {
    const grants = await withOwner(async (client) => {
      const result = await client.query<{
        table_name: string;
        privilege_type: string;
      }>(
        `select table_name, privilege_type
           from information_schema.role_table_grants
          where grantee = 'saas_runtime'
            and table_schema = 'public'
          order by table_name, privilege_type`,
      );
      return result.rows;
    });

    expect(grants).toHaveLength(12);
    // Still twelve table-level privileges: the compensation grant the next slice
    // added is column-qualified, so it is not in this view and is pinned instead
    // in tests/people-compensation.test.ts.
    expect(
      grants.filter((row) => row.table_name === 'employment').map((row) => row.privilege_type),
    ).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);

    // A narrowed write path would show up as a column-qualified grant on the
    // relation. Employment has none: its privilege is the whole-table DML that
    // the M0 RLS proof surface deliberately keeps, so a denial is always a
    // policy denial and never a missing privilege. information_schema
    // .column_privileges expands a table privilege onto every column, so it
    // cannot express this; the relation's own ACL can.
    const acl = await withOwner(async (client) => {
      const result = await client.query<{ entries: string[] | null }>(
        `select array_agg(item::text) as entries
           from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
          cross join lateral unnest(c.relacl) as item
          where n.nspname = 'public'
            and c.relname = 'employment'`,
      );
      return result.rows[0]?.entries ?? [];
    });
    expect(acl.filter((entry) => entry.includes(':'))).toEqual([]);
    expect(acl.filter((entry) => entry.startsWith('saas_runtime='))).toHaveLength(1);
  });

  test('adds no migration of its own: the ledger holds thirteen applied versions, newest 0013', async () => {
    const ledger = await withOwner(async (client) => {
      const result = await client.query<{ version: string; status: string }>(
        `select version, status from infra.schema_migration
          where status = 'applied'
          order by version`,
      );
      return result.rows;
    });

    // Employment added no version between 0001 and 0012; the thirteenth,
    // 0013_compensation_read.sql, belongs to the next slice and changes nothing
    // here. The ledger is pinned so a fourth history migration cannot arrive
    // without being named in this suite too.
    expect(ledger).toHaveLength(13);
    expect(one(ledger).version).toBe('0001_core.sql');
    expect(ledger[ledger.length - 1]?.version).toBe('0013_compensation_read.sql');
  });

  test('leaves the directory row and the export byte-identical to before the writes', async () => {
    const s = structure();
    const subject = await newSubject(s.entityA);
    const personBefore = await ownerPersonRow(subject.id);
    const employmentId = await newEmployment(subject.id, s.entityA, {
      startDate: '2016-01-01',
    });

    await withApp(async (app) => {
      const exportBefore = await exportDirectory(app);

      const created = await addEmployment(app, 'a', subject.id, {
        employmentType: 'full_time',
        startDate: '2017-01-01',
      });
      expect(created.statusCode).toBe(201);
      const updated = await patchEmployment(app, 'a', subject.id, created.item.id, {
        status: 'cancelled',
      });
      expect(updated.statusCode).toBe(200);

      // The directory read still names the placement, not the employment: a
      // history row changes nothing about the eleven-key person item. The
      // search filter is the route's own "q" parameter, so the subject is found
      // by term rather than by hoping it lands on the first unfiltered page.
      const list = await app.inject({
        method: 'GET',
        url: `/v1/people?q=${encodeURIComponent(subject.displayName)}`,
        headers: { cookie: session('a').cookie, 'user-agent': USER_AGENT },
      });
      expect(list.statusCode).toBe(200);
      const data = list.json() as {
        items: { id: string; legalEntityId: string | null }[];
      };
      expect(one(data.items.filter((row) => row.id === subject.id))).toMatchObject({
        legalEntityId: s.entityA,
      });

      // The CSV export is the directory identity export it already was: no
      // employment column, no extra row, and byte-for-byte the same content.
      const exportAfter = await exportDirectory(app);
      expect(exportAfter).toBe(exportBefore);
    });

    // An employment write never touches the person row, so the placement and the
    // identity clock both stay exactly as they were.
    expect(await ownerPersonRow(subject.id)).toEqual(personBefore);
    expect(await ownerEmploymentRow(employmentId)).toMatchObject({ status: 'active' });
  });
});
