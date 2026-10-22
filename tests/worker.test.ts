import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createRuntimePool } from '@saasmodels/db';
import { runTenantJob } from '@saasmodels/worker';
import { createTestDatabase, type TestDatabase } from '@saasmodels/testkit';
import {
  createAccessFixtures,
  type AccessFixtures,
} from './support/access-fixtures.js';

let database: TestDatabase | undefined;
let fixtures: AccessFixtures | undefined;
let pool: ReturnType<typeof createRuntimePool> | undefined;

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

function runtimePool(): ReturnType<typeof createRuntimePool> {
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

describe('worker tenant jobs', () => {
  test('an entitled People read job sees only its own employment row', async () => {
    const a = fx().a;

    const ids = await runTenantJob(runtimePool(), {
      tenantId: a.tenantId,
      gate: { module: 'people', operation: 'read' },
      run: async (client) => {
        const result = await client.query<{ id: string }>(
          'select id from employment order by id',
        );
        return result.rows.map((row) => row.id);
      },
    });

    expect(ids).toEqual([a.employmentId]);
  });

  test('an unentitled module fails before the callback runs', async () => {
    const a = fx().a;
    let ran = false;

    await expect(
      runTenantJob(runtimePool(), {
        tenantId: a.tenantId,
        gate: { module: 'work', operation: 'read' },
        run: async () => {
          ran = true;
          return 'not reached';
        },
      }),
    ).rejects.toMatchObject({
      code: 'MODULE_NOT_ENTITLED',
      module: 'work',
      operation: 'read',
    });
    expect(ran).toBe(false);
  });

  test('a suspended tenant fails platform access before the callback runs', async () => {
    const suspended = fx().suspended;
    let ran = false;

    await expect(
      runTenantJob(runtimePool(), {
        tenantId: suspended.tenantId,
        gate: { module: 'people', operation: 'read' },
        run: async () => {
          ran = true;
          return 'not reached';
        },
      }),
    ).rejects.toMatchObject({ code: 'PLATFORM_ACCESS_DENIED' });
    expect(ran).toBe(false);
  });

  test('a cancelled tenant can read but cannot write', async () => {
    const cancelled = fx().cancelled;

    const result = await runTenantJob(runtimePool(), {
      tenantId: cancelled.tenantId,
      gate: { module: 'people', operation: 'read' },
      run: async (client) => {
        const rows = await client.query<{ id: string }>('select id from employment');
        return rows.rows.map((row) => row.id);
      },
    });
    expect(result).toEqual([cancelled.employmentId]);

    let ran = false;
    await expect(
      runTenantJob(runtimePool(), {
        tenantId: cancelled.tenantId,
        gate: { module: 'people', operation: 'write' },
        run: async () => {
          ran = true;
          return 'not reached';
        },
      }),
    ).rejects.toMatchObject({
      code: 'MODULE_NOT_ENTITLED',
      module: 'people',
      operation: 'write',
    });
    expect(ran).toBe(false);
  });

  test('a callback error rolls the transaction back', async () => {
    const a = fx().a;
    const employmentId = randomUUID();
    let ran = false;

    await expect(
      runTenantJob(runtimePool(), {
        tenantId: a.tenantId,
        gate: { module: 'people', operation: 'write' },
        run: async (client) => {
          ran = true;
          await client.query(
            `insert into employment
               (id, tenant_id, person_id, legal_entity_id, employment_type, start_date)
             values ($1, $2, $3, $4, 'full_time', '2025-02-01')`,
            [employmentId, a.tenantId, a.personId, a.legalEntityId],
          );
          throw new Error('intentional rollback');
        },
      }),
    ).rejects.toThrow('intentional rollback');
    expect(ran).toBe(true);

    const owner = await ownerClient();
    try {
      const persisted = await owner.query('select id from employment where id = $1', [
        employmentId,
      ]);
      expect(persisted.rowCount).toBe(0);
    } finally {
      await owner.end();
    }
  });

  test('a platform job without a module gate runs for an active tenant', async () => {
    const a = fx().a;

    const context = await runTenantJob(runtimePool(), {
      tenantId: a.tenantId,
      run: async (client) => {
        const setting = await client.query<{
          tenant_id: string;
          application_name: string;
        }>(
          "select current_setting('app.tenant_id', true) as tenant_id, current_setting('application_name') as application_name",
        );
        const rows = await client.query<{ id: string }>(
          'select id from employment order by id',
        );
        return {
          setting: setting.rows[0]?.tenant_id,
          applicationName: setting.rows[0]?.application_name,
          employment: rows.rows.map((row) => row.id),
        };
      },
    });

    expect(context).toEqual({
      setting: a.tenantId,
      applicationName: 'saasmodels-runtime',
      employment: [a.employmentId],
    });
  });
});
