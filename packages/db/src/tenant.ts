import {
  hasPermission,
  MEMBERSHIP_ROLES,
  permissionFor,
  type MembershipRole,
  type ModuleOperation,
} from '@saasmodels/contracts';
import { Pool, type PoolClient } from 'pg';

export type { MembershipRole, ModuleOperation } from '@saasmodels/contracts';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODULE_CODE_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;

declare const runtimePoolBrand: unique symbol;

export type RuntimePool = Pool & { readonly [runtimePoolBrand]: true };

export type MemberContext = {
  role: MembershipRole;
};

export type TenantGate = {
  module: string;
  operation: ModuleOperation;
};

export type TenantTransactionOptions = {
  tenantId: string;
  gate?: TenantGate;
};

export type MemberTransactionOptions = TenantTransactionOptions & {
  userId: string;
};

export class InvalidTenantContextError extends Error {
  readonly code = 'INVALID_TENANT_CONTEXT' as const;

  constructor(message = 'Invalid tenant context') {
    super(message);
    this.name = 'InvalidTenantContextError';
  }
}

export class PlatformAccessDeniedError extends Error {
  readonly code = 'PLATFORM_ACCESS_DENIED' as const;

  constructor(message = 'Platform access denied') {
    super(message);
    this.name = 'PlatformAccessDeniedError';
  }
}

export class ModuleAccessDeniedError extends Error {
  readonly code = 'MODULE_NOT_ENTITLED' as const;

  constructor(
    readonly module: string,
    readonly operation: ModuleOperation,
    message = `Module ${operation} access denied`,
  ) {
    super(message);
    this.name = 'ModuleAccessDeniedError';
  }
}

export class RoleAccessDeniedError extends Error {
  readonly code = 'ROLE_DENIED' as const;

  constructor(
    readonly module: string,
    readonly operation: ModuleOperation,
    readonly permission: string,
    message = `Role is not permitted to ${operation} ${module}`,
  ) {
    super(message);
    this.name = 'RoleAccessDeniedError';
  }
}

export class MembershipDeniedError extends Error {
  readonly code = 'MEMBERSHIP_DENIED' as const;

  constructor(message = 'Membership denied') {
    super(message);
    this.name = 'MembershipDeniedError';
  }
}

export class InvalidMembershipRoleError extends Error {
  readonly code = 'INVALID_MEMBERSHIP_ROLE' as const;

  constructor(message = 'Membership role is not recognised') {
    super(message);
    this.name = 'InvalidMembershipRoleError';
  }
}

export function createRuntimePool(connectionString: string): RuntimePool {
  const pool = new Pool({
    connectionString,
    max: 5,
    idleTimeoutMillis: 10_000,
    application_name: 'saasmodels-runtime',
  });
  return pool as RuntimePool;
}

function oneAllowed(rows: { allowed: boolean }[]): boolean {
  const row = rows[0];
  if (!row) {
    throw new Error('Access helper returned no row');
  }
  return row.allowed;
}

function assertUuid(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new InvalidTenantContextError();
  }
}

function assertGate(gate: TenantGate): void {
  if (
    typeof gate.module !== 'string' ||
    !MODULE_CODE_PATTERN.test(gate.module) ||
    (gate.operation !== 'read' && gate.operation !== 'write')
  ) {
    throw new ModuleAccessDeniedError(gate.module, gate.operation);
  }
}

function assertMembershipRole(value: string | null | undefined): MembershipRole {
  if (!value || !(MEMBERSHIP_ROLES as readonly string[]).includes(value)) {
    throw new InvalidMembershipRoleError();
  }
  return value as MembershipRole;
}

/**
 * System and background access only. This path checks the tenant and module
 * entitlements but not a user membership or role; request routes must use
 * withMemberTransaction or they lose role enforcement.
 */
export async function withTenantTransaction<T>(
  pool: RuntimePool,
  options: TenantTransactionOptions,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const { tenantId, gate } = options;

  assertUuid(tenantId);
  if (gate) {
    assertGate(gate);
  }

  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);

    const platform = await client.query<{ allowed: boolean }>(
      'select app.has_platform_access() as allowed',
    );
    if (!oneAllowed(platform.rows)) {
      throw new PlatformAccessDeniedError();
    }

    if (gate) {
      const check =
        gate.operation === 'read'
          ? 'select app.has_module_read($1) as allowed'
          : 'select app.has_module_write($1) as allowed';
      const module = await client.query<{ allowed: boolean }>(check, [gate.module]);
      if (!oneAllowed(module.rows)) {
        throw new ModuleAccessDeniedError(gate.module, gate.operation);
      }
    }

    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Member request access. Resolves membership, then tenant platform access, then
 * the module entitlement, then the member role's permission, in that order.
 * Any member route that reads or writes module data must pass a gate; an
 * ungated call runs with no role authorization.
 */
export async function withMemberTransaction<T>(
  pool: RuntimePool,
  options: MemberTransactionOptions,
  fn: (client: PoolClient, member: MemberContext) => Promise<T>,
): Promise<T> {
  const { tenantId, userId, gate } = options;

  assertUuid(tenantId);
  assertUuid(userId);
  if (gate) {
    assertGate(gate);
  }

  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
    await client.query("select set_config('app.user_id', $1, true)", [userId]);

    // Membership resolves before the platform check so a non-member cannot
    // probe whether the tenant exists, is suspended, closed or deleted.
    const membership = await client.query<{ role: string | null }>(
      'select app.current_member_role() as role',
    );
    const role = membership.rows[0]?.role;
    if (!role) {
      throw new MembershipDeniedError();
    }
    const member: MemberContext = { role: assertMembershipRole(role) };

    const platform = await client.query<{ allowed: boolean }>(
      'select app.has_platform_access() as allowed',
    );
    if (!oneAllowed(platform.rows)) {
      throw new PlatformAccessDeniedError();
    }

    if (gate) {
      const check =
        gate.operation === 'read'
          ? 'select app.has_module_read($1) as allowed'
          : 'select app.has_module_write($1) as allowed';
      const module = await client.query<{ allowed: boolean }>(check, [gate.module]);
      if (!oneAllowed(module.rows)) {
        throw new ModuleAccessDeniedError(gate.module, gate.operation);
      }

      // The entitlement check comes first so an unentitled module never
      // discloses which roles could use it.
      const permission = permissionFor(gate.module, gate.operation);
      if (!permission || !hasPermission(member.role, permission)) {
        throw new RoleAccessDeniedError(
          gate.module,
          gate.operation,
          permission ?? `${gate.module}.${gate.operation}`,
        );
      }
    }

    const result = await fn(client, member);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
