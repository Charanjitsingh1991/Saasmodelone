import { randomBytes, randomUUID } from 'node:crypto';
import { Client, Pool, type QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  createRuntimePool,
  getMembershipScope,
  linkPersonUser,
  setMembershipScope,
  unlinkPersonUser,
  type RuntimePool,
  type ScopeValue,
} from '@saasmodels/db';
import { createTestDatabase, type TestDatabase } from '@saasmodels/testkit';

const LINKED = 'person.user.linked';
const UNLINKED = 'person.user.unlinked';
const SCOPE_CHANGED = 'membership.scope.changed';

let database: TestDatabase | undefined;
let owner: Pool | undefined;
let runtime: RuntimePool | undefined;
let fx: Fixtures | undefined;

function db(): TestDatabase {
  if (!database) {
    throw new Error('Test database has not been created');
  }
  return database;
}

function ownerPool(): Pool {
  if (!owner) {
    throw new Error('Owner pool has not been created');
  }
  return owner;
}

function scope(): Fixtures {
  if (!fx) {
    throw new Error('Scope administration fixtures have not been created');
  }
  return fx;
}

function suffix(): string {
  return randomBytes(4).toString('hex');
}

function one<T>(rows: T[]): T {
  const row = rows[0];
  if (!row) {
    throw new Error('Expected exactly one row');
  }
  return row;
}

function sorted(ids: string[]): string[] {
  return [...ids].sort();
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

async function personUserId(tenantId: string, personId: string): Promise<string | null> {
  const result = await ownerPool().query<{ user_id: string | null }>(
    'select user_id from person where tenant_id = $1 and id = $2',
    [tenantId, personId],
  );
  return one(result.rows).user_id;
}

async function scopeRows(tenantId: string, membershipId: string): Promise<string[]> {
  const result = await ownerPool().query<{
    scope_type: string;
    legal_entity_id: string | null;
    org_unit_id: string | null;
  }>(
    `select scope_type, legal_entity_id, org_unit_id
       from membership_scope
      where tenant_id = $1 and membership_id = $2`,
    [tenantId, membershipId],
  );
  return sorted(
    result.rows.map((row) => `${row.scope_type}:${row.legal_entity_id ?? row.org_unit_id}`),
  );
}

type AuditRow = {
  actor_type: string;
  actor_user_id: string | null;
  entity_type: string;
  entity_id: string | null;
  before_state: unknown;
  after_state: unknown;
};

async function auditRows(action: string, entityId: string): Promise<AuditRow[]> {
  const result = await ownerPool().query<AuditRow>(
    `select actor_type, actor_user_id, entity_type, entity_id, before_state, after_state
       from audit_event
      where action = $1 and entity_id = $2
      order by occurred_at`,
    [action, entityId],
  );
  return result.rows;
}

/** The raw runtime path: both GUCs set, no gate, RLS and grants only. */
async function withRuntime<T>(
  tenantId: string,
  userId: string | null,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString: db().runtimeUrl });
  await client.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
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

async function runtimeVisiblePersonIds(tenantId: string, userId: string | null): Promise<string[]> {
  return withRuntime(tenantId, userId, async (client) => {
    const result = await client.query<{ id: string }>('select id from public.person order by id');
    return result.rows.map((row) => row.id);
  });
}

async function runtimeVisibleEmploymentIds(
  tenantId: string,
  userId: string | null,
): Promise<string[]> {
  return withRuntime(tenantId, userId, async (client) => {
    const result = await client.query<{ id: string }>(
      'select id from public.employment order by id',
    );
    return result.rows.map((row) => row.id);
  });
}

async function runtimeError(tenantId: string, sql: string): Promise<{ code?: string }> {
  return withRuntime(tenantId, null, async (client) => {
    try {
      await client.query(sql);
    } catch (caught) {
      return caught as { code?: string };
    }
    throw new Error(`Expected the statement to fail: ${sql}`);
  });
}

async function insertJurisdiction(client: Client): Promise<string> {
  const result = await client.query<{ id: string }>(
    `insert into jurisdiction
       (code, country_code, name, default_currency, default_timezone)
     values ('ZZ', 'ZZ', 'Synthetic scope-admin jurisdiction', 'ZZZ', 'UTC')
     returning id`,
  );
  return one(result.rows).id;
}

async function insertTenant(client: Client, label: string, deleted = false): Promise<string> {
  const result = await client.query<{ id: string }>(
    `insert into tenant (name, slug, data_region, deleted_at)
     values ($1, $2, 'test', $3)
     returning id`,
    [`Scope-admin ${label}`, `scopeadmin_${label}_${suffix()}`, deleted ? new Date() : null],
  );
  return one(result.rows).id;
}

async function insertUser(client: Client, label: string, status = 'active'): Promise<string> {
  const result = await client.query<{ id: string }>(
    `insert into app_user (email, display_name, status)
     values ($1, $2, $3)
     returning id`,
    [`scopeadmin_${label}_${suffix()}@example.test`, `Scope-admin user ${label}`, status],
  );
  return one(result.rows).id;
}

async function insertMembership(
  client: Client,
  tenantId: string,
  userId: string,
  role: string,
  status = 'active',
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `insert into membership (tenant_id, user_id, role, status)
     values ($1, $2, $3, $4)
     returning id`,
    [tenantId, userId, role, status],
  );
  return one(result.rows).id;
}

async function insertLegalEntity(
  client: Client,
  tenantId: string,
  label: string,
  jurisdictionId: string,
  deleted = false,
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `insert into legal_entity
       (tenant_id, name, code, jurisdiction_id, currency, timezone, deleted_at)
     values ($1, $2, $3, $4, 'ZZZ', 'UTC', $5)
     returning id`,
    [
      tenantId,
      `Scope-admin entity ${label}`,
      `sa_${label}_${suffix()}`,
      jurisdictionId,
      deleted ? new Date() : null,
    ],
  );
  return one(result.rows).id;
}

