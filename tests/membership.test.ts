import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  createRuntimePool,
  withMemberTransaction,
  type RuntimePool,
} from '@saasmodels/db';
import { createTestDatabase, type TestDatabase } from '@saasmodels/testkit';
import {
  createAccessFixtures,
  type AccessFixtures,
} from './support/access-fixtures.js';

let database: TestDatabase | undefined;
let fixtures: AccessFixtures | undefined;
let pool: RuntimePool | undefined;

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
  if (!pool) {
    throw new Error('Runtime pool has not been created');
  }
  return pool;
}

async function ownerClient(): Promise<Client> {
  const client = new Client({ connectionString: db().ownerUrl });
  await client.connect();
  return client;
}

async function withRuntimeSettings<T>(
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

async function memberRole(
  tenantId: string | null,
  userId: string | null,
): Promise<string | null> {
  return withRuntimeSettings(tenantId, userId, async (client) => {
    const result = await client.query<{ role: string | null }>(
      'select app.current_member_role() as role',
    );
    return result.rows[0]?.role ?? null;
  });
}

type PgError = { code?: string; message: string };

async function denied(
  tenantId: string | null,
  sql: string,
  params: unknown[] = [],
): Promise<PgError> {
  return withRuntimeSettings(tenantId, null, async (client) => {
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

beforeAll(async () => {
  database = await createTestDatabase({ migrate: true, seed: true });
  pool = createRuntimePool(database.runtimeUrl);

  const owner = await ownerClient();
  try {
    fixtures = await createAccessFixtures(owner);
  } finally {
    await owner.end();
  }
});

afterAll(async () => {
  await pool?.end();
  await database?.drop();
});

describe('app.current_member_role', () => {
  test('resolves the active membership role for the current tenant and user', async () => {
    const a = fx().a;
    const b = fx().b;
    const c = fx().cancelled;

    expect(await memberRole(a.tenantId, a.userId)).toBe('owner');
    expect(await memberRole(b.tenantId, b.userId)).toBe('admin');
    expect(await memberRole(c.tenantId, c.userId)).toBe('employee');
  });

  test('returns null for no membership, a suspended membership and a cross-tenant user', async () => {
    const a = fx().a;

    expect(await memberRole(a.tenantId, fx().nonMemberUserId)).toBeNull();
    expect(await memberRole(a.tenantId, fx().suspendedMemberUserId)).toBeNull();
    expect(await memberRole(fx().b.tenantId, a.userId)).toBeNull();
    expect(await memberRole(a.tenantId, randomUUID())).toBeNull();
    expect(await memberRole(null, a.userId)).toBeNull();
    expect(await memberRole(a.tenantId, null)).toBeNull();
  });

  test('does not check platform access: a member of a suspended or deleted tenant still resolves', async () => {
    expect(await memberRole(fx().suspended.tenantId, fx().suspended.userId)).toBe('owner');
    expect(await memberRole(fx().closed.tenantId, fx().closed.userId)).toBe('owner');
    expect(await memberRole(fx().deleted.tenantId, fx().deleted.userId)).toBe('owner');
  });
});

describe('withMemberTransaction', () => {
  test('passes the role to the callback and sets both transaction-local settings', async () => {
    const a = fx().a;

    const observed = await withMemberTransaction(
      runtimePool(),
      { tenantId: a.tenantId, userId: a.userId },
      async (client, member) => {
        const settings = await client.query<{ tenant_id: string; user_id: string }>(
          `select current_setting('app.tenant_id', true) as tenant_id,
                  current_setting('app.user_id', true) as user_id`,
        );
        return {
          member,
          tenantId: settings.rows[0]?.tenant_id,
          userId: settings.rows[0]?.user_id,
        };
      },
    );

    expect(observed).toEqual({
      member: { role: 'owner' },
      tenantId: a.tenantId,
      userId: a.userId,
    });
  });

  test('sequential users through one pool do not leak app.user_id or role', async () => {
    const a = fx().a;
    const b = fx().b;

    for (const fixture of [a, b, a]) {
      const observed = await withMemberTransaction(
        runtimePool(),
        { tenantId: fixture.tenantId, userId: fixture.userId },
        async (client, member) => {
          const settings = await client.query<{ user_id: string }>(
            "select current_setting('app.user_id', true) as user_id",
          );
          return { userId: settings.rows[0]?.user_id, role: member.role };
        },
      );
      expect(observed).toEqual({ userId: fixture.userId, role: fixture.role });
    }
  });

  test('rejects malformed tenant and user ids before connecting a callback', async () => {
    const a = fx().a;
    let ran = false;

    await expect(
      withMemberTransaction(
        runtimePool(),
        { tenantId: 'not-a-uuid', userId: a.userId },
        async () => {
          ran = true;
          return 'not reached';
        },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_TENANT_CONTEXT' });

    await expect(
      withMemberTransaction(
        runtimePool(),
        { tenantId: a.tenantId, userId: 'not-a-uuid' },
        async () => {
          ran = true;
          return 'not reached';
        },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_TENANT_CONTEXT' });

    expect(ran).toBe(false);
  });

  test('denies a non-member and a suspended member before the callback', async () => {
    const a = fx().a;

    for (const userId of [fx().nonMemberUserId, fx().suspendedMemberUserId]) {
      let ran = false;
      await expect(
        withMemberTransaction(
          runtimePool(),
          { tenantId: a.tenantId, userId },
          async () => {
            ran = true;
            return 'not reached';
          },
        ),
      ).rejects.toMatchObject({ code: 'MEMBERSHIP_DENIED' });
      expect(ran).toBe(false);
    }
  });

  test('a member of a suspended tenant passes membership and fails platform access', async () => {
    const suspended = fx().suspended;

    await expect(
      withMemberTransaction(
        runtimePool(),
        { tenantId: suspended.tenantId, userId: suspended.userId },
        async () => 'not reached',
      ),
    ).rejects.toMatchObject({ code: 'PLATFORM_ACCESS_DENIED' });
  });

  test('an unknown stored role is a data-integrity error, never a permissive default', async () => {
    const owner = await ownerClient();
    let forgedUserId: string;
    try {
      await owner.query('begin');
      await owner.query('alter table membership drop constraint membership_role_check');
      const user = await owner.query<{ id: string }>(
        `insert into app_user (email, display_name, status)
         values ($1, 'Forged role user', 'active')
         returning id`,
        [`forged_${randomUUID()}@example.test`],
      );
      const row = user.rows[0];
      if (!row) {
        throw new Error('Could not create the forged-role user');
      }
      forgedUserId = row.id;
      await owner.query(
        `insert into membership (tenant_id, user_id, role, status)
         values ($1, $2, 'superuser', 'active')`,
        [fx().a.tenantId, forgedUserId],
      );
      await owner.query('commit');
    } finally {
      await owner.end();
    }

    await expect(
      withMemberTransaction(
        runtimePool(),
        { tenantId: fx().a.tenantId, userId: forgedUserId },
        async () => 'not reached',
      ),
    ).rejects.toMatchObject({ code: 'INVALID_MEMBERSHIP_ROLE' });
  });
});

describe('runtime role membership and tenant privileges', () => {
  test('cannot read or write membership directly', async () => {
    const a = fx().a;

    const reads = await denied(a.tenantId, 'select * from membership');
    expect(reads.code).toBe('42501');

    const inserts = await denied(
      a.tenantId,
      `insert into membership (tenant_id, user_id, role, status)
       values ($1, $2, 'employee', 'active')`,
      [a.tenantId, randomUUID()],
    );
    expect(inserts.code).toBe('42501');

    const updates = await denied(
      a.tenantId,
      "update membership set role = 'owner' where tenant_id = $1",
      [a.tenantId],
    );
    expect(updates.code).toBe('42501');

    const deletes = await denied(a.tenantId, 'delete from membership where tenant_id = $1', [
      a.tenantId,
    ]);
    expect(deletes.code).toBe('42501');
  });

  test('cannot read, insert or update tenants, including is_internal', async () => {
    const a = fx().a;

    expect((await denied(a.tenantId, 'select * from tenant')).code).toBe('42501');

    const inserted = await denied(
      a.tenantId,
      `insert into tenant (name, slug, data_region)
       values ('Runtime tenant', $1, 'test')`,
      [`runtime-${randomUUID()}`],
    );
    expect(inserted.code).toBe('42501');

    const updated = await denied(
      a.tenantId,
      'update tenant set is_internal = true where id = $1',
      [a.tenantId],
    );
    expect(updated.code).toBe('42501');
  });
});
