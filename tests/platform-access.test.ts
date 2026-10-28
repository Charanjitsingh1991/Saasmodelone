import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@saasmodels/testkit';

const DAY_MS = 24 * 60 * 60 * 1000;

let database: TestDatabase | undefined;

function db(): TestDatabase {
  if (!database) {
    throw new Error('Test database has not been created');
  }
  return database;
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

type TenantOptions = {
  status?: string;
  internal?: boolean;
  deleted?: boolean;
};

async function createTenant(client: Client, options: TenantOptions = {}): Promise<string> {
  const slug = `t${randomBytes(6).toString('hex')}`;
  const result = await client.query<{ id: string }>(
    `insert into tenant (name, slug, data_region, status, is_internal, deleted_at)
     values ($1, $2, 'test', $3, $4, $5)
     returning id`,
    [
      `Tenant ${slug}`,
      slug,
      options.status ?? 'active',
      options.internal ?? false,
      options.deleted ? new Date() : null,
    ],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error('tenant insert returned no row');
  }
  return row.id;
}

type EntitlementOptions = {
  status?: string;
  source?: string;
  startsAt?: Date | null;
  endsAt?: Date | null;
  readUntil?: Date | null;
};

async function createEntitlement(
  client: Client,
  tenantId: string,
  code: string,
  options: EntitlementOptions = {},
): Promise<void> {
  await client.query(
    `insert into module_entitlement
       (tenant_id, module_id, status, source, starts_at, ends_at, read_until)
     values ($1, (select id from platform_module where code = $2), $3, $4, $5, $6, $7)`,
    [
      tenantId,
      code,
      options.status ?? 'active',
      options.source ?? 'contract',
      options.startsAt ?? new Date(Date.now() - DAY_MS),
      options.endsAt ?? null,
      options.readUntil ?? null,
    ],
  );
}

type AccessFlags = {
  platform_access: boolean;
  module_read: boolean;
  module_write: boolean;
  switch_access: boolean;
};

async function accessFlags(tenantId: string | null, code = 'people'): Promise<AccessFlags> {
  const client = await runtimeClient();
  try {
    await client.query('begin');
    if (tenantId) {
      await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
    }
    const result = await client.query<AccessFlags>(
      `select
         app.has_platform_access() as platform_access,
         app.has_module_read($1) as module_read,
         app.has_module_write($1) as module_write,
         app.has_switch_access() as switch_access`,
      [code],
    );
    await client.query('rollback');
    const row = result.rows[0];
    if (!row) {
      throw new Error('helper query returned no row');
    }
    return row;
  } finally {
    await client.end();
  }
}

// The complete table-to-policy allowlist from 0008. The exact-map test below
// fails if the procedure and this constant ever drift apart.
const MODULE_POLICY_MAP: Record<string, string> = {
  employment: 'people',
  person_identifier: 'people',
  bank_account: 'people',
  compensation: 'people',
  salary_component: 'people',
  salary_structure: 'people',
  salary_structure_line: 'people',
  payroll_run: 'people',
  payroll_run_rule_pack: 'people',
  payslip: 'people',
  payslip_line: 'people',
  payroll_adjustment: 'people',
  leave_type: 'people',
  leave_balance: 'people',
  leave_request: 'people',
  attendance_day: 'people',
  holiday: 'people',
  engagement: 'work',
  project: 'work',
  milestone: 'work',
  task: 'work',
  allocation: 'work',
  timesheet: 'work',
  timesheet_entry: 'work',
  deliverable: 'work',
  project_cost: 'work',
  content_item: 'content',
  content_version: 'content',
  asset: 'content',
  content_asset: 'content',
  document_room: 'content',
  document_room_member: 'content',
  proposal: 'money',
  proposal_line: 'money',
  contract: 'money',
  invoice: 'money',
  invoice_line: 'money',
  tax_line: 'money',
  payment: 'money',
  payment_allocation: 'money',
  credit_note: 'money',
  expense: 'money',
  vendor: 'money',
  vendor_bill: 'money',
  import_batch: 'switch',
  import_file: 'switch',
  mapping_profile: 'switch',
  import_row: 'switch',
  import_issue: 'switch',
  reconciliation: 'switch',
};

beforeAll(async () => {
  database = await createTestDatabase({ migrate: true, seed: true });
});

afterAll(async () => {
  await database?.drop();
});

describe('platform access helpers', () => {
  test('active entitlement inside the window grants read and write', async () => {
    const tenantId = await withOwner(async (client) => {
      const id = await createTenant(client);
      await createEntitlement(client, id, 'people', { status: 'active' });
      return id;
    });

    expect(await accessFlags(tenantId)).toEqual({
      platform_access: true,
      module_read: true,
      module_write: true,
      switch_access: true,
    });
  });

  test('trialing entitlement inside the window grants read and write', async () => {
    const tenantId = await withOwner(async (client) => {
      const id = await createTenant(client);
      await createEntitlement(client, id, 'people', { status: 'trialing' });
      return id;
    });

    const flags = await accessFlags(tenantId);
    expect(flags.module_read).toBe(true);
    expect(flags.module_write).toBe(true);
    expect(flags.switch_access).toBe(true);
  });

  test('an entitlement outside its window grants nothing', async () => {
    const [endedTenant, futureTenant] = await withOwner(async (client) => {
      const ended = await createTenant(client);
      await createEntitlement(client, ended, 'people', {
        status: 'active',
        startsAt: new Date(Date.now() - 30 * DAY_MS),
        endsAt: new Date(Date.now() - DAY_MS),
      });
      const future = await createTenant(client);
      await createEntitlement(client, future, 'people', {
        status: 'active',
        startsAt: new Date(Date.now() + DAY_MS),
      });
      return [ended, future];
    });

    for (const tenantId of [endedTenant, futureTenant]) {
      const flags = await accessFlags(tenantId);
      expect(flags.module_read).toBe(false);
      expect(flags.module_write).toBe(false);
      expect(flags.switch_access).toBe(false);
    }
  });

  test('a suspended entitlement grants read but not write', async () => {
    const tenantId = await withOwner(async (client) => {
      const id = await createTenant(client);
      await createEntitlement(client, id, 'people', { status: 'suspended' });
      return id;
    });

    const flags = await accessFlags(tenantId);
    expect(flags.module_read).toBe(true);
    expect(flags.module_write).toBe(false);
    expect(flags.switch_access).toBe(false);
  });

  test('a suspended entitlement past its end date cannot read', async () => {
    const tenantId = await withOwner(async (client) => {
      const id = await createTenant(client);
      await createEntitlement(client, id, 'people', {
        status: 'suspended',
        startsAt: new Date(Date.now() - 30 * DAY_MS),
        endsAt: new Date(Date.now() - DAY_MS),
      });
      return id;
    });

    const flags = await accessFlags(tenantId);
    expect(flags.module_read).toBe(false);
    expect(flags.module_write).toBe(false);
  });

  test('a suspended entitlement before its start date cannot read', async () => {
    const tenantId = await withOwner(async (client) => {
      const id = await createTenant(client);
      await createEntitlement(client, id, 'people', {
        status: 'suspended',
        startsAt: new Date(Date.now() + DAY_MS),
      });
      return id;
    });

    const flags = await accessFlags(tenantId);
    expect(flags.module_read).toBe(false);
    expect(flags.module_write).toBe(false);
  });

  test('a cancelled entitlement inside read_until grants read but not write', async () => {
    const tenantId = await withOwner(async (client) => {
      const id = await createTenant(client);
      await createEntitlement(client, id, 'people', {
        status: 'cancelled',
        readUntil: new Date(Date.now() + 30 * DAY_MS),
      });
      return id;
    });

    const flags = await accessFlags(tenantId);
    expect(flags.module_read).toBe(true);
    expect(flags.module_write).toBe(false);
    expect(flags.switch_access).toBe(false);
  });

  test('a cancelled entitlement past read_until grants nothing', async () => {
    const tenantId = await withOwner(async (client) => {
      const id = await createTenant(client);
      await createEntitlement(client, id, 'people', {
        status: 'cancelled',
        readUntil: new Date(Date.now() - DAY_MS),
      });
      return id;
    });

    const flags = await accessFlags(tenantId);
    expect(flags.module_read).toBe(false);
    expect(flags.module_write).toBe(false);
    expect(flags.switch_access).toBe(false);
  });

  test('a cancelled entitlement before its start date cannot read', async () => {
    const tenantId = await withOwner(async (client) => {
      const id = await createTenant(client);
      await createEntitlement(client, id, 'people', {
        status: 'cancelled',
        startsAt: new Date(Date.now() + DAY_MS),
        readUntil: new Date(Date.now() + 30 * DAY_MS),
      });
      return id;
    });

    const flags = await accessFlags(tenantId);
    expect(flags.module_read).toBe(false);
    expect(flags.module_write).toBe(false);
  });

  test('a cancelled entitlement without read_until violates the check constraint', async () => {
    await withOwner(async (client) => {
      const tenantId = await createTenant(client);
      await expect(
        createEntitlement(client, tenantId, 'people', { status: 'cancelled' }),
      ).rejects.toMatchObject({ code: '23514' });
    });
  });

  test('a non-cancelled entitlement with read_until violates the check constraint', async () => {
    await withOwner(async (client) => {
      const tenantId = await createTenant(client);
      await expect(
        createEntitlement(client, tenantId, 'people', {
          status: 'active',
          readUntil: new Date(Date.now() + 30 * DAY_MS),
        }),
      ).rejects.toMatchObject({ code: '23514' });
    });
  });

  test('an internal tenant reaches a planned module with an internal-source entitlement', async () => {
    const tenantId = await withOwner(async (client) => {
      const id = await createTenant(client, { internal: true });
      await createEntitlement(client, id, 'procurement', {
        status: 'active',
        source: 'internal',
      });
      return id;
    });

    const flags = await accessFlags(tenantId, 'procurement');
    expect(flags.module_read).toBe(true);
    expect(flags.module_write).toBe(true);
    expect(flags.switch_access).toBe(true);
  });

  // Procurement is still 'planned'. CRM left that status on 28 October 2026,
  // when the CRM account and contact surfaces shipped, so a planned module is
  // proved with a module that is still planned.
  test('a public tenant cannot reach a planned module through an entitlement', async () => {
    const [contractTenant, internalSourceTenant] = await withOwner(async (client) => {
      const contract = await createTenant(client);
      await createEntitlement(client, contract, 'procurement', {
        status: 'active',
        source: 'contract',
      });
      const internalSource = await createTenant(client);
      await createEntitlement(client, internalSource, 'procurement', {
        status: 'active',
        source: 'internal',
      });
      return [contract, internalSource];
    });

    for (const tenantId of [contractTenant, internalSourceTenant]) {
      const flags = await accessFlags(tenantId, 'procurement');
      expect(flags.module_read).toBe(false);
      expect(flags.module_write).toBe(false);
      expect(flags.switch_access).toBe(false);
    }
  });

  test('core is never entitled, even with an entitlement row', async () => {
    const tenantId = await withOwner(async (client) => {
      const id = await createTenant(client);
      await createEntitlement(client, id, 'core', { status: 'active' });
      return id;
    });

    const flags = await accessFlags(tenantId, 'core');
    expect(flags.module_read).toBe(false);
    expect(flags.module_write).toBe(false);
    expect(flags.switch_access).toBe(false);
  });

  test('switch access requires a licensed module and never a switch entitlement', async () => {
    const [switchOnlyTenant, noEntitlementTenant, licensedTenant, suspendedTenant] =
      await withOwner(async (client) => {
        const switchOnly = await createTenant(client);
        await createEntitlement(client, switchOnly, 'switch', { status: 'active' });
        const none = await createTenant(client);
        const licensed = await createTenant(client);
        await createEntitlement(client, licensed, 'people', { status: 'active' });
        const suspended = await createTenant(client);
        await createEntitlement(client, suspended, 'people', { status: 'suspended' });
        return [switchOnly, none, licensed, suspended];
      });

    expect((await accessFlags(switchOnlyTenant)).switch_access).toBe(false);
    expect((await accessFlags(noEntitlementTenant)).switch_access).toBe(false);
    expect((await accessFlags(licensedTenant)).switch_access).toBe(true);
    expect((await accessFlags(suspendedTenant)).switch_access).toBe(false);
  });

  test('helpers deny everything without a tenant context', async () => {
    const client = await runtimeClient();
    try {
      const result = await client.query<{
        current_tenant: string | null;
        platform_access: boolean;
        module_read: boolean;
        module_write: boolean;
        switch_access: boolean;
      }>(
        `select
           app.current_tenant_id() as current_tenant,
           app.has_platform_access() as platform_access,
           app.has_module_read('people') as module_read,
           app.has_module_write('people') as module_write,
           app.has_switch_access() as switch_access`,
      );
      expect(result.rows[0]).toEqual({
        current_tenant: null,
        platform_access: false,
        module_read: false,
        module_write: false,
        switch_access: false,
      });
    } finally {
      await client.end();
    }
  });

  test('an entitlement for another tenant grants nothing', async () => {
    const [entitledTenant, otherTenant] = await withOwner(async (client) => {
      const entitled = await createTenant(client);
      await createEntitlement(client, entitled, 'people', { status: 'active' });
      const other = await createTenant(client);
      return [entitled, other];
    });

    const other = await accessFlags(otherTenant);
    expect(other.platform_access).toBe(true);
    expect(other.module_read).toBe(false);
    expect(other.module_write).toBe(false);
    expect(other.switch_access).toBe(false);

    const entitled = await accessFlags(entitledTenant);
    expect(entitled.module_read).toBe(true);
  });

  test('has_platform_access is false for suspended, closed and deleted tenants', async () => {
    const [active, suspended, closed, deleted] = await withOwner(async (client) => {
      return [
        await createTenant(client),
        await createTenant(client, { status: 'suspended' }),
        await createTenant(client, { status: 'closed' }),
        await createTenant(client, { deleted: true }),
      ];
    });

    expect((await accessFlags(active)).platform_access).toBe(true);
    expect((await accessFlags(suspended)).platform_access).toBe(false);
    expect((await accessFlags(closed)).platform_access).toBe(false);
    expect((await accessFlags(deleted)).platform_access).toBe(false);
  });

  test('suspended, closed and deleted tenants are denied by every helper', async () => {
    const tenantIds = await withOwner(async (client) => {
      const created: string[] = [];
      for (const options of [
        { status: 'suspended' },
        { status: 'closed' },
        { deleted: true },
      ] as TenantOptions[]) {
        const id = await createTenant(client, options);
        await createEntitlement(client, id, 'people', { status: 'active' });
        created.push(id);
      }
      return created;
    });

    for (const tenantId of tenantIds) {
      expect(await accessFlags(tenantId)).toEqual({
        platform_access: false,
        module_read: false,
        module_write: false,
        switch_access: false,
      });
    }
  });

  test('a retired module grants nothing even with an active entitlement', async () => {
    const tenantId = await withOwner(async (client) => {
      await client.query(
        `insert into platform_module (code, name, category, status)
         values ('retired_probe', 'Retired probe', 'test', 'retired')`,
      );
      const id = await createTenant(client);
      await createEntitlement(client, id, 'retired_probe', { status: 'active' });
      return id;
    });

    const flags = await accessFlags(tenantId, 'retired_probe');
    expect(flags.module_read).toBe(false);
    expect(flags.module_write).toBe(false);
    expect(flags.switch_access).toBe(false);
  });

  test('an internal tenant still needs an internal-source entitlement for a planned module', async () => {
    const tenantId = await withOwner(async (client) => {
      const id = await createTenant(client, { internal: true });
      await createEntitlement(client, id, 'procurement', {
        status: 'active',
        source: 'contract',
      });
      return id;
    });

    const flags = await accessFlags(tenantId, 'procurement');
    expect(flags.module_read).toBe(false);
    expect(flags.module_write).toBe(false);
    expect(flags.switch_access).toBe(false);
  });

  test('has_active_module answers exactly like has_module_write', async () => {
    const [active, suspended, cancelled] = await withOwner(async (client) => {
      const a = await createTenant(client);
      await createEntitlement(client, a, 'people', { status: 'active' });
      const s = await createTenant(client);
      await createEntitlement(client, s, 'people', { status: 'suspended' });
      const c = await createTenant(client);
      await createEntitlement(client, c, 'people', {
        status: 'cancelled',
        readUntil: new Date(Date.now() + 30 * DAY_MS),
      });
      return [a, s, c];
    });

    const expected: Array<[string, boolean]> = [
      [active, true],
      [suspended, false],
      [cancelled, false],
    ];
    const client = await runtimeClient();
    try {
      for (const [tenantId, writeGate] of expected) {
        await client.query('begin');
        await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
        const result = await client.query<{ alias: boolean; write_gate: boolean }>(
          `select
             app.has_active_module('people') as alias,
             app.has_module_write('people') as write_gate`,
        );
        await client.query('rollback');
        expect(result.rows[0]).toEqual({ alias: writeGate, write_gate: writeGate });
      }
    } finally {
      await client.end();
    }
  });

  test('the runtime role cannot call the policy installer or update tenant rows', async () => {
    const tenantId = await withOwner((client) => createTenant(client));

    const client = await runtimeClient();
    try {
      await client.query('begin');
      await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
      await expect(client.query('call app.apply_module_policies()')).rejects.toMatchObject({
        code: '42501',
      });
      await client.query('rollback');

      await client.query('begin');
      await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
      await expect(
        client.query('update tenant set is_internal = true where id = $1', [tenantId]),
      ).rejects.toMatchObject({ code: '42501' });
      await client.query('rollback');
    } finally {
      await client.end();
    }
  });

  test('the policy map matches the allowlist exactly and reapplying it is idempotent', async () => {
    type PolicyRow = {
      tablename: string;
      policyname: string;
      permissive: string;
      cmd: string;
      qual: string | null;
      with_check: string | null;
    };

    const readPolicyRows = async (client: Client): Promise<PolicyRow[]> => {
      const result = await client.query<PolicyRow>(
        `select tablename, policyname, permissive, cmd, qual, with_check
         from pg_policies
         where schemaname = 'public'
           and (policyname like 'module\\_%' escape '\\'
             or policyname like 'switch\\_%' escape '\\')
         order by tablename, policyname`,
      );
      return result.rows;
    };

    const expectedCommands: Record<string, string> = {
      read: 'SELECT',
      write_insert: 'INSERT',
      write_update: 'UPDATE',
      write_delete: 'DELETE',
    };

    await withOwner(async (client) => {
      const first = await readPolicyRows(client);
      const expectedTables = Object.keys(MODULE_POLICY_MAP).sort();
      const actualTables = [...new Set(first.map((row) => row.tablename))].sort();
      expect(actualTables).toEqual(expectedTables);
      expect(first).toHaveLength(200);
      expect(expectedTables).toHaveLength(50);

      for (const row of first) {
        const gate = MODULE_POLICY_MAP[row.tablename];
        expect(gate).toBeDefined();
        const group = gate === 'switch' ? 'switch' : `module_${gate}`;
        const helper = gate === 'switch' ? 'has_switch_access' : undefined;

        expect(row.permissive).toBe('RESTRICTIVE');
        const suffix = row.policyname.slice(`${group}_`.length);
        expect(row.policyname.startsWith(`${group}_`)).toBe(true);
        expect(Object.keys(expectedCommands)).toContain(suffix);
        expect(row.cmd).toBe(expectedCommands[suffix]);

        const expression = `${row.qual ?? ''} ${row.with_check ?? ''}`;
        if (helper) {
          expect(expression).toContain(helper);
        } else if (suffix === 'read') {
          expect(expression).toContain('has_module_read');
          expect(expression).toContain(`'${gate}'`);
        } else {
          expect(expression).toContain('has_module_write');
          expect(expression).toContain(`'${gate}'`);
        }
      }

      await client.query('call app.apply_module_policies()');
      await client.query('call app.apply_module_policies()');
      const after = await readPolicyRows(client);
      expect(after).toHaveLength(200);
      expect(after).toEqual(first);

      const relations = await client.query<{
        relname: string;
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
      }>(
        `select c.relname, c.relrowsecurity, c.relforcerowsecurity
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind = 'r'`,
      );
      const relationMap = new Map(relations.rows.map((row) => [row.relname, row]));
      for (const table of expectedTables) {
        const relation = relationMap.get(table);
        expect(relation?.relrowsecurity).toBe(true);
        expect(relation?.relforcerowsecurity).toBe(false);
      }

      const forced = await client.query<{ forced: string }>(
        `select count(*)::text as forced
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         where n.nspname in ('public', 'infra') and c.relforcerowsecurity`,
      );
      expect(forced.rows[0]?.forced).toBe('0');

      const isolation = await client.query<{
        tablename: string;
        permissive: string;
      }>(
        `select tablename, permissive
         from pg_policies
         where schemaname = 'public' and policyname = 'tenant_isolation'`,
      );
      const isolationMap = new Map(isolation.rows.map((row) => [row.tablename, row]));
      for (const table of expectedTables) {
        expect(isolationMap.get(table)?.permissive).toBe('PERMISSIVE');
      }
    });
  });
});
