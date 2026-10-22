import type { Pool, PoolClient } from 'pg';
import { appendAuditEvent } from './audit.js';
import {
  resolveModuleCatalog,
  type EntitlementSource,
  type SeatUnit,
} from './modules.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODULE_CODE_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;
const SOURCES: readonly EntitlementSource[] = ['contract', 'trial', 'internal'];
const GRANT_STATUSES = ['trialing', 'active'] as const;
const SEAT_UNITS: readonly SeatUnit[] = ['employee', 'seat', 'organisation'];

export type GrantEntitlementStatus = (typeof GRANT_STATUSES)[number];

export type EntitlementErrorCode =
  | 'INVALID_ENTITLEMENT_INPUT'
  | 'ENTITLEMENT_NOT_FOUND'
  | 'TENANT_NOT_FOUND'
  | 'ACTOR_NOT_ELIGIBLE';

export class EntitlementError extends Error {
  constructor(
    readonly code: EntitlementErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'EntitlementError';
  }
}

export type GrantEntitlementInput = {
  tenantId: string;
  moduleCode: string;
  actorUserId: string;
  source?: EntitlementSource;
  status?: GrantEntitlementStatus;
  startsAt?: Date;
  endsAt?: Date | null;
  seatUnit?: SeatUnit;
  seatCount?: number | null;
  contractRef?: string | null;
};

export type CancelEntitlementInput = {
  tenantId: string;
  moduleCode: string;
  actorUserId: string;
  readUntil: Date;
  reason?: string;
};

type EntitlementRow = {
  id: string;
  status: string;
  source: string;
  starts_at: Date;
  ends_at: Date | null;
  read_until: Date | null;
  seat_unit: string;
  seat_count: number | null;
};

type EntitlementSnapshot = {
  status: string;
  source: string;
  starts_at: string;
  ends_at: string | null;
  read_until: string | null;
  seat_unit: string;
  seat_count: number | null;
};

function invalid(message: string): EntitlementError {
  return new EntitlementError('INVALID_ENTITLEMENT_INPUT', message);
}

function uuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw invalid(`${field} must be a UUID`);
  }
  return value;
}

function moduleCode(value: unknown): string {
  if (typeof value !== 'string' || !MODULE_CODE_PATTERN.test(value)) {
    throw invalid('moduleCode is invalid');
  }
  return value;
}

function date(value: unknown, field: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw invalid(`${field} must be a valid date`);
  }
  return value;
}

function snapshot(row: EntitlementRow): EntitlementSnapshot {
  return {
    status: row.status,
    source: row.source,
    starts_at: row.starts_at.toISOString(),
    ends_at: row.ends_at?.toISOString() ?? null,
    read_until: row.read_until?.toISOString() ?? null,
    seat_unit: row.seat_unit,
    seat_count: row.seat_count,
  };
}

async function assertEligibleActor(client: PoolClient, actorUserId: string): Promise<void> {
  const result = await client.query<{ status: string }>(
    'select status from app_user where id = $1',
    [actorUserId],
  );
  const status = result.rows[0]?.status;
  if (!status || status === 'disabled' || status === 'suspended') {
    throw new EntitlementError(
      'ACTOR_NOT_ELIGIBLE',
      'The acting user does not exist or is not eligible',
    );
  }
}