async function insertOrgUnit(
  client: Client,
  tenantId: string,
  label: string,
  parentId: string | null,
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `insert into org_unit (tenant_id, parent_id, name, kind)
     values ($1, $2, $3, 'department')
     returning id`,
    [tenantId, parentId, `Scope-admin unit ${label}`],
  );
  return one(result.rows).id;
}

type PersonSeed = {
  legalEntityId?: string | null;
  orgUnitId?: string | null;
  deleted?: boolean;
};

async function insertPerson(
  client: Client,
  tenantId: string,
  label: string,
  seed: PersonSeed = {},
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `insert into person
       (tenant_id, employee_code, first_name, display_name,
        legal_entity_id, org_unit_id, deleted_at)
     values ($1, $2, $3, $4, $5, $6, $7)
     returning id`,
    [
      tenantId,
      `SA${label}_${suffix()}`,
      label,
      `Person ${label}`,
      seed.legalEntityId ?? null,
      seed.orgUnitId ?? null,
      seed.deleted ? new Date() : null,
    ],
  );
  return one(result.rows).id;
}

async function insertEmployment(
  client: Client,
  tenantId: string,
  personId: string,
  legalEntityId: string,
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `insert into employment
       (tenant_id, person_id, legal_entity_id, employment_type, start_date)
     values ($1, $2, $3, 'full_time', '2024-01-01')
     returning id`,
    [tenantId, personId, legalEntityId],
  );
  return one(result.rows).id;
}

async function grantPeople(client: Client, tenantId: string): Promise<void> {
  await client.query(
    `insert into module_entitlement
       (tenant_id, module_id, status, source, starts_at, ends_at)
     values ($1, (select id from platform_module where code = 'people'), 'active',
             'contract', now() - interval '1 day', null)`,
    [tenantId],
  );
}

type Fixtures = {
  tenantA: string;
  tenantB: string;
  tenantC: string;
  tenantGone: string;
  entityA1: string;
  entityA2: string;
  entityB: string;
  unitRootA: string;
  unitMidA: string;
  personA1: string;
  personA2: string;
  personADeleted: string;
  personB: string;
  personGone: string;
  employmentA1: string;
  employmentA2: string;
  ownerA: string;
  membershipOwnerA: string;
  adminA: string;
  managerA: string;
  employeeA: string;
  personOfEmployeeA: string;
  employmentOfEmployeeA: string;
  membershipEmployeeA: string;
  secondEmployeeA: string;
  suspendedMemberA: string;
  dormantMemberA: string;
  suspendedOwnerA: string;
  suspendedAppOwnerA: string;
  outsider: string;
  ownerB: string;
  membershipOwnerB: string;
  ownerGone: string;
  entityC1: string;
  entityC2: string;
  unitRootC: string;
  unitOtherC: string;
  personC1: string;
  personC2: string;
  personC3: string;
  personC4: string;
  personC5: string;
  employmentC1: string;
  employmentC2: string;
  employmentC3: string;
  employmentC4: string;
  managerC: string;
  membershipManagerC: string;
  ownerC: string;
};

