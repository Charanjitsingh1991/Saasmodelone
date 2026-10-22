import type { Pool, PoolClient } from 'pg';
import {
  withTenantTransaction,
  type TenantGate,
} from '@saasmodels/db';

export const workerName = 'SaaSModels One worker';

export type TenantJob<T> = {
  tenantId: string;
  gate?: TenantGate;
  run: (client: PoolClient) => Promise<T>;
};

export async function runTenantJob<T>(
  pool: Pool,
  job: TenantJob<T>,
): Promise<T> {
  return withTenantTransaction(
    pool,
    { tenantId: job.tenantId, gate: job.gate },
    job.run,
  );
}
