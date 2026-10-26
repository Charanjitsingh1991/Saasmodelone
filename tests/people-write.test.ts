import type { OutgoingHttpHeaders } from 'node:http';
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
  PeopleCreateInput,
  PeopleListItem,
  PeopleListResponse,
} from '@saasmodels/contracts';
import {
  PERSON_DISPLAY_NAME_MAX_LENGTH,
  PERSON_EMPLOYEE_CODE_MAX_LENGTH,
  PERSON_NAME_MAX_LENGTH,
  PERSON_PHONE_MAX_LENGTH,
  PERSON_WORK_EMAIL_MAX_LENGTH,
} from '@saasmodels/contracts';
import { createServer } from '@saasmodels/api';
import { createTestDatabase, type TestDatabase } from '@saasmodels/testkit';
import {
  createAccessFixtures,
  type AccessFixtures,
  type PersonRowFixture,
} from './support/access-fixtures.js';
import {
  createSessionFixture,
  randomToken,
  type SessionFixture,
} from './support/auth-fixtures.js';

const appOrigin = 'https://app.example.test';
const USER_AGENT = 'People write test/1.0';
const ITEM_KEYS = [
  'displayName',
  'employeeCode',
  'firstName',
  'id',
  'lastName',
  'phone',
  'workEmail',
];

