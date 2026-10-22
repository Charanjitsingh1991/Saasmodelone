import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@saasmodels/testkit';

const DAY_MS = 24 * 60 * 60 * 1000;

let database: TestDatabase | undefined;
let fixtures: Fixtures | undefined;

function db(): TestDatabase {
  if (!database) {
    throw new Error('Test database has not been created');
  }
  return database;
}

function fx(): Fixtures {
  if (!fixtures) {
    throw new Error('Fixtures have not been created');
  }
  return fixtures;
}

function one<T>(rows: T[]): T {
  const row = rows[0];
  if (!row) {
    throw new Error('Expected one row');
  }
  return row;
}

async function ownerClient(): Promise<Client> {
  const client = new Client({ connectionString: db().ownerUrl });
  await client.connect();
  return client;
}

async function runtimeClient(): Promise<Client> {
  const client = new Client({ connectionString: db().runtimeUrl });
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

async function withRuntime<T>(
  tenantId: string | null,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = await runtimeClient();
  try {
    await client.query('begin');
    if (tenantId) {
      await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
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

type PgError = { code?: string; message: string };

async function denied(
  tenantId: string | null,
  sql: string,
  params: unknown[] = [],
): Promise<PgError> {
  return withRuntime(tenantId, async (client) => {
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

type TenantOptions = { status?: string; deleted?: boolean; internal?: boolean };

type EmploymentFixture = {
  tenantId: string;
  personId: string;
  legalEntityId: string;
  employmentId: string;
};

type TenancyFixture = EmploymentFixture & {
  clientId: string;
  projectId: string;
  projectName: string;
};

type Fixtures = {
  a: TenancyFixture;
  b: TenancyFixture;
  suspended: EmploymentFixture;
  closed: EmploymentFixture;
  deleted: EmploymentFixture;
  cancelled: EmploymentFixture;
  originalProjectName: string;
};

function suffix(): string {
  return randomBytes(4).toString('hex');
}

async function insertJurisdiction(client: Client): Promise<string> {
  const result = await client.query<{ id: string }>(
    `insert into jurisdiction
       (code, country_code, name, default_currency, default_timezone)
     values ('ZZ', 'ZZ', 'Synthetic test jurisdiction', 'ZZZ', 'UTC')
     returning id`,
  );
  return one(result.rows).id;
}

async function insertTenant(
  client: Client,
  label: string,
  options: TenantOptions = {},
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `insert into tenant (name, slug, data_region, status, deleted_at, is_internal)
     values ($1, $2, 'test', $3, $4, $5)
     returning id`,
    [
      `RLS ${label}`,
      `rls_${label}_${suffix()}`,
      options.status ?? 'active',
      options.deleted ? new Date() : null,
      options.internal ?? false,
    ],
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
    [tenantId, `Legal ${label}`, `le_${label}_${suffix()}`, jurisdictionId],
  );
  return one(result.rows).id;
}

async function insertPerson(client: Client, tenantId: string, label: string): Promise<string> {
  const result = await client.query<{ id: string }>(
    `insert into person (tenant_id, first_name, display_name, work_email)
     values ($1, 'Ada', $2, $3)
     returning id`,
    [tenantId, `Person ${label}`, `${label}_${suffix()}@example.test`],
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
    `insert into employment (tenant_id, person_id, legal_entity_id, employment_type, start_date)
     values ($1, $2, $3, 'full_time', '2024-01-01')
     returning id`,
    [tenantId, personId, legalEntityId],
  );
  return one(result.rows).id;
}

async function insertClientRecord(
  client: Client,
  tenantId: string,
  label: string,
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `insert into client (tenant_id, name, code, currency)
     values ($1, $2, $3, 'ZZZ')
     returning id`,
    [tenantId, `Client ${label}`, `cl_${label}_${suffix()}`],
  );
  return one(result.rows).id;
}

async function insertProject(
  client: Client,
  tenantId: string,
  clientId: string,
  projectName: string,
  label: string,
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `insert into project (tenant_id, client_id, name, code, currency)
     values ($1, $2, $3, $4, 'ZZZ')
     returning id`,
    [tenantId, clientId, projectName, `pr_${label}_${suffix()}`],
  );
  return one(result.rows).id;
}

async function grantModule(
  client: Client,
  tenantId: string,
  code: string,
  options: { status?: string; readUntil?: Date; source?: string } = {},
): Promise<void> {
  await client.query(
    `insert into module_entitlement
       (tenant_id, module_id, status, source, starts_at, ends_at, read_until)
     values ($1, (select id from platform_module where code = $2), $3, $4,
             now() - interval '1 day', null, $5)`,
    [
      tenantId,
      code,
      options.status ?? 'active',
      options.source ?? 'contract',
      options.readUntil ?? null,
    ],
  );
}

async function createEmploymentFixture(
  client: Client,
  jurisdictionId: string,
  label: string,
  options: TenantOptions = {},
): Promise<EmploymentFixture> {
  const tenantId = await insertTenant(client, label, options);
  const legalEntityId = await insertLegalEntity(client, tenantId, label, jurisdictionId);
  const personId = await insertPerson(client, tenantId, label);
  const employmentId = await insertEmployment(client, tenantId, personId, legalEntityId);
  return { tenantId, personId, legalEntityId, employmentId };
}

async function createTenancyFixture(
  client: Client,
  jurisdictionId: string,
  label: string,
  options: TenantOptions = {},
): Promise<TenancyFixture> {
  const base = await createEmploymentFixture(client, jurisdictionId, label, options);
  const clientId = await insertClientRecord(client, base.tenantId, label);
  const projectName = `${label} original project`;
  const projectId = await insertProject(client, base.tenantId, clientId, projectName, label);
  return { ...base, clientId, projectId, projectName };
}

beforeAll(async () => {
  database = await createTestDatabase({ migrate: true, seed: true });
  fixtures = await withOwner(async (client) => {
    const jurisdictionId = await insertJurisdiction(client);

    const a = await createTenancyFixture(client, jurisdictionId, 'a');
    // Work is catalog status 'planned', so only an internal tenant may hold it,
    // and its entitlement must carry an internal source.
    const b = await createTenancyFixture(client, jurisdictionId, 'b', { internal: true });
    await grantModule(client, a.tenantId, 'people');
    await grantModule(client, b.tenantId, 'work', { source: 'internal' });

    const suspended = await createEmploymentFixture(client, jurisdictionId, 's', {
      status: 'suspended',
    });
    await grantModule(client, suspended.tenantId, 'people');

    const closed = await createEmploymentFixture(client, jurisdictionId, 'l', {
      status: 'closed',
    });
    await grantModule(client, closed.tenantId, 'people');

    const deleted = await createEmploymentFixture(client, jurisdictionId, 'd', {
      deleted: true,
    });
    await grantModule(client, deleted.tenantId, 'people');

    const cancelled = await createEmploymentFixture(client, jurisdictionId, 'c');
    await grantModule(client, cancelled.tenantId, 'people', {
      status: 'cancelled',
      readUntil: new Date(Date.now() + 30 * DAY_MS),
    });

    return {
      a,
      b,
      suspended,
      closed,
      deleted,
      cancelled,
      originalProjectName: a.projectName,
    };
  });
});

afterAll(async () => {
  await database?.drop();
});

describe('module RLS on employment and project', () => {
  test('tenant A reads only its own employment row', async () => {
    const rows = await withRuntime(fx().a.tenantId, async (client) => {
      const result = await client.query<{ id: string }>('select id from employment order by id');
      return result.rows;
    });

    expect(rows.map((row) => row.id)).toEqual([fx().a.employmentId]);
  });

  test('tenant A cannot read any project row', async () => {
    const rows = await withRuntime(fx().a.tenantId, async (client) => {
      const result = await client.query<{ id: string }>('select id from project order by id');
      return result.rows;
    });

    expect(rows).toEqual([]);
  });

  test('tenant A insert into project is denied by row-level security, not table privilege', async () => {
    const error = await denied(
      fx().a.tenantId,
      `insert into project (tenant_id, client_id, name, currency)
       values ($1, $2, 'Denied project', 'ZZZ')`,
      [fx().a.tenantId, fx().a.clientId],
    );

    expect(error.code).toBe('42501');
    expect(error.message).toMatch(/row-level security/);
    expect(error.message).not.toMatch(/permission denied for table project/);
  });

  test('tenant A update and delete of its project row affect zero rows', async () => {
    const outcome = await withRuntime(fx().a.tenantId, async (client) => {
      const updated = await client.query("update project set name = 'Hijacked' where id = $1", [
        fx().a.projectId,
      ]);
      const deleted = await client.query('delete from project where id = $1', [fx().a.projectId]);
      return { updated: updated.rowCount, deleted: deleted.rowCount };
    });

    expect(outcome).toEqual({ updated: 0, deleted: 0 });

    const name = await withOwner(async (client) => {
      const row = await client.query<{ name: string }>('select name from project where id = $1', [
        fx().a.projectId,
      ]);
      return row.rows[0]?.name;
    });
    expect(name).toBe(fx().originalProjectName);
  });

  test('tenant A can insert, update and delete its own employment row', async () => {
    const outcome = await withRuntime(fx().a.tenantId, async (client) => {
      const inserted = await client.query<{ id: string }>(
        `insert into employment (tenant_id, person_id, legal_entity_id, employment_type, start_date)
         values ($1, $2, $3, 'full_time', '2025-01-01')
         returning id`,
        [fx().a.tenantId, fx().a.personId, fx().a.legalEntityId],
      );
      const id = one(inserted.rows).id;
      const updated = await client.query('update employment set notice_days = 10 where id = $1', [
        id,
      ]);
      const deleted = await client.query('delete from employment where id = $1', [id]);
      return { updated: updated.rowCount, deleted: deleted.rowCount };
    });

    expect(outcome).toEqual({ updated: 1, deleted: 1 });
  });

  test('cross-tenant reads, updates and deletes on employment and project see zero rows', async () => {
    const fromA = await withRuntime(fx().a.tenantId, async (client) => {
      const read = await client.query('select id from employment where id = $1', [
        fx().b.employmentId,
      ]);
      const updated = await client.query(
        'update employment set notice_days = 99 where id = $1',
        [fx().b.employmentId],
      );
      const deleted = await client.query('delete from employment where id = $1', [
        fx().b.employmentId,
      ]);
      return { read: read.rows.length, updated: updated.rowCount, deleted: deleted.rowCount };
    });
    expect(fromA).toEqual({ read: 0, updated: 0, deleted: 0 });

    const fromB = await withRuntime(fx().b.tenantId, async (client) => {
      const read = await client.query('select id from employment where id = $1', [
        fx().a.employmentId,
      ]);
      const projects = await client.query<{ id: string }>('select id from project order by id');
      const projectUpdated = await client.query(
        "update project set name = 'Hijacked' where id = $1",
        [fx().a.projectId],
      );
      const projectDeleted = await client.query('delete from project where id = $1', [
        fx().a.projectId,
      ]);
      return {
        read: read.rows.length,
        projects: projects.rows.map((row) => row.id),
        projectUpdated: projectUpdated.rowCount,
        projectDeleted: projectDeleted.rowCount,
      };
    });
    expect(fromB.read).toBe(0);
    expect(fromB.projects).toEqual([fx().b.projectId]);
    expect(fromB.projectUpdated).toBe(0);
    expect(fromB.projectDeleted).toBe(0);
  });

  test('tenant A cannot insert an employment row for tenant B', async () => {
    const error = await denied(
      fx().a.tenantId,
      `insert into employment (tenant_id, person_id, legal_entity_id, employment_type, start_date)
       values ($1, $2, $3, 'full_time', '2025-01-01')`,
      [fx().b.tenantId, fx().b.personId, fx().b.legalEntityId],
    );

    expect(error.code).toBe('42501');
    expect(error.message).toMatch(/row-level security/);
    expect(error.message).not.toMatch(/foreign key/);
    expect(error.message).not.toMatch(/permission denied for table employment/);
  });

  test('without a tenant context the runtime sees no employment or project rows', async () => {
    const counts = await withRuntime(null, async (client) => {
      const employment = await client.query('select id from employment');
      const project = await client.query('select id from project');
      return { employment: employment.rows.length, project: project.rows.length };
    });

    expect(counts).toEqual({ employment: 0, project: 0 });
  });

  test('suspended, closed and deleted tenants cannot read or insert employment', async () => {
    for (const fixture of [fx().suspended, fx().closed, fx().deleted]) {
      const read = await withRuntime(fixture.tenantId, async (client) => {
        const result = await client.query('select id from employment');
        return result.rows.length;
      });
      expect(read).toBe(0);

      const error = await denied(
        fixture.tenantId,
        `insert into employment (tenant_id, person_id, legal_entity_id, employment_type, start_date)
         values ($1, $2, $3, 'full_time', '2025-01-01')`,
        [fixture.tenantId, fixture.personId, fixture.legalEntityId],
      );
      expect(error.code).toBe('42501');
      expect(error.message).toMatch(/row-level security/);
    }
  });

  test('a cancelled entitlement inside read_until is read-only at the table', async () => {
    const read = await withRuntime(fx().cancelled.tenantId, async (client) => {
      const result = await client.query<{ id: string }>('select id from employment');
      return result.rows.map((row) => row.id);
    });
    expect(read).toEqual([fx().cancelled.employmentId]);

    const writes = await withRuntime(fx().cancelled.tenantId, async (client) => {
      const updated = await client.query(
        'update employment set notice_days = 5 where id = $1',
        [fx().cancelled.employmentId],
      );
      const deleted = await client.query('delete from employment where id = $1', [
        fx().cancelled.employmentId,
      ]);
      return { updated: updated.rowCount, deleted: deleted.rowCount };
    });
    expect(writes).toEqual({ updated: 0, deleted: 0 });

    const error = await denied(
      fx().cancelled.tenantId,
      `insert into employment (tenant_id, person_id, legal_entity_id, employment_type, start_date)
       values ($1, $2, $3, 'full_time', '2025-01-01')`,
      [fx().cancelled.tenantId, fx().cancelled.personId, fx().cancelled.legalEntityId],
    );
    expect(error.code).toBe('42501');
    expect(error.message).toMatch(/row-level security/);
  });

  test('tenant B reads and writes its own project and reads no employment', async () => {
    const outcome = await withRuntime(fx().b.tenantId, async (client) => {
      const projects = await client.query<{ id: string }>('select id from project');
      const updated = await client.query('update project set name = $2 where id = $1', [
        fx().b.projectId,
        'B renamed',
      ]);
      const readBack = await client.query<{ name: string }>(
        'select name from project where id = $1',
        [fx().b.projectId],
      );
      const employment = await client.query('select id from employment');
      return {
        projects: projects.rows.map((row) => row.id),
        updated: updated.rowCount,
        name: readBack.rows[0]?.name,
        employment: employment.rows.length,
      };
    });

    expect(outcome.projects).toEqual([fx().b.projectId]);
    expect(outcome.updated).toBe(1);
    expect(outcome.name).toBe('B renamed');
    expect(outcome.employment).toBe(0);
  });

  test('owner confirms the denial cases persisted nothing', async () => {
    const state = await withOwner(async (client) => {
      const counts = await client.query<{ employment: string; project: string }>(`
        select
          (select count(*) from employment)::text as employment,
          (select count(*) from project)::text as project
      `);
      const aProject = await client.query<{ name: string }>('select name from project where id = $1', [
        fx().a.projectId,
      ]);
      const bEmployment = await client.query<{ notice_days: number | null }>(
        'select notice_days from employment where id = $1',
        [fx().b.employmentId],
      );
      return {
        counts: counts.rows[0],
        aProjectName: aProject.rows[0]?.name,
        bEmploymentNoticeDays: bEmployment.rows[0]?.notice_days,
      };
    });

    expect(state.counts).toEqual({ employment: '6', project: '2' });
    expect(state.aProjectName).toBe(fx().originalProjectName);
    expect(state.bEmploymentNoticeDays).toBeNull();
  });
});
