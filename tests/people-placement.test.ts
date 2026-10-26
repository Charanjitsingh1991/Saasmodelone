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
  MembershipRole,
  PeopleListItem,
  PeopleListResponse,
  PeoplePlacementInput,
  PeoplePlacementOptions,
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
const USER_AGENT = 'People placement test/1.0';
const ITEM_KEYS = [
  'displayName',
  'employeeCode',
  'firstName',
  'id',
  'lastName',
  'legalEntityId',
  'legalEntityName',
  'orgUnitId',
  'orgUnitName',
  'phone',
  'workEmail',
];

type WriteResponse = {
  statusCode: number;
  headers: OutgoingHttpHeaders;
  body: string;
  payload: Record<string, unknown> | null;
  item: PeopleListItem;
  options: PeoplePlacementOptions;
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
  hrUnit: SessionFixture;
  hrOrphan: SessionFixture;
};

type Membership = { userId: string; membershipId: string };

type Subject = { id: string; displayName: string; workEmail: string };

let database: TestDatabase | undefined;
let fixtures: AccessFixtures | undefined;
let runtime: RuntimePool | undefined;
let auth: AuthPool | undefined;
let owner: Pool | undefined;
let sessions: Sessions | undefined;
let memberships:
  | Record<'manager' | 'hrEntity' | 'hrUnit' | 'hrOrphan', Membership>
  | undefined;
let org:
  | {
      entityA: string;
      entityB: string;
      entityBName: string;
      entityRetired: string;
      unitRoot: string;
      unitRootName: string;
      unitChild: string;
      unitChildName: string;
      unitGrandchild: string;
      unitGrandchildName: string;
      unitSibling: string;
      unitSiblingName: string;
      unitOtherEntity: string;
      unitOtherEntityName: string;
      unitNoEntity: string;
      unitRetired: string;
    }
  | undefined;
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

function membership(name: 'manager' | 'hrEntity' | 'hrUnit' | 'hrOrphan'): Membership {
  if (!memberships) {
    throw new Error('Placement members have not been created');
  }
  return memberships[name];
}