async function buildFixtures(): Promise<Fixtures> {
  return withOwner(async (client) => {
    const jurisdictionId = await insertJurisdiction(client);

    const tenantA = await insertTenant(client, 'a');
    const tenantB = await insertTenant(client, 'b');
    const tenantC = await insertTenant(client, 'c');
    const tenantGone = await insertTenant(client, 'gone', true);
    await grantPeople(client, tenantA);
    await grantPeople(client, tenantB);
    await grantPeople(client, tenantC);

    const entityA1 = await insertLegalEntity(client, tenantA, 'a1', jurisdictionId);
    const entityA2 = await insertLegalEntity(client, tenantA, 'a2', jurisdictionId);
    const entityB = await insertLegalEntity(client, tenantB, 'b1', jurisdictionId);
    const entityGone = await insertLegalEntity(client, tenantGone, 'g1', jurisdictionId);
    const unitRootA = await insertOrgUnit(client, tenantA, 'root-a', null);
    const unitMidA = await insertOrgUnit(client, tenantA, 'mid-a', unitRootA);

    const personA1 = await insertPerson(client, tenantA, 'a1', {
      legalEntityId: entityA1,
      orgUnitId: unitMidA,
    });
    const personA2 = await insertPerson(client, tenantA, 'a2', {
      legalEntityId: entityA2,
      orgUnitId: unitRootA,
    });
    const personADeleted = await insertPerson(client, tenantA, 'adeleted', {
      legalEntityId: entityA1,
      deleted: true,
    });
    const personB = await insertPerson(client, tenantB, 'b1', { legalEntityId: entityB });
    const personGone = await insertPerson(client, tenantGone, 'g1', {
      legalEntityId: entityGone,
    });
    const employmentA1 = await insertEmployment(client, tenantA, personA1, entityA1);
    const employmentA2 = await insertEmployment(client, tenantA, personA2, entityA2);

    const ownerA = await insertUser(client, 'owner-a');
    const membershipOwnerA = await insertMembership(client, tenantA, ownerA, 'owner');
    const adminA = await insertUser(client, 'admin-a');
    await insertMembership(client, tenantA, adminA, 'admin');
    const managerA = await insertUser(client, 'manager-a');
    await insertMembership(client, tenantA, managerA, 'manager');
    const employeeA = await insertUser(client, 'employee-a');
    const membershipEmployeeA = await insertMembership(client, tenantA, employeeA, 'employee');
    const personOfEmployeeA = await insertPerson(client, tenantA, 'emp-a', {
      legalEntityId: entityA1,
      orgUnitId: unitMidA,
    });
    const employmentOfEmployeeA = await insertEmployment(
      client,
      tenantA,
      personOfEmployeeA,
      entityA1,
    );
    const secondEmployeeA = await insertUser(client, 'employee-a2');
    await insertMembership(client, tenantA, secondEmployeeA, 'employee');
    const suspendedMemberA = await insertUser(client, 'suspended-member');
    await insertMembership(client, tenantA, suspendedMemberA, 'employee', 'suspended');
    const dormantMemberA = await insertUser(client, 'dormant-member', 'suspended');
    await insertMembership(client, tenantA, dormantMemberA, 'employee');
    const suspendedOwnerA = await insertUser(client, 'suspended-owner');
    await insertMembership(client, tenantA, suspendedOwnerA, 'owner', 'suspended');
    const suspendedAppOwnerA = await insertUser(client, 'suspended-app-owner', 'suspended');
    await insertMembership(client, tenantA, suspendedAppOwnerA, 'owner');
    const outsider = await insertUser(client, 'outsider');
    const ownerB = await insertUser(client, 'owner-b');
    const membershipOwnerB = await insertMembership(client, tenantB, ownerB, 'owner');
    const ownerGone = await insertUser(client, 'owner-gone');
    await insertMembership(client, tenantGone, ownerGone, 'owner');

    const entityC1 = await insertLegalEntity(client, tenantC, 'c1', jurisdictionId);
    const entityC2 = await insertLegalEntity(client, tenantC, 'c2', jurisdictionId);
    const unitRootC = await insertOrgUnit(client, tenantC, 'root-c', null);
    const unitMidC = await insertOrgUnit(client, tenantC, 'mid-c', unitRootC);
    const unitOtherC = await insertOrgUnit(client, tenantC, 'other-c', null);

    const personC1 = await insertPerson(client, tenantC, 'c1', {
      legalEntityId: entityC1,
      orgUnitId: unitMidC,
    });
    const personC2 = await insertPerson(client, tenantC, 'c2', {
      legalEntityId: entityC2,
      orgUnitId: unitOtherC,
    });
    const personC3 = await insertPerson(client, tenantC, 'c3', {
      legalEntityId: entityC1,
      orgUnitId: unitRootC,
    });
    const personC4 = await insertPerson(client, tenantC, 'c4', {
      legalEntityId: entityC2,
      orgUnitId: unitMidC,
    });
    const personC5 = await insertPerson(client, tenantC, 'c5');
    const employmentC1 = await insertEmployment(client, tenantC, personC1, entityC1);
    const employmentC2 = await insertEmployment(client, tenantC, personC2, entityC2);
    const employmentC3 = await insertEmployment(client, tenantC, personC3, entityC1);
    const employmentC4 = await insertEmployment(client, tenantC, personC4, entityC2);
    const managerC = await insertUser(client, 'manager-c');
    const membershipManagerC = await insertMembership(client, tenantC, managerC, 'manager');
    const ownerC = await insertUser(client, 'owner-c');
    await insertMembership(client, tenantC, ownerC, 'owner');

    return {
      tenantA,
      tenantB,
      tenantC,
      tenantGone,
      entityA1,
      entityA2,
      entityB,
      unitRootA,
      unitMidA,
      personA1,
      personA2,
      personADeleted,
      personB,
      personGone,
      employmentA1,
      employmentA2,
      ownerA,
      membershipOwnerA,
      adminA,
      managerA,
      employeeA,
      personOfEmployeeA,
      employmentOfEmployeeA,
      membershipEmployeeA,
      secondEmployeeA,
      suspendedMemberA,
      dormantMemberA,
      suspendedOwnerA,
      suspendedAppOwnerA,
      outsider,
      ownerB,
      membershipOwnerB,
      ownerGone,
      entityC1,
      entityC2,
      unitRootC,
      unitOtherC,
      personC1,
      personC2,
      personC3,
      personC4,
      personC5,
      employmentC1,
      employmentC2,
      employmentC3,
      employmentC4,
      managerC,
      membershipManagerC,
      ownerC,
    };
  });
}

/**
 * A real owner pool whose audit insert is redirected at an insert that violates
 * audit_event.tenant_id, so appendAuditEvent fails with a genuine 23503 inside
 * the library's own transaction. By then the link or scope write has already
 * happened, so asserting that it disappeared is what proves the rollback.
 */
function ownerPoolWithFailingAudit(): Pool {
  const pool = new Pool({ connectionString: db().ownerUrl });
  const connect = pool.connect.bind(pool) as unknown as () => Promise<Client>;
  (pool as unknown as { connect: unknown }).connect = async () => {
    const client = await connect();
    const query = client.query.bind(client) as unknown as (
      sql: string,
      values?: unknown[],
    ) => Promise<QueryResult>;
    (client as unknown as { query: unknown }).query = (sql: string, values?: unknown[]) =>
      typeof sql === 'string' && sql.startsWith('insert into audit_event')
        ? query(
            `insert into audit_event (tenant_id, actor_type, action, entity_type)
             values ($1, 'system', 'test.scope_admin_audit_failure', 'person')`,
            [randomUUID()],
          )
        : query(sql, values);
    return client;
  };
  return pool;
}

beforeAll(async () => {
  database = await createTestDatabase({ migrate: true, seed: true });
  owner = new Pool({ connectionString: database.ownerUrl });
  runtime = createRuntimePool(database.runtimeUrl);
  fx = await buildFixtures();
});

