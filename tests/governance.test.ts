import { randomBytes, randomUUID } from 'node:crypto';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  appendAuditEvent,
  cancelEntitlement,
  createRuntimePool,
  grantEntitlement,
  provisionTenant,
  withMemberTransaction,
  type RuntimePool,
} from '@saasmodels/db';
import { createTestDatabase, type TestDatabase } from '@saasmodels/testkit';
import {
  createAccessFixtures,
  type AccessFixtures,
} from './support/access-fixtures.js';

const DAY_MS = 24 * 60 * 60 * 1000;

let database: TestDatabase | undefined;
let fixtures: AccessFixtures | undefined;
let owner: Pool | undefined;
let runtime: RuntimePool | undefined;
let bareTenantId: string | undefined;

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

function ownerPool(): Pool {
  if (!owner) {
    throw new Error('Owner pool has not been created');
  }
  return owner;
}

function runtimePool(): RuntimePool {
  if (!runtime) {
    throw new Error('Runtime pool has not been created');
  }
  return runtime;
}

function bareTenant(): string {
  if (!bareTenantId) {
    throw new Error('Bare tenant has not been created');
  }
  return bareTenantId;
}

function suffix(): string {
  return randomBytes(4).toString('hex');
}

function one<T>(rows: T[]): T {
  const row = rows[0];
  if (!row) {
    throw new Error('Expected one row');
  }
  return row;
}

async function createPublicTenant(label: string): Promise<string> {
  const inserted = await ownerPool().query<{ id: string }>(
    `insert into tenant (name, slug, data_region)
     values ($1, $2, 'test')
     returning id`,
    [`${label} tenant`, `${label}-${suffix()}`],
  );
  return one(inserted.rows).id;
}

async function withRuntime<T>(
  tenantId: string | null,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString: db().runtimeUrl });
  await client.connect();
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

beforeAll(async () => {
  database = await createTestDatabase({ migrate: true, seed: true });
  owner = new Pool({ connectionString: database.ownerUrl });
  runtime = createRuntimePool(database.runtimeUrl);

  const fixturesClient = new Client({ connectionString: database.ownerUrl });
  await fixturesClient.connect();
  try {
    fixtures = await createAccessFixtures(fixturesClient);
  } finally {
    await fixturesClient.end();
  }

  const bare = await ownerPool().query<{ id: string }>(
    `insert into tenant (name, slug, data_region)
     values ('Bare entitlement tenant', $1, 'test')
     returning id`,
    [`bare_${suffix()}`],
  );
  bareTenantId = one(bare.rows).id;
});

afterAll(async () => {
  await runtime?.end();
  await owner?.end();
  await database?.drop();
});

