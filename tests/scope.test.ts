import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  createRuntimePool,
  withMemberTransaction,
  type RuntimePool,
} from '@saasmodels/db';
import { createTestDatabase, type TestDatabase } from '@saasmodels/testkit';

let database: TestDatabase | undefined;
let fx: Fixtures | undefined;
let pool: RuntimePool | undefined;

function db(): TestDatabase {
  if (!database) {
    throw new Error('Test database has not been created');
  }
  return database;
}

function scope(): Fixtures {
  if (!fx) {
    throw new Error('Scope fixtures have not been created');
  }
  return fx;
}

function runtimePool(): RuntimePool {
  if (!pool) {
    throw new Error('Runtime pool has not been created');
  }
  return pool;
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

async function ownerClient(): Promise<Client> {
  const client = new Client({ connectionString: db().ownerUrl });
  await client.connect();
  return client;
}

async function withOwner<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = await ownerClient();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/**
 * The runtime role inside an explicit tenant and user context, always rolled
 * back. This is the raw RLS path: no entitlement or role gate, only what the
 * database enforces.
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

/** The system path: a tenant context and nothing else. */
async function withSystem<T>(
  tenantId: string,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  return withMember(tenantId, null, fn);
}

type PgError = { code?: string; message: string };

async function expectError(
  tenantId: string | null,
  userId: string | null,
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

async function visiblePersonIds(tenantId: string | null, userId: string | null) {
  return withMember(tenantId, userId, async (client) => {
    const result = await client.query<{ id: string }>(
      'select id from public.person order by id',
    );
    return result.rows.map((row) => row.id);
  });
}

async function visibleEmploymentIds(tenantId: string | null, userId: string | null) {
  return withMember(tenantId, userId, async (client) => {
    const result = await client.query<{ id: string }>(
      'select id from public.employment order by id',
    );
    return result.rows.map((row) => row.id);
  });
}

async function helperBoolean(
  tenantId: string | null,
  userId: string | null,
  sql: string,
  params: unknown[],
): Promise<boolean | null> {
  return withMember(tenantId, userId, async (client) => {
    const result = await client.query<{ allowed: boolean | null }>(sql, params);
    return one(result.rows).allowed;
  });
}

async function insertJurisdiction(client: Client): Promise<string> {
  const result = await client.query<{ id: string }>(
    `insert into jurisdiction
       (code, country_code, name, default_currency, default_timezone)
     values ('ZZ', 'ZZ', 'Synthetic scope jurisdiction', 'ZZZ', 'UTC')
     returning id`,
  );
  return one(result.rows).id;
}

async function insertTenant(client: Client, label: string): Promise<string> {
  const result = await client.query<{ id: string }>(
    `insert into tenant (name, slug, data_region)
     values ($1, $2, 'test')
     returning id`,
    [`Scope ${label}`, `scope_${label}_${suffix()}`],
  );
  return one(result.rows).id;
}

async function insertUser(client: Client, label: string): Promise<string> {
  const result = await client.query<{ id: string }>(
    `insert into app_user (email, display_name)
     values ($1, $2)
     returning id`,
    [`scope_${label}_${suffix()}@example.test`, `Scope user ${label}`],
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
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `insert into legal_entity (tenant_id, name, code, jurisdiction_id, currency, timezone)
     values ($1, $2, $3, $4, 'ZZZ', 'UTC')
     returning id`,
    [tenantId, `Scope entity ${label}`, `sle_${label}_${suffix()}`, jurisdictionId],
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
    [tenantId, parentId, `Scope unit ${label}`],
  );
  return one(result.rows).id;
}

type PersonInput = {
  legalEntityId?: string | null;
  orgUnitId?: string | null;
  userId?: string | null;
};

async function insertPerson(
  client: Client,
  tenantId: string,
  label: string,
  input: PersonInput = {},
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `insert into person
       (tenant_id, first_name, display_name, work_email,
        legal_entity_id, org_unit_id, user_id)
     values ($1, $2, $3, $4, $5, $6, $7)
     returning id`,
    [
      tenantId,
      label,
      `Person ${label}`,
      `scope_${label}_${suffix()}@example.test`,
      input.legalEntityId ?? null,
      input.orgUnitId ?? null,
      input.userId ?? null,
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
     values ($1, $2, $3, 'full_time', $4)
     returning id`,
    [tenantId, personId, legalEntityId, '2024-01-01'],
  );
  return one(result.rows).id;
}

async function insertScopeRow(
  client: Client,
  tenantId: string,
  membershipId: string,
  scopeType: string,
  targetId: string,
): Promise<void> {
  await client.query(
    `insert into membership_scope (tenant_id, membership_id, scope_type, legal_entity_id, org_unit_id)
     values ($1, $2, $3, $4, $5)`,
    [
      tenantId,
      membershipId,
      scopeType,
      scopeType === 'legal_entity' ? targetId : null,
      scopeType === 'org_unit' ? targetId : null,
    ],
  );
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
  tenantNoEntitlement: string;
  entity1: string;
  entity2: string;
  entityB: string;
  entityNoEnt: string;
  unitParent: string;
  unitMid: string;
  unitLeaf: string;
  unitSibling: string;
  personEntity1: string;
  personEntity2: string;
  personMid: string;
  personLeaf: string;
  personParent: string;
  personSibling: string;
  personNull: string;
  personEntityB: string;
  personNullB: string;
  personNoEnt: string;
  employmentNoEnt: string;
  employmentEntity1: string;
  employmentEntity2: string;
  employmentMid: string;
  employmentLeaf: string;
  employmentParent: string;
  employmentSibling: string;
  employmentNull: string;
  employmentB: string;
  managerWide: string;
  managerEntity: string;
  managerUnit: string;
  managerRoot: string;
  employeeLinked: string;
  personOfLinkedEmployee: string;
  employeeLinkedEmployment: string;
  employeeUnlinked: string;
  membershipOfLinkedEmployee: string;
  scopeManagerEntity: string;
  scopeManagerUnit: string;
  suspendedManager: string;
  nonMember: string;
};

async function buildFixtures(): Promise<Fixtures> {
  return withOwner(async (client) => {
    const jurisdictionId = await insertJurisdiction(client);
    const tenantA = await insertTenant(client, 'a');
    const tenantB = await insertTenant(client, 'b');
    const tenantNoEntitlement = await insertTenant(client, 'n');

    const entity1 = await insertLegalEntity(client, tenantA, 'one', jurisdictionId);
    const entity2 = await insertLegalEntity(client, tenantA, 'two', jurisdictionId);
    const entityB = await insertLegalEntity(client, tenantB, 'bee', jurisdictionId);
    const entityNoEnt = await insertLegalEntity(
      client,
      tenantNoEntitlement,
      'unentitled',
      jurisdictionId,
    );

    const unitParent = await insertOrgUnit(client, tenantA, 'parent', null);
    const unitMid = await insertOrgUnit(client, tenantA, 'mid', unitParent);
    const unitLeaf = await insertOrgUnit(client, tenantA, 'leaf', unitMid);
    const unitSibling = await insertOrgUnit(client, tenantA, 'sibling', unitParent);

    const personEntity1 = await insertPerson(client, tenantA, 'ent1', { legalEntityId: entity1 });
    const personEntity2 = await insertPerson(client, tenantA, 'ent2', { legalEntityId: entity2 });
    const personMid = await insertPerson(client, tenantA, 'mid', {
      legalEntityId: entity1,
      orgUnitId: unitMid,
    });
    const personLeaf = await insertPerson(client, tenantA, 'leaf', {
      legalEntityId: entity1,
      orgUnitId: unitLeaf,
    });
    const personParent = await insertPerson(client, tenantA, 'parent', {
      legalEntityId: entity1,
      orgUnitId: unitParent,
    });
    const personSibling = await insertPerson(client, tenantA, 'sibling', {
      legalEntityId: entity1,
      orgUnitId: unitSibling,
    });
    const personNull = await insertPerson(client, tenantA, 'nulls');
    const personEntityB = await insertPerson(client, tenantB, 'bee', { legalEntityId: entityB });
    const personNullB = await insertPerson(client, tenantB, 'bee-null');
    const personNoEnt = await insertPerson(client, tenantNoEntitlement, 'noent', {
      legalEntityId: entityNoEnt,
    });
    const employmentNoEnt = await insertEmployment(
      client,
      tenantNoEntitlement,
      personNoEnt,
      entityNoEnt,
    );

    const employmentEntity1 = await insertEmployment(client, tenantA, personEntity1, entity1);
    const employmentEntity2 = await insertEmployment(client, tenantA, personEntity2, entity2);
    const employmentMid = await insertEmployment(client, tenantA, personMid, entity1);
    const employmentLeaf = await insertEmployment(client, tenantA, personLeaf, entity1);
    const employmentParent = await insertEmployment(client, tenantA, personParent, entity1);
    const employmentSibling = await insertEmployment(client, tenantA, personSibling, entity1);
    const employmentNull = await insertEmployment(client, tenantA, personNull, entity1);
    const employmentB = await insertEmployment(client, tenantB, personEntityB, entityB);

    const managerWide = await insertUser(client, 'wide');
    await insertMembership(client, tenantA, managerWide, 'manager');
    const managerEntity = await insertUser(client, 'entity');
    const membershipEntity = await insertMembership(client, tenantA, managerEntity, 'manager');
    await insertScopeRow(client, tenantA, membershipEntity, 'legal_entity', entity1);
    const managerUnit = await insertUser(client, 'unit');
    const membershipUnit = await insertMembership(client, tenantA, managerUnit, 'manager');
    await insertScopeRow(client, tenantA, membershipUnit, 'org_unit', unitMid);
    const managerRoot = await insertUser(client, 'root');
    const membershipRoot = await insertMembership(client, tenantA, managerRoot, 'manager');
    await insertScopeRow(client, tenantA, membershipRoot, 'org_unit', unitParent);

    const employeeLinked = await insertUser(client, 'emp-linked');
    const membershipLinked = await insertMembership(client, tenantA, employeeLinked, 'employee');
    const personOfLinkedEmployee = await insertPerson(client, tenantA, 'self', {
      legalEntityId: entity2,
      userId: employeeLinked,
    });
    const employeeLinkedEmployment = await insertEmployment(
      client,
      tenantA,
      personOfLinkedEmployee,
      entity2,
    );
    // Deliberately given scope rows: they must not widen an employee read.
    await insertScopeRow(client, tenantA, membershipLinked, 'legal_entity', entity1);

    const employeeUnlinked = await insertUser(client, 'emp-unlinked');
    await insertMembership(client, tenantA, employeeUnlinked, 'employee');

    const suspendedManager = await insertUser(client, 'suspended');
    await insertMembership(client, tenantA, suspendedManager, 'manager', 'suspended');
    const nonMember = await insertUser(client, 'nonmember');

    await grantPeople(client, tenantA);
    await grantPeople(client, tenantB);

    return {
      tenantA,
      tenantB,
      tenantNoEntitlement,
      entity1,
      entity2,
      entityB,
      entityNoEnt,
      unitParent,
      unitMid,
      unitLeaf,
      unitSibling,
      personEntity1,
      personEntity2,
      personMid,
      personLeaf,
      personParent,
      personSibling,
      personNull,
      personEntityB,
      personNullB,
      personNoEnt,
      employmentNoEnt,
      employmentEntity1,
      employmentEntity2,
      employmentMid,
      employmentLeaf,
      employmentParent,
      employmentSibling,
      employmentNull,
      employmentB,
      managerWide,
      managerEntity,
      managerUnit,
      managerRoot,
      employeeLinked,
      personOfLinkedEmployee,
      employeeLinkedEmployment,
      employeeUnlinked,
      membershipOfLinkedEmployee: membershipLinked,
      scopeManagerEntity: membershipEntity,
      scopeManagerUnit: membershipUnit,
      suspendedManager,
      nonMember,
    };
  });
}

beforeAll(async () => {
  database = await createTestDatabase({ migrate: true, seed: true });
  fx = await buildFixtures();
  pool = createRuntimePool(db().runtimeUrl);
});

afterAll(async () => {
  await pool?.end();
  await database?.drop();
});

describe('people scope schema and privileges', () => {
  test('links person to app_user with a nullable column and a partial unique index', async () => {
    await withOwner(async (client) => {
      const column = await client.query<{
        is_nullable: string;
        data_type: string;
      }>(`
        select c.is_nullable, c.data_type
          from information_schema.columns c
         where c.table_schema = 'public' and c.table_name = 'person'
           and c.column_name = 'user_id'
      `);
      expect(column.rows).toHaveLength(1);
      expect(one(column.rows).is_nullable).toBe('YES');
      expect(one(column.rows).data_type).toBe('uuid');

      const foreignKey = await client.query<{
        conname: string;
        ref_table: string;
        delete_rule: string;
      }>(`
        select con.conname, ref.relname as ref_table, con.confdeltype as delete_rule
          from pg_constraint con
          join pg_class rel on rel.oid = con.conrelid
          join pg_class ref on ref.oid = con.confrelid
          join pg_attribute a
            on a.attrelid = con.conrelid and a.attnum = con.conkey[1]
         where rel.relname = 'person'
           and con.contype = 'f'
           and a.attname = 'user_id'
      `);
      expect(foreignKey.rows).toEqual([
        { conname: 'person_user_id_fkey', ref_table: 'app_user', delete_rule: 'n' },
      ]);

      const index = await client.query<{
        indexname: string;
        is_partial: boolean;
        indexdef: string;
      }>(`
        select ic.relname as indexname,
               i.indpred is not null as is_partial,
               pg_get_indexdef(i.indexrelid) as indexdef
          from pg_index i
          join pg_class ic on ic.oid = i.indexrelid
          join pg_class t on t.oid = i.indrelid
         where t.relname = 'person' and ic.relname = 'person_user_uidx'
      `);
      expect(index.rows).toHaveLength(1);
      expect(one(index.rows).is_partial).toBe(true);
      expect(one(index.rows).indexdef).toContain('(tenant_id, user_id)');
      expect(one(index.rows).indexdef).toContain('WHERE (user_id IS NOT NULL)');

      // The link is enforced for real: two people in one tenant cannot share a
      // user, and a user who leaves unlinks the person instead of deleting it.
      const s = scope();
      const duplicate = await withOwner(async (client) => {
        let error: PgError | undefined;
        try {
          await client.query(
            `insert into person (tenant_id, first_name, display_name, user_id)
             values ($1, 'Dup', 'Duplicate Link', $2)`,
            [s.tenantA, s.employeeLinked],
          );
        } catch (caught) {
          error = caught as PgError;
        }
        return error;
      });
      expect(duplicate?.code).toBe('23505');
    });
  });

  test('creates membership_scope as a tenant-isolated table with the reviewed constraints', async () => {
    await withOwner(async (client) => {
      const table = await client.query<{
        has_tenant_id: boolean;
        rls: boolean;
        forced: boolean;
        policies: string[];
      }>(`
        select exists (
                 select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'membership_scope'
                    and column_name = 'tenant_id'
               ) as has_tenant_id,
               c.relrowsecurity as rls,
               c.relforcerowsecurity as forced,
               coalesce((select array_agg(p.polname::text order by p.polname)::text[]
                           from pg_policy p where p.polrelid = c.oid), '{}'::text[]) as policies
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relname = 'membership_scope'
      `);
      expect(table.rows).toEqual([
        {
          has_tenant_id: true,
          rls: true,
          forced: false,
          policies: ['tenant_isolation'],
        },
      ]);

      const foreignKeys = await client.query<{
        ref_table: string;
        columns: string[];
        delete_rule: string;
      }>(`
        select ref.relname as ref_table,
               array_agg(a.attname::text order by array_position(con.conkey, a.attnum)) as columns,
               con.confdeltype as delete_rule
          from pg_constraint con
          join pg_class rel on rel.oid = con.conrelid
          join pg_class ref on ref.oid = con.confrelid
          join pg_attribute a on a.attrelid = rel.oid and a.attnum = any (con.conkey)
         where rel.relname = 'membership_scope' and con.contype = 'f'
         group by ref.relname, con.conkey, con.confdeltype
         order by ref.relname
      `);
      expect(foreignKeys.rows).toEqual([
        { columns: ['tenant_id', 'legal_entity_id'], delete_rule: 'a', ref_table: 'legal_entity' },
        { columns: ['tenant_id', 'membership_id'], delete_rule: 'c', ref_table: 'membership' },
        { columns: ['tenant_id', 'org_unit_id'], delete_rule: 'a', ref_table: 'org_unit' },
        { columns: ['tenant_id'], delete_rule: 'c', ref_table: 'tenant' },
      ]);

      // The composite FK target this migration had to create on membership.
      const membershipUniques = await client.query<{ columns: string[] }>(`
        select array_agg(a.attname::text order by array_position(con.conkey, a.attnum)) as columns
          from pg_constraint con
          join pg_class rel on rel.oid = con.conrelid
          join pg_attribute a on a.attrelid = rel.oid and a.attnum = any (con.conkey)
         where rel.relname = 'membership' and con.contype = 'u'
         group by con.conkey
         order by 1
      `);
      expect(membershipUniques.rows.map((row) => row.columns)).toEqual([
        ['tenant_id', 'id'],
        ['tenant_id', 'user_id'],
      ]);

      const indexes = await client.query<{ indexname: string }>(`
        select ic.relname as indexname
          from pg_index x
          join pg_class ic on ic.oid = x.indexrelid
          join pg_class t on t.oid = x.indrelid
         where t.relname = 'membership_scope'
         order by 1
      `);
      expect(indexes.rows.map((row) => row.indexname)).toEqual([
        'membership_scope_entity_idx',
        'membership_scope_membership_idx',
        'membership_scope_pkey',
        'membership_scope_tenant_id_membership_id_scope_type_legal_e_key',
        'membership_scope_unit_idx',
      ]);

      const partial = await client.query<{ indexname: string }>(`
        select ic.relname as indexname
          from pg_index x
          join pg_class ic on ic.oid = x.indexrelid
          join pg_class t on t.oid = x.indrelid
         where t.relname = 'membership_scope' and x.indpred is not null
         order by 1
      `);
      expect(partial.rows.map((row) => row.indexname)).toEqual([
        'membership_scope_entity_idx',
        'membership_scope_unit_idx',
      ]);
    });
  });

  test('enforces the membership_scope value rules', async () => {
    const s = scope();
    const codes: Record<string, string | undefined> = {};

    // A scope row must carry exactly one typed column.
    codes.bothNull = await withOwner(async (client) => {
      try {
        await client.query(
          `insert into membership_scope (tenant_id, membership_id, scope_type)
           values ($1, $2, 'legal_entity')`,
          [s.tenantA, s.scopeManagerEntity],
        );
        return undefined;
      } catch (caught) {
        return (caught as PgError).code;
      }
    });
    codes.bothSet = await withOwner(async (client) => {
      try {
        await client.query(
          `insert into membership_scope (tenant_id, membership_id, scope_type, legal_entity_id, org_unit_id)
           values ($1, $2, 'legal_entity', $3, $4)`,
          [s.tenantA, s.scopeManagerEntity, s.entity1, s.unitMid],
        );
        return undefined;
      } catch (caught) {
        return (caught as PgError).code;
      }
    });
    codes.badType = await withOwner(async (client) => {
      try {
        await client.query(
          `insert into membership_scope (tenant_id, membership_id, scope_type, legal_entity_id)
           values ($1, $2, 'project', $3)`,
          [s.tenantA, s.scopeManagerEntity, s.entity1],
        );
        return undefined;
      } catch (caught) {
        return (caught as PgError).code;
      }
    });
    // The reviewed duplicate key is NULLS NOT DISTINCT, so two identical
    // org_unit rows for one membership collide on the null legal_entity_id.
    codes.duplicate = await withOwner(async (client) => {
      try {
        await client.query('begin');
        await client.query(
          `insert into membership_scope (tenant_id, membership_id, scope_type, org_unit_id)
           values ($1, $2, 'org_unit', $3)`,
          [s.tenantA, s.scopeManagerUnit, s.unitLeaf],
        );
        await client.query(
          `insert into membership_scope (tenant_id, membership_id, scope_type, org_unit_id)
           values ($1, $2, 'org_unit', $3)`,
          [s.tenantA, s.scopeManagerUnit, s.unitLeaf],
        );
        await client.query('rollback');
        return undefined;
      } catch (caught) {
        await client.query('rollback').catch(() => undefined);
        return (caught as PgError).code;
      }
    });
    expect(codes).toEqual({
      bothNull: '23514',
      bothSet: '23514',
      badType: '23514',
      duplicate: '23505',
    });
  });

  test('installs the eight restrictive scope policies without touching the M0 policies', async () => {
    await withOwner(async (client) => {
      const policies = await client.query<{
        table_name: string;
        polname: string;
        polcmd: string;
        permissive: boolean;
        using_clause: string | null;
        check_clause: string | null;
      }>(`
        select c.relname as table_name, p.polname, p.polcmd, p.polpermissive as permissive,
               pg_get_expr(p.polqual, p.polrelid) as using_clause,
               pg_get_expr(p.polwithcheck, p.polrelid) as check_clause
          from pg_policy p
          join pg_class c on c.oid = p.polrelid
         where c.relname in ('person', 'employment')
         order by c.relname, p.polname
      `);
      const scope = policies.rows.filter((row) => row.polname.startsWith('scope_'));
      expect(scope.map((row) => `${row.table_name}.${row.polname}.${row.polcmd}`)).toEqual([
        'employment.scope_delete.d',
        // pg_policy stores an INSERT policy as command class "a": INSERT is the
        // only command with a WITH CHECK clause and no USING clause.
        'employment.scope_insert.a',
        'employment.scope_read.r',
        'employment.scope_update.w',
        'person.scope_delete.d',
        'person.scope_insert.a',
        'person.scope_read.r',
        'person.scope_update.w',
      ]);
      expect(scope.every((row) => row.permissive === false)).toBe(true);
      expect(
        scope
          .filter((row) => row.polname === 'scope_read')
          .map((row) => `${row.table_name}:${row.using_clause}`),
      ).toEqual([
        'employment:app.person_visible(person_id)',
        'person:app.person_visible(id)',
      ]);
      expect(
        scope
          .filter((row) => row.table_name === 'person' && row.polname === 'scope_insert')
          .map((row) => row.check_clause),
      ).toEqual(['app.person_placement_in_scope(legal_entity_id, org_unit_id)']);
      expect(
        scope
          .filter((row) => row.table_name === 'person' && row.polname === 'scope_update')
          .map((row) => `${row.using_clause}|${row.check_clause}`),
      ).toEqual([
        'app.person_in_scope(id)|app.person_placement_in_scope(legal_entity_id, org_unit_id)',
      ]);
      expect(
        scope
          .filter((row) => row.table_name === 'employment' && row.polname === 'scope_update')
          .map((row) => `${row.using_clause}|${row.check_clause}`),
      ).toEqual(['app.person_in_scope(person_id)|app.person_in_scope(person_id)']);

      // Nothing M0 installed was dropped or weakened.
      const survivors = policies.rows.filter((row) => !row.polname.startsWith('scope_'));
      expect(
        survivors.map((row) => `${row.table_name}.${row.polname}.${row.polcmd}`).sort(),
      ).toEqual([
        'employment.module_people_read.r',
        'employment.module_people_write_delete.d',
        'employment.module_people_write_insert.a',
        'employment.module_people_write_update.w',
        'employment.tenant_isolation.*',
        'person.tenant_isolation.*',
      ]);
      expect(
        survivors.every((row) => (row.polname === 'tenant_isolation' ? row.permissive : !row.permissive)),
      ).toBe(true);

      const forced = await client.query<{ n: string }>(`
        select count(*)::text as n
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
         where n.nspname in ('public', 'infra') and c.relkind = 'r'
           and c.relforcerowsecurity
      `);
      expect(one(forced.rows).n).toBe('0');
    });
  });

  test('counts every scope policy in the catalogue: eleven names over three tables', async () => {
    await withOwner(async (client) => {
      // The scope layer as one set, because the number of names is what tells a
      // future slice that a new person-child table needs its own reviewed
      // migration: person and employment each carry four (0012) and compensation
      // carries three (0013 read, 0014 insert and update). Compensation has no
      // delete name on purpose - there is no delete privilege on the table, so a
      // delete policy would govern a command no role can execute.
      const scope = await client.query<{ table_name: string; polname: string }>(`
        select c.relname as table_name, p.polname
          from pg_policy p
          join pg_class c on c.oid = p.polrelid
         where p.polname like 'scope_%'
         order by c.relname, p.polname
      `);
      expect(scope.rows).toEqual([
        { table_name: 'compensation', polname: 'scope_insert' },
        { table_name: 'compensation', polname: 'scope_read' },
        { table_name: 'compensation', polname: 'scope_update' },
        { table_name: 'employment', polname: 'scope_delete' },
        { table_name: 'employment', polname: 'scope_insert' },
        { table_name: 'employment', polname: 'scope_read' },
        { table_name: 'employment', polname: 'scope_update' },
        { table_name: 'person', polname: 'scope_delete' },
        { table_name: 'person', polname: 'scope_insert' },
        { table_name: 'person', polname: 'scope_read' },
        { table_name: 'person', polname: 'scope_update' },
      ]);
      expect(new Set(scope.rows.map((row) => row.table_name))).toEqual(
        new Set(['compensation', 'employment', 'person']),
      );

      // Every one of them is restrictive, so a scope name can only ever narrow
      // the tenant and module layers in front of it, and the whole catalogue
      // stays at one permissive policy per RLS table.
      const permissive = await client.query<{ table_name: string; polname: string }>(`
        select c.relname as table_name, p.polname
          from pg_policy p
          join pg_class c on c.oid = p.polrelid
         where p.polname like 'scope_%' and p.polpermissive
      `);
      expect(permissive.rows).toEqual([]);

      // The 0014 pair evaluates the write oracle for every person-child write in
      // the catalogue: three names, one per command, all spelling the predicate
      // the same way. The directory reads its own id instead, because a person row
      // carries its placement on the row itself. The two scope_delete names are
      // deliberately outside this count - they are the fourth and fifth rows of the
      // eleven above, and compensation has no delete name at all.
      const writeOracle = scope.rows.filter(
        (row) => row.polname === 'scope_insert' || row.polname === 'scope_update',
      );
      expect(writeOracle).toHaveLength(6);
      const clauses = await client.query<{ named: string }>(`
        select c.relname || '.' || p.polname || '=' ||
               coalesce('using ' || pg_get_expr(p.polqual, p.polrelid), 'no using') || '+' ||
               coalesce('check ' || pg_get_expr(p.polwithcheck, p.polrelid), 'no check') as named
          from pg_policy p
          join pg_class c on c.oid = p.polrelid
         where p.polname in ('scope_insert', 'scope_update')
         order by 1
      `);
      expect(clauses.rows.map((row) => row.named)).toEqual([
        'compensation.scope_insert=no using+check app.person_in_scope(person_id)',
        'compensation.scope_update=using app.person_in_scope(person_id)+check app.person_in_scope(person_id)',
        'employment.scope_insert=no using+check app.person_in_scope(person_id)',
        'employment.scope_update=using app.person_in_scope(person_id)+check app.person_in_scope(person_id)',
        'person.scope_insert=no using+check app.person_placement_in_scope(legal_entity_id, org_unit_id)',
        'person.scope_update=using app.person_in_scope(id)+check app.person_placement_in_scope(legal_entity_id, org_unit_id)',
      ]);
    });
  });

  test('defines every helper as owner-owned with a pinned empty search path', async () => {
    await withOwner(async (client) => {
      const functions = await client.query<{
        proname: string;
        definer: boolean;
        config: string[];
      }>(`
        select p.proname, p.prosecdef as definer, coalesce(p.proconfig, '{}'::text[]) as config
          from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'app'
           and p.proname in ('current_user_id', 'current_person_id', 'person_visible',
                             'person_in_scope', 'person_placement_in_scope',
                             'current_active_membership_id', 'member_has_scope',
                             'org_unit_is_in_scope_subtree', 'member_placement_matches')
         order by p.proname
      `);
      expect(functions.rows.map((row) => row.proname)).toEqual([
        'current_active_membership_id',
        'current_person_id',
        'current_user_id',
        'member_has_scope',
        'member_placement_matches',
        'org_unit_is_in_scope_subtree',
        'person_in_scope',
        'person_placement_in_scope',
        'person_visible',
      ]);
      // current_user_id reads only a GUC, so it is deliberately invoker.
      expect(functions.rows.every((row) => row.config.includes('search_path=""'))).toBe(true);
      expect(
        functions.rows.map((row) => `${row.proname}:${row.definer ? 'definer' : 'invoker'}`),
      ).toEqual([
        'current_active_membership_id:definer',
        'current_person_id:definer',
        'current_user_id:invoker',
        'member_has_scope:definer',
        'member_placement_matches:definer',
        'org_unit_is_in_scope_subtree:definer',
        'person_in_scope:definer',
        'person_placement_in_scope:definer',
        'person_visible:definer',
      ]);
    });
  });

  test('grants the five public helpers to the runtime role and nothing to the worker', async () => {
    await withOwner(async (client) => {
      const executable = await client.query<{ proname: string }>(`
        select p.proname
          from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'app'
           and has_function_privilege('saas_runtime', p.oid, 'EXECUTE')
         order by 1
      `);
      expect(executable.rows.map((row) => row.proname)).toEqual([
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

      const internals = await client.query<{ proname: string; runtime: boolean; worker: boolean }>(`
        select p.proname,
               has_function_privilege('saas_runtime', p.oid, 'EXECUTE') as runtime,
               has_function_privilege('saas_worker', p.oid, 'EXECUTE') as worker
          from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'app'
           and p.proname in ('current_active_membership_id', 'member_has_scope',
                             'org_unit_is_in_scope_subtree', 'member_placement_matches')
         order by 1
      `);
      expect(internals.rows).toHaveLength(4);
      expect(internals.rows.every((row) => !row.runtime && !row.worker)).toBe(true);

      const publicGrant = await client.query<{ proname: string }>(`
        select p.proname
          from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'app'
           and has_function_privilege('public', p.oid, 'EXECUTE')
           and p.proname in ('current_person_id', 'person_visible', 'person_in_scope',
                             'person_placement_in_scope', 'member_has_scope')
      `);
      expect(publicGrant.rows).toEqual([]);

      const worker = await client.query<{ n: string }>(`
        select (select count(*)::text from information_schema.role_table_grants
                 where grantee = 'saas_worker') as tables,
               (select count(*)::text from information_schema.column_privileges
                 where grantee = 'saas_worker') as columns,
               (select count(*)::text from pg_proc p
                  join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'app'
                   and has_function_privilege('saas_worker', p.oid, 'EXECUTE')) as functions
      `);
      expect(worker.rows).toEqual([{ tables: '0', columns: '0', functions: '8' }]);
    });
  });

  test('gives the runtime role no privilege on membership_scope and no person.user_id read', async () => {
    await withOwner(async (client) => {
      const scopeGrants = await client.query(
        `select 1 from information_schema.role_table_grants
          where table_name = 'membership_scope'
            and grantee in ('saas_runtime', 'saas_worker', 'saas_auth')`,
      );
      expect(scopeGrants.rows).toEqual([]);

      const privileges = await client.query<{ privilege: string; allowed: boolean }>(`
        select p as privilege,
               has_table_privilege('saas_runtime', 'public.membership_scope', p) as allowed
          from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p
         order by 1
      `);
      expect(privileges.rows.every((row) => !row.allowed)).toBe(true);

      const membershipSelect = await client.query<{ allowed: boolean }>(`
        select has_table_privilege('saas_runtime', 'public.membership', 'SELECT') as allowed
      `);
      expect(one(membershipSelect.rows).allowed).toBe(false);

      const userIdColumn = await client.query<{ allowed: boolean }>(`
        select has_column_privilege('saas_runtime', 'public.person', 'user_id', 'SELECT') as allowed
      `);
      expect(one(userIdColumn.rows).allowed).toBe(false);

      const personColumns = await client.query<{ column_name: string }>(`
        select distinct column_name
          from information_schema.column_privileges
         where grantee = 'saas_runtime' and table_name = 'person'
         order by 1
      `);
      // Distinct columns only; tests/schema-inventory.test.ts pins the exact
      // 10 SELECT + 8 INSERT + 8 UPDATE privilege inventory.
      expect(personColumns.rows.map((row) => row.column_name)).toEqual([
        'deleted_at',
        'display_name',
        'employee_code',
        'first_name',
        'id',
        'last_name',
        'legal_entity_id',
        'org_unit_id',
        'phone',
        'tenant_id',
        'work_email',
      ]);

      // The reference tables hold exactly the four columns the directory join
      // and the placement option list need, and nothing else.
      for (const [table, columns] of [
        ['legal_entity', ['code', 'deleted_at', 'id', 'name']],
        ['org_unit', ['deleted_at', 'id', 'legal_entity_id', 'name']],
      ] as const) {
        const reference = await client.query<{ column_name: string }>(`
          select distinct column_name
            from information_schema.column_privileges
           where grantee = 'saas_runtime' and table_name = $1
           order by 1
        `, [table]);
        expect(reference.rows.map((row) => row.column_name)).toEqual(columns);

        const tablePrivilege = await client.query<{ allowed: boolean }>(`
          select p as privilege,
                 has_table_privilege('saas_runtime', 'public.' || $1, p) as allowed
            from unnest(array['SELECT','INSERT','UPDATE','DELETE']) p
        `, [table]);
        expect(tablePrivilege.rows.every((row) => !row.allowed)).toBe(true);
      }
    });
  });

  test('pins the scope invariant for every runtime-readable person_id table', async () => {
    await withOwner(async (client) => {
      const readable = await client.query<{ table_name: string }>(`
        select c.relname as table_name
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public'
           and c.relkind = 'r'
           and exists (
             select 1 from information_schema.columns col
              where col.table_schema = 'public'
                and col.table_name = c.relname
                and col.column_name = 'person_id'
           )
           and (
             has_table_privilege('saas_runtime', c.oid, 'SELECT')
             or exists (
               select 1 from information_schema.column_privileges cp
                where cp.grantee = 'saas_runtime'
                  and cp.table_name = c.relname
                  and cp.privilege_type = 'SELECT'
             )
           )
         order by 1
      `);
      expect(readable.rows.length).toBeGreaterThan(0);

      const uncovered: string[] = [];
      for (const row of readable.rows) {
        const policy = await client.query<{ using_clause: string | null }>(`
          select pg_get_expr(p.polqual, p.polrelid) as using_clause
            from pg_policy p
            join pg_class c on c.oid = p.polrelid
           where c.relname = $1
             and p.polpermissive = false
             and p.polcmd = 'r'
             and pg_get_expr(p.polqual, p.polrelid) like '%app.person_visible(person_id)%'
        `, [row.table_name]);
        if (policy.rowCount !== 1) {
          uncovered.push(row.table_name);
        }
      }
      // Any new table that the runtime can read by person_id must be added to
      // the scope policies in a reviewed migration, or this list grows.
      expect(uncovered).toEqual([]);
    });
  });
});

describe('people scope read semantics', () => {
  test('keeps a tenant-wide manager with no scope rows able to read everything', async () => {
    const s = scope();
    const people = await visiblePersonIds(s.tenantA, s.managerWide);
    expect(people).toEqual(
      [
        s.personEntity1,
        s.personEntity2,
        s.personLeaf,
        s.personMid,
        s.personNull,
        s.personOfLinkedEmployee,
        s.personParent,
        s.personSibling,
      ].sort(),
    );

    const employments = await visibleEmploymentIds(s.tenantA, s.managerWide);
    expect(employments).toEqual(
      [
        s.employmentEntity1,
        s.employmentEntity2,
        s.employmentLeaf,
        s.employmentMid,
        s.employmentNull,
        s.employeeLinkedEmployment,
        s.employmentParent,
        s.employmentSibling,
      ].sort(),
    );

    // Tenant isolation still holds for a tenant-wide reader.
    const other = await visiblePersonIds(s.tenantB, s.managerWide);
    expect(other).toEqual([]);
  });

  test('restricts a legal-entity-scoped manager to that entity', async () => {
    const s = scope();
    const people = await visiblePersonIds(s.tenantA, s.managerEntity);
    expect(people).toEqual([s.personEntity1, s.personLeaf, s.personMid, s.personParent, s.personSibling].sort());
    expect(people).not.toContain(s.personEntity2);
    expect(people).not.toContain(s.personNull);

    const lookups = await withMember(s.tenantA, s.managerEntity, async (client) => {
      const out = await client.query(
        'select id from public.person where id = $1',
        [s.personEntity2],
      );
      const unplaced = await client.query(
        'select id from public.person where id = $1',
        [s.personNull],
      );
      return { out: out.rowCount, unplaced: unplaced.rowCount };
    });
    expect(lookups).toEqual({ out: 0, unplaced: 0 });

    const employments = await visibleEmploymentIds(s.tenantA, s.managerEntity);
    expect(employments).toEqual(
      [
        s.employmentEntity1,
        s.employmentLeaf,
        s.employmentMid,
        s.employmentParent,
        s.employmentSibling,
      ].sort(),
    );
    expect(employments).not.toContain(s.employmentEntity2);

    const readHelper = await helperBoolean(
      s.tenantA,
      s.managerEntity,
      'select app.person_visible($1) as allowed',
      [s.personEntity1],
    );
    expect(readHelper).toBe(true);
    const deniedHelper = await helperBoolean(
      s.tenantA,
      s.managerEntity,
      'select app.person_visible($1) as allowed',
      [s.personEntity2],
    );
    expect(deniedHelper).toBe(false);
  });

  test('restricts an org-unit-scoped manager to the unit and its descendants', async () => {
    const s = scope();
    const people = await visiblePersonIds(s.tenantA, s.managerUnit);
    expect(people).toEqual([s.personLeaf, s.personMid].sort());

    const checks = await withMember(s.tenantA, s.managerUnit, async (client) => {
      const parent = await client.query('select id from public.person where id = $1', [s.personParent]);
      const sibling = await client.query('select id from public.person where id = $1', [s.personSibling]);
      const unplaced = await client.query('select id from public.person where id = $1', [s.personNull]);
      const entityOnly = await client.query('select id from public.person where id = $1', [s.personEntity1]);
      return {
        parent: parent.rowCount,
        sibling: sibling.rowCount,
        unplaced: unplaced.rowCount,
        entityOnly: entityOnly.rowCount,
      };
    });
    expect(checks).toEqual({ parent: 0, sibling: 0, unplaced: 0, entityOnly: 0 });

    // A scope row on the parent unit is the widest org_unit scope in this
    // fixture: it then includes every unit below it and still nothing above.
    const widened = await visiblePersonIds(s.tenantA, s.managerRoot);
    expect(widened).toEqual(
      [s.personLeaf, s.personMid, s.personParent, s.personSibling].sort(),
    );
  });

  test('treats an unplaced person as visible only to a tenant-wide member', async () => {
    const s = scope();
    const wide = await helperBoolean(
      s.tenantA,
      s.managerWide,
      'select app.person_visible($1) as allowed',
      [s.personNull],
    );
    const entityScoped = await helperBoolean(
      s.tenantA,
      s.managerEntity,
      'select app.person_visible($1) as allowed',
      [s.personNull],
    );
    const unitScoped = await helperBoolean(
      s.tenantA,
      s.managerUnit,
      'select app.person_visible($1) as allowed',
      [s.personNull],
    );
    expect({ wide, entityScoped, unitScoped }).toEqual({
      wide: true,
      entityScoped: false,
      unitScoped: false,
    });
  });

  test('gives an employee exactly the linked person row and nothing else', async () => {
    const s = scope();
    const linked = await visiblePersonIds(s.tenantA, s.employeeLinked);
    expect(linked).toEqual([s.personOfLinkedEmployee]);

    const employments = await visibleEmploymentIds(s.tenantA, s.employeeLinked);
    expect(employments).toEqual([s.employeeLinkedEmployment]);

    const unlinked = await visiblePersonIds(s.tenantA, s.employeeUnlinked);
    expect(unlinked).toEqual([]);
    const unlinkedEmployment = await visibleEmploymentIds(s.tenantA, s.employeeUnlinked);
    expect(unlinkedEmployment).toEqual([]);

    // The entity scope row on this membership must not widen the read.
    const ownPlacement = await helperBoolean(
      s.tenantA,
      s.employeeLinked,
      'select app.person_visible($1) as allowed',
      [s.personEntity1],
    );
    expect(ownPlacement).toBe(false);
    const self = await helperBoolean(
      s.tenantA,
      s.employeeLinked,
      'select app.person_visible($1) as allowed',
      [s.personOfLinkedEmployee],
    );
    expect(self).toBe(true);
  });

  test('denies every person for a suspended membership or an absent membership', async () => {
    const s = scope();
    expect(await visiblePersonIds(s.tenantA, s.suspendedManager)).toEqual([]);
    expect(await visiblePersonIds(s.tenantA, s.nonMember)).toEqual([]);
    expect(await visibleEmploymentIds(s.tenantA, s.suspendedManager)).toEqual([]);

    await withOwner(async (client) => {
      const check = await client.query<{ def: string }>(`
        select pg_get_constraintdef(con.oid) as def
          from pg_constraint con
          join pg_class c on c.oid = con.conrelid
         where c.relname = 'membership' and con.contype = 'c'
           and pg_get_constraintdef(con.oid) like '%role%'
      `);
      // An unrecognised role cannot exist, so the helper's unknown-role guard is
      // only reachable through an absent membership; the CHECK is what pins that.
      expect(one(check.rows).def).toContain("'employee'");
      expect(one(check.rows).def).toContain("'owner'");
    });
  });

  test('keeps scope rows from reaching across tenants', async () => {
    const s = scope();
    // A's entity-scoped manager asking for B's person by id.
    expect(
      await helperBoolean(s.tenantA, s.managerEntity, 'select app.person_visible($1) as allowed', [
        s.personEntityB,
      ]),
    ).toBe(false);
    const crossLookups = await withMember(s.tenantA, s.managerEntity, async (client) => {
      const b = await client.query('select id from public.person where id = $1', [s.personEntityB]);
      return b.rowCount;
    });
    expect(crossLookups).toBe(0);

    // A's manager user inside tenant B, where they have no membership at all.
    expect(await visiblePersonIds(s.tenantB, s.managerEntity)).toEqual([]);
    expect(await visibleEmploymentIds(s.tenantB, s.managerEntity)).toEqual([]);
    expect(await visiblePersonIds(s.tenantB, s.employeeLinked)).toEqual([]);
  });

  test('pins the documented fail-open for a tenant-only system context', async () => {
    const s = scope();
    const people = await visiblePersonIds(s.tenantA, null);
    expect(people).toEqual(
      [
        s.personEntity1,
        s.personEntity2,
        s.personLeaf,
        s.personMid,
        s.personNull,
        s.personOfLinkedEmployee,
        s.personParent,
        s.personSibling,
      ].sort(),
    );
    expect(await visibleEmploymentIds(s.tenantA, null)).toContain(s.employmentEntity2);

    // Tenant isolation is not part of the residual: no user and no tenant is
    // still no rows, and another tenant stays unreachable.
    expect(await visiblePersonIds(s.tenantB, null)).toEqual(
      [s.personEntityB, s.personNullB].sort(),
    );
    const noContext = await visiblePersonIds(null, null);
    expect(noContext).toEqual([]);

    // The module policy still applies on the system path: this tenant has no
    // people entitlement, so its directory rows read but its employment does
    // not.
    const unentitled = await withSystem(s.tenantNoEntitlement, async (client) => {
      const people = await client.query<{ id: string }>('select id from public.person');
      const employment = await client.query<{ id: string }>('select id from public.employment');
      return {
        people: people.rows.map((row) => row.id),
        employment: employment.rows.map((row) => row.id),
      };
    });
    expect(unentitled).toEqual({ people: [s.personNoEnt], employment: [] });
  });
});

describe('people scope write semantics', () => {
  test('moves a scoped manager past in-scope employment rows and stops at the boundary', async () => {
    const s = scope();
    const inScope = await withMember(s.tenantA, s.managerEntity, async (client) => {
      const result = await client.query(
        `update public.employment set start_date = start_date
          where person_id = $1`,
        [s.personEntity1],
      );
      return result.rowCount;
    });
    expect(inScope).toBe(1);

    const outScope = await withMember(s.tenantA, s.managerEntity, async (client) => {
      const result = await client.query(
        `update public.employment set start_date = start_date
          where person_id = $1`,
        [s.personEntity2],
      );
      return result.rowCount;
    });
    expect(outScope).toBe(0);

    const deleteOut = await withMember(s.tenantA, s.managerEntity, async (client) => {
      const result = await client.query('delete from public.employment where person_id = $1', [
        s.personEntity2,
      ]);
      return result.rowCount;
    });
    expect(deleteOut).toBe(0);

    const deleteIn = await withMember(s.tenantA, s.managerEntity, async (client) => {
      const result = await client.query('delete from public.employment where person_id = $1', [
        s.personEntity1,
      ]);
      return result.rowCount;
    });
    expect(deleteIn).toBe(1);
  });

  test('refuses an out-of-scope employment insert on the RLS policy, not a privilege', async () => {
    const s = scope();
    const error = await expectError(
      s.tenantA,
      s.managerEntity,
      `insert into employment (tenant_id, person_id, legal_entity_id, employment_type, start_date)
       values ($1, $2, $3, 'full_time', '2024-01-01')`,
      [s.tenantA, s.personEntity2, s.entity2],
    );
    expect(error.code).toBe('42501');
    expect(error.message).toContain('row-level security');
    expect(error.message).toContain('employment');

    const success = await withMember(s.tenantA, s.managerEntity, async (client) => {
      const result = await client.query(
        `insert into employment (tenant_id, person_id, legal_entity_id, employment_type, start_date)
         values ($1, $2, $3, 'full_time', '2024-01-01')
         returning id`,
        [s.tenantA, s.personMid, s.entity1],
      );
      return result.rowCount;
    });
    expect(success).toBe(1);
  });

  test('lets an employee read but never write through SQL scope, even for their own row', async () => {
    const s = scope();
    const update = await withMember(s.tenantA, s.employeeLinked, async (client) => {
      const result = await client.query(
        `update public.employment set start_date = start_date where id = $1`,
        [s.employeeLinkedEmployment],
      );
      return result.rowCount;
    });
    expect(update).toBe(0);

    const remove = await withMember(s.tenantA, s.employeeLinked, async (client) => {
      const result = await client.query('delete from public.employment where id = $1', [
        s.employeeLinkedEmployment,
      ]);
      return result.rowCount;
    });
    expect(remove).toBe(0);

    expect(
      await helperBoolean(s.tenantA, s.employeeLinked, 'select app.person_in_scope($1) as allowed', [
        s.personOfLinkedEmployee,
      ]),
    ).toBe(false);
    expect(
      await helperBoolean(
        s.tenantA,
        s.employeeLinked,
        'select app.person_placement_in_scope($1, $2) as allowed',
        [s.entity1, null],
      ),
    ).toBe(false);
  });

  test('pins the person write policies against the identity and placement column grants', async () => {
    const s = scope();
    // T19 gives the runtime role column-level INSERT and UPDATE on the person
    // identity columns; T20 extends UPDATE to the two placement columns.
    // Table-level DML is still refused, so the write boundary here is RLS, not
    // a grant: the 42501 below names the scope_insert policy rather than
    // "permission denied for table person".
    const privileges = await withOwner(async (client) => {
      const result = await client.query<{ privilege: string; allowed: boolean }>(`
        select p as privilege,
               has_table_privilege('saas_runtime', 'public.person', p) as allowed
          from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p
         order by 1
      `);
      return result.rows;
    });
    expect(privileges).toEqual([
      { privilege: 'DELETE', allowed: false },
      { privilege: 'INSERT', allowed: false },
      { privilege: 'SELECT', allowed: false },
      { privilege: 'UPDATE', allowed: false },
    ]);

    const denied = await expectError(
      s.tenantA,
      s.managerEntity,
      `insert into person (id, tenant_id, first_name, display_name)
       values (gen_random_uuid(), $1, 'Denied', 'Out Of Scope Insert')`,
      [s.tenantA],
    );
    expect(denied.code).toBe('42501');
    expect(denied.message).toContain('row-level security');
    expect(denied.message).toContain('scope_insert');

    // A tenant-wide member may create an unplaced person; that is the database
    // behaviour the People create route depends on. The id is supplied by the
    // caller and the insert carries no RETURNING, because the restrictive
    // scope_read policy cannot observe a row created by the same command; the
    // row is readable by the next statement in the same transaction (ADR 0008).
    const newPersonId = '7f0d1c2e-4b5a-4c6d-9e8f-1a2b3c4d5e6f';
    const created = await withMember(s.tenantA, s.managerWide, async (client) => {
      await client.query(
        `insert into person (id, tenant_id, first_name, display_name)
         values ($1, $2, 'Placed Later', 'Wide Create')`,
        [newPersonId, s.tenantA],
      );
      const readBack = await client.query<{ display_name: string }>(
        'select display_name from person where id = $1',
        [newPersonId],
      );
      return one(readBack.rows).display_name;
    });
    expect(created).toBe('Wide Create');

    // Placement is now real runtime DML: the UPDATE grant reaches
    // legal_entity_id and org_unit_id, so an in-scope move writes and an
    // out-of-scope move is refused by the policy, not by the grant. The
    // statement carries no RETURNING for the same reason as the insert above
    // (ADR 0008); the row is read by the next statement in the transaction.
    const movedByWide = await withMember(s.tenantA, s.managerWide, async (client) => {
      const updated = await client.query(
        `update person set legal_entity_id = $1, org_unit_id = $2
          where id = $3 and deleted_at is null`,
        [s.entity2, s.unitSibling, s.personEntity1],
      );
      const readBack = await client.query<{
        legal_entity_id: string;
        org_unit_id: string;
      }>(
        `select legal_entity_id, org_unit_id from person where id = $1`,
        [s.personEntity1],
      );
      return { rowCount: updated.rowCount, placement: one(readBack.rows) };
    });
    expect(movedByWide).toEqual({
      rowCount: 1,
      placement: { legal_entity_id: s.entity2, org_unit_id: s.unitSibling },
    });

    // The same statement from an entity-scoped member inside their entity
    // succeeds, and moving that row to another entity is refused with the
    // policy named - the grant covers the column, the policy decides the row.
    const movedByScoped = await withMember(s.tenantA, s.managerEntity, async (client) => {
      const updated = await client.query(
        `update person set legal_entity_id = $1, org_unit_id = $2
          where id = $3 and deleted_at is null`,
        [s.entity1, s.unitMid, s.personEntity1],
      );
      return updated.rowCount;
    });
    expect(movedByScoped).toBe(1);

    const movedOutOfScope = await expectError(
      s.tenantA,
      s.managerEntity,
      `update person set legal_entity_id = $1, org_unit_id = $2
        where id = $3 and deleted_at is null`,
      [s.entity2, null, s.personEntity1],
    );
    expect(movedOutOfScope.code).toBe('42501');
    expect(movedOutOfScope.message).toContain('row-level security');
    expect(movedOutOfScope.message).toContain('scope_update');

    // An org-unit-scoped member can move a person within their subtree but not
    // onto the bare legal entity: a null unit never matches an org_unit scope.
    const movedToUnit = await withMember(s.tenantA, s.managerUnit, async (client) => {
      const updated = await client.query(
        `update person set legal_entity_id = $1, org_unit_id = $2
          where id = $3 and deleted_at is null`,
        [s.entity1, s.unitMid, s.personLeaf],
      );
      return updated.rowCount;
    });
    expect(movedToUnit).toBe(1);

    const movedToEntityOnly = await expectError(
      s.tenantA,
      s.managerUnit,
      `update person set legal_entity_id = $1, org_unit_id = $2
        where id = $3 and deleted_at is null`,
      [s.entity1, null, s.personLeaf],
    );
    expect(movedToEntityOnly.code).toBe('42501');
    expect(movedToEntityOnly.message).toContain('scope_update');

    const placement = await helperBoolean(
      s.tenantA,
      s.managerEntity,
      'select app.person_placement_in_scope($1, $2) as allowed',
      [s.entity2, null],
    );
    expect(placement).toBe(false);
    const inPlacement = await helperBoolean(
      s.tenantA,
      s.managerEntity,
      'select app.person_placement_in_scope($1, $2) as allowed',
      [s.entity1, null],
    );
    expect(inPlacement).toBe(true);
    const unplacedByScoped = await helperBoolean(
      s.tenantA,
      s.managerEntity,
      'select app.person_placement_in_scope($1, $2) as allowed',
      [null, null],
    );
    expect(unplacedByScoped).toBe(false);
    const unplacedByWide = await helperBoolean(
      s.tenantA,
      s.managerWide,
      'select app.person_placement_in_scope($1, $2) as allowed',
      [null, null],
    );
    expect(unplacedByWide).toBe(true);
  });
});

describe('people scope in the member gate path', () => {
  test('applies scope after entitlement and role, and denies a role without people.read first', async () => {
    const s = scope();

    const scoped = await withMemberTransaction(
      runtimePool(),
      { tenantId: s.tenantA, userId: s.managerEntity, gate: { module: 'people', operation: 'read' } },
      async (client) => {
        const result = await client.query<{ id: string }>('select id from public.person order by id');
        return result.rows.map((row) => row.id);
      },
    );
    expect(scoped).toEqual(
      [
        s.personEntity1,
        s.personLeaf,
        s.personMid,
        s.personParent,
        s.personSibling,
      ].sort(),
    );

    // Employee holds a people entitlement and a scope row, but no people.read
    // permission: the role gate denies before any scope expression is evaluated.
    let denial: { code?: string } | undefined;
    try {
      await withMemberTransaction(
        runtimePool(),
        {
          tenantId: s.tenantA,
          userId: s.employeeLinked,
          gate: { module: 'people', operation: 'read' },
        },
        async (client) => client.query('select id from public.person'),
      );
    } catch (caught) {
      denial = caught as { code?: string };
    }
    expect(denial?.code).toBe('ROLE_DENIED');

    // A non-member never reaches the gate at all.
    let membershipDenial: { code?: string } | undefined;
    try {
      await withMemberTransaction(
        runtimePool(),
        { tenantId: s.tenantA, userId: s.nonMember, gate: { module: 'people', operation: 'read' } },
        async (client) => client.query('select id from public.person'),
      );
    } catch (caught) {
      membershipDenial = caught as { code?: string };
    }
    expect(membershipDenial?.code).toBe('MEMBERSHIP_DENIED');
  });
});