function structure() {
  if (!org) {
    throw new Error('Placement structure has not been created');
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

/** The whole stored row, owner-side, so a placement write can be proven to have
 *  touched nothing except the two placement columns and the clock. */
async function ownerPersonRow(id: string): Promise<Record<string, unknown> | null> {
  return withOwner(async (client) => {
    const result = await client.query<Record<string, unknown>>(
      'select * from person where id = $1',
      [id],
    );
    return result.rows[0] ?? null;
  });
}

function withoutPlacementAndClock(
  row: Record<string, unknown> | null,
): Record<string, unknown> {
  const copy = { ...(row ?? {}) };
  delete copy.legal_entity_id;
  delete copy.org_unit_id;
  delete copy.updated_at;
  return copy;
}

/** Each test writes to its own person, so no assertion depends on the order the
 *  tests ran in. */
async function newSubject(
  legalEntityId: string | null,
  orgUnitId: string | null,
): Promise<Subject> {
  subjectCounter += 1;
  const label = `subject${subjectCounter}`;
  return withOwner(async (client) => {
    const result = await client.query<{ id: string }>(
      `insert into person
         (tenant_id, employee_code, first_name, display_name, work_email, phone,
          legal_entity_id, org_unit_id)
       values ($1, $2, 'Subject', $3, $4, '+1 555 0300', $5, $6)
       returning id`,
      [
        fx().a.tenantId,
        `PLC-${label}-${randomToken().slice(0, 6)}`,
        `Placement ${label}`,
        `${label}_${randomToken().slice(0, 8)}@example.test`,
        legalEntityId,
        orgUnitId,
      ],
    );
    return {
      id: one(result.rows).id,
      displayName: `Placement ${label}`,
      workEmail: `${label}@example.test`,
    };
  });
}

async function placementAuditRows(tenantId: string): Promise<AuditRow[]> {
  return withOwner(async (client) => {
    const result = await client.query<AuditRow>(
      `select action, entity_type, entity_id, actor_type, actor_user_id,
              before_state, after_state, metadata
         from audit_event
        where tenant_id = $1
          and action = 'person.placement.changed'
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
  method: 'GET' | 'PATCH';
  url: string;
  cookie?: string;
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
    item: payload as unknown as PeopleListItem,
    options: payload as unknown as PeoplePlacementOptions,
  };
}

function options(
  app: TestServer,
  which: keyof Sessions,
  origin?: string,
): Promise<WriteResponse> {
  const s = session(which);
  return send(app, {
    method: 'GET',
    url: '/v1/people/placement-options',
    cookie: s.cookie,
    origin,
  });
}

function place(
  app: TestServer,
  which: keyof Sessions,
  id: string,
  body: unknown,
): Promise<WriteResponse> {
  const s = session(which);
  return send(app, {
    method: 'PATCH',
    url: `/v1/people/${id}/placement`,
    cookie: s.cookie,
    csrf: s.csrfToken,
    body,
  });
}

function pair(input: PeoplePlacementInput): Record<string, unknown> {
  return { legalEntityId: input.legalEntityId, orgUnitId: input.orgUnitId };
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
    [`${label}_${randomToken().slice(0, 8)}@example.test`, `Placement ${label}`],
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
  tenantId: string,
  jurisdictionId: string,
  name: string,
  deleted: boolean,
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `insert into legal_entity
       (tenant_id, name, code, jurisdiction_id, currency, timezone, deleted_at)
     values ($1, $2, $3, $4, 'ZZZ', 'UTC', $5)
     returning id`,
    [
      tenantId,
      name,
      `pl_${randomToken().slice(0, 8)}`,
      jurisdictionId,
      deleted ? new Date() : null,
    ],
  );
  return one(result.rows).id;
}

async function insertOrgUnit(
  client: Client,
  tenantId: string,
  name: string,
  legalEntityId: string | null,
  parentId: string | null,
  deleted: boolean,
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `insert into org_unit
       (tenant_id, legal_entity_id, parent_id, name, kind, deleted_at)
     values ($1, $2, $3, $4, 'department', $5)
     returning id`,
    [tenantId, legalEntityId, parentId, name, deleted ? new Date() : null],
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

    // A second live entity, a retired entity and an org-unit tree, all written
    // owner-side: legal entity and org unit administration is not a route in
    // this milestone and the tests must not imply that it is.
    const jurisdiction = await client.query<{ jurisdiction_id: string }>(
      'select jurisdiction_id from legal_entity where id = $1',
      [a.legalEntityId],
    );
    const jurisdictionId = one(jurisdiction.rows).jurisdiction_id;
    const entityBName = 'Placement beta';
    const entityB = await insertLegalEntity(
      client,
      a.tenantId,
      jurisdictionId,
      entityBName,
      false,
    );
    const entityRetired = await insertLegalEntity(
      client,
      a.tenantId,
      jurisdictionId,
      'Placement retired entity',
      true,
    );

    const unitRootName = 'Placement unit root';
    const unitChildName = 'Placement unit child';
    const unitGrandchildName = 'Placement unit grandchild';
    const unitSiblingName = 'Placement unit sibling';
    const unitOtherEntityName = 'Placement unit elsewhere';
    const unitRoot = await insertOrgUnit(
      client,
      a.tenantId,
      unitRootName,
      a.legalEntityId,
      null,
      false,
    );
    const unitChild = await insertOrgUnit(
      client,
      a.tenantId,
      unitChildName,
      a.legalEntityId,
      unitRoot,
      false,
    );
    const unitGrandchild = await insertOrgUnit(
      client,
      a.tenantId,
      unitGrandchildName,
      a.legalEntityId,
      unitChild,
      false,
    );
    const unitSibling = await insertOrgUnit(
      client,
      a.tenantId,
      unitSiblingName,
      a.legalEntityId,
      unitRoot,
      false,
    );
    const unitRetired = await insertOrgUnit(
      client,
      a.tenantId,
      'Placement unit retired',
      a.legalEntityId,
      unitRoot,
      true,
    );
    const unitOtherEntity = await insertOrgUnit(
      client,
      a.tenantId,
      unitOtherEntityName,
      entityB,
      null,
      false,
    );
    // A unit with no legal entity names no placement this route can store,
    // because an org unit is always placed under its own entity.
    const unitNoEntity = await insertOrgUnit(
      client,
      a.tenantId,
      'Placement unit ownerless',
      null,
      null,
      false,
    );

    const managerMember = await insertMember(client, 'manager', 'manager');
    const hrEntityMember = await insertMember(client, 'hr', 'hrentity');
    const hrUnitMember = await insertMember(client, 'hr', 'hrunit');
    const hrOrphanMember = await insertMember(client, 'hr', 'hrorphan');
    memberships = {
      manager: managerMember,
      hrEntity: hrEntityMember,
      hrUnit: hrUnitMember,
      hrOrphan: hrOrphanMember,
    };

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
      hrUnit: await createSessionFixture(client, {
        userId: hrUnitMember.userId,
        tenantId: a.tenantId,
      }),
      hrOrphan: await createSessionFixture(client, {
        userId: hrOrphanMember.userId,
        tenantId: a.tenantId,
      }),
    };

    org = {
      entityA: a.legalEntityId,
      entityB,
      entityBName,
      entityRetired,
      unitRoot,
      unitRootName,
      unitChild,
      unitChildName,
      unitGrandchild,
      unitGrandchildName,
      unitSibling,
      unitSiblingName,
      unitOtherEntity,
      unitOtherEntityName,
      unitNoEntity,
      unitRetired,
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
    membershipId: membership('hrUnit').membershipId,
    scopes: [{ scopeType: 'org_unit', scopeId: structure().unitChild }],
    actorUserId: fx().a.userId,
  });
  await setMembershipScope(ownerPool(), {
    tenantId: fx().a.tenantId,
    membershipId: membership('hrOrphan').membershipId,
    // A unit that belongs to no legal entity and has no children: this member
    // has a scope, and nothing inside it to place a person onto.
    scopes: [{ scopeType: 'org_unit', scopeId: structure().unitNoEntity }],
    actorUserId: fx().a.userId,
  });
}, 180_000);

afterAll(async () => {
  await owner?.end();
  await auth?.end();
  await runtime?.end();
  await database?.drop();
});

describe('People placement options', () => {
  test('rejects the options route without a valid session', async () => {
    await withApp(async (app) => {
      for (const cookie of [undefined, `saas_session=${randomToken()}`]) {
        const response = await send(app, {
          method: 'GET',
          url: '/v1/people/placement-options',
          cookie,
        });
        expect(response.statusCode).toBe(401);
        expect(response.payload).toEqual({ error: { code: 'UNAUTHENTICATED' } });
        expect(response.headers['cache-control']).toBe('no-store');
      }
    });
  });

  test('answers a tenant-wide owner with every live entity and unit, sorted', async () => {
    const a = fx().a;
    const s = structure();
    const beforeAudit = await auditRowCount(a.tenantId);

    await withApp(async (app) => {
      const response = await options(app, 'a');
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.options).toEqual({
        canUnplace: true,
        legalEntities: [
          { id: s.entityA, name: 'Legal a', code: expect.any(String), placeable: true },
          { id: s.entityB, name: s.entityBName, code: expect.any(String), placeable: true },
        ],
        orgUnits: [
          { id: s.unitChild, name: s.unitChildName, legalEntityId: s.entityA, placeable: true },
          {
            id: s.unitOtherEntity,
            name: s.unitOtherEntityName,
            legalEntityId: s.entityB,
            placeable: true,
          },
          {
            id: s.unitGrandchild,
            name: s.unitGrandchildName,
            legalEntityId: s.entityA,
            placeable: true,
          },
          { id: s.unitRoot, name: s.unitRootName, legalEntityId: s.entityA, placeable: true },
          { id: s.unitSibling, name: s.unitSiblingName, legalEntityId: s.entityA, placeable: true },
        ],
      });

      // Retired reference rows are absent by id and by name, and so is a unit
      // that belongs to no entity.
      for (const absent of [
        s.unitRetired,
        s.entityRetired,
        s.unitNoEntity,
        'Placement unit retired',
        'Placement retired entity',
        'Placement unit ownerless',
        fx().b.legalEntityId,
      ]) {
        expect(response.body).not.toContain(absent);
      }
    });

    // The read authorizes but never audits: no row of any kind is added.
    expect(await auditRowCount(a.tenantId)).toBe(beforeAudit);
  });

  test('limits an entity-scoped member to their own entity and its units', async () => {
    const s = structure();
    await withApp(async (app) => {
      const response = await options(app, 'hrEntity');
      expect(response.statusCode).toBe(200);
      expect(response.options).toEqual({
        canUnplace: false,
        legalEntities: [
          { id: s.entityA, name: 'Legal a', code: expect.any(String), placeable: true },
        ],
        orgUnits: [
          { id: s.unitChild, name: s.unitChildName, legalEntityId: s.entityA, placeable: true },
          {
            id: s.unitGrandchild,
            name: s.unitGrandchildName,
            legalEntityId: s.entityA,
            placeable: true,
          },
          { id: s.unitRoot, name: s.unitRootName, legalEntityId: s.entityA, placeable: true },
          { id: s.unitSibling, name: s.unitSiblingName, legalEntityId: s.entityA, placeable: true },
        ],
      });
      expect(response.body).not.toContain(s.entityB);
      expect(response.body).not.toContain(s.unitOtherEntity);
    });
  });

  test('shows an org-unit-scoped member the parent entity as not placeable and only their subtree', async () => {
    const s = structure();
    await withApp(async (app) => {
      const response = await options(app, 'hrUnit');
      expect(response.statusCode).toBe(200);
      // The entity is offered only to group the units inside the subtree:
      // placeable false tells the UI that an entity-only placement is not
      // available to this member.
      expect(response.options).toEqual({
        canUnplace: false,
        legalEntities: [
          { id: s.entityA, name: 'Legal a', code: expect.any(String), placeable: false },
        ],
        orgUnits: [
          { id: s.unitChild, name: s.unitChildName, legalEntityId: s.entityA, placeable: true },
          {
            id: s.unitGrandchild,
            name: s.unitGrandchildName,
            legalEntityId: s.entityA,
            placeable: true,
          },
        ],
      });
      // An ancestor and a sibling are outside the subtree.
      expect(response.body).not.toContain(s.unitRoot);
      expect(response.body).not.toContain(s.unitSibling);
    });
  });

  test('answers a member with nothing placeable as an empty, successful list', async () => {
    await withApp(async (app) => {
      const response = await options(app, 'hrOrphan');
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.options).toEqual({
        canUnplace: false,
        legalEntities: [],
        orgUnits: [],
      });
    });
  });

  test('refuses a people.read-only role with ROLE_DENIED on the options route', async () => {
    const a = fx().a;
    const before = await denialRows(a.tenantId);

    await withApp(async (app) => {
      const response = await options(app, 'manager');
      expect(response.statusCode).toBe(403);
      expect(response.payload).toEqual({
        error: { code: 'ROLE_DENIED', permission: 'people.write' },
      });
      expect(response.headers['cache-control']).toBe('no-store');
    });

    const after = await denialRows(a.tenantId);
    expect(after).toHaveLength(before.length + 1);
    expect(one(after.slice(-1))).toMatchObject({
      action: 'authorization.denied',
      entity_type: 'request',
      actor_user_id: membership('manager').userId,
      metadata: {
        reason: 'ROLE_DENIED',
        module: 'people',
        operation: 'write',
        method: 'GET',
        path: '/v1/people/placement-options',
      },
    });
  });

  test('refuses a tenant without the People entitlement before the role check', async () => {
    const b = fx().b;
    const before = await denialRows(b.tenantId);

    await withApp(async (app) => {
      const response = await options(app, 'b');
      expect(response.statusCode).toBe(403);
      expect(response.payload).toEqual({
        error: { code: 'MODULE_NOT_ENTITLED', module: 'people', operation: 'write' },
      });
      expect(response.headers['cache-control']).toBe('no-store');
    });

    const after = await denialRows(b.tenantId);
    expect(after).toHaveLength(before.length + 1);
    expect(one(after.slice(-1)).metadata.reason).toBe('MODULE_NOT_ENTITLED');
  });

  test('needs no CSRF token for the options GET and never caches it', async () => {
    await withApp(async (app) => {
      const noCsrf = await send(app, {
        method: 'GET',
        url: '/v1/people/placement-options',
        cookie: session('a').cookie,
      });
      expect(noCsrf.statusCode).toBe(200);
      expect(noCsrf.headers['cache-control']).toBe('no-store');

      // The origin hook guards unsafe methods only, so a cross-origin GET reads
      // the caller's own choices and discloses nothing new.
      const crossOrigin = await options(app, 'a', 'https://evil.example.test');
      expect(crossOrigin.statusCode).toBe(200);
      expect(crossOrigin.options).toEqual(noCsrf.options);
    });
  });
});

describe('People placement write', () => {
  test('rejects the placement route without a session, a CSRF token or the origin', async () => {
    const a = fx().a;
    const s = structure();
    const subject = await newSubject(s.entityA, s.unitChild);
    const before = await ownerPersonRow(subject.id);
    const beforeAudit = await placementAuditRows(a.tenantId);
    const body = pair({ legalEntityId: s.entityB, orgUnitId: null });

    await withApp(async (app) => {
      const noSession = await send(app, {
        method: 'PATCH',
        url: `/v1/people/${subject.id}/placement`,
        csrf: session('a').csrfToken,
        body,
      });
      expect(noSession.statusCode).toBe(401);
      expect(noSession.payload).toEqual({ error: { code: 'UNAUTHENTICATED' } });
      expect(noSession.headers['cache-control']).toBe('no-store');

      for (const csrf of [undefined, 'wrong-token']) {
        const noCsrf = await send(app, {
          method: 'PATCH',
          url: `/v1/people/${subject.id}/placement`,
          cookie: session('a').cookie,
          csrf,
          body,
        });
        expect(noCsrf.statusCode).toBe(403);
        expect(noCsrf.payload).toEqual({ error: { code: 'CSRF_INVALID' } });
        expect(noCsrf.headers['cache-control']).toBe('no-store');
      }

      const badOrigin = await send(app, {
        method: 'PATCH',
        url: `/v1/people/${subject.id}/placement`,
        cookie: session('a').cookie,
        csrf: session('a').csrfToken,
        origin: 'https://evil.example.test',
        body,
      });
      expect(badOrigin.statusCode).toBe(403);
      expect(badOrigin.payload).toEqual({ error: { code: 'ORIGIN_DENIED' } });
      expect(badOrigin.headers['cache-control']).toBe('no-store');
    });

    expect(await ownerPersonRow(subject.id)).toEqual(before);
    expect(await placementAuditRows(a.tenantId)).toHaveLength(beforeAudit.length);
  });

  test('places a person, answers the eleven-key item and keeps every other column still', async () => {
    const a = fx().a;
    const s = structure();
    const subject = await newSubject(null, null);
    const before = await ownerPersonRow(subject.id);
    expect(before?.legal_entity_id).toBeNull();
    const beforeAudit = await placementAuditRows(a.tenantId);

    await withApp(async (app) => {
      const response = await place(
        app,
        'a',
        subject.id,
        pair({ legalEntityId: s.entityA, orgUnitId: s.unitChild }),
      );
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(Object.keys(response.item).sort()).toEqual(ITEM_KEYS);
      expect(response.item).toMatchObject({
        id: subject.id,
        legalEntityId: s.entityA,
        legalEntityName: 'Legal a',
        orgUnitId: s.unitChild,
        orgUnitName: s.unitChildName,
      });

      const after = await ownerPersonRow(subject.id);
      expect(after).toMatchObject({
        legal_entity_id: s.entityA,
        org_unit_id: s.unitChild,
      });
      expect((after?.updated_at as Date).getTime()).toBeGreaterThan(
        (before?.updated_at as Date).getTime(),
      );
      // Nothing else moved: not the identity, not the status, not the link,
      // not the soft delete.
      expect(withoutPlacementAndClock(after)).toEqual(withoutPlacementAndClock(before));

      const audit = await placementAuditRows(a.tenantId);
      expect(audit).toHaveLength(beforeAudit.length + 1);
      const row = one(audit.slice(-1));
      expect(row).toMatchObject({
        action: 'person.placement.changed',
        entity_type: 'person',
        entity_id: subject.id,
        actor_type: 'user',
        actor_user_id: fx().a.userId,
        before_state: null,
        after_state: null,
        metadata: {
          module: 'people',
          legalEntityId: s.entityA,
          orgUnitId: s.unitChild,
          previousLegalEntityId: null,
          previousOrgUnitId: null,
        },
      });

      // Ids only: the audit row repeats no name, email or phone from the row.
      const serialized = JSON.stringify(row);
      for (const secret of [
        subject.displayName,
        'Legal a',
        s.unitChildName,
        '+1 555 0300',
      ]) {
        expect(serialized).not.toContain(secret);
      }
      expect(serialized).not.toContain('work_email');
    });
  });

  test('places on a legal entity alone and clears the unit', async () => {
    const s = structure();
    const subject = await newSubject(s.entityA, s.unitChild);

    await withApp(async (app) => {
      const response = await place(
        app,
        'a',
        subject.id,
        pair({ legalEntityId: s.entityB, orgUnitId: null }),
      );
      expect(response.statusCode).toBe(200);
      expect(response.item).toMatchObject({
        id: subject.id,
        legalEntityId: s.entityB,
        legalEntityName: s.entityBName,
        orgUnitId: null,
        orgUnitName: null,
      });
      expect(await ownerPersonRow(subject.id)).toMatchObject({
        legal_entity_id: s.entityB,
        org_unit_id: null,
      });
    });
  });

  test('removes a placement for a tenant-wide owner', async () => {
    const a = fx().a;
    const s = structure();
    const subject = await newSubject(s.entityB, s.unitOtherEntity);
    const beforeAudit = await placementAuditRows(a.tenantId);

    await withApp(async (app) => {
      const response = await place(
        app,
        'a',
        subject.id,
        pair({ legalEntityId: null, orgUnitId: null }),
      );
      expect(response.statusCode).toBe(200);
      expect(response.item).toMatchObject({
        id: subject.id,
        legalEntityId: null,
        legalEntityName: null,
        orgUnitId: null,
        orgUnitName: null,
      });

      expect(await ownerPersonRow(subject.id)).toMatchObject({
        legal_entity_id: null,
        org_unit_id: null,
      });

      const audit = await placementAuditRows(a.tenantId);
      expect(audit).toHaveLength(beforeAudit.length + 1);
      expect(one(audit.slice(-1)).metadata).toEqual({
        module: 'people',
        legalEntityId: null,
        orgUnitId: null,
        previousLegalEntityId: s.entityB,
        previousOrgUnitId: s.unitOtherEntity,
      });
    });
  });

  test('refuses every body that is not exactly the two-key pair', async () => {
    const a = fx().a;
    const s = structure();
    const subject = await newSubject(s.entityA, s.unitChild);
    const before = await ownerPersonRow(subject.id);
    const beforeAudit = await placementAuditRows(a.tenantId);

    const invalidBodies: unknown[] = [
      null,
      'not-an-object',
      42,
      [],
      [{ legalEntityId: s.entityA, orgUnitId: null }],
      {},
      { legalEntityId: s.entityA },
      { orgUnitId: null },
      { legalEntityId: s.entityA, orgUnitId: null, firstName: 'Sneak' },
      { legalEntityId: s.entityA, orgUnit: null },
      { legalEntityId: '', orgUnitId: null },
      { legalEntityId: 'not-a-uuid', orgUnitId: null },
      { legalEntityId: s.entityA, orgUnitId: 7 },
      { legalEntityId: s.entityA, orgUnitId: true },
      // An org unit is never placed without the entity it belongs to.
      { legalEntityId: null, orgUnitId: s.unitChild },
    ];

    await withApp(async (app) => {
      for (const body of invalidBodies) {
        const response = await place(app, 'a', subject.id, body);
        expect([JSON.stringify(body), response.statusCode, response.payload]).toEqual([
          JSON.stringify(body),
          400,
          { error: { code: 'INVALID_BODY' } },
        ]);
        expect(response.headers['cache-control']).toBe('no-store');
      }

      // A body of the right shape but no content at all is the same refusal.
      const missingBody = await send(app, {
        method: 'PATCH',
        url: `/v1/people/${subject.id}/placement`,
        cookie: session('a').cookie,
        csrf: session('a').csrfToken,
        origin: 'https://app.example.test',
      });
      expect(missingBody.statusCode).toBe(400);
      expect(missingBody.payload).toEqual({ error: { code: 'INVALID_BODY' } });
    });

    expect(await ownerPersonRow(subject.id)).toEqual(before);
    expect(await placementAuditRows(a.tenantId)).toHaveLength(beforeAudit.length);
  });

  test('answers one 404 for a reference that is unknown, retired, foreign or under the wrong entity', async () => {
    const a = fx().a;
    const s = structure();
    const subject = await newSubject(s.entityA, s.unitChild);
    const before = await ownerPersonRow(subject.id);
    const beforeAudit = await placementAuditRows(a.tenantId);

    const misses: { label: string; body: PeoplePlacementInput }[] = [
      { label: 'unknown entity', body: { legalEntityId: randomUUID(), orgUnitId: null } },
      { label: 'retired entity', body: { legalEntityId: s.entityRetired, orgUnitId: null } },
      {
        label: 'another tenant entity',
        body: { legalEntityId: fx().b.legalEntityId, orgUnitId: null },
      },
      { label: 'unknown unit', body: { legalEntityId: s.entityA, orgUnitId: randomUUID() } },
      { label: 'retired unit', body: { legalEntityId: s.entityA, orgUnitId: s.unitRetired } },
      {
        label: 'unit under another entity',
        body: { legalEntityId: s.entityA, orgUnitId: s.unitOtherEntity },
      },
      {
        label: 'unit with no entity',
        body: { legalEntityId: s.entityA, orgUnitId: s.unitNoEntity },
      },
    ];

    await withApp(async (app) => {
      for (const miss of misses) {
        const response = await place(app, 'a', subject.id, pair(miss.body));
        expect([miss.label, response.statusCode, response.payload]).toEqual([
          miss.label,
          404,
          { error: { code: 'PLACEMENT_NOT_FOUND' } },
        ]);
        expect(response.headers['cache-control']).toBe('no-store');
      }
    });

    expect(await ownerPersonRow(subject.id)).toEqual(before);
    expect(await placementAuditRows(a.tenantId)).toHaveLength(beforeAudit.length);
  });

  test('answers 404 PERSON_NOT_FOUND for an unknown, foreign, soft-deleted or malformed person', async () => {
    const a = fx().a;
    const s = structure();
    const beforeAudit = await placementAuditRows(a.tenantId);
    const body = pair({ legalEntityId: s.entityA, orgUnitId: null });

    await withApp(async (app) => {
      for (const id of [
        randomUUID(),
        'not-a-uuid',
        s.unitChild,
        fx().b.personId,
        fx().softDeletedPerson.id,
      ]) {
        const response = await place(app, 'a', id, body);
        expect([response.statusCode, response.payload]).toEqual([
          404,
          { error: { code: 'PERSON_NOT_FOUND' } },
        ]);
        expect(response.headers['cache-control']).toBe('no-store');
      }
    });

    expect(await placementAuditRows(a.tenantId)).toHaveLength(beforeAudit.length);
  });

  test('gates before the person id and the body', async () => {
    const s = structure();
    const body = pair({ legalEntityId: null, orgUnitId: null });

    await withApp(async (app) => {
      // A role that may not write is refused before the id shape or the body is
      // looked at, so a denial never depends on the caller guessing a UUID.
      const deniedByRole = await place(app, 'manager', 'not-a-uuid', body);
      expect(deniedByRole.statusCode).toBe(403);
      expect(deniedByRole.payload).toEqual({
        error: { code: 'ROLE_DENIED', permission: 'people.write' },
      });

      const deniedByBody = await place(app, 'manager', s.entityA, {});
      expect(deniedByBody.statusCode).toBe(403);

      const deniedByEntitlement = await place(app, 'b', 'not-a-uuid', body);
      expect(deniedByEntitlement.statusCode).toBe(403);
      expect(deniedByEntitlement.payload).toEqual({
        error: { code: 'MODULE_NOT_ENTITLED', module: 'people', operation: 'write' },
      });
    });
  });

  test('lets an entity-scoped member place inside their entity and refuses everything else', async () => {
    const a = fx().a;
    const s = structure();
    const subject = await newSubject(s.entityA, s.unitChild);
    const unplaced = await newSubject(null, null);
    const beforeAudit = await placementAuditRows(a.tenantId);

    await withApp(async (app) => {
      // In scope: the same entity, a different unit of it.
      const moved = await place(
        app,
        'hrEntity',
        subject.id,
        pair({ legalEntityId: s.entityA, orgUnitId: s.unitRoot }),
      );
      expect(moved.statusCode).toBe(200);
      expect(moved.item).toMatchObject({
        legalEntityId: s.entityA,
        legalEntityName: 'Legal a',
        orgUnitId: s.unitRoot,
        orgUnitName: s.unitRootName,
      });
      expect(await ownerPersonRow(subject.id)).toMatchObject({
        legal_entity_id: s.entityA,
        org_unit_id: s.unitRoot,
      });

      // Another entity answers as a miss, not as a disclosure that it exists.
      const elsewhere = await place(
        app,
        'hrEntity',
        subject.id,
        pair({ legalEntityId: s.entityB, orgUnitId: null }),
      );
      expect(elsewhere.statusCode).toBe(404);
      expect(elsewhere.payload).toEqual({ error: { code: 'PLACEMENT_NOT_FOUND' } });

      // Removing a placement entirely leaves a person this member could neither
      // see nor maintain: the one case with no id to hide behind.
      const unplace = await place(
        app,
        'hrEntity',
        subject.id,
        pair({ legalEntityId: null, orgUnitId: null }),
      );
      expect(unplace.statusCode).toBe(403);
      expect(unplace.payload).toEqual({ error: { code: 'SCOPE_DENIED' } });
      expect(unplace.headers['cache-control']).toBe('no-store');

      // A person who is currently unplaced is invisible to a scoped member, so
      // the write never reaches them.
      const invisible = await place(
        app,
        'hrEntity',
        unplaced.id,
        pair({ legalEntityId: s.entityA, orgUnitId: s.unitChild }),
      );
      expect(invisible.statusCode).toBe(404);
      expect(invisible.payload).toEqual({ error: { code: 'PERSON_NOT_FOUND' } });
      expect(await ownerPersonRow(unplaced.id)).toMatchObject({
        legal_entity_id: null,
        org_unit_id: null,
      });
    });

    // Exactly the one successful write was audited.
    const audit = await placementAuditRows(a.tenantId);
    expect(audit).toHaveLength(beforeAudit.length + 1);
    expect(one(audit.slice(-1)).actor_user_id).toBe(membership('hrEntity').userId);
    expect(await ownerPersonRow(subject.id)).toMatchObject({
      legal_entity_id: s.entityA,
      org_unit_id: s.unitRoot,
    });
  });

  test('keeps an org-unit-scoped member inside their subtree', async () => {
    const s = structure();
    const subject = await newSubject(s.entityA, s.unitChild);

    await withApp(async (app) => {
      const deepened = await place(
        app,
        'hrUnit',
        subject.id,
        pair({ legalEntityId: s.entityA, orgUnitId: s.unitGrandchild }),
      );
      expect(deepened.statusCode).toBe(200);
      expect(deepened.item.orgUnitId).toBe(s.unitGrandchild);

      // An ancestor unit, a sibling unit and the entity alone are all outside
      // what this member may place, and each is the same silent miss.
      for (const body of [
        pair({ legalEntityId: s.entityA, orgUnitId: s.unitRoot }),
        pair({ legalEntityId: s.entityA, orgUnitId: s.unitSibling }),
        pair({ legalEntityId: s.entityA, orgUnitId: null }),
      ]) {
        const refused = await place(app, 'hrUnit', subject.id, body);
        expect(refused.statusCode).toBe(404);
        expect(refused.payload).toEqual({ error: { code: 'PLACEMENT_NOT_FOUND' } });
      }

      const unplace = await place(
        app,
        'hrUnit',
        subject.id,
        pair({ legalEntityId: null, orgUnitId: null }),
      );
      expect(unplace.statusCode).toBe(403);
      expect(unplace.payload).toEqual({ error: { code: 'SCOPE_DENIED' } });

      expect(await ownerPersonRow(subject.id)).toMatchObject({
        legal_entity_id: s.entityA,
        org_unit_id: s.unitGrandchild,
      });
    });
  });

  test('treats an unchanged placement as a no-op with no write and no audit', async () => {
    const a = fx().a;
    const s = structure();
    const subject = await newSubject(s.entityA, s.unitChild);

    await withApp(async (app) => {
      const first = await place(
        app,
        'a',
        subject.id,
        pair({ legalEntityId: s.entityA, orgUnitId: s.unitGrandchild }),
      );
      expect(first.statusCode).toBe(200);
      const afterFirst = await ownerPersonRow(subject.id);
      const beforeAudit = await placementAuditRows(a.tenantId);

      const again = await place(
        app,
        'a',
        subject.id,
        pair({ legalEntityId: s.entityA, orgUnitId: s.unitGrandchild }),
      );
      expect(again.statusCode).toBe(200);
      expect(again.headers['cache-control']).toBe('no-store');
      expect(again.item).toEqual(first.item);

      // The clock is the proof: an UPDATE that changes nothing would still
      // advance updated_at through the trigger.
      expect(await ownerPersonRow(subject.id)).toEqual(afterFirst);
      expect(await placementAuditRows(a.tenantId)).toHaveLength(beforeAudit.length);

      // The same no-op through a scoped member who can see the row.
      const scoped = await place(
        app,
        'hrEntity',
        subject.id,
        pair({ legalEntityId: s.entityA, orgUnitId: s.unitGrandchild }),
      );
      expect(scoped.statusCode).toBe(200);
      expect(await placementAuditRows(a.tenantId)).toHaveLength(beforeAudit.length);
    });
  });

  test('fails closed with a sanitized 500 when the audit write fails, leaving the placement still', async () => {
    const a = fx().a;
    const s = structure();
    const subject = await newSubject(s.entityA, s.unitChild);
    const before = await ownerPersonRow(subject.id);
    const beforeAudit = await placementAuditRows(a.tenantId);

    await withOwner(async (client) => {
      await client.query('revoke insert on table public.audit_event from saas_runtime');
    });
    try {
      await withApp(async (app) => {
        const response = await place(
          app,
          'a',
          subject.id,
          pair({ legalEntityId: s.entityB, orgUnitId: s.unitOtherEntity }),
        );
        expect(response.statusCode).toBe(500);
        expect(response.payload).toEqual({ error: { code: 'INTERNAL_ERROR' } });
        expect(response.headers['cache-control']).toBe('no-store');
        for (const detail of [
          'permission denied',
          'audit_event',
          'insert into',
          'saas_runtime',
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

    // The transaction rolled back with the audit row: the person never moved
    // and nothing was audited.
    expect(await ownerPersonRow(subject.id)).toEqual(before);
    expect(await placementAuditRows(a.tenantId)).toHaveLength(beforeAudit.length);
  });

  test('marks every placement outcome uncacheable', async () => {
    const s = structure();
    const subject = await newSubject(s.entityA, s.unitChild);
    // A row still inside the org-unit member's subtree, so their refusal is the
    // scope denial and not a person they cannot see.
    const subtreeSubject = await newSubject(s.entityA, s.unitChild);
    const statuses: number[] = [];

    await withApp(async (app) => {
      const ok = await place(
        app,
        'a',
        subject.id,
        pair({ legalEntityId: s.entityA, orgUnitId: s.unitRoot }),
      );
      statuses.push(ok.statusCode);

      const badBody = await place(app, 'a', subject.id, {});
      statuses.push(badBody.statusCode);

      const badReference = await place(
        app,
        'a',
        subject.id,
        pair({ legalEntityId: s.entityRetired, orgUnitId: null }),
      );
      statuses.push(badReference.statusCode);

      const scopeDenied = await place(
        app,
        'hrUnit',
        subtreeSubject.id,
        pair({ legalEntityId: null, orgUnitId: null }),
      );
      statuses.push(scopeDenied.statusCode);

      const roleDenied = await place(
        app,
        'manager',
        subject.id,
        pair({ legalEntityId: s.entityA, orgUnitId: null }),
      );
      statuses.push(roleDenied.statusCode);
    });

    expect(statuses).toEqual([200, 400, 404, 403, 403]);
  });

  test('shows placement names in the directory and no other tenant rows', async () => {
    const s = structure();
    const subject = await newSubject(null, null);

    await withApp(async (app) => {
      const placed = await place(
        app,
        'a',
        subject.id,
        pair({ legalEntityId: s.entityA, orgUnitId: s.unitGrandchild }),
      );
      expect(placed.statusCode).toBe(200);

      const response = await app.inject({
        method: 'GET',
        url: `/v1/people?query=${encodeURIComponent(subject.displayName)}`,
        headers: { cookie: session('a').cookie, 'user-agent': USER_AGENT },
      });
      expect(response.statusCode).toBe(200);
      const data = response.json() as PeopleListResponse;
      const item = one(data.items.filter((row) => row.id === subject.id));
      expect(item).toMatchObject({
        legalEntityId: s.entityA,
        legalEntityName: 'Legal a',
        orgUnitId: s.unitGrandchild,
        orgUnitName: s.unitGrandchildName,
      });

      // Another tenant's directory rows never appear, whatever the placement.
      expect(data.items.map((row) => row.id)).not.toContain(fx().b.personId);
    });
  });

  test('keeps placement keys out of the identity patch', async () => {
    const s = structure();
    const subject = await newSubject(s.entityA, s.unitChild);
    const before = await ownerPersonRow(subject.id);

    await withApp(async (app) => {
      for (const body of [
        { firstName: 'Placement', legalEntityId: s.entityB },
        { legalEntityId: s.entityA, orgUnitId: null },
        { phone: '+1 555 0301', orgUnitId: s.unitRoot },
      ]) {
        const response = await send(app, {
          method: 'PATCH',
          url: `/v1/people/${subject.id}`,
          cookie: session('a').cookie,
          csrf: session('a').csrfToken,
          body,
        });
        expect(response.statusCode).toBe(400);
        expect(response.payload).toEqual({ error: { code: 'INVALID_BODY' } });
      }
    });

    expect(await ownerPersonRow(subject.id)).toEqual(before);
  });

  test('keeps the placement ids but nulls a retired reference name in the directory read', async () => {
    const jurisdictionId = await withOwner(async (client) => {
      const result = await client.query<{ jurisdiction_id: string }>(
        'select jurisdiction_id from legal_entity where id = $1',
        [structure().entityA],
      );
      return one(result.rows).jurisdiction_id;
    });

    /** A whole new entity + unit + unplaced person, because soft-deleting a
     *  shared fixture would change what the other tests in this file see. */
    async function freshPlacement(
      label: string,
    ): Promise<{ entityId: string; entityName: string; unitId: string; unitName: string; subject: Subject }> {
      const token = randomToken().slice(0, 8);
      const entityName = `Placement ${label} entity ${token}`;
      const unitName = `Placement ${label} unit ${token}`;
      const ids = await withOwner(async (client) => {
        const entityId = await insertLegalEntity(
          client,
          fx().a.tenantId,
          jurisdictionId,
          entityName,
          false,
        );
        const unitId = await insertOrgUnit(
          client,
          fx().a.tenantId,
          unitName,
          entityId,
          null,
          false,
        );
        return { entityId, unitId };
      });
      return { ...ids, entityName, unitName, subject: await newSubject(null, null) };
    }

    async function retire(kind: 'entity' | 'unit', id: string): Promise<void> {
      await withOwner(async (client) => {
        await client.query(
          kind === 'unit'
            ? 'update org_unit set deleted_at = now() where id = $1'
            : 'update legal_entity set deleted_at = now() where id = $1',
          [id],
        );
      });
    }

    async function directoryItem(
      app: TestServer,
      id: string,
      displayName: string,
    ): Promise<PeopleListItem> {
      const response = await app.inject({
        method: 'GET',
        url: `/v1/people?query=${encodeURIComponent(displayName)}`,
        headers: { cookie: session('a').cookie, 'user-agent': USER_AGENT },
      });
      expect(response.statusCode).toBe(200);
      const data = response.json() as PeopleListResponse;
      return one(data.items.filter((row) => row.id === id));
    }

    const unitCase = await freshPlacement('retired unit');
    const entityCase = await freshPlacement('retired entity');

    await withApp(async (app) => {
      const first = await place(
        app,
        'a',
        unitCase.subject.id,
        pair({ legalEntityId: unitCase.entityId, orgUnitId: unitCase.unitId }),
      );
      expect(first.statusCode).toBe(200);
      expect(first.item).toMatchObject({
        legalEntityId: unitCase.entityId,
        legalEntityName: unitCase.entityName,
        orgUnitId: unitCase.unitId,
        orgUnitName: unitCase.unitName,
      });
      const rowAfterFirstPlace = await ownerPersonRow(unitCase.subject.id);
      const auditAfterFirstPlace = await auditRowCount(fx().a.tenantId);

      await retire('unit', unitCase.unitId);

      const afterUnitRetirement = await directoryItem(
        app,
        unitCase.subject.id,
        unitCase.subject.displayName,
      );
      expect(Object.keys(afterUnitRetirement).sort()).toEqual([...ITEM_KEYS].sort());
      expect(afterUnitRetirement).toMatchObject({
        legalEntityId: unitCase.entityId,
        legalEntityName: unitCase.entityName,
        orgUnitId: unitCase.unitId,
        orgUnitName: null,
      });
      expect(JSON.stringify(afterUnitRetirement)).not.toContain(unitCase.unitName);
      expect(await ownerPersonRow(unitCase.subject.id)).toEqual(rowAfterFirstPlace);
      expect(await auditRowCount(fx().a.tenantId)).toBe(auditAfterFirstPlace);

      const second = await place(
        app,
        'a',
        entityCase.subject.id,
        pair({ legalEntityId: entityCase.entityId, orgUnitId: entityCase.unitId }),
      );
      expect(second.statusCode).toBe(200);
      expect(second.item).toMatchObject({
        legalEntityName: entityCase.entityName,
        orgUnitName: entityCase.unitName,
      });
      const rowAfterSecondPlace = await ownerPersonRow(entityCase.subject.id);
      const auditAfterSecondPlace = await auditRowCount(fx().a.tenantId);

      await retire('entity', entityCase.entityId);

      const afterEntityRetirement = await directoryItem(
        app,
        entityCase.subject.id,
        entityCase.subject.displayName,
      );
      expect(afterEntityRetirement).toMatchObject({
        legalEntityId: entityCase.entityId,
        legalEntityName: null,
        orgUnitId: entityCase.unitId,
        orgUnitName: entityCase.unitName,
      });
      expect(JSON.stringify(afterEntityRetirement)).not.toContain(entityCase.entityName);
      expect(await ownerPersonRow(entityCase.subject.id)).toEqual(rowAfterSecondPlace);
      expect(await auditRowCount(fx().a.tenantId)).toBe(auditAfterSecondPlace);
    });
  });
});