describe('audit append and immutability', () => {
  test('a member appends an audit event and the owner reads it with the transaction tenant', async () => {
    const a = fx().a;
    const action = `test.member_audit_${suffix()}`;

    const appended = await withMemberTransaction(
      runtimePool(),
      { tenantId: a.tenantId, userId: a.userId },
      async (client) =>
        appendAuditEvent(client, {
          action,
          entityType: 'employment',
          entityId: a.employmentId,
          actorType: 'user',
          actorUserId: a.userId,
          afterState: { noticeDays: 10 },
          metadata: { source: 'membership-test' },
        }),
    );
    expect(appended).toBeUndefined();

    const row = one(
      (
        await ownerPool().query<{
          tenant_id: string;
          actor_user_id: string | null;
          actor_type: string;
          entity_id: string | null;
          before_state: unknown;
          after_state: unknown;
          metadata: unknown;
        }>(
          `select tenant_id, actor_user_id, actor_type, entity_id,
                  before_state, after_state, metadata
             from audit_event
            where action = $1`,
          [action],
        )
      ).rows,
    );

    expect(row).toEqual({
      tenant_id: a.tenantId,
      actor_user_id: a.userId,
      actor_type: 'user',
      entity_id: a.employmentId,
      before_state: null,
      after_state: { noticeDays: 10 },
      metadata: { source: 'membership-test' },
    });
  });

  test('rejects malformed audit events before writing', async () => {
    const a = fx().a;

    await withMemberTransaction(
      runtimePool(),
      { tenantId: a.tenantId, userId: a.userId },
      async (client) => {
        await expect(
          appendAuditEvent(client, {
            action: '',
            entityType: 'employment',
            actorType: 'system',
          }),
        ).rejects.toMatchObject({ code: 'INVALID_AUDIT_EVENT' });

        await expect(
          appendAuditEvent(client, {
            action: 'test.invalid',
            entityType: 'employment',
            actorType: 'user',
          }),
        ).rejects.toMatchObject({ code: 'INVALID_AUDIT_EVENT' });

        await expect(
          appendAuditEvent(client, {
            action: 'test.invalid',
            entityType: 'employment',
            actorType: 'system',
            actorUserId: a.userId,
          }),
        ).rejects.toMatchObject({ code: 'INVALID_AUDIT_EVENT' });
      },
    );
  });

  test('runtime cannot select, update or delete audit events', async () => {
    const a = fx().a;

    expect((await denied(a.tenantId, 'select count(*) from audit_event')).code).toBe('42501');
    expect(
      (
        await denied(
          a.tenantId,
          "update audit_event set action = 'tampered' where tenant_id = $1",
          [a.tenantId],
        )
      ).code,
    ).toBe('42501');
    expect(
      (await denied(a.tenantId, 'delete from audit_event where tenant_id = $1', [a.tenantId]))
        .code,
    ).toBe('42501');
  });

  test('runtime cannot insert an audit event for another tenant', async () => {
    const a = fx().a;
    const b = fx().b;

    const error = await denied(
      a.tenantId,
      `insert into audit_event (tenant_id, actor_type, action, entity_type)
       values ($1, 'system', 'test.cross_tenant', 'tenant')`,
      [b.tenantId],
    );
    expect(error.code).toBe('42501');
    expect(error.message).toMatch(/row-level security/);
  });

  test('owner cannot update or delete audit events either', async () => {
    const a = fx().a;
    const action = `test.immutable_${suffix()}`;

    const inserted = await ownerPool().query<{ id: string }>(
      `insert into audit_event (tenant_id, actor_type, action, entity_type)
       values ($1, 'system', $2, 'test')
       returning id`,
      [a.tenantId, action],
    );
    const id = one(inserted.rows).id;

    await expect(
      ownerPool().query("update audit_event set action = 'tampered' where id = $1", [id]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      ownerPool().query('delete from audit_event where id = $1', [id]),
    ).rejects.toMatchObject({ code: '42501' });
  });

  test('an audit validation failure rolls back the underlying employment insert', async () => {
    const a = fx().a;
    const employmentId = randomUUID();

    await expect(
      withMemberTransaction(
        runtimePool(),
        {
          tenantId: a.tenantId,
          userId: a.userId,
          gate: { module: 'people', operation: 'write' },
        },
        async (client) => {
          await client.query(
            `insert into employment
               (id, tenant_id, person_id, legal_entity_id, employment_type, start_date)
             values ($1, $2, $3, $4, 'full_time', '2025-03-01')`,
            [employmentId, a.tenantId, a.personId, a.legalEntityId],
          );
          await appendAuditEvent(client, {
            action: '',
            entityType: 'employment',
            actorType: 'user',
            actorUserId: a.userId,
          });
        },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_AUDIT_EVENT' });

    const persisted = await ownerPool().query('select id from employment where id = $1', [
      employmentId,
    ]);
    expect(persisted.rowCount).toBe(0);
  });

  test('a database-level audit failure rolls back the underlying employment insert', async () => {
    const a = fx().a;
    const employmentId = randomUUID();
    const missingActorId = randomUUID();

    await expect(
      withMemberTransaction(
        runtimePool(),
        {
          tenantId: a.tenantId,
          userId: a.userId,
          gate: { module: 'people', operation: 'write' },
        },
        async (client) => {
          await client.query(
            `insert into employment
               (id, tenant_id, person_id, legal_entity_id, employment_type, start_date)
             values ($1, $2, $3, $4, 'full_time', '2025-03-01')`,
            [employmentId, a.tenantId, a.personId, a.legalEntityId],
          );
          await appendAuditEvent(client, {
            action: 'test.audit_foreign_key',
            entityType: 'employment',
            entityId: employmentId,
            actorType: 'user',
            actorUserId: missingActorId,
          });
        },
      ),
    ).rejects.toMatchObject({ code: '23503' });

    const persisted = await ownerPool().query('select id from employment where id = $1', [
      employmentId,
    ]);
    expect(persisted.rowCount).toBe(0);
    const audits = await ownerPool().query(
      "select id from audit_event where action = 'test.audit_foreign_key'",
    );
    expect(audits.rowCount).toBe(0);
  });
});

describe('tenant provisioning', () => {
  test('creates tenant, invited owner, membership, entitlement and audit in one transaction', async () => {
    const slug = `prov-${suffix()}`;
    const email = `owner_${suffix()}@example.test`;

    const result = await provisionTenant(ownerPool(), {
      name: 'Provisioned Synthetic Co',
      slug: `  ${slug.toUpperCase()}  `,
      dataRegion: 'ap-south-1',
      ownerEmail: email,
      ownerDisplayName: 'Provisioned Owner',
      modules: ['people'],
    });

    expect(result.moduleCodes).toEqual(['people']);

    const tenant = one(
      (
        await ownerPool().query<{
          name: string;
          slug: string;
          status: string;
          deleted_at: Date | null;
          is_internal: boolean;
        }>(
          'select name, slug, status, deleted_at, is_internal from tenant where id = $1',
          [result.tenantId],
        )
      ).rows,
    );
    expect(tenant).toEqual({
      name: 'Provisioned Synthetic Co',
      slug,
      status: 'active',
      deleted_at: null,
      is_internal: false,
    });

    const user = one(
      (
        await ownerPool().query<{
          email: string;
          display_name: string;
          status: string;
          password_hash: string | null;
        }>(
          'select email, display_name, status, password_hash from app_user where id = $1',
          [result.ownerUserId],
        )
      ).rows,
    );
    expect(user).toEqual({
      email,
      display_name: 'Provisioned Owner',
      status: 'invited',
      password_hash: null,
    });

    const membership = one(
      (
        await ownerPool().query<{ role: string; status: string }>(
          'select role, status from membership where tenant_id = $1 and user_id = $2',
          [result.tenantId, result.ownerUserId],
        )
      ).rows,
    );
    expect(membership).toEqual({ role: 'owner', status: 'invited' });

    const entitlement = one(
      (
        await ownerPool().query<{
          status: string;
          source: string;
          seat_unit: string;
          ends_at: Date | null;
          read_until: Date | null;
          created_by: string | null;
        }>(
          `select e.status, e.source, e.seat_unit, e.ends_at, e.read_until, e.created_by
             from module_entitlement e
             join platform_module m on m.id = e.module_id
            where e.tenant_id = $1 and m.code = 'people'`,
          [result.tenantId],
        )
      ).rows,
    );
    expect(entitlement).toEqual({
      status: 'active',
      source: 'contract',
      seat_unit: 'employee',
      ends_at: null,
      read_until: null,
      created_by: result.ownerUserId,
    });

    const audit = one(
      (
        await ownerPool().query<{
          actor_type: string;
          actor_user_id: string | null;
          action: string;
          entity_type: string;
          entity_id: string;
          before_state: unknown;
          after_state: unknown;
          metadata: unknown;
        }>(
          `select actor_type, actor_user_id, action, entity_type, entity_id,
                  before_state, after_state, metadata
             from audit_event
            where tenant_id = $1 and action = 'tenant.provisioned'`,
          [result.tenantId],
        )
      ).rows,
    );
    expect(audit).toEqual({
      actor_type: 'system',
      actor_user_id: null,
      action: 'tenant.provisioned',
      entity_type: 'tenant',
      entity_id: result.tenantId,
      before_state: null,
      after_state: {
        slug,
        dataRegion: 'ap-south-1',
        isInternal: false,
        modules: [{ code: 'people', status: 'active', source: 'contract' }],
      },
      metadata: { ownerUserId: result.ownerUserId },
    });
    expect(JSON.stringify(audit)).not.toContain(email);
  });

  test('duplicate slugs fail without leaving a second tenant or audit row', async () => {
    const slug = `dup-${suffix()}`;
    const email = `owner_${suffix()}@example.test`;
    const input = {
      name: 'Duplicate Co',
      slug,
      dataRegion: 'test-region',
      ownerEmail: email,
      ownerDisplayName: 'Duplicate Owner',
      modules: ['people'],
    };

    const first = await provisionTenant(ownerPool(), input);
    expect(first.tenantId).toBeTruthy();

    const secondEmail = `owner_${suffix()}@example.test`;
    await expect(
      provisionTenant(ownerPool(), { ...input, ownerEmail: secondEmail }),
    ).rejects.toMatchObject({ code: 'TENANT_SLUG_TAKEN' });

    const tenants = await ownerPool().query('select id from tenant where slug = $1', [slug]);
    expect(tenants.rowCount).toBe(1);
    const users = await ownerPool().query('select id from app_user where email = $1', [
      secondEmail,
    ]);
    expect(users.rowCount).toBe(0);
    const audits = await ownerPool().query(
      "select id from audit_event where action = 'tenant.provisioned' and after_state->>'slug' = $1",
      [slug],
    );
    expect(audits.rowCount).toBe(1);
  });

  test('validates input before writing', async () => {
    const valid = {
      name: 'Validation Co',
      slug: `validate-${suffix()}`,
      dataRegion: 'test-region',
      ownerEmail: `validate_${suffix()}@example.test`,
      ownerDisplayName: 'Validation Owner',
      modules: ['people'],
    };

    const cases: Array<[string, Record<string, unknown>]> = [
      ['empty name', { name: '   ' }],
      ['short slug', { slug: 'ab' }],
      ['invalid slug', { slug: 'not a slug' }],
      ['empty region', { dataRegion: '' }],
      ['uppercase region', { dataRegion: 'AP-SOUTH-1' }],
      ['invalid email', { ownerEmail: 'not-an-email' }],
      ['empty modules', { modules: [] }],
      ['duplicate modules', { modules: ['people', 'people'] }],
      ['non-string module', { modules: [42] }],
      ['non-boolean internal flag', { isInternal: 'yes' }],
    ];

    for (const [label, override] of cases) {
      await expect(
        provisionTenant(ownerPool(), { ...valid, ...override } as never),
        label,
      ).rejects.toMatchObject({ code: 'INVALID_PROVISION_INPUT' });
    }
  });

  test('rejects null input with the stable provisioning error', async () => {
    await expect(provisionTenant(ownerPool(), null as never)).rejects.toMatchObject({
      code: 'INVALID_PROVISION_INPUT',
    });
  });

  test('applies catalog rules and rolls back on an ineligible module', async () => {
    const base = {
      name: 'Module Rules Co',
      slug: `rules-${suffix()}`,
      dataRegion: 'test-region',
      ownerEmail: `rules_${suffix()}@example.test`,
      ownerDisplayName: 'Rules Owner',
    };

    await expect(
      provisionTenant(ownerPool(), { ...base, modules: ['missing_module'] }),
    ).rejects.toMatchObject({ code: 'MODULE_UNKNOWN', moduleCode: 'missing_module' });

    await expect(
      provisionTenant(ownerPool(), { ...base, modules: ['core'] }),
    ).rejects.toMatchObject({ code: 'MODULE_NOT_LICENSABLE' });

    await expect(
      provisionTenant(ownerPool(), { ...base, modules: ['crm'] }),
    ).rejects.toMatchObject({ code: 'MODULE_NOT_AVAILABLE' });

    const retiredCode = `retired_${suffix()}`;
    await ownerPool().query(
      `insert into platform_module (code, name, category, is_licensable, status)
       values ($1, 'Retired probe', 'test', true, 'retired')`,
      [retiredCode],
    );
    await expect(
      provisionTenant(ownerPool(), { ...base, modules: [retiredCode] }),
    ).rejects.toMatchObject({ code: 'MODULE_NOT_AVAILABLE' });

    const tenants = await ownerPool().query('select id from tenant where slug = $1', [
      base.slug,
    ]);
    expect(tenants.rowCount).toBe(0);
    const users = await ownerPool().query('select id from app_user where email = $1', [
      base.ownerEmail,
    ]);
    expect(users.rowCount).toBe(0);
  });

  test('an internal tenant may receive a planned module with an internal source', async () => {
    const result = await provisionTenant(ownerPool(), {
      name: 'Internal Studio Co',
      slug: `internal-${suffix()}`,
      dataRegion: 'test-region',
      ownerEmail: `internal_${suffix()}@example.test`,
      ownerDisplayName: 'Internal Owner',
      modules: ['crm'],
      isInternal: true,
    });

    const entitlement = one(
      (
        await ownerPool().query<{ source: string; status: string }>(
          `select e.source, e.status
             from module_entitlement e
             join platform_module m on m.id = e.module_id
            where e.tenant_id = $1 and m.code = 'crm'`,
          [result.tenantId],
        )
      ).rows,
    );
    expect(entitlement).toEqual({ source: 'internal', status: 'active' });

    const helper = await withRuntime(result.tenantId, async (client) => {
      const resultRows = await client.query<{ write: boolean; read: boolean }>(
        "select app.has_module_write('crm') as write, app.has_module_read('crm') as read",
      );
      return resultRows.rows[0];
    });
    expect(helper).toEqual({ read: true, write: true });
  });

  test('reuses an existing eligible owner and never changes the display name', async () => {
    const email = `reuse_${suffix()}@example.test`;

    const first = await provisionTenant(ownerPool(), {
      name: 'First Reuse Co',
      slug: `reuse-a-${suffix()}`,
      dataRegion: 'test-region',
      ownerEmail: email,
      ownerDisplayName: 'Original Name',
      modules: ['people'],
    });
    const second = await provisionTenant(ownerPool(), {
      name: 'Second Reuse Co',
      slug: `reuse-b-${suffix()}`,
      dataRegion: 'test-region',
      ownerEmail: email,
      ownerDisplayName: 'Changed Name',
      modules: ['people'],
    });

    expect(second.ownerUserId).toBe(first.ownerUserId);
    const users = await ownerPool().query<{ display_name: string; status: string }>(
      'select display_name, status from app_user where email = $1',
      [email],
    );
    expect(users.rowCount).toBe(1);
    expect(users.rows[0]).toMatchObject({ display_name: 'Original Name', status: 'invited' });
    const memberships = await ownerPool().query(
      "select id from membership where user_id = $1 and role = 'owner'",
      [first.ownerUserId],
    );
    expect(memberships.rowCount).toBe(2);
  });

  test('refuses a disabled or suspended owner and rolls the tenant back', async () => {
    for (const status of ['disabled', 'suspended']) {
      const email = `${status}_${suffix()}@example.test`;
      await ownerPool().query(
        `insert into app_user (email, display_name, status)
         values ($1, 'Ineligible Owner', $2)`,
        [email, status],
      );

      const slug = `ineligible-${suffix()}`;
      await expect(
        provisionTenant(ownerPool(), {
          name: 'Ineligible Owner Co',
          slug,
          dataRegion: 'test-region',
          ownerEmail: email,
          ownerDisplayName: 'Ignored Name',
          modules: ['people'],
        }),
      ).rejects.toMatchObject({ code: 'OWNER_NOT_ELIGIBLE' });

      const tenants = await ownerPool().query('select id from tenant where slug = $1', [slug]);
      expect(tenants.rowCount).toBe(0);
    }
  });

  test('provisioning succeeds while the tenant table has FORCE ROW LEVEL SECURITY', async () => {
    const forceClient = await ownerPool().connect();
    try {
      await forceClient.query('alter table tenant force row level security');
      const forced = await forceClient.query<{ relforcerowsecurity: boolean }>(
        "select relforcerowsecurity from pg_class where oid = 'public.tenant'::regclass",
      );
      expect(forced.rows[0]?.relforcerowsecurity).toBe(true);

      const result = await provisionTenant(ownerPool(), {
        name: 'Forced RLS Co',
        slug: `forced-${suffix()}`,
        dataRegion: 'test-region',
        ownerEmail: `forced_${suffix()}@example.test`,
        ownerDisplayName: 'Forced Owner',
        modules: ['people'],
      });
      expect(result.tenantId).toBeTruthy();
      expect(result.moduleCodes).toEqual(['people']);
    } finally {
      await forceClient
        .query('alter table tenant no force row level security')
        .catch(() => undefined);
      forceClient.release();
    }
  });
});

describe('entitlement lifecycle', () => {
  test('grant, cancel and reactivate preserve history and audit before/after states', async () => {
    const a = fx().a;
    const b = fx().b;
    const tenantId = bareTenant();
    const readUntil = new Date(Date.now() + 30 * DAY_MS);

    await grantEntitlement(ownerPool(), {
      tenantId,
      moduleCode: 'people',
      actorUserId: a.userId,
      seatCount: 25,
      contractRef: 'contract-secret-ref',
    });

    const granted = one(
      (
        await ownerPool().query<{
          id: string;
          status: string;
          source: string;
          seat_unit: string;
          seat_count: number | null;
          starts_at: Date;
          ends_at: Date | null;
          read_until: Date | null;
          created_by: string | null;
        }>(
          `select e.id, e.status, e.source, e.seat_unit, e.seat_count, e.starts_at,
                  e.ends_at, e.read_until, e.created_by
             from module_entitlement e
             join platform_module m on m.id = e.module_id
            where e.tenant_id = $1 and m.code = 'people'`,
          [tenantId],
        )
      ).rows,
    );
    expect(granted).toMatchObject({
      status: 'active',
      source: 'contract',
      seat_unit: 'employee',
      seat_count: 25,
      ends_at: null,
      read_until: null,
      created_by: a.userId,
    });

    const grantAudit = one(
      (
        await ownerPool().query<{
          actor_type: string;
          actor_user_id: string | null;
          action: string;
          before_state: unknown;
          after_state: unknown;
          metadata: unknown;
        }>(
          `select actor_type, actor_user_id, action, before_state, after_state, metadata
             from audit_event
            where tenant_id = $1 and action = 'module_entitlement.granted'`,
          [tenantId],
        )
      ).rows,
    );
    expect(grantAudit.actor_type).toBe('user');
    expect(grantAudit.actor_user_id).toBe(a.userId);
    expect(grantAudit.before_state).toBeNull();
    expect(grantAudit.after_state).toEqual({
      status: 'active',
      source: 'contract',
      starts_at: granted.starts_at.toISOString(),
      ends_at: null,
      read_until: null,
      seat_unit: 'employee',
      seat_count: 25,
    });
    expect(grantAudit.metadata).toEqual({ moduleCode: 'people' });
    expect(JSON.stringify(grantAudit)).not.toContain('contract-secret-ref');

    await cancelEntitlement(ownerPool(), {
      tenantId,
      moduleCode: 'people',
      actorUserId: a.userId,
      readUntil,
      reason: 'contract ended',
    });

    const cancelled = one(
      (
        await ownerPool().query<{
          status: string;
          starts_at: Date;
          ends_at: Date | null;
          read_until: Date | null;
          created_by: string | null;
        }>(
          `select e.status, e.starts_at, e.ends_at, e.read_until, e.created_by
             from module_entitlement e
             join platform_module m on m.id = e.module_id
            where e.tenant_id = $1 and m.code = 'people'`,
          [tenantId],
        )
      ).rows,
    );
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.read_until?.toISOString()).toBe(readUntil.toISOString());
    expect(cancelled.starts_at.toISOString()).toBe(granted.starts_at.toISOString());
    expect(cancelled.ends_at).toBeNull();
    expect(cancelled.created_by).toBe(a.userId);

    const cancelAudit = one(
      (
        await ownerPool().query<{
          before_state: Record<string, unknown>;
          after_state: Record<string, unknown>;
          metadata: Record<string, unknown>;
        }>(
          `select before_state, after_state, metadata
             from audit_event
            where tenant_id = $1 and action = 'module_entitlement.cancelled'
            order by occurred_at desc
            limit 1`,
          [tenantId],
        )
      ).rows,
    );
    expect(cancelAudit.before_state.status).toBe('active');
    expect(cancelAudit.before_state.read_until).toBeNull();
    expect(cancelAudit.after_state.status).toBe('cancelled');
    expect(cancelAudit.after_state.read_until).toBe(readUntil.toISOString());
    expect(cancelAudit.metadata).toEqual({
      moduleCode: 'people',
      reason: 'contract ended',
    });
    expect(JSON.stringify(cancelAudit)).not.toContain('contract-secret-ref');

    await grantEntitlement(ownerPool(), {
      tenantId,
      moduleCode: 'people',
      actorUserId: b.userId,
    });

    const reactivated = one(
      (
        await ownerPool().query<{
          status: string;
          starts_at: Date;
          read_until: Date | null;
          created_by: string | null;
        }>(
          `select e.status, e.starts_at, e.read_until, e.created_by
             from module_entitlement e
             join platform_module m on m.id = e.module_id
            where e.tenant_id = $1 and m.code = 'people'`,
          [tenantId],
        )
      ).rows,
    );
    expect(reactivated.status).toBe('active');
    expect(reactivated.read_until).toBeNull();
    expect(reactivated.created_by).toBe(a.userId);

    const reactivationAudit = one(
      (
        await ownerPool().query<{
          actor_user_id: string | null;
          before_state: Record<string, unknown>;
          after_state: Record<string, unknown>;
        }>(
          `select actor_user_id, before_state, after_state
             from audit_event
            where tenant_id = $1 and action = 'module_entitlement.granted'
            order by occurred_at desc
            limit 1`,
          [tenantId],
        )
      ).rows,
    );
    expect(reactivationAudit.actor_user_id).toBe(b.userId);
    expect(reactivationAudit.before_state.status).toBe('cancelled');
    expect(reactivationAudit.before_state.read_until).toBe(readUntil.toISOString());
    expect(reactivationAudit.after_state.status).toBe('active');
    expect(reactivationAudit.after_state.read_until).toBeNull();

    const extended = new Date(Date.now() + 60 * DAY_MS);
    await cancelEntitlement(ownerPool(), {
      tenantId,
      moduleCode: 'people',
      actorUserId: b.userId,
      readUntil: extended,
    });

    const extendedRow = one(
      (
        await ownerPool().query<{ status: string; read_until: Date | null }>(
          `select e.status, e.read_until
             from module_entitlement e
             join platform_module m on m.id = e.module_id
            where e.tenant_id = $1 and m.code = 'people'`,
          [tenantId],
        )
      ).rows,
    );
    expect(extendedRow.status).toBe('cancelled');
    expect(extendedRow.read_until?.toISOString()).toBe(extended.toISOString());

    const audits = await ownerPool().query<{ count: string }>(
      `select count(*)::text as count
         from audit_event
        where tenant_id = $1
          and action in ('module_entitlement.granted', 'module_entitlement.cancelled')`,
      [tenantId],
    );
    expect(audits.rows[0]?.count).toBe('4');
  });

  test('grant validates the tenant, actor, dates and module rules', async () => {
    const a = fx().a;

    await expect(
      grantEntitlement(ownerPool(), {
        tenantId: randomUUID(),
        moduleCode: 'people',
        actorUserId: a.userId,
      }),
    ).rejects.toMatchObject({ code: 'TENANT_NOT_FOUND' });

    await expect(
      grantEntitlement(ownerPool(), {
        tenantId: bareTenant(),
        moduleCode: 'people',
        actorUserId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'ACTOR_NOT_ELIGIBLE' });

    const disabledEmail = `disabled_actor_${suffix()}@example.test`;
    const suspendedEmail = `suspended_actor_${suffix()}@example.test`;
    const actors = await ownerPool().query<{ id: string }>(
      `insert into app_user (email, display_name, status)
       values ($1, 'Disabled Actor', 'disabled'),
              ($2, 'Suspended Actor', 'suspended')
       returning id`,
      [disabledEmail, suspendedEmail],
    );
    for (const actor of actors.rows) {
      await expect(
        grantEntitlement(ownerPool(), {
          tenantId: bareTenant(),
          moduleCode: 'people',
          actorUserId: actor.id,
        }),
      ).rejects.toMatchObject({ code: 'ACTOR_NOT_ELIGIBLE' });
    }

    await expect(
      grantEntitlement(ownerPool(), {
        tenantId: bareTenant(),
        moduleCode: 'people',
        actorUserId: a.userId,
        startsAt: new Date('2026-01-01T00:00:00Z'),
        endsAt: new Date('2026-01-01T00:00:00Z'),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ENTITLEMENT_INPUT' });

    await expect(
      grantEntitlement(ownerPool(), {
        tenantId: bareTenant(),
        moduleCode: 'missing_module',
        actorUserId: a.userId,
      }),
    ).rejects.toMatchObject({ code: 'MODULE_UNKNOWN' });

    await expect(
      grantEntitlement(ownerPool(), {
        tenantId: bareTenant(),
        moduleCode: 'core',
        actorUserId: a.userId,
      }),
    ).rejects.toMatchObject({ code: 'MODULE_NOT_LICENSABLE' });

    await expect(
      grantEntitlement(ownerPool(), {
        tenantId: bareTenant(),
        moduleCode: 'crm',
        actorUserId: a.userId,
      }),
    ).rejects.toMatchObject({ code: 'MODULE_NOT_AVAILABLE' });

    await expect(
      grantEntitlement(ownerPool(), {
        tenantId: fx().deleted.tenantId,
        moduleCode: 'people',
        actorUserId: a.userId,
      }),
    ).rejects.toMatchObject({ code: 'TENANT_NOT_FOUND' });
  });

  test('an internal tenant needs an internal source for a planned module', async () => {
    const b = fx().b;

    await expect(
      grantEntitlement(ownerPool(), {
        tenantId: b.tenantId,
        moduleCode: 'crm',
        actorUserId: b.userId,
        source: 'contract',
      }),
    ).rejects.toMatchObject({ code: 'MODULE_NOT_AVAILABLE' });

    await grantEntitlement(ownerPool(), {
      tenantId: b.tenantId,
      moduleCode: 'crm',
      actorUserId: b.userId,
      source: 'internal',
    });

    const row = one(
      (
        await ownerPool().query<{ source: string; status: string }>(
          `select e.source, e.status
             from module_entitlement e
             join platform_module m on m.id = e.module_id
            where e.tenant_id = $1 and m.code = 'crm'`,
          [b.tenantId],
        )
      ).rows,
    );
    expect(row).toEqual({ source: 'internal', status: 'active' });
  });

  test('cancel requires an entitlement, a future retention date and an eligible tenant and actor', async () => {
    const a = fx().a;
    const tenantId = bareTenant();
    const readUntil = new Date(Date.now() + DAY_MS);

    await expect(
      cancelEntitlement(ownerPool(), {
        tenantId,
        moduleCode: 'money',
        actorUserId: a.userId,
        readUntil,
      }),
    ).rejects.toMatchObject({ code: 'ENTITLEMENT_NOT_FOUND' });

    await expect(
      cancelEntitlement(ownerPool(), {
        tenantId,
        moduleCode: 'people',
        actorUserId: a.userId,
        readUntil: new Date(Date.now() - DAY_MS),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ENTITLEMENT_INPUT' });

    await expect(
      cancelEntitlement(ownerPool(), {
        tenantId: fx().deleted.tenantId,
        moduleCode: 'people',
        actorUserId: a.userId,
        readUntil,
      }),
    ).rejects.toMatchObject({ code: 'TENANT_NOT_FOUND' });

    const disabled = await ownerPool().query<{ id: string }>(
      `insert into app_user (email, display_name, status)
       values ($1, 'Cancelling Actor', 'disabled')
       returning id`,
      [`cancel_disabled_${suffix()}@example.test`],
    );
    await expect(
      cancelEntitlement(ownerPool(), {
        tenantId,
        moduleCode: 'people',
        actorUserId: one(disabled.rows).id,
        readUntil,
      }),
    ).rejects.toMatchObject({ code: 'ACTOR_NOT_ELIGIBLE' });
  });

  test('a trialing entitlement requires an end date and honors its window', async () => {
    const a = fx().a;
    const tenantId = await createPublicTenant('trial');
    const pastStart = new Date(Date.now() - 2 * DAY_MS);
    const pastEnd = new Date(Date.now() - DAY_MS);

    await grantEntitlement(ownerPool(), {
      tenantId,
      moduleCode: 'people',
      actorUserId: a.userId,
      status: 'trialing',
      startsAt: pastStart,
      endsAt: pastEnd,
    });

    const expired = one(
      (
        await ownerPool().query<{ status: string; ends_at: Date | null }>(
          `select e.status, e.ends_at
             from module_entitlement e
             join platform_module m on m.id = e.module_id
            where e.tenant_id = $1 and m.code = 'people'`,
          [tenantId],
        )
      ).rows,
    );
    expect(expired.status).toBe('trialing');
    expect(expired.ends_at?.toISOString()).toBe(pastEnd.toISOString());

    const expiredAccess = await withRuntime(tenantId, async (client) => {
      const result = await client.query<{ write: boolean; read: boolean }>(
        "select app.has_module_write('people') as write, app.has_module_read('people') as read",
      );
      return result.rows[0];
    });
    expect(expiredAccess).toEqual({ read: false, write: false });

    const expiredAudit = one(
      (
        await ownerPool().query<{ after_state: Record<string, unknown> }>(
          `select after_state
             from audit_event
            where tenant_id = $1 and action = 'module_entitlement.granted'
            order by occurred_at desc
            limit 1`,
          [tenantId],
        )
      ).rows,
    );
    expect(expiredAudit.after_state).toMatchObject({
      status: 'trialing',
      ends_at: pastEnd.toISOString(),
    });

    await expect(
      grantEntitlement(ownerPool(), {
        tenantId,
        moduleCode: 'people',
        actorUserId: a.userId,
        status: 'trialing',
        startsAt: pastStart,
        endsAt: null,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ENTITLEMENT_INPUT' });

    await expect(
      grantEntitlement(ownerPool(), {
        tenantId,
        moduleCode: 'people',
        actorUserId: a.userId,
        status: 'suspended' as never,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ENTITLEMENT_INPUT' });

    await grantEntitlement(ownerPool(), {
      tenantId,
      moduleCode: 'people',
      actorUserId: a.userId,
      status: 'trialing',
      startsAt: new Date(Date.now() - DAY_MS),
      endsAt: new Date(Date.now() + 30 * DAY_MS),
    });

    const activeAccess = await withRuntime(tenantId, async (client) => {
      const result = await client.query<{ write: boolean; read: boolean }>(
        "select app.has_module_write('people') as write, app.has_module_read('people') as read",
      );
      return result.rows[0];
    });
    expect(activeAccess).toEqual({ read: true, write: true });

    const currentAudit = one(
      (
        await ownerPool().query<{ after_state: Record<string, unknown> }>(
          `select after_state
             from audit_event
            where tenant_id = $1 and action = 'module_entitlement.granted'
            order by occurred_at desc
            limit 1`,
          [tenantId],
        )
      ).rows,
    );
    expect(currentAudit.after_state.status).toBe('trialing');
  });

  test('grant audit snapshots include before and after seat_count', async () => {
    const tenantId = await createPublicTenant('seats');
    const a = fx().a;

    await grantEntitlement(ownerPool(), {
      tenantId,
      moduleCode: 'people',
      actorUserId: a.userId,
      seatCount: 10,
    });
    await grantEntitlement(ownerPool(), {
      tenantId,
      moduleCode: 'people',
      actorUserId: a.userId,
      seatCount: 5,
    });

    const audits = await ownerPool().query<{
      before_state: { seat_count: number | null } | null;
      after_state: { seat_count: number | null };
    }>(
      `select before_state, after_state
         from audit_event
        where tenant_id = $1 and action = 'module_entitlement.granted'`,
      [tenantId],
    );
    expect(audits.rowCount).toBe(2);
    expect(audits.rows.some((row) => row.before_state === null && row.after_state.seat_count === 10)).toBe(true);
    const updateAudit = audits.rows.find((row) => row.before_state?.seat_count === 10);
    expect(updateAudit?.after_state.seat_count).toBe(5);
  });

  test('a public tenant cannot use an internal entitlement source', async () => {
    const a = fx().a;
    const b = fx().b;
    const tenantId = await createPublicTenant('source');

    await expect(
      grantEntitlement(ownerPool(), {
        tenantId,
        moduleCode: 'people',
        actorUserId: a.userId,
        source: 'internal',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ENTITLEMENT_INPUT' });

    const entitlements = await ownerPool().query(
      'select id from module_entitlement where tenant_id = $1',
      [tenantId],
    );
    expect(entitlements.rowCount).toBe(0);
    const audits = await ownerPool().query(
      "select id from audit_event where tenant_id = $1 and action = 'module_entitlement.granted'",
      [tenantId],
    );
    expect(audits.rowCount).toBe(0);

    await grantEntitlement(ownerPool(), {
      tenantId: b.tenantId,
      moduleCode: 'people',
      actorUserId: b.userId,
      source: 'internal',
    });

    const internal = one(
      (
        await ownerPool().query<{ source: string }>(
          `select e.source
             from module_entitlement e
             join platform_module m on m.id = e.module_id
            where e.tenant_id = $1 and m.code = 'people'`,
          [b.tenantId],
        )
      ).rows,
    );
    expect(internal.source).toBe('internal');
  });

  test('rejects null input with the stable entitlement error', async () => {
    await expect(grantEntitlement(ownerPool(), null as never)).rejects.toMatchObject({
      code: 'INVALID_ENTITLEMENT_INPUT',
    });
  });
});