afterAll(async () => {
  await runtime?.end();
  await owner?.end();
  await database?.drop();
});

describe('linkPersonUser', () => {
  test('links a person to an active member and writes exactly one audit row', async () => {
    const s = scope();
    const result = await linkPersonUser(ownerPool(), {
      tenantId: s.tenantA,
      personId: s.personOfEmployeeA,
      userId: s.employeeA,
      actorUserId: s.ownerA,
    });
    expect(result).toEqual({ changed: true });
    expect(await personUserId(s.tenantA, s.personOfEmployeeA)).toBe(s.employeeA);

    const rows = await auditRows(LINKED, s.personOfEmployeeA);
    expect(rows).toHaveLength(1);
    expect(one(rows)).toMatchObject({
      actor_type: 'user',
      actor_user_id: s.ownerA,
      entity_type: 'person',
      entity_id: s.personOfEmployeeA,
      before_state: { user_id: null },
      after_state: { user_id: s.employeeA },
    });
    expect(JSON.stringify(rows)).not.toContain('@example.test');
  });

  test('the linked employee reads its own person and employment and nothing else', async () => {
    const s = scope();
    expect(await runtimeVisiblePersonIds(s.tenantA, s.employeeA)).toEqual([
      s.personOfEmployeeA,
    ]);
    expect(await runtimeVisibleEmploymentIds(s.tenantA, s.employeeA)).toEqual([
      s.employmentOfEmployeeA,
    ]);
    expect(await runtimeVisiblePersonIds(s.tenantA, s.secondEmployeeA)).toEqual([]);
  });

  test('reading the same link again changes nothing and writes no audit row', async () => {
    const s = scope();
    const result = await linkPersonUser(ownerPool(), {
      tenantId: s.tenantA,
      personId: s.personOfEmployeeA,
      userId: s.employeeA,
      actorUserId: s.ownerA,
    });
    expect(result).toEqual({ changed: false });
    expect(await auditRows(LINKED, s.personOfEmployeeA)).toHaveLength(1);
  });

  test('refuses to move a person that is already linked to another user', async () => {
    const s = scope();
    await expect(
      linkPersonUser(ownerPool(), {
        tenantId: s.tenantA,
        personId: s.personOfEmployeeA,
        userId: s.secondEmployeeA,
        actorUserId: s.ownerA,
      }),
    ).rejects.toMatchObject({ code: 'PERSON_ALREADY_LINKED' });

    expect(await personUserId(s.tenantA, s.personOfEmployeeA)).toBe(s.employeeA);
    expect(await auditRows(LINKED, s.personOfEmployeeA)).toHaveLength(1);
    expect(await auditRows(LINKED, s.personA1)).toEqual([]);
  });

  test('refuses a user who is already linked to another person in the tenant', async () => {
    const s = scope();
    await expect(
      linkPersonUser(ownerPool(), {
        tenantId: s.tenantA,
        personId: s.personA1,
        userId: s.employeeA,
        actorUserId: s.ownerA,
      }),
    ).rejects.toMatchObject({ code: 'USER_ALREADY_LINKED' });

    expect(await personUserId(s.tenantA, s.personA1)).toBeNull();
    expect(await auditRows(LINKED, s.personA1)).toEqual([]);
  });

  test('refuses a soft-deleted person and a person from another tenant', async () => {
    const s = scope();
    await expect(
      linkPersonUser(ownerPool(), {
        tenantId: s.tenantA,
        personId: s.personADeleted,
        userId: s.secondEmployeeA,
        actorUserId: s.ownerA,
      }),
    ).rejects.toMatchObject({ code: 'PERSON_NOT_FOUND' });

    await expect(
      linkPersonUser(ownerPool(), {
        tenantId: s.tenantA,
        personId: s.personB,
        userId: s.secondEmployeeA,
        actorUserId: s.ownerA,
      }),
    ).rejects.toMatchObject({ code: 'PERSON_NOT_FOUND' });

    await expect(
      linkPersonUser(ownerPool(), {
        tenantId: s.tenantB,
        personId: s.personA1,
        userId: s.ownerB,
        actorUserId: s.ownerB,
      }),
    ).rejects.toMatchObject({ code: 'PERSON_NOT_FOUND' });

    expect(await personUserId(s.tenantA, s.personA1)).toBeNull();
    expect(await personUserId(s.tenantB, s.personB)).toBeNull();
  });

  test('refuses a target user with no active membership in the tenant', async () => {
    const s = scope();
    const cases: { userId: string; code: string }[] = [
      { userId: s.outsider, code: 'MEMBERSHIP_NOT_FOUND' },
      { userId: s.suspendedMemberA, code: 'MEMBERSHIP_NOT_ACTIVE' },
      { userId: s.dormantMemberA, code: 'MEMBERSHIP_NOT_ACTIVE' },
    ];
    for (const entry of cases) {
      await expect(
        linkPersonUser(ownerPool(), {
          tenantId: s.tenantA,
          personId: s.personA1,
          userId: entry.userId,
          actorUserId: s.ownerA,
        }),
      ).rejects.toMatchObject({ code: entry.code });
    }

    expect(await personUserId(s.tenantA, s.personA1)).toBeNull();
    expect(await auditRows(LINKED, s.personA1)).toEqual([]);
  });

  test('refuses actors that are not an active owner of the tenant', async () => {
    const s = scope();
    const actors = [
      s.adminA,
      s.managerA,
      s.employeeA,
      s.suspendedOwnerA,
      s.suspendedAppOwnerA,
      s.outsider,
      s.ownerB,
      s.ownerGone,
    ];
    for (const actorUserId of actors) {
      await expect(
        linkPersonUser(ownerPool(), {
          tenantId: s.tenantA,
          personId: s.personA1,
          userId: s.secondEmployeeA,
          actorUserId,
        }),
      ).rejects.toMatchObject({ code: 'ACTOR_NOT_OWNER' });
    }

    expect(await personUserId(s.tenantA, s.personA1)).toBeNull();
    expect(await auditRows(LINKED, s.personA1)).toEqual([]);
  });

  test('refuses a deleted tenant', async () => {
    const s = scope();
    await expect(
      linkPersonUser(ownerPool(), {
        tenantId: s.tenantGone,
        personId: s.personGone,
        userId: s.ownerGone,
        actorUserId: s.ownerGone,
      }),
    ).rejects.toMatchObject({ code: 'TENANT_NOT_FOUND' });
    expect(await personUserId(s.tenantGone, s.personGone)).toBeNull();
  });

  test('validates the input shape before opening a transaction', async () => {
    const s = scope();
    await expect(
      linkPersonUser(ownerPool(), {
        tenantId: s.tenantA,
        personId: 'not-a-uuid',
        userId: s.secondEmployeeA,
        actorUserId: s.ownerA,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_SCOPE_INPUT' });

    await expect(linkPersonUser(ownerPool(), undefined as never)).rejects.toMatchObject({
      code: 'INVALID_SCOPE_INPUT',
    });

    expect(await personUserId(s.tenantA, s.personA1)).toBeNull();
    expect(await auditRows(LINKED, s.personA1)).toEqual([]);
  });
});

describe('unlinkPersonUser', () => {
  test('clears the link, audits the previous value and closes the employee read', async () => {
    const s = scope();
    const result = await unlinkPersonUser(ownerPool(), {
      tenantId: s.tenantA,
      personId: s.personOfEmployeeA,
      actorUserId: s.ownerA,
    });
    expect(result).toEqual({ changed: true });
    expect(await personUserId(s.tenantA, s.personOfEmployeeA)).toBeNull();
    expect(await runtimeVisiblePersonIds(s.tenantA, s.employeeA)).toEqual([]);
    expect(await runtimeVisibleEmploymentIds(s.tenantA, s.employeeA)).toEqual([]);

    const rows = await auditRows(UNLINKED, s.personOfEmployeeA);
    expect(rows).toHaveLength(1);
    expect(one(rows)).toMatchObject({
      actor_type: 'user',
      actor_user_id: s.ownerA,
      entity_type: 'person',
      before_state: { user_id: s.employeeA },
      after_state: { user_id: null },
    });
  });

  test('unlinking an already unlinked person changes nothing and writes no audit row', async () => {
    const s = scope();
    const result = await unlinkPersonUser(ownerPool(), {
      tenantId: s.tenantA,
      personId: s.personOfEmployeeA,
      actorUserId: s.ownerA,
    });
    expect(result).toEqual({ changed: false });
    expect(await auditRows(UNLINKED, s.personOfEmployeeA)).toHaveLength(1);
  });

  test('applies the same tenant, actor and person guards to unlink', async () => {
    const s = scope();
    await expect(
      unlinkPersonUser(ownerPool(), {
        tenantId: s.tenantA,
        personId: s.personB,
        actorUserId: s.ownerA,
      }),
    ).rejects.toMatchObject({ code: 'PERSON_NOT_FOUND' });

    await expect(
      unlinkPersonUser(ownerPool(), {
        tenantId: s.tenantA,
        personId: s.personA1,
        actorUserId: s.adminA,
      }),
    ).rejects.toMatchObject({ code: 'ACTOR_NOT_OWNER' });

    await expect(
      unlinkPersonUser(ownerPool(), {
        tenantId: s.tenantGone,
        personId: s.personGone,
        actorUserId: s.ownerGone,
      }),
    ).rejects.toMatchObject({ code: 'TENANT_NOT_FOUND' });

    expect(await auditRows(UNLINKED, s.personA1)).toEqual([]);
  });
});

describe('setMembershipScope', () => {
  const entityC1 = (): ScopeValue => ({ scopeType: 'legal_entity', scopeId: scope().entityC1 });
  const unitRootC = (): ScopeValue => ({ scopeType: 'org_unit', scopeId: scope().unitRootC });

  test('refuses an empty scope list, tenantWide with rows, duplicates and unknown types', async () => {
    const s = scope();
    const base = {
      tenantId: s.tenantC,
      membershipId: s.membershipManagerC,
      actorUserId: s.ownerC,
    };

    await expect(setMembershipScope(ownerPool(), { ...base, scopes: [] })).rejects.toMatchObject({
      code: 'SCOPE_LIST_EMPTY',
    });
    await expect(
      setMembershipScope(ownerPool(), { ...base, scopes: [entityC1()], tenantWide: true }),
    ).rejects.toMatchObject({ code: 'TENANT_WIDE_WITH_SCOPES' });
    await expect(
      setMembershipScope(ownerPool(), { ...base, scopes: [entityC1(), entityC1()] }),
    ).rejects.toMatchObject({ code: 'SCOPE_DUPLICATE' });
    await expect(
      setMembershipScope(ownerPool(), {
        ...base,
        scopes: [{ scopeType: 'project' as never, scopeId: s.entityC1 }],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_SCOPE_INPUT' });
    await expect(
      setMembershipScope(ownerPool(), {
        ...base,
        scopes: [{ scopeType: 'legal_entity', scopeId: 'nope' }],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_SCOPE_INPUT' });
    await expect(
      setMembershipScope(ownerPool(), {
        tenantId: s.tenantC,
        membershipId: s.membershipManagerC,
        scopes: 'not-an-array' as never,
        actorUserId: s.ownerC,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_SCOPE_INPUT' });

    expect(await scopeRows(s.tenantC, s.membershipManagerC)).toEqual([]);
    expect(await auditRows(SCOPE_CHANGED, s.membershipManagerC)).toEqual([]);
  });

  test('refuses an employee membership, a foreign or inactive membership and a non-owner actor', async () => {
    const s = scope();
    await expect(
      setMembershipScope(ownerPool(), {
        tenantId: s.tenantA,
        membershipId: s.membershipEmployeeA,
        scopes: [{ scopeType: 'legal_entity', scopeId: s.entityA1 }],
        actorUserId: s.ownerA,
      }),
    ).rejects.toMatchObject({ code: 'MEMBERSHIP_IS_EMPLOYEE' });

    await expect(
      setMembershipScope(ownerPool(), {
        tenantId: s.tenantC,
        membershipId: s.membershipManagerC,
        scopes: [entityC1()],
        actorUserId: s.ownerA,
      }),
    ).rejects.toMatchObject({ code: 'ACTOR_NOT_OWNER' });

    await expect(
      setMembershipScope(ownerPool(), {
        tenantId: s.tenantA,
        membershipId: s.membershipManagerC,
        scopes: [{ scopeType: 'legal_entity', scopeId: s.entityA1 }],
        actorUserId: s.ownerA,
      }),
    ).rejects.toMatchObject({ code: 'MEMBERSHIP_NOT_FOUND' });

    await expect(
      setMembershipScope(ownerPool(), {
        tenantId: s.tenantC,
        membershipId: s.membershipManagerC,
        scopes: [entityC1()],
        actorUserId: s.ownerC,
      }).then((first) => first),
    ).resolves.toEqual({ changed: true });

    const suspendedMembership = await withOwner(async (client) => {
      const inserted = await client.query<{ id: string }>(
        `insert into membership (tenant_id, user_id, role, status)
         values ($1, $2, 'manager', 'suspended')
         returning id`,
        [s.tenantC, s.managerA],
      );
      return one(inserted.rows).id;
    });
    await expect(
      setMembershipScope(ownerPool(), {
        tenantId: s.tenantC,
        membershipId: suspendedMembership,
        scopes: [entityC1()],
        actorUserId: s.ownerC,
      }),
    ).rejects.toMatchObject({ code: 'MEMBERSHIP_NOT_ACTIVE' });

    await expect(
      setMembershipScope(ownerPool(), {
        tenantId: s.tenantGone,
        membershipId: s.membershipManagerC,
        scopes: [entityC1()],
        actorUserId: s.ownerC,
      }),
    ).rejects.toMatchObject({ code: 'TENANT_NOT_FOUND' });

    expect(await scopeRows(s.tenantA, s.membershipEmployeeA)).toEqual([]);
    expect(await auditRows(SCOPE_CHANGED, s.membershipEmployeeA)).toEqual([]);
    expect(await auditRows(SCOPE_CHANGED, suspendedMembership)).toEqual([]);

    await setMembershipScope(ownerPool(), {
      tenantId: s.tenantC,
      membershipId: s.membershipManagerC,
      scopes: [],
      tenantWide: true,
      actorUserId: s.ownerC,
    });
    expect(await scopeRows(s.tenantC, s.membershipManagerC)).toEqual([]);
  });

  test('refuses scope targets that are unknown, cross-tenant or soft-deleted', async () => {
    const s = scope();
    const before = await auditRows(SCOPE_CHANGED, s.membershipManagerC);
    const deletedTarget = await withOwner(async (client) => {
      const jurisdiction = await client.query<{ id: string }>(
        "select id from jurisdiction where code = 'ZZ'",
      );
      return insertLegalEntity(client, s.tenantC, 'gone', one(jurisdiction.rows).id, true);
    });

    const attempts: ScopeValue[] = [
      { scopeType: 'legal_entity', scopeId: randomUUID() },
      { scopeType: 'legal_entity', scopeId: s.entityB },
      { scopeType: 'org_unit', scopeId: s.unitRootA },
      { scopeType: 'legal_entity', scopeId: deletedTarget },
    ];
    for (const scopeValue of attempts) {
      await expect(
        setMembershipScope(ownerPool(), {
          tenantId: s.tenantC,
          membershipId: s.membershipManagerC,
          scopes: [scopeValue],
          actorUserId: s.ownerC,
        }),
      ).rejects.toMatchObject({ code: 'SCOPE_TARGET_NOT_FOUND' });
    }

    expect(await scopeRows(s.tenantC, s.membershipManagerC)).toEqual([]);
    expect(await auditRows(SCOPE_CHANGED, s.membershipManagerC)).toHaveLength(before.length);
  });

  test('replaces the whole set in one transaction and audits sorted before and after', async () => {
    const s = scope();
    const before = await auditRows(SCOPE_CHANGED, s.membershipManagerC);

    const first = await setMembershipScope(ownerPool(), {
      tenantId: s.tenantC,
      membershipId: s.membershipManagerC,
      scopes: [{ scopeType: 'legal_entity', scopeId: s.entityC2 }],
      actorUserId: s.ownerC,
    });
    expect(first).toEqual({ changed: true });
    expect(await scopeRows(s.tenantC, s.membershipManagerC)).toEqual([
      `legal_entity:${s.entityC2}`,
    ]);

    const second = await setMembershipScope(ownerPool(), {
      tenantId: s.tenantC,
      membershipId: s.membershipManagerC,
      scopes: [unitRootC(), entityC1()],
      actorUserId: s.ownerC,
    });
    expect(second).toEqual({ changed: true });
    expect(await scopeRows(s.tenantC, s.membershipManagerC)).toEqual([
      `legal_entity:${s.entityC1}`,
      `org_unit:${s.unitRootC}`,
    ]);

    const rows = await auditRows(SCOPE_CHANGED, s.membershipManagerC);
    expect(rows).toHaveLength(before.length + 2);
    const fresh = rows.slice(before.length);
    expect(one(fresh)).toMatchObject({
      actor_type: 'user',
      actor_user_id: s.ownerC,
      entity_type: 'membership',
      entity_id: s.membershipManagerC,
      before_state: [],
      after_state: [{ scope_type: 'legal_entity', id: s.entityC2 }],
    });
    expect(fresh[1]?.after_state).toEqual([
      { scope_type: 'legal_entity', id: s.entityC1 },
      { scope_type: 'org_unit', id: s.unitRootC },
    ]);
    const serialized = JSON.stringify(fresh);
    expect(serialized).not.toContain('@example.test');
    expect(serialized).not.toContain('Scope-admin entity');
  });

  test('treats the same set in another order as a no-op with no audit row', async () => {
    const s = scope();
    const before = await auditRows(SCOPE_CHANGED, s.membershipManagerC);
    const result = await setMembershipScope(ownerPool(), {
      tenantId: s.tenantC,
      membershipId: s.membershipManagerC,
      scopes: [entityC1(), unitRootC()],
      actorUserId: s.ownerC,
    });
    expect(result).toEqual({ changed: false });
    expect(await scopeRows(s.tenantC, s.membershipManagerC)).toEqual([
      `legal_entity:${s.entityC1}`,
      `org_unit:${s.unitRootC}`,
    ]);
    expect(await auditRows(SCOPE_CHANGED, s.membershipManagerC)).toHaveLength(before.length);
  });

  test('a legal entity scope narrows the manager runtime reads', async () => {
    const s = scope();
    await setMembershipScope(ownerPool(), {
      tenantId: s.tenantC,
      membershipId: s.membershipManagerC,
      scopes: [],
      tenantWide: true,
      actorUserId: s.ownerC,
    });
    expect(await runtimeVisiblePersonIds(s.tenantC, s.managerC)).toEqual(
      sorted([s.personC1, s.personC2, s.personC3, s.personC4, s.personC5]),
    );

    await setMembershipScope(ownerPool(), {
      tenantId: s.tenantC,
      membershipId: s.membershipManagerC,
      scopes: [entityC1()],
      actorUserId: s.ownerC,
    });

    expect(await runtimeVisiblePersonIds(s.tenantC, s.managerC)).toEqual(
      sorted([s.personC1, s.personC3]),
    );
    expect(await runtimeVisibleEmploymentIds(s.tenantC, s.managerC)).toEqual(
      sorted([s.employmentC1, s.employmentC3]),
    );
  });

  test('an org unit scope covers the subtree and excludes other trees and unplaced people', async () => {
    const s = scope();
    await setMembershipScope(ownerPool(), {
      tenantId: s.tenantC,
      membershipId: s.membershipManagerC,
      scopes: [unitRootC()],
      actorUserId: s.ownerC,
    });

    const visible = await runtimeVisiblePersonIds(s.tenantC, s.managerC);
    expect(visible).toEqual(sorted([s.personC1, s.personC3, s.personC4]));
    expect(visible).not.toContain(s.personC2);
    expect(visible).not.toContain(s.personC5);
  });

  test('an explicit tenantWide clears the rows and restores the tenant-wide read', async () => {
    const s = scope();
    const before = await auditRows(SCOPE_CHANGED, s.membershipManagerC);
    const result = await setMembershipScope(ownerPool(), {
      tenantId: s.tenantC,
      membershipId: s.membershipManagerC,
      scopes: [],
      tenantWide: true,
      actorUserId: s.ownerC,
    });
    expect(result).toEqual({ changed: true });
    expect(await scopeRows(s.tenantC, s.membershipManagerC)).toEqual([]);
    expect(await runtimeVisiblePersonIds(s.tenantC, s.managerC)).toEqual(
      sorted([s.personC1, s.personC2, s.personC3, s.personC4, s.personC5]),
    );

    const rows = await auditRows(SCOPE_CHANGED, s.membershipManagerC);
    expect(rows).toHaveLength(before.length + 1);
    expect(rows.at(-1)).toMatchObject({
      before_state: [{ scope_type: 'org_unit', id: s.unitRootC }],
      after_state: [],
    });
  });

  test('rolls back the scope replacement when the audit append fails', async () => {
    const s = scope();
    const before = await auditRows(SCOPE_CHANGED, s.membershipManagerC);
    const pool = ownerPoolWithFailingAudit();
    try {
      await expect(
        setMembershipScope(pool, {
          tenantId: s.tenantC,
          membershipId: s.membershipManagerC,
          scopes: [{ scopeType: 'legal_entity', scopeId: s.entityC2 }],
          actorUserId: s.ownerC,
        }),
      ).rejects.toMatchObject({ code: '23503' });
    } finally {
      await pool.end();
    }

    expect(await scopeRows(s.tenantC, s.membershipManagerC)).toEqual([]);
    expect(await auditRows(SCOPE_CHANGED, s.membershipManagerC)).toHaveLength(before.length);
    const injected = await ownerPool().query(
      "select id from audit_event where action = 'test.scope_admin_audit_failure'",
    );
    expect(injected.rows).toEqual([]);
  });

  test('rolls back a person link when the audit append fails', async () => {
    const s = scope();
    const pool = ownerPoolWithFailingAudit();
    try {
      await expect(
        linkPersonUser(pool, {
          tenantId: s.tenantA,
          personId: s.personA1,
          userId: s.secondEmployeeA,
          actorUserId: s.ownerA,
        }),
      ).rejects.toMatchObject({ code: '23503' });
    } finally {
      await pool.end();
    }

    expect(await personUserId(s.tenantA, s.personA1)).toBeNull();
    expect(await auditRows(LINKED, s.personA1)).toEqual([]);
    expect(await runtimeVisiblePersonIds(s.tenantA, s.secondEmployeeA)).toEqual([]);
  });
});

describe('getMembershipScope', () => {
  test('returns the role, the membership status and labelled scope rows', async () => {
    const s = scope();
    await setMembershipScope(ownerPool(), {
      tenantId: s.tenantC,
      membershipId: s.membershipManagerC,
      scopes: [
        { scopeType: 'org_unit', scopeId: s.unitOtherC },
        { scopeType: 'legal_entity', scopeId: s.entityC1 },
      ],
      actorUserId: s.ownerC,
    });

    const view = await getMembershipScope(ownerPool(), {
      tenantId: s.tenantC,
      membershipId: s.membershipManagerC,
    });
    expect(view.membershipId).toBe(s.membershipManagerC);
    expect(view.role).toBe('manager');
    expect(view.membershipStatus).toBe('active');
    expect(view.tenantWide).toBe(false);
    expect(view.scopes.map((entry) => `${entry.scopeType}:${entry.scopeId}`)).toEqual([
      `legal_entity:${s.entityC1}`,
      `org_unit:${s.unitOtherC}`,
    ]);
    expect(view.scopes[0]?.label).toContain('Scope-admin entity c1');
    expect(view.scopes[1]?.label).toBe('Scope-admin unit other-c');
    expect(JSON.stringify(view)).not.toContain('@example.test');

    await setMembershipScope(ownerPool(), {
      tenantId: s.tenantC,
      membershipId: s.membershipManagerC,
      scopes: [],
      tenantWide: true,
      actorUserId: s.ownerC,
    });
  });

  test('reports a membership with no rows as tenant-wide', async () => {
    const s = scope();
    const view = await getMembershipScope(ownerPool(), {
      tenantId: s.tenantA,
      membershipId: s.membershipOwnerA,
    });
    expect(view).toMatchObject({
      role: 'owner',
      membershipStatus: 'active',
      tenantWide: true,
      scopes: [],
    });
  });

  test('refuses a membership that is not in the given tenant', async () => {
    const s = scope();
    await expect(
      getMembershipScope(ownerPool(), {
        tenantId: s.tenantA,
        membershipId: s.membershipManagerC,
      }),
    ).rejects.toMatchObject({ code: 'MEMBERSHIP_NOT_FOUND' });
    await expect(
      getMembershipScope(ownerPool(), {
        tenantId: s.tenantGone,
        membershipId: s.membershipOwnerA,
      }),
    ).rejects.toMatchObject({ code: 'TENANT_NOT_FOUND' });
  });
});

describe('grant surface', () => {
  test('keeps membership_scope unreadable and the runtime and worker grants unchanged', async () => {
    const s = scope();
    expect((await runtimeError(s.tenantC, 'select id from public.membership_scope')).code).toBe(
      '42501',
    );
    expect(
      (await runtimeError(s.tenantC, 'select user_id from public.person')).code,
    ).toBe('42501');

    const workerClient = new Client({ connectionString: db().workerUrl });
    await workerClient.connect();
    let workerCode: string | undefined;
    try {
      await workerClient.query("select set_config('app.tenant_id', $1, true)", [s.tenantC]);
      await workerClient.query('select id from public.membership_scope');
    } catch (caught) {
      workerCode = (caught as { code?: string }).code;
    } finally {
      await workerClient.end();
    }
    expect(workerCode).toBe('42501');

    const tableGrants = await withOwner(async (client) => {
      const result = await client.query<{ grantee: string; count: string }>(
        `select grantee, count(*)::text
           from information_schema.role_table_grants
          where grantee in ('saas_runtime', 'saas_worker')
            and table_schema = 'public'
          group by grantee
          order by grantee`,
      );
      return result.rows;
    });
    expect(tableGrants).toEqual([{ grantee: 'saas_runtime', count: '12' }]);

    const runtimeFunctions = await withOwner(async (client) => {
      const result = await client.query<{ proname: string }>(`
        select distinct p.proname
          from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'app'
           and has_function_privilege('saas_runtime', p.oid, 'EXECUTE')
         order by 1
      `);
      return result.rows.map((row) => row.proname);
    });
    expect(runtimeFunctions).toEqual([
      'current_member_role',
      'current_person_id',
      'current_tenant_id',
      'current_user_id',
      'has_active_module',
      'has_module_read',
      'has_module_write',
      'has_platform_access',
      'has_switch_access',
      'person_in_scope',
      'person_placement_in_scope',
      'person_visible',
    ]);

    const scopeGrants = await withOwner(async (client) => {
      const result = await client.query(
        `select 1
           from information_schema.role_table_grants
          where table_name = 'membership_scope'
            and grantee in ('saas_runtime', 'saas_worker', 'saas_auth')`,
      );
      return result.rows;
    });
    expect(scopeGrants).toEqual([]);

    const personPrivileges = await withOwner(async (client) => {
      const result = await client.query<{ privilege: string; allowed: boolean }>(`
        select p as privilege,
               has_table_privilege('saas_runtime', 'public.person', p) as allowed
          from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p
         order by 1
      `);
      return result.rows;
    });
    expect(personPrivileges.every((row) => !row.allowed)).toBe(true);

    expect(await personUserId(s.tenantA, s.personA1)).toBeNull();
  });
});