type WriteResponse = {
  statusCode: number;
  headers: OutgoingHttpHeaders;
  body: string;
  payload: Record<string, unknown> | null;
  item: PeopleListItem;
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

type PersonDbRow = {
  id: string;
  tenant_id: string;
  employee_code: string | null;
  first_name: string;
  last_name: string | null;
  display_name: string;
  work_email: string | null;
  phone: string | null;
  status: string;
  deleted_at: string | null;
  legal_entity_id: string | null;
  org_unit_id: string | null;
  user_id: string | null;
  personal_email: string | null;
  date_of_birth: string | null;
  gender: string | null;
  designation: string | null;
  created_at: Date;
  updated_at: Date;
};

type Sessions = {
  a: SessionFixture;
  admin: SessionFixture;
  b: SessionFixture;
  manager: SessionFixture;
  hrScoped: SessionFixture;
};

let database: TestDatabase | undefined;
let fixtures: AccessFixtures | undefined;
let runtime: RuntimePool | undefined;
let auth: AuthPool | undefined;
let owner: Pool | undefined;
let sessions: Sessions | undefined;
let members: {
  admin: { userId: string; membershipId: string };
  manager: { userId: string; membershipId: string };
  hrScoped: { userId: string; membershipId: string };
} | undefined;

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

function member(name: 'admin' | 'manager' | 'hrScoped'): {
  userId: string;
  membershipId: string;
} {
  if (!members) {
    throw new Error('Write test members have not been created');
  }
  return members[name];
}

function one<T>(rows: T[]): T {
  const row = rows[0];
  if (!row) {
    throw new Error('Expected exactly one row');
  }
  return row;
}

function exportPerson(index: number): PersonRowFixture {
  const person = fx().exportPeople[index];
  if (!person) {
    throw new Error(`Missing export person fixture at index ${index}`);
  }
  return person;
}

let codeCounter = 0;
function newCode(prefix = 'W'): string {
  codeCounter += 1;
  return `${prefix}${codeCounter}-${randomToken().slice(0, 8)}`;
}

function newEmail(prefix = 'w'): string {
  codeCounter += 1;
  return `${prefix}${codeCounter}@example.test`;
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

async function ownerPerson(id: string): Promise<PersonDbRow | null> {
  return withOwner(async (client) => {
    const result = await client.query<PersonDbRow>(
      `select id, tenant_id, employee_code, first_name, last_name, display_name,
              work_email::text as work_email, phone, status, deleted_at,
              legal_entity_id, org_unit_id, user_id, personal_email::text as personal_email,
              date_of_birth, gender, designation, created_at, updated_at
         from person
        where id = $1`,
      [id],
    );
    return result.rows[0] ?? null;
  });
}

async function personCount(tenantId: string): Promise<number> {
  return withOwner(async (client) => {
    const result = await client.query<{ total: string }>(
      'select count(*) as total from person where tenant_id = $1',
      [tenantId],
    );
    return Number(one(result.rows).total);
  });
}

async function auditRows(tenantId: string): Promise<AuditRow[]> {
  return withOwner(async (client) => {
    const result = await client.query<AuditRow>(
      `select action, entity_type, entity_id, actor_type, actor_user_id,
              before_state, after_state, metadata
         from audit_event
        where tenant_id = $1
        order by occurred_at, id`,
      [tenantId],
    );
    return result.rows;
  });
}

async function writeAuditRows(tenantId: string): Promise<AuditRow[]> {
  const rows = await auditRows(tenantId);
  return rows.filter(
    (row) => row.action === 'person.created' || row.action === 'person.updated',
  );
}

async function denialRows(tenantId: string): Promise<AuditRow[]> {
  const rows = await auditRows(tenantId);
  return rows.filter((row) => row.action === 'authorization.denied');
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
  method: 'POST' | 'PATCH';
  url: string;
  cookie?: string;
  csrf?: string | null;
  origin?: string;
  body?: unknown;
  sendContentType?: boolean;
};

async function send(
  app: TestServer,
  options: SendOptions,
): Promise<WriteResponse> {
  const headers: Record<string, string> = { 'user-agent': USER_AGENT };
  headers.origin = options.origin ?? appOrigin;
  if (options.cookie) {
    headers.cookie = options.cookie;
  }
  if (options.csrf) {
    headers['x-csrf-token'] = options.csrf;
  }
  const payloadKnown = Object.hasOwn(options, 'body');
  if (payloadKnown && options.sendContentType !== false) {
    headers['content-type'] = 'application/json';
  }

  const response = await app.inject({
    method: options.method,
    url: options.url,
    headers,
    ...(payloadKnown
      ? { payload: JSON.stringify(options.body) }
      : {}),
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
  };
}

function create(
  app: TestServer,
  which: keyof Sessions,
  body: PeopleCreateInput,
): Promise<WriteResponse> {
  const s = session(which);
  return send(app, {
    method: 'POST',
    url: '/v1/people',
    cookie: s.cookie,
    csrf: s.csrfToken,
    body,
  });
}

function update(
  app: TestServer,
  which: keyof Sessions,
  id: string,
  body: Record<string, unknown>,
): Promise<WriteResponse> {
  const s = session(which);
  return send(app, {
    method: 'PATCH',
    url: `/v1/people/${id}`,
    cookie: s.cookie,
    csrf: s.csrfToken,
    body,
  });
}

async function insertMember(
  role: MembershipRole,
  label: string,
): Promise<{ userId: string; membershipId: string }> {
  const a = fx().a;
  return withOwner(async (client) => {
    const user = await client.query<{ id: string }>(
      `insert into app_user (email, display_name, status)
       values ($1, $2, 'active')
       returning id`,
      [`${label}_${randomToken().slice(0, 8)}@example.test`, `Write ${label}`],
    );
    const membership = await client.query<{ id: string }>(
      `insert into membership (tenant_id, user_id, role, status)
       values ($1, $2, $3, 'active')
       returning id`,
      [a.tenantId, one(user.rows).id, role],
    );
    return {
      userId: one(user.rows).id,
      membershipId: one(membership.rows).id,
    };
  });
}

beforeAll(async () => {
  database = await createTestDatabase({ migrate: true, seed: true });
  runtime = createRuntimePool(database.runtimeUrl);
  auth = createAuthPool(database.authUrl);
  owner = new Pool({ connectionString: database.ownerUrl });

  await withOwner(async (client) => {
    fixtures = await createAccessFixtures(client);
    const a = fixtures.a;

    const adminMember = await insertMember('admin', 'admin');
    const managerMember = await insertMember('manager', 'manager');
    const hrMember = await insertMember('hr', 'hr');
    members = { admin: adminMember, manager: managerMember, hrScoped: hrMember };

    sessions = {
      a: await createSessionFixture(client, {
        userId: a.userId,
        tenantId: a.tenantId,
      }),
      admin: await createSessionFixture(client, {
        userId: adminMember.userId,
        tenantId: a.tenantId,
      }),
      b: await createSessionFixture(client, {
        userId: fixtures.b.userId,
        tenantId: fixtures.b.tenantId,
      }),
      manager: await createSessionFixture(client, {
        userId: managerMember.userId,
        tenantId: a.tenantId,
      }),
      hrScoped: await createSessionFixture(client, {
        userId: hrMember.userId,
        tenantId: a.tenantId,
      }),
    };
  });

  await setMembershipScope(ownerPool(), {
    tenantId: fx().a.tenantId,
    membershipId: member('hrScoped').membershipId,
    scopes: [{ scopeType: 'legal_entity', scopeId: fx().a.legalEntityId }],
    actorUserId: fx().a.userId,
  });
}, 180_000);

afterAll(async () => {
  await owner?.end();
  await auth?.end();
  await runtime?.end();
  await database?.drop();
});

describe('People write path', () => {
  test('rejects both routes without a valid session', async () => {
    await withApp(async (app) => {
      const before = await personCount(fx().a.tenantId);

      for (const headers of [{}, { cookie: `saas_session=${randomToken()}` }]) {
        const created = await send(app, {
          method: 'POST',
          url: '/v1/people',
          ...headers,
          csrf: session('a').csrfToken,
          body: { firstName: 'No Session' },
        });
        expect(created.statusCode).toBe(401);
        expect(created.payload).toEqual({ error: { code: 'UNAUTHENTICATED' } });
        expect(created.headers['cache-control']).toBe('no-store');

        const updated = await send(app, {
          method: 'PATCH',
          url: `/v1/people/${exportPerson(0).id}`,
          ...headers,
          csrf: session('a').csrfToken,
          body: { phone: '+1 555 9999' },
        });
        expect(updated.statusCode).toBe(401);
        expect(updated.payload).toEqual({ error: { code: 'UNAUTHENTICATED' } });
        expect(updated.headers['cache-control']).toBe('no-store');
      }

      expect(await personCount(fx().a.tenantId)).toBe(before);
      expect(await ownerPerson(exportPerson(0).id)).toMatchObject({
        phone: '+1 555 0100',
      });
    });
  });

  test('refuses a cross-origin write before any session or database work', async () => {
    await withApp(async (app) => {
      const before = await personCount(fx().a.tenantId);

      for (const call of [
        {
          method: 'POST' as const,
          url: '/v1/people',
          body: { firstName: 'Origin Denied' },
        },
        {
          method: 'PATCH' as const,
          url: `/v1/people/${exportPerson(0).id}`,
          body: { phone: '+1 555 9999' },
        },
      ]) {
        const response = await send(app, {
          ...call,
          cookie: session('a').cookie,
          csrf: session('a').csrfToken,
          origin: 'https://evil.example.test',
        });
        expect(response.statusCode).toBe(403);
        expect(response.payload).toEqual({ error: { code: 'ORIGIN_DENIED' } });
        expect(response.headers['cache-control']).toBe('no-store');
      }

      expect(await personCount(fx().a.tenantId)).toBe(before);
    });
  });

  test('refuses a missing or wrong CSRF token on both routes with no write', async () => {
    const a = fx().a;
    const cookie = session('a').cookie;

    await withApp(async (app) => {
      const before = await personCount(a.tenantId);
      const beforeAudit = await writeAuditRows(a.tenantId);

      const bodies = [undefined, 'wrong-token'];
      for (const csrf of bodies) {
        const created = await send(app, {
          method: 'POST',
          url: '/v1/people',
          cookie,
          csrf,
          body: { firstName: 'No Csrf', employeeCode: newCode('CSRF') },
        });
        expect(created.statusCode).toBe(403);
        expect(created.payload).toEqual({ error: { code: 'CSRF_INVALID' } });
        expect(created.headers['cache-control']).toBe('no-store');

        const updated = await send(app, {
          method: 'PATCH',
          url: `/v1/people/${exportPerson(0).id}`,
          cookie,
          csrf,
          body: { phone: '+1 555 9999' },
        });
        expect(updated.statusCode).toBe(403);
        expect(updated.payload).toEqual({ error: { code: 'CSRF_INVALID' } });
      }

      expect(await personCount(a.tenantId)).toBe(before);
      expect(await writeAuditRows(a.tenantId)).toHaveLength(beforeAudit.length);
      expect(await ownerPerson(exportPerson(0).id)).toMatchObject({
        phone: '+1 555 0100',
      });
    });
  });

  test('creates a full record, stores the directory defaults and audits field names', async () => {
    const a = fx().a;
    const employeeCode = newCode('FULL');
    const workEmail = newEmail('full');
    const before = await writeAuditRows(a.tenantId);

    await withApp(async (app) => {
      const response = await create(app, 'a', {
        firstName: 'Grace',
        lastName: 'Hopper',
        displayName: 'Rear Admiral Grace Hopper',
        employeeCode,
        workEmail,
        phone: '+1 555 0111',
      });

      expect(response.statusCode).toBe(201);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(Object.keys(response.item).sort()).toEqual(ITEM_KEYS);
      expect(response.item.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect({ ...response.item, id: 'stored' }).toEqual({
        id: 'stored',
        employeeCode,
        firstName: 'Grace',
        lastName: 'Hopper',
        displayName: 'Rear Admiral Grace Hopper',
        workEmail,
        phone: '+1 555 0111',
      });

      const stored = await ownerPerson(response.item.id);
      expect(stored).not.toBeNull();
      expect(stored).toMatchObject({
        tenant_id: a.tenantId,
        status: 'active',
        deleted_at: null,
        legal_entity_id: null,
        org_unit_id: null,
        user_id: null,
        personal_email: null,
        date_of_birth: null,
        gender: null,
        designation: null,
      });
      expect(stored?.created_at).not.toBeNull();
      expect(stored?.updated_at).not.toBeNull();

      const after = await writeAuditRows(a.tenantId);
      expect(after).toHaveLength(before.length + 1);
      const row = one(after.slice(-1));
      expect(row).toMatchObject({
        action: 'person.created',
        entity_type: 'person',
        entity_id: response.item.id,
        actor_type: 'user',
        actor_user_id: a.userId,
        before_state: null,
        after_state: null,
        metadata: {
          module: 'people',
          fields: [
            'displayName',
            'employeeCode',
            'firstName',
            'lastName',
            'phone',
            'workEmail',
          ],
        },
      });

      // The audit trail carries field names only, never the person's details.
      const serialised = JSON.stringify(row.metadata);
      for (const value of [
        'Grace',
        'Hopper',
        'Rear Admiral Grace Hopper',
        employeeCode,
        workEmail,
        '+1 555 0111',
      ]) {
        expect(serialised).not.toContain(value);
      }
    });
  });

  test('derives the display name, trims values and treats a blank field as absent', async () => {
    await withApp(async (app) => {
      const minimal = await create(app, 'a', { firstName: 'Solo' });
      expect(minimal.statusCode).toBe(201);
      expect(minimal.item).toMatchObject({
        firstName: 'Solo',
        lastName: null,
        displayName: 'Solo',
        employeeCode: null,
        workEmail: null,
        phone: null,
      });
      expect(await ownerPerson(minimal.item.id)).toMatchObject({
        status: 'active',
        deleted_at: null,
        legal_entity_id: null,
      });

      const trimmed = await create(app, 'a', {
        firstName: '  Ada  ',
        lastName: '  Lovelace  ',
        displayName: '   ',
        employeeCode: '   ',
        workEmail: '',
        phone: '  +1 555 0122  ',
      });
      expect(trimmed.statusCode).toBe(201);
      expect(trimmed.item).toMatchObject({
        firstName: 'Ada',
        lastName: 'Lovelace',
        // A blank display name is derived, never stored as empty.
        displayName: 'Ada Lovelace',
        employeeCode: null,
        workEmail: null,
        phone: '+1 555 0122',
      });
    });
  });

  test('refuses a duplicate employee code or work email on create and update with a typed 409', async () => {
    const a = fx().a;
    const takenCode = exportPerson(0).employeeCode ?? 'EXP-001';
    const takenEmail = exportPerson(0).workEmail ?? 'ada@example.test';

    await withApp(async (app) => {
      const before = await personCount(a.tenantId);
      const beforeAudit = await writeAuditRows(a.tenantId);

      const codeClash = await create(app, 'a', {
        firstName: 'Collision',
        employeeCode: takenCode,
      });
      expect(codeClash.statusCode).toBe(409);
      expect(codeClash.payload).toEqual({ error: { code: 'PERSON_CODE_TAKEN' } });
      expect(codeClash.headers['cache-control']).toBe('no-store');
      // The message names the collision without repeating the value.
      expect(codeClash.body).not.toContain(takenCode);

      // citext means one address in two spellings is still one address.
      const emailClash = await create(app, 'a', {
        firstName: 'Collision',
        employeeCode: newCode('CLASH'),
        workEmail: takenEmail.toUpperCase(),
      });
      expect(emailClash.statusCode).toBe(409);
      expect(emailClash.payload).toEqual({
        error: { code: 'PERSON_EMAIL_TAKEN' },
      });
      expect(emailClash.body).not.toContain(takenEmail.toLowerCase());

      // Renaming an existing row onto a taken value is the same collision.
      const renameClash = await update(app, 'a', exportPerson(1).id, {
        employeeCode: takenCode,
      });
      expect(renameClash.statusCode).toBe(409);
      expect(renameClash.payload).toEqual({ error: { code: 'PERSON_CODE_TAKEN' } });
      expect(renameClash.body).not.toContain(takenCode);

      const emailRename = await update(app, 'a', exportPerson(1).id, {
        workEmail: takenEmail.toUpperCase(),
      });
      expect(emailRename.statusCode).toBe(409);
      expect(emailRename.payload).toEqual({ error: { code: 'PERSON_EMAIL_TAKEN' } });

      const untouched = await ownerPerson(exportPerson(1).id);
      expect(untouched).toMatchObject({
        employee_code: exportPerson(1).employeeCode,
        work_email: exportPerson(1).workEmail,
      });

      expect(await personCount(a.tenantId)).toBe(before);
      expect(await writeAuditRows(a.tenantId)).toHaveLength(beforeAudit.length);
    });
  });

  test('rejects malformed create and update bodies with INVALID_BODY and no write', async () => {
    const a = fx().a;

    const longName = 'x'.repeat(PERSON_NAME_MAX_LENGTH + 1);
    const maxName = 'y'.repeat(PERSON_NAME_MAX_LENGTH);
    const longDisplay = 'z'.repeat(PERSON_DISPLAY_NAME_MAX_LENGTH + 1);
    const longCode = 'c'.repeat(PERSON_EMPLOYEE_CODE_MAX_LENGTH + 1);
    const longEmail = `${'e'.repeat(PERSON_WORK_EMAIL_MAX_LENGTH)}@example.test`;
    const maxEmail = `${'q'.repeat(
      PERSON_WORK_EMAIL_MAX_LENGTH - '@example.test'.length,
    )}@example.test`;
    const longPhone = '+'.repeat(PERSON_PHONE_MAX_LENGTH + 1);

    const createBodies: unknown[] = [
      undefined,
      null,
      'not-an-object',
      42,
      true,
      [],
      [{ firstName: 'Array' }],
      {},
      { firstName: '' },
      { firstName: '    ' },
      { firstName: null },
      { firstName: 7 },
      { lastName: 'No First Name' },
      { firstName: longName },
      { firstName: maxName, lastName: maxName },
      { firstName: 'Ada', displayName: longDisplay },
      { firstName: 'Ada', employeeCode: longCode },
      { firstName: 'Ada', workEmail: longEmail },
      { firstName: 'Ada', workEmail: 'no-at-sign' },
      { firstName: 'Ada', workEmail: 'two@@at.example.test' },
      { firstName: 'Ada', workEmail: 'spaces in@example.test' },
      { firstName: 'Ada', workEmail: 'local@nodotdomain' },
      { firstName: 'Ada', workEmail: 'a@b.' },
      { firstName: 'Ada', phone: longPhone },
      { firstName: 'Ada', status: 'active' },
      { firstName: 'Ada', id: '00000000-0000-4000-8000-000000000000' },
      { firstName: 'Ada', legalEntityId: fx().a.legalEntityId },
      { firstName: 'Ada', orgUnitId: fx().a.legalEntityId },
      { firstName: 'Ada', userId: fx().a.userId },
      { firstName: 'Ada', personalEmail: 'ada@example.test' },
      { firstName: 'Ada', dateOfBirth: '1815-12-10' },
    ];

    await withApp(async (app) => {
      const before = await personCount(a.tenantId);

      for (const body of createBodies) {
        const response =
          body === undefined
            ? await send(app, {
                method: 'POST',
                url: '/v1/people',
                cookie: session('a').cookie,
                csrf: session('a').csrfToken,
              })
            : await create(app, 'a', body as PeopleCreateInput);
        expect(response.statusCode).toBe(400);
        expect(response.payload).toEqual({ error: { code: 'INVALID_BODY' } });
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.body).not.toContain(fx().a.legalEntityId);
      }

      const atLimit = await create(app, 'a', {
        firstName: maxName,
        lastName: 'Z',
        displayName: 'y'.repeat(PERSON_DISPLAY_NAME_MAX_LENGTH),
        workEmail: maxEmail,
      });
      expect(atLimit.statusCode).toBe(201);
      expect(atLimit.item).toMatchObject({
        employeeCode: null,
        phone: null,
        workEmail: maxEmail,
      });
      expect(maxEmail.length).toBe(PERSON_WORK_EMAIL_MAX_LENGTH);

      const updateBodies: unknown[] = [
        undefined,
        null,
        [],
        'string',
        {},
        { firstName: '' },
        { firstName: '   ' },
        { firstName: null },
        { firstName: longName },
        { displayName: longDisplay },
        { employeeCode: longCode },
        { workEmail: 'no-at-sign' },
        { phone: longPhone },
        { status: 'exited' },
        { legalEntityId: fx().a.legalEntityId },
        { userId: fx().a.userId },
        { deletedAt: null },
      ];

      const target = await ownerPerson(atLimit.item.id);
      expect(target).not.toBeNull();

      for (const body of updateBodies) {
        const response =
          body === undefined
            ? await send(app, {
                method: 'PATCH',
                url: `/v1/people/${atLimit.item.id}`,
                cookie: session('a').cookie,
                csrf: session('a').csrfToken,
              })
            : await update(app, 'a', atLimit.item.id, body as Record<string, unknown>);
        expect(response.statusCode).toBe(400);
        expect(response.payload).toEqual({ error: { code: 'INVALID_BODY' } });
        expect(response.body).not.toContain(fx().a.legalEntityId);
      }

      // Nothing in the matrix wrote: the row from the accepted create is the
      // only new person, and its stored values are the ones from that request.
      expect(await personCount(a.tenantId)).toBe(before + 1);
      const unchanged = await ownerPerson(atLimit.item.id);
      expect(unchanged).toMatchObject({
        first_name: target?.first_name,
        display_name: target?.display_name,
        status: 'active',
        legal_entity_id: null,
        user_id: null,
        deleted_at: null,
      });
    });
  });

  test('updates identity fields, advances updated_at and audits only what changed', async () => {
    const a = fx().a;
    const code = newCode('UPD');

    await withApp(async (app) => {
      const created = await create(app, 'a', {
        firstName: 'Ada',
        lastName: 'Byron',
        employeeCode: code,
        workEmail: newEmail('upd'),
        phone: '+1 555 0200',
      });
      expect(created.statusCode).toBe(201);
      const beforeRow = await ownerPerson(created.item.id);
      expect(beforeRow).not.toBeNull();
      const beforeAudit = await writeAuditRows(a.tenantId);

      const response = await update(app, 'a', created.item.id, {
        firstName: 'Ada',
        lastName: 'Lovelace',
        displayName: 'Ada Lovelace, Countess',
        employeeCode: code,
        phone: '+1 555 0201',
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(Object.keys(response.item).sort()).toEqual(ITEM_KEYS);
      expect(response.item).toMatchObject({
        id: created.item.id,
        firstName: 'Ada',
        lastName: 'Lovelace',
        displayName: 'Ada Lovelace, Countess',
        employeeCode: code,
        phone: '+1 555 0201',
      });

      const afterRow = await ownerPerson(created.item.id);
      expect(afterRow?.updated_at.getTime()).toBeGreaterThan(
        beforeRow?.updated_at.getTime() ?? 0,
      );
      // The identity of the row never moves, and no unlisted column was touched.
      expect(afterRow?.created_at.getTime()).toBe(
        beforeRow?.created_at.getTime(),
      );
      expect(afterRow).toMatchObject({
        status: beforeRow?.status,
        legal_entity_id: null,
        user_id: null,
        personal_email: null,
      });

      const afterAudit = await writeAuditRows(a.tenantId);
      expect(afterAudit).toHaveLength(beforeAudit.length + 1);
      const row = one(afterAudit.slice(-1));
      expect(row).toMatchObject({
        action: 'person.updated',
        entity_type: 'person',
        entity_id: created.item.id,
        actor_user_id: a.userId,
        before_state: null,
        after_state: null,
        // Only the two fields that actually moved appear.
        metadata: {
          module: 'people',
          changedFields: ['displayName', 'lastName', 'phone'],
        },
      });
      const serialised = JSON.stringify(row.metadata);
      for (const value of ['Lovelace', 'Countess', '+1 555 0201', code]) {
        expect(serialised).not.toContain(value);
      }
    });
  });

  test('answers a no-change update with the stored row and no audit row', async () => {
    const a = fx().a;

    await withApp(async (app) => {
      const created = await create(app, 'a', {
        firstName: 'Noop',
        lastName: 'Update',
        employeeCode: newCode('NOOP'),
        workEmail: newEmail('noop'),
        phone: '+1 555 0300',
      });
      expect(created.statusCode).toBe(201);
      const beforeRow = await ownerPerson(created.item.id);
      const beforeAudit = await writeAuditRows(a.tenantId);

      const response = await update(app, 'a', created.item.id, {
        firstName: 'Noop',
        lastName: 'Update',
        displayName: 'Noop Update',
        employeeCode: created.item.employeeCode,
        workEmail: created.item.workEmail,
        phone: '+1 555 0300',
      });
      expect(response.statusCode).toBe(200);
      expect(response.item).toEqual(created.item);

      const after = await writeAuditRows(a.tenantId);
      expect(after).toHaveLength(beforeAudit.length);
      const afterRow = await ownerPerson(created.item.id);
      expect(afterRow?.updated_at.getTime()).toBe(
        beforeRow?.updated_at.getTime(),
      );
    });
  });

  test('treats an absent key as unchanged and a null or blank key as cleared', async () => {
    const a = fx().a;

    await withApp(async (app) => {
      const created = await create(app, 'a', {
        firstName: 'Keeprun',
        lastName: 'Clearme',
        employeeCode: newCode('CLR'),
        workEmail: newEmail('clear'),
        phone: '+1 555 0400',
      });
      expect(created.statusCode).toBe(201);

      const partial = await update(app, 'a', created.item.id, {
        firstName: 'Kept',
      });
      expect(partial.statusCode).toBe(200);
      expect(partial.item).toMatchObject({
        firstName: 'Kept',
        lastName: 'Clearme',
        // The display name was stored, so an omitted key keeps it verbatim.
        displayName: 'Keeprun Clearme',
        employeeCode: created.item.employeeCode,
        workEmail: created.item.workEmail,
        phone: '+1 555 0400',
      });

      const cleared = await update(app, 'a', created.item.id, {
        lastName: '',
        displayName: null,
        employeeCode: '   ',
        phone: null,
      });
      expect(cleared.statusCode).toBe(200);
      expect(cleared.item).toMatchObject({
        firstName: 'Kept',
        lastName: null,
        // A cleared display name is re-derived from the remaining names.
        displayName: 'Kept',
        employeeCode: null,
        workEmail: created.item.workEmail,
        phone: null,
      });
      const stored = await ownerPerson(created.item.id);
      expect(stored).toMatchObject({
        last_name: null,
        employee_code: null,
        phone: null,
        display_name: 'Kept',
        status: 'active',
      });

      const audit = await writeAuditRows(a.tenantId);
      const last = one(audit.slice(-1));
      expect(last.metadata).toEqual({
        module: 'people',
        changedFields: ['displayName', 'employeeCode', 'lastName', 'phone'],
      });
    });
  });

  test('answers 404 for unknown, malformed, cross-tenant and soft-deleted ids', async () => {
    const a = fx().a;
    const b = fx().b;

    await withApp(async (app) => {
      const beforeAudit = await writeAuditRows(a.tenantId);
      const target = await ownerPerson(a.personId);
      expect(target).not.toBeNull();

      const personB = await withOwner(async (client) => {
        const result = await client.query<{ id: string }>(
          `insert into person (tenant_id, first_name, display_name)
           values ($1, 'Other Tenant', 'Other Tenant')
           returning id`,
          [b.tenantId],
        );
        return one(result.rows).id;
      });

      const ids = [
        '00000000-0000-4000-8000-000000000000',
        'not-a-uuid',
        personB,
        fx().softDeletedPerson.id,
      ];

      for (const id of ids) {
        const response = await update(app, 'a', id, { phone: '+1 555 0500' });
        expect(response.statusCode).toBe(404);
        expect(response.payload).toEqual({
          error: { code: 'PERSON_NOT_FOUND' },
        });
        expect(response.headers['cache-control']).toBe('no-store');
      }

      expect(await ownerPerson(a.personId)).toMatchObject({
        phone: target?.phone ?? null,
        updated_at: target?.updated_at,
      });
      expect(await writeAuditRows(a.tenantId)).toHaveLength(beforeAudit.length);
    });
  });

  test('lets a scoped member edit in scope, and answers 404 or 403 outside it', async () => {
    const a = fx().a;
    const inScope = exportPerson(0);
    const outOfScope = a.personId;

    await withApp(async (app) => {
      const beforeOut = await ownerPerson(outOfScope);
      const beforeAudit = await writeAuditRows(a.tenantId);

      const scoped = await update(app, 'hrScoped', inScope.id, {
        phone: '+1 555 0600',
      });
      expect(scoped.statusCode).toBe(200);
      expect(scoped.item).toMatchObject({ id: inScope.id, phone: '+1 555 0600' });

      const denied = await update(app, 'hrScoped', outOfScope, {
        phone: '+1 555 0601',
      });
      expect(denied.statusCode).toBe(404);
      expect(denied.payload).toEqual({ error: { code: 'PERSON_NOT_FOUND' } });
      expect(await ownerPerson(outOfScope)).toMatchObject({
        phone: beforeOut?.phone ?? null,
        updated_at: beforeOut?.updated_at,
      });

      // A new person starts unplaced, which a scoped role may not record.
      const before = await personCount(a.tenantId);
      const created = await create(app, 'hrScoped', {
        firstName: 'Unplaced',
        employeeCode: newCode('SCOPE'),
      });
      expect(created.statusCode).toBe(403);
      expect(created.payload).toEqual({ error: { code: 'SCOPE_DENIED' } });
      expect(created.headers['cache-control']).toBe('no-store');
      expect(await personCount(a.tenantId)).toBe(before);

      const audit = await writeAuditRows(a.tenantId);
      expect(audit).toHaveLength(beforeAudit.length + 1);
      expect(one(audit.slice(-1))).toMatchObject({
        action: 'person.updated',
        actor_user_id: member('hrScoped').userId,
        entity_id: inScope.id,
      });
    });
  });

  test('lets a tenant-wide admin create where the owner can', async () => {
    await withApp(async (app) => {
      const response = await create(app, 'admin', {
        firstName: 'Workspace',
        lastName: 'Admin',
        employeeCode: newCode('ADMIN'),
      });
      expect(response.statusCode).toBe(201);
      expect(response.item).toMatchObject({
        firstName: 'Workspace',
        lastName: 'Admin',
        displayName: 'Workspace Admin',
      });
      expect(await ownerPerson(response.item.id)).toMatchObject({
        status: 'active',
        legal_entity_id: null,
      });
    });
  });

  test('denies a people.read-only role with ROLE_DENIED before reading the body', async () => {
    const a = fx().a;
    const before = await denialRows(a.tenantId);
    // Earlier tests in this file may have edited this row, so the claim is that
    // the denials changed nothing, not that the row still holds its seed value.
    const untouched = await ownerPerson(exportPerson(0).id);

    await withApp(async (app) => {
      const created = await create(app, 'manager', { firstName: 'Refused' });
      expect(created.statusCode).toBe(403);
      expect(created.payload).toEqual({
        error: { code: 'ROLE_DENIED', permission: 'people.write' },
      });

      // The gate is older than validation: a broken body from the same role is
      // still a role denial, not a 400.
      const malformed = await send(app, {
        method: 'POST',
        url: '/v1/people',
        cookie: session('manager').cookie,
        csrf: session('manager').csrfToken,
        body: { status: 'active' },
      });
      expect(malformed.statusCode).toBe(403);
      expect(malformed.payload).toEqual({
        error: { code: 'ROLE_DENIED', permission: 'people.write' },
      });

      const updated = await update(app, 'manager', exportPerson(0).id, {
        phone: '+1 555 0700',
      });
      expect(updated.statusCode).toBe(403);
      expect(updated.payload).toEqual({
        error: { code: 'ROLE_DENIED', permission: 'people.write' },
      });

      // The id shape is checked after the gate, so it cannot turn a role denial
      // into a 404 and a denied caller never reaches SQL with a malformed UUID.
      const malformedId = await update(app, 'manager', 'not-a-uuid', {
        phone: '+1 555 0701',
      });
      expect(malformedId.statusCode).toBe(403);
      expect(malformedId.payload).toEqual({
        error: { code: 'ROLE_DENIED', permission: 'people.write' },
      });
    });

    const after = await denialRows(a.tenantId);
    expect(after).toHaveLength(before.length + 4);
    for (const row of after.slice(-4)) {
      expect(row).toMatchObject({
        action: 'authorization.denied',
        entity_type: 'request',
        entity_id: null,
        actor_user_id: member('manager').userId,
        metadata: {
          reason: 'ROLE_DENIED',
          module: 'people',
          operation: 'write',
          permission: 'people.write',
        },
      });
    }
    expect(after.slice(-4).map((row) => row.metadata.method)).toEqual([
      'POST',
      'POST',
      'PATCH',
      'PATCH',
    ]);
    expect(await ownerPerson(exportPerson(0).id)).toEqual(untouched);
  });

  test('denies an unentitled tenant with MODULE_NOT_ENTITLED and a denial audit', async () => {
    const b = fx().b;
    const before = await denialRows(b.tenantId);

    await withApp(async (app) => {
      const created = await create(app, 'b', { firstName: 'Unentitled' });
      expect(created.statusCode).toBe(403);
      expect(created.payload).toEqual({
        error: { code: 'MODULE_NOT_ENTITLED', module: 'people', operation: 'write' },
      });
      expect(created.headers['cache-control']).toBe('no-store');

      const updated = await update(app, 'b', exportPerson(0).id, {
        phone: '+1 555 0800',
      });
      expect(updated.statusCode).toBe(403);
      expect(updated.payload).toEqual({
        error: { code: 'MODULE_NOT_ENTITLED', module: 'people', operation: 'write' },
      });

      // Entitlement is settled before the id is even looked at, so a tenant with
      // no People module still gets its own denial for a malformed id.
      const malformedId = await update(app, 'b', 'not-a-uuid', {
        phone: '+1 555 0801',
      });
      expect(malformedId.statusCode).toBe(403);
      expect(malformedId.payload).toEqual({
        error: { code: 'MODULE_NOT_ENTITLED', module: 'people', operation: 'write' },
      });
      expect(malformedId.headers['cache-control']).toBe('no-store');
    });

    const after = await denialRows(b.tenantId);
    expect(after).toHaveLength(before.length + 3);
    expect(after.slice(-3).map((row) => row.metadata.method)).toEqual([
      'POST',
      'PATCH',
      'PATCH',
    ]);
  });

  test('fails closed with a sanitized 500 when the audit write fails', async () => {
    const a = fx().a;

    await withOwner(async (client) => {
      await client.query('revoke insert on table public.audit_event from saas_runtime');
    });
    try {
      await withApp(async (app) => {
        const before = await personCount(a.tenantId);
        const code = newCode('AUDITFAIL');
        const target = exportPerson(0).id;
        const beforeRow = await ownerPerson(target);

        const created = await create(app, 'a', {
          firstName: 'AuditFail',
          employeeCode: code,
        });
        expect(created.statusCode).toBe(500);
        expect(created.payload).toEqual({ error: { code: 'INTERNAL_ERROR' } });
        expect(created.headers['cache-control']).toBe('no-store');
        for (const detail of [
          'permission denied',
          'audit_event',
          'insert into',
          'saas_runtime',
          'PostgreSQL',
        ]) {
          expect(created.body.toLowerCase()).not.toContain(detail.toLowerCase());
        }

        const updated = await update(app, 'a', target, {
          phone: '+1 555 0900',
        });
        expect(updated.statusCode).toBe(500);
        expect(updated.payload).toEqual({ error: { code: 'INTERNAL_ERROR' } });

        // The create rolled back and the update never landed.
        expect(await personCount(a.tenantId)).toBe(before);
        expect(await ownerPerson(target)).toMatchObject({
          phone: beforeRow?.phone,
          updated_at: beforeRow?.updated_at,
        });
      });
    } finally {
      await withOwner(async (client) => {
        await client.query(
          'grant insert on table public.audit_event to saas_runtime',
        );
      });
    }
  });

  test('marks every write response uncacheable', async () => {
    await withApp(async (app) => {
      const statuses: number[] = [];

      const created = await create(app, 'a', {
        firstName: 'Cache',
        employeeCode: newCode('CACHE'),
      });
      statuses.push(created.statusCode);
      expect(created.statusCode).toBe(201);

      const updated = await update(app, 'a', created.item.id, {
        phone: '+1 555 1000',
      });
      statuses.push(updated.statusCode);
      expect(updated.statusCode).toBe(200);

      const invalid = await create(app, 'a', { firstName: '' });
      statuses.push(invalid.statusCode);
      expect(invalid.statusCode).toBe(400);

      const missing = await update(app, 'a', 'not-a-uuid', { phone: '1' });
      statuses.push(missing.statusCode);
      expect(missing.statusCode).toBe(404);

      const denied = await create(app, 'b', { firstName: 'Cache' });
      statuses.push(denied.statusCode);
      expect(denied.statusCode).toBe(403);

      const scopeDenied = await create(app, 'hrScoped', {
        firstName: 'Cache',
        employeeCode: newCode('CACHE2'),
      });
      statuses.push(scopeDenied.statusCode);
      expect(scopeDenied.statusCode).toBe(403);

      const unauthenticated = await send(app, {
        method: 'POST',
        url: '/v1/people',
        csrf: session('a').csrfToken,
        body: { firstName: 'Cache' },
      });
      statuses.push(unauthenticated.statusCode);
      expect(unauthenticated.statusCode).toBe(401);

      const clash = await create(app, 'a', {
        firstName: 'Cache',
        employeeCode: exportPerson(0).employeeCode ?? 'EXP-001',
      });
      statuses.push(clash.statusCode);
      expect(clash.statusCode).toBe(409);

      expect(statuses).toHaveLength(8);
      for (const response of [
        created,
        updated,
        invalid,
        missing,
        denied,
        scopeDenied,
        unauthenticated,
        clash,
      ]) {
        expect(response.headers['cache-control']).toBe('no-store');
      }
    });
  });

  test('keeps the directory listing and paging consistent with the writes', async () => {
    await withApp(async (app) => {
      const before = await app.inject({
        method: 'GET',
        url: '/v1/people',
        headers: { cookie: session('a').cookie },
      });
      const beforeBody = before.json() as PeopleListResponse;
      const code = newCode('LIST');

      const created = await create(app, 'a', {
        firstName: 'Listed',
        lastName: 'Person',
        employeeCode: code,
        workEmail: newEmail('list'),
      });
      expect(created.statusCode).toBe(201);

      const after = await app.inject({
        method: 'GET',
        url: '/v1/people',
        headers: { cookie: session('a').cookie },
      });
      const afterBody = after.json() as PeopleListResponse;
      expect(afterBody.total).toBe(beforeBody.total + 1);
      expect(afterBody.items.map((item) => item.id)).toContain(created.item.id);

      const searched = await app.inject({
        method: 'GET',
        url: `/v1/people?q=${encodeURIComponent(code)}`,
        headers: { cookie: session('a').cookie },
      });
      const searchedBody = searched.json() as PeopleListResponse;
      expect(searchedBody.total).toBe(1);
      expect(one(searchedBody.items)).toEqual(created.item);

      const scoped = await app.inject({
        method: 'GET',
        url: '/v1/people',
        headers: { cookie: session('hrScoped').cookie },
      });
      const scopedBody = scoped.json() as PeopleListResponse;
      // The new person is unplaced, so a legal-entity scope cannot list it.
      expect(scopedBody.items.map((item) => item.id)).not.toContain(
        created.item.id,
      );
    });
  });
});
