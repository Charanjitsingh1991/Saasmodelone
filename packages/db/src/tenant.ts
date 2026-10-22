import { Pool, type PoolClient } from 'pg';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODULE_CODE_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;

export type ModuleOperation = 'read' | 'write';

export type TenantGate = {
  module: string;
  operation: ModuleOperation;
};

export type TenantTransactionOptions = {
  tenantId: string;
  gate?: TenantGate;
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

export function createRuntimePool(connectionString: string): Pool {
  return new Pool({
    connectionString,
    max: 5,
    idleTimeoutMillis: 10_000,
    application_name: 'saasmodels-runtime',
  });
}

function oneAllowed(rows: { allowed: boolean }[]): boolean {
  const row = rows[0];
  if (!row) {
    throw new Error('Access helper returned no row');
  }
  return row.allowed;
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

export async function withTenantTransaction<T>(
  pool: Pool,
  options: TenantTransactionOptions,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const { tenantId, gate } = options;

  if (typeof tenantId !== 'string' || !UUID_PATTERN.test(tenantId)) {
    throw new InvalidTenantContextError();
  }
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
