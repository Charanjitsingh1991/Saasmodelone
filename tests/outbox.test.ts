import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createWorkerPool, type WorkerPool } from '@saasmodels/db';
import { runOutboxPass, startOutboxWorker, type OutboxEvent } from '@saasmodels/worker';
import { createTestDatabase, type TestDatabase } from '@saasmodels/testkit';
import {
  createAccessFixtures,
  type AccessFixtures,
} from './support/access-fixtures.js';

let database: TestDatabase | undefined;
let fixtures: AccessFixtures | undefined;
let pool: WorkerPool | undefined;

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

function workerPool(): WorkerPool {
  if (!pool) {
    throw new Error('Worker pool has not been created');
  }
  return pool;
}

async function ownerClient(): Promise<Client> {
  const client = new Client({ connectionString: db().ownerUrl });
  await client.connect();
  return client;
}

async function workerClient(): Promise<Client> {
  const client = new Client({ connectionString: db().workerUrl });
  await client.connect();
  return client;
}

async function insertEvent(
  tenantId: string,
  type: string,
  payload: Record<string, unknown> = {},
): Promise<string> {
  const client = await ownerClient();
  try {
    const result = await client.query<{ id: string }>(
      `insert into domain_event (tenant_id, type, aggregate_type, aggregate_id, payload)
       values ($1, $2, 'outbox_test', $3, $4::jsonb)
       returning id::text as id`,
      [tenantId, type, randomUUID(), JSON.stringify(payload)],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error('Event insert returned no row');
    }
    return row.id;
  } finally {
    await client.end();
  }
}

