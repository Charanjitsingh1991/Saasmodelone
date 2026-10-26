import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@saasmodels/testkit';
import {
  collectDrillMetrics,
  compareDrillMetrics,
  type DrillMetrics,
} from '../scripts/restore-drill.js';

let database: TestDatabase | undefined;

function db(): TestDatabase {
  if (!database) {
    throw new Error('Test database has not been created');
  }
  return database;
}

async function collect(): Promise<DrillMetrics> {
  return collectDrillMetrics({
    databaseName: db().name,
    ownerUrl: db().ownerUrl,
    runtimeUrl: db().runtimeUrl,
  });
}

beforeAll(async () => {
  database = await createTestDatabase({ migrate: true, seed: true });
});

afterAll(async () => {
  await database?.drop();
});

describe('restore drill verification', () => {
  test('compares real metrics and fails loudly when one row count diverges', async () => {
    const source = await collect();
    const sameAsRestored = await collect();

    const identical = compareDrillMetrics(source, sameAsRestored);
    expect(identical.ok).toBe(true);
    expect(identical.differences).toEqual([]);
    expect(identical.source.publicTableCount).toBeGreaterThan(60);
    expect(identical.restored.runtimeTableGrants).toContain('employment:SELECT');
    // The person read surface is the eight identity and lifecycle columns the
    // directory already needed plus the two placement columns it joins on.
    expect(identical.restored.runtimePersonColumnGrants).toEqual([
      'deleted_at',
      'display_name',
      'employee_code',
      'first_name',
      'id',
      'last_name',
      'legal_entity_id',
      'org_unit_id',
      'phone',
      'work_email',
    ]);
    expect(identical.restored.runtimeSampleCounts).toEqual({
      employment: 0,
      project: 0,
      person: 0,
    });

    const client = new Client({ connectionString: db().ownerUrl });
    await client.connect();
    try {
      await client.query(
        `insert into tenant (name, slug, data_region)
         values ('Drill Mutated Tenant', 'drill-mutated-tenant', 'local')`,
      );
    } finally {
      await client.end();
    }

    const mutated = await collect();
    const drifted = compareDrillMetrics(source, mutated);
    expect(drifted.ok).toBe(false);
    expect(drifted.differences).toEqual([
      'rowCountByTable.tenant: source=0 restored=1',
    ]);
  });
});