async function assertTenant(client: PoolClient, tenantId: string): Promise<{ isInternal: boolean }> {
  const result = await client.query<{ is_internal: boolean }>(
    'select is_internal from tenant where id = $1 and deleted_at is null',
    [tenantId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new EntitlementError('TENANT_NOT_FOUND', 'Tenant does not exist or is deleted');
  }
  return { isInternal: row.is_internal };
}

export async function grantEntitlement(
  pool: Pool,
  input: GrantEntitlementInput,
): Promise<void> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw invalid('input must be an object');
  }

  const tenantId = uuid(input.tenantId, 'tenantId');
  const actorUserId = uuid(input.actorUserId, 'actorUserId');
  const code = moduleCode(input.moduleCode);

  const source = input.source ?? 'contract';
  if (!SOURCES.includes(source)) {
    throw invalid('source is invalid');
  }

  const status = input.status ?? 'active';
  if (!(GRANT_STATUSES as readonly string[]).includes(status)) {
    throw invalid('status is invalid');
  }

  const startsAt = input.startsAt === undefined ? new Date() : date(input.startsAt, 'startsAt');
  const endsAt = input.endsAt === undefined || input.endsAt === null
    ? null
    : date(input.endsAt, 'endsAt');
  if (endsAt && endsAt.getTime() <= startsAt.getTime()) {
    throw invalid('endsAt must be after startsAt');
  }
  if (status === 'trialing' && endsAt === null) {
    throw invalid('A trialing entitlement requires endsAt');
  }

  if (input.seatUnit !== undefined && !SEAT_UNITS.includes(input.seatUnit)) {
    throw invalid('seatUnit is invalid');
  }

  const seatCount = input.seatCount ?? null;
  if (seatCount !== null && (!Number.isInteger(seatCount) || seatCount <= 0)) {
    throw invalid('seatCount must be a positive integer');
  }

  const contractRef = input.contractRef ?? null;
  if (contractRef !== null && typeof contractRef !== 'string') {
    throw invalid('contractRef must be a string');
  }

  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);

    const tenant = await assertTenant(client, tenantId);
    if (!tenant.isInternal && source === 'internal') {
      throw invalid('source "internal" requires an internal tenant');
    }
    await assertEligibleActor(client, actorUserId);

    const [module] = await resolveModuleCatalog(client, [code], {
      isInternal: tenant.isInternal,
      source,
    });
    if (!module) {
      throw new EntitlementError('ENTITLEMENT_NOT_FOUND', 'Module was not resolved');
    }

    const beforeResult = await client.query<EntitlementRow>(
      `select id, status, source, starts_at, ends_at, read_until, seat_unit, seat_count
         from module_entitlement
        where tenant_id = $1 and module_id = $2
        for update`,
      [tenantId, module.id],
    );
    const before = beforeResult.rows[0];

    const afterResult = await client.query<EntitlementRow>(
      `insert into module_entitlement
         (tenant_id, module_id, status, seat_unit, seat_count, starts_at, ends_at,
          source, contract_ref, read_until, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, null, $10)
       on conflict (tenant_id, module_id) do update
         set status = excluded.status,
             seat_unit = excluded.seat_unit,
             seat_count = excluded.seat_count,
             starts_at = excluded.starts_at,
             ends_at = excluded.ends_at,
             source = excluded.source,
             contract_ref = excluded.contract_ref,
             read_until = null
       returning id, status, source, starts_at, ends_at, read_until, seat_unit, seat_count`,
      [
        tenantId,
        module.id,
        status,
        input.seatUnit ?? module.defaultSeatUnit,
        seatCount,
        startsAt,
        endsAt,
        source,
        contractRef,
        actorUserId,
      ],
    );
    const after = afterResult.rows[0];
    if (!after) {
      throw new Error('Entitlement insert returned no row');
    }

    await appendAuditEvent(client, {
      action: 'module_entitlement.granted',
      entityType: 'module_entitlement',
      entityId: after.id,
      actorType: 'user',
      actorUserId,
      beforeState: before ? snapshot(before) : null,
      afterState: snapshot(after),
      metadata: { moduleCode: code },
    });

    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function cancelEntitlement(
  pool: Pool,
  input: CancelEntitlementInput,
): Promise<void> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw invalid('input must be an object');
  }

  const tenantId = uuid(input.tenantId, 'tenantId');
  const actorUserId = uuid(input.actorUserId, 'actorUserId');
  const code = moduleCode(input.moduleCode);
  const readUntil = date(input.readUntil, 'readUntil');

  if (readUntil.getTime() <= Date.now()) {
    throw invalid('readUntil must be in the future');
  }

  if (input.reason !== undefined && typeof input.reason !== 'string') {
    throw invalid('reason must be a string');
  }

  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);

    await assertTenant(client, tenantId);
    await assertEligibleActor(client, actorUserId);

    const beforeResult = await client.query<EntitlementRow>(
      `select e.id, e.status, e.source, e.starts_at, e.ends_at, e.read_until, e.seat_unit,
              e.seat_count
         from module_entitlement e
         join platform_module m on m.id = e.module_id
        where e.tenant_id = $1 and m.code = $2
        for update of e`,
      [tenantId, code],
    );
    const before = beforeResult.rows[0];
    if (!before) {
      throw new EntitlementError(
        'ENTITLEMENT_NOT_FOUND',
        `Tenant has no entitlement for module ${code}`,
      );
    }

    const afterResult = await client.query<EntitlementRow>(
      `update module_entitlement
          set status = 'cancelled',
              read_until = $2
        where id = $1
        returning id, status, source, starts_at, ends_at, read_until, seat_unit, seat_count`,
      [before.id, readUntil],
    );
    const after = afterResult.rows[0];
    if (!after) {
      throw new Error('Entitlement update returned no row');
    }

    await appendAuditEvent(client, {
      action: 'module_entitlement.cancelled',
      entityType: 'module_entitlement',
      entityId: after.id,
      actorType: 'user',
      actorUserId,
      beforeState: snapshot(before),
      afterState: snapshot(after),
      metadata:
        input.reason === undefined
          ? { moduleCode: code }
          : { moduleCode: code, reason: input.reason },
    });

    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
