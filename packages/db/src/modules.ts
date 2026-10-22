import type { PoolClient } from 'pg';

export type ModuleStatus = 'available' | 'preview' | 'planned' | 'retired';
export type EntitlementSource = 'contract' | 'trial' | 'internal';
export type SeatUnit = 'employee' | 'seat' | 'organisation';

export type CatalogModule = {
  id: string;
  code: string;
  status: ModuleStatus;
  isLicensable: boolean;
  defaultSeatUnit: SeatUnit;
};

export type ModuleCatalogErrorCode =
  | 'MODULE_UNKNOWN'
  | 'MODULE_NOT_LICENSABLE'
  | 'MODULE_NOT_AVAILABLE';

export class ModuleCatalogError extends Error {
  constructor(
    readonly code: ModuleCatalogErrorCode,
    readonly moduleCode: string,
    message: string,
  ) {
    super(message);
    this.name = 'ModuleCatalogError';
  }
}

/**
 * Resolves module codes against the catalog and applies the licensing rules
 * shared by provisioning and entitlement changes. Planned modules require both
 * an internal tenant and an internal-source entitlement.
 */
export async function resolveModuleCatalog(
  client: PoolClient,
  codes: string[],
  options: { isInternal: boolean; source: EntitlementSource },
): Promise<CatalogModule[]> {
  const result = await client.query<CatalogModule>(
    `select id,
            code,
            status,
            is_licensable as "isLicensable",
            default_seat_unit as "defaultSeatUnit"
       from platform_module
      where code = any($1::text[])
      order by code`,
    [codes],
  );
  const byCode = new Map(result.rows.map((row) => [row.code, row]));

  const unknown = codes.find((code) => !byCode.has(code));
  if (unknown !== undefined) {
    throw new ModuleCatalogError('MODULE_UNKNOWN', unknown, `Unknown module ${unknown}`);
  }

  const modules = codes.map((code) => {
    const module = byCode.get(code);
    if (!module) {
      throw new ModuleCatalogError('MODULE_UNKNOWN', code, `Unknown module ${code}`);
    }
    return module;
  });

  for (const module of modules) {
    if (!module.isLicensable) {
      throw new ModuleCatalogError(
        'MODULE_NOT_LICENSABLE',
        module.code,
        `Module ${module.code} is not licensable`,
      );
    }
    if (module.status === 'retired') {
      throw new ModuleCatalogError(
        'MODULE_NOT_AVAILABLE',
        module.code,
        `Module ${module.code} is retired`,
      );
    }
    if (
      module.status === 'planned' &&
      (!options.isInternal || options.source !== 'internal')
    ) {
      throw new ModuleCatalogError(
        'MODULE_NOT_AVAILABLE',
        module.code,
        `Module ${module.code} requires an internal tenant and an internal-source entitlement`,
      );
    }
  }

  return modules;
}