async function eventState(id: string): Promise<Record<string, unknown>> {
  const client = await ownerClient();
  try {
    const result = await client.query<Record<string, unknown>>(
      `select status, attempts, published_at, last_error, lease_owner,
              next_attempt_at, lease_expires_at
         from domain_event where id = $1`,
      [id],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error(`Event ${id} not found`);
    }
    return row;
  } finally {
    await client.end();
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// Mark every pending or leased event published as the owner, so each pass
// test starts from an empty queue and per-tenant claim counts stay exact.
// Tests that must keep an event pending run before the drain or drain first.
async function drainOutbox(): Promise<void> {
  const client = await ownerClient();
  try {
    await client.query(`
      update domain_event
         set status = 'published', published_at = now(),
             lease_owner = null, lease_expires_at = null
       where status in ('pending', 'leased')
    `);
  } finally {
    await client.end();
  }
}

// Every event type this file ever creates, so a pass never claims an older
// leftover as a "no handler registered" failure and skew the counts.
const knownTypes = [
  'xtenant.a',
  'xtenant.b',
  'isolation.a',
  'isolation.b',
  'lease.expired',
  'retry.always-throws',
  'retry.not-before-due',
  'dupe.deliver',
  'dupe.slow-handler',
  'entitlement.work',
  'suspended.delivery',
  'loop.tick',
] as const;

function baseHandlers(
  overrides: Record<string, (event: OutboxEvent) => void | Promise<void>> = {},
): Record<string, (event: OutboxEvent) => void | Promise<void>> {
  const handlers: Record<string, (event: OutboxEvent) => void | Promise<void>> = {};
  for (const type of knownTypes) {
    handlers[type] = () => undefined;
  }
  return { ...handlers, ...overrides };
}

// Every test inserts its own events, so each starts from an empty queue and
// per-tenant claim counts stay exact regardless of what earlier tests leaked.
beforeEach(async () => {
  await drainOutbox();
});

beforeAll(async () => {
  database = await createTestDatabase({ migrate: true, seed: true });
  pool = createWorkerPool(database.workerUrl);

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

describe('outbox claim helpers', () => {
  test('claim refuses when the tenant GUC is unset or invalid', async () => {
    const client = await workerClient();
    try {
      await expect(
        client.query('select * from app.outbox_claim(10, $1, 60, 5)', ['guc-probe']),
      ).rejects.toThrow(/app\.tenant_id is not set/);

      await client.query("select set_config('app.tenant_id', 'not-a-uuid', false)");
      await expect(
        client.query('select * from app.outbox_claim(10, $1, 60, 5)', ['guc-probe']),
      ).rejects.toThrow(/not a valid uuid/);

      await client.query('select set_config($1, $2, false)', ['app.tenant_id', fx().a.tenantId]);
      await expect(
        client.query('select app.outbox_claim(0, $1, 60, 5)', ['guc-probe']),
      ).rejects.toThrow(/p_batch_size must be between 1 and 1000/);
      await expect(
        client.query('select app.outbox_claim(10, $1, 60, 0)', ['guc-probe']),
      ).rejects.toThrow(/p_max_attempts must be between 1 and 1000/);
    } finally {
      await client.end();
    }
  });

  test('the worker role cannot read or write domain_event directly', async () => {
    const client = await workerClient();
    try {
      for (const sql of [
        'select * from domain_event',
        "insert into domain_event (tenant_id, type, aggregate_type, aggregate_id) values ('00000000-0000-0000-0000-000000000001', 'probe', 'probe', '00000000-0000-0000-0000-000000000002')",
        'update domain_event set attempts = attempts + 1',
        'delete from domain_event',
      ]) {
        await expect(client.query(sql)).rejects.toMatchObject({ code: '42501' });
      }
    } finally {
      await client.end();
    }
  });

  test('the helpers are filtered to the tenant GUC even when given a foreign event id', async () => {
    const idA = await insertEvent(fx().a.tenantId, 'xtenant.a');
    const idB = await insertEvent(fx().b.tenantId, 'xtenant.b');
    const client = await workerClient();
    try {
      await client.query('begin');
      await client.query('select set_config($1, $2, true)', ['app.tenant_id', fx().a.tenantId]);
      await expect(
        client.query('select app.outbox_mark_published($1, $2)', [idB, 'xtenant-probe']),
      ).rejects.toThrow(/not in this tenant/);
      await client.query('rollback');

      await client.query('begin');
      await client.query('select set_config($1, $2, true)', ['app.tenant_id', fx().a.tenantId]);
      await expect(
        client.query(
          "select app.outbox_record_failure($1, $2, 5, interval '1 second', 'probe')",
          [idB, 'xtenant-probe'],
        ),
      ).rejects.toThrow(/not in this tenant/);
      await client.query('rollback');

      await client.query('begin');
      await client.query('select set_config($1, $2, true)', ['app.tenant_id', fx().b.tenantId]);
      const claimed = await client.query<{ id: string }>(
        'select id from app.outbox_claim(10, $1, 60, 5)',
        ['xtenant-probe'],
      );
      expect(claimed.rows.map((row) => String(row.id))).toEqual([idB]);
      await expect(
        client.query('select app.outbox_mark_published($1, $2)', [idA, 'xtenant-probe']),
      ).rejects.toThrow(/not in this tenant/);
      await client.query('rollback');
    } finally {
      await client.end();
    }

    // Both transactions rolled back: tenant A's event is untouched and
    // tenant B's claim left no durable trace either.
    expect(await eventState(idA)).toMatchObject({ status: 'pending', attempts: 0 });
    expect(await eventState(idB)).toMatchObject({ status: 'pending', attempts: 0 });

    // Consume the two probe events so later per-tenant counts stay exact.
    // Tenant B is entitled for work, not people, so its sweep uses that gate.
    await runOutboxPass(workerPool(), fx().a.tenantId, { workerId: 'sweep-a', handlers: baseHandlers() });
    await runOutboxPass(workerPool(), fx().b.tenantId, {
      workerId: 'sweep-b',
      gate: { module: 'work', operation: 'read' },
      handlers: baseHandlers(),
    });
    expect(await eventState(idA)).toMatchObject({ status: 'published' });
    expect(await eventState(idB)).toMatchObject({ status: 'published' });
  });

  test('an expired lease is re-claimable by another worker and the lost lease is refused', async () => {
    const id = await insertEvent(fx().a.tenantId, 'lease.expired');
    const client = await workerClient();
    try {
      await client.query('begin');
      await client.query('select set_config($1, $2, true)', ['app.tenant_id', fx().a.tenantId]);
      const first = await client.query('select * from app.outbox_claim(10, $1, 1, 5)', ['lease-1']);
      expect(first.rowCount).toBe(1);
      await client.query('commit');

      await sleep(1_300);

      await client.query('begin');
      await client.query('select set_config($1, $2, true)', ['app.tenant_id', fx().a.tenantId]);
      const second = await client.query(
        'select id, attempts from app.outbox_claim(10, $1, 60, 5)',
        ['lease-2'],
      );
      expect(second.rows.map((row) => String(row.id))).toContain(id);
      expect(second.rows[0]?.attempts).toBe(2);

      const stolen = await client.query<{ ok: boolean }>(
        'select app.outbox_mark_published($1, $2) as ok',
        [id, 'lease-1'],
      );
      expect(stolen.rows[0]?.ok).toBe(false);
      const refused = await client.query<{ outcome: string }>(
        "select app.outbox_record_failure($1, $2, 5, interval '1 second', 'lost lease') as outcome",
        [id, 'lease-1'],
      );
      expect(refused.rows[0]?.outcome).toBe('refused');

      const kept = await client.query<{ ok: boolean }>(
        'select app.outbox_mark_published($1, $2) as ok',
        [id, 'lease-2'],
      );
      expect(kept.rows[0]?.ok).toBe(true);
      await client.query('commit');
    } finally {
      await client.end();
    }

    expect(await eventState(id)).toMatchObject({ status: 'published', attempts: 2 });
  });
});

describe('outbox worker passes', () => {
  test('tenant A cannot claim or observe tenant B events', async () => {
    const idA = await insertEvent(fx().a.tenantId, 'isolation.a');
    const idB = await insertEvent(fx().b.tenantId, 'isolation.b');
    await insertEvent(fx().b.tenantId, 'xtenant.b');
    const seen: OutboxEvent[] = [];

    const result = await runOutboxPass(workerPool(), fx().a.tenantId, {
      workerId: 'iso-1',
      handlers: baseHandlers({
        'isolation.a': (event) => {
          seen.push(event);
        },
      }),
    });

    expect(result.claimed).toBe(1);
    expect(result.handled).toBe(1);
    expect(result.skipped).toBeNull();
    expect(seen.map((event) => event.id)).toEqual([idA]);
    expect(seen.every((event) => event.type !== 'isolation.b')).toBe(true);

    // Tenant B's events are untouched: not claimed, not leased, not seen.
    expect(await eventState(idB)).toMatchObject({
      status: 'pending',
      attempts: 0,
      lease_owner: null,
    });
  });

  test('a throwing handler is retried with backoff and reaches dead after max attempts', async () => {
    const id = await insertEvent(fx().a.tenantId, 'retry.always-throws');
    let calls = 0;
    const failing = (): void => {
      calls += 1;
      throw new Error('handler always fails');
    };
    const options = {
      workerId: 'dead-1',
      handlers: baseHandlers({ 'retry.always-throws': failing }),
      maxAttempts: 2,
      backoffSeconds: 1,
    };

    const first = await runOutboxPass(workerPool(), fx().a.tenantId, options);
    expect(first).toMatchObject({ claimed: 1, retried: 1, dead: 0 });
    expect(await eventState(id)).toMatchObject({
      status: 'pending',
      attempts: 1,
      last_error: 'handler always fails',
    });

    await sleep(1_300);
    const second = await runOutboxPass(workerPool(), fx().a.tenantId, options);
    expect(second).toMatchObject({ claimed: 1, retried: 0, dead: 1 });
    expect(calls).toBe(2);
    expect(await eventState(id)).toMatchObject({
      status: 'dead',
      attempts: 2,
      last_error: 'handler always fails',
    });

    const third = await runOutboxPass(workerPool(), fx().a.tenantId, {
      workerId: 'dead-1',
      handlers: baseHandlers(),
      maxAttempts: 2,
    });
    expect(third).toMatchObject({ claimed: 0, dead: 0 });
    expect(calls).toBe(2);
    expect(await eventState(id)).toMatchObject({ status: 'dead', attempts: 2 });
  });

  test('a failed attempt is not claimable before its next attempt time', async () => {
    const id = await insertEvent(fx().a.tenantId, 'retry.not-before-due');
    const seen: OutboxEvent[] = [];
    const boom = (): void => {
      throw new Error('boom once');
    };
    const recording = (event: OutboxEvent): void => {
      seen.push(event);
    };

    await runOutboxPass(workerPool(), fx().a.tenantId, {
      workerId: 'backoff-1',
      handlers: baseHandlers({ 'retry.not-before-due': boom }),
      maxAttempts: 5,
      backoffSeconds: 120,
    });
    const state = await eventState(id);
    expect(state).toMatchObject({
      status: 'pending',
      attempts: 1,
      lease_owner: null,
      lease_expires_at: null,
    });
    expect((state.next_attempt_at as Date).getTime()).toBeGreaterThan(Date.now() + 100_000);

    const early = await runOutboxPass(workerPool(), fx().a.tenantId, {
      workerId: 'backoff-1',
      handlers: baseHandlers({ 'retry.not-before-due': recording }),
      maxAttempts: 5,
    });
    expect(early).toMatchObject({ claimed: 0 });
    expect(seen).toHaveLength(0);

    const owner = await ownerClient();
    try {
      await owner.query(
        "update domain_event set next_attempt_at = now() - interval '1 second' where id = $1",
        [id],
      );
    } finally {
      await owner.end();
    }

    const due = await runOutboxPass(workerPool(), fx().a.tenantId, {
      workerId: 'backoff-1',
      handlers: baseHandlers({ 'retry.not-before-due': recording }),
      maxAttempts: 5,
    });
    expect(due).toMatchObject({ claimed: 1, handled: 1 });
    expect(seen).toHaveLength(1);
    expect(await eventState(id)).toMatchObject({ status: 'published', attempts: 2 });
  });

  test('duplicate delivery through an idempotent handler produces one net effect', async () => {
    const id = await insertEvent(fx().a.tenantId, 'dupe.deliver');
    const applied = new Set<string>();
    const idempotent = (event: OutboxEvent): void => {
      applied.add(event.id);
    };
    const handlers = baseHandlers({ 'dupe.deliver': idempotent });

    const firstPass = await runOutboxPass(workerPool(), fx().a.tenantId, {
      workerId: 'dupe-1',
      handlers,
    });
    expect(firstPass).toMatchObject({ claimed: 1, handled: 1 });

    // At-least-once overlap: force the published row back to pending with an
    // expired lease, exactly what an expired-lease re-claim looks like to the
    // claim helper, and deliver it a second time.
    const owner = await ownerClient();
    try {
      await owner.query(
        `update domain_event
            set status = 'pending', published_at = null,
                lease_expires_at = now() - interval '1 second'
          where id = $1`,
        [id],
      );
    } finally {
      await owner.end();
    }

    const secondPass = await runOutboxPass(workerPool(), fx().a.tenantId, {
      workerId: 'dupe-2',
      handlers,
    });
    expect(secondPass).toMatchObject({ claimed: 1, handled: 1 });

    expect(applied.size).toBe(1);
    expect([...applied]).toEqual([id]);
    expect(await eventState(id)).toMatchObject({ status: 'published', attempts: 2 });
  });

  test('a handler whose lease expires mid-run delivers twice but publishes once', async () => {
    const id = await insertEvent(fx().a.tenantId, 'dupe.slow-handler');
    let calls = 0;
    const slow = async (): Promise<void> => {
      calls += 1;
      await sleep(1_200);
    };
    const handlers = baseHandlers({ 'dupe.slow-handler': slow });

    const first = await runOutboxPass(workerPool(), fx().a.tenantId, {
      workerId: 'slow-1',
      handlers,
      leaseSeconds: 1,
    });

    const second = await runOutboxPass(workerPool(), fx().a.tenantId, {
      workerId: 'slow-2',
      handlers,
      leaseSeconds: 60,
    });

    expect(calls).toBe(2);
    expect(first.claimed).toBe(1);
    expect(second.claimed).toBe(1);
    expect(first.handled + second.handled).toBe(1);
    expect(first.refused + second.refused).toBe(1);
    expect(await eventState(id)).toMatchObject({ status: 'published' });
  });

  test('an unentitled tenant delivers nothing while an entitlement-matched tenant does', async () => {
    const id = await insertEvent(fx().b.tenantId, 'entitlement.work');

    const denied = await runOutboxPass(workerPool(), fx().b.tenantId, {
      workerId: 'gate-1',
      gate: { module: 'people', operation: 'read' },
      handlers: baseHandlers({
        'entitlement.work': () => {
          throw new Error('must not run for an unentitled module');
        },
      }),
    });
    expect(denied).toMatchObject({ claimed: 0, handled: 0, skipped: 'entitlement_denied' });
    expect(await eventState(id)).toMatchObject({ status: 'pending', attempts: 0 });

    const allowed = await runOutboxPass(workerPool(), fx().b.tenantId, {
      workerId: 'gate-2',
      gate: { module: 'work', operation: 'read' },
      handlers: baseHandlers(),
    });
    expect(allowed).toMatchObject({ claimed: 1, handled: 1, skipped: null });
    expect(await eventState(id)).toMatchObject({ status: 'published' });
  });

  test('a suspended tenant delivers nothing', async () => {
    const id = await insertEvent(fx().suspended.tenantId, 'suspended.delivery');
    let ran = false;

    const result = await runOutboxPass(workerPool(), fx().suspended.tenantId, {
      workerId: 'suspend-1',
      handlers: baseHandlers({
        'suspended.delivery': () => {
          ran = true;
        },
      }),
    });

    expect(result).toMatchObject({ claimed: 0, handled: 0, skipped: 'platform_denied' });
    expect(ran).toBe(false);
    expect(await eventState(id)).toMatchObject({ status: 'pending', attempts: 0 });
  });
});

describe('outbox polling loop', () => {
  test('startOutboxWorker polls on its interval and stop halts it', async () => {
    const id = await insertEvent(fx().a.tenantId, 'loop.tick');
    let calls = 0;

    const worker = startOutboxWorker(workerPool(), {
      tenantIds: [fx().a.tenantId],
      workerId: 'loop-1',
      pollIntervalMs: 60,
      handlers: baseHandlers({
        'loop.tick': () => {
          calls += 1;
        },
      }),
    });

    await sleep(300);
    worker.stop();
    const callsWhileRunning = calls;
    expect(callsWhileRunning).toBeGreaterThanOrEqual(1);
    expect(await eventState(id)).toMatchObject({ status: 'published' });

    await sleep(200);
    expect(calls).toBe(callsWhileRunning);
    expect(await eventState(id)).toMatchObject({ status: 'published', attempts: 1 });
  });

  test('bad loop configuration is rejected before any query runs', () => {
    expect(() =>
      startOutboxWorker(workerPool(), {
        tenantIds: [fx().a.tenantId],
        workerId: 'bad config',
        handlers: baseHandlers(),
      }),
    ).toThrow(/workerId/);
    expect(() =>
      startOutboxWorker(workerPool(), {
        tenantIds: [fx().a.tenantId],
        workerId: 'ok',
        batchSize: 0,
        handlers: baseHandlers(),
      }),
    ).toThrow(/batchSize/);
    expect(() =>
      startOutboxWorker(workerPool(), {
        tenantIds: [fx().a.tenantId],
        workerId: 'ok',
        pollIntervalMs: 1,
        handlers: baseHandlers(),
      }),
    ).toThrow(/pollIntervalMs/);
  });
});
