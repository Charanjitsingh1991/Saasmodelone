import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { appendAuditEvent } from './audit.js';
import {
  resolveModuleCatalog,
  type EntitlementSource,
} from './modules.js';

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;
const DATA_REGION_PATTERN = /^[a-z0-9-]+$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MODULE_CODE_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;

export type ProvisionTenantInput = {
  name: string;
  slug: string;
  dataRegion: string;
  ownerEmail: string;
  ownerDisplayName: string;
  modules: string[];
  isInternal?: boolean;
};

export type ProvisionTenantResult = {
  tenantId: string;
  ownerUserId: string;
  moduleCodes: string[];
};

export type ProvisioningErrorCode = 'INVALID_PROVISION_INPUT' | 'TENANT_SLUG_TAKEN' | 'OWNER_NOT_ELIGIBLE';

export class ProvisioningError extends Error {
  constructor(
    readonly code: ProvisioningErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ProvisioningError';
  }
}

function invalid(message: string): ProvisioningError {
  return new ProvisioningError('INVALID_PROVISION_INPUT', message);
}

function text(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== 'string') {
    throw invalid(`${field} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) {
    throw invalid(`${field} must be between ${min} and ${max} characters`);
  }
  return trimmed;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  const code = (error as { code: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function normalizeModules(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw invalid('modules must contain at least one module code');
  }

  const modules = value.map((code) => {
    if (typeof code !== 'string') {
      throw invalid('module codes must be strings');
    }
    const trimmed = code.trim();
    if (!MODULE_CODE_PATTERN.test(trimmed)) {
      throw invalid(`Invalid module code ${trimmed}`);
    }
    return trimmed;
  });

  const unique = new Set(modules);
  if (unique.size !== modules.length) {
    throw invalid('modules must not contain duplicates');
  }
  return modules;
}

/**
 * Owner/operator path. Never wire this into the API: it creates the tenant row
 * and owner membership, which the runtime role cannot do.
 */
export async function provisionTenant(
  pool: Pool,
  input: ProvisionTenantInput,
): Promise<ProvisionTenantResult> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw invalid('input must be an object');
  }

  const name = text(input.name, 'name', 1, 200);
  const slug = text(input.slug, 'slug', 1, 200).toLowerCase();
  if (slug.length < 3 || slug.length > 63 || !SLUG_PATTERN.test(slug)) {
    throw invalid('slug must be 3-63 characters of lowercase letters, digits and hyphens');
  }

  const dataRegion = text(input.dataRegion, 'dataRegion', 1, 64);
  if (!DATA_REGION_PATTERN.test(dataRegion)) {
    throw invalid('dataRegion must contain only lowercase letters, digits and hyphens');
  }

  const ownerEmail = text(input.ownerEmail, 'ownerEmail', 1, 320);
  if (!EMAIL_PATTERN.test(ownerEmail)) {
    throw invalid('ownerEmail is not a valid email address');
  }

  const ownerDisplayName = text(input.ownerDisplayName, 'ownerDisplayName', 1, 200);
  const modules = normalizeModules(input.modules);

  const isInternal = input.isInternal ?? false;
  if (typeof isInternal !== 'boolean') {
    throw invalid('isInternal must be a boolean');
  }

  const tenantId = randomUUID();
  const source: EntitlementSource = isInternal ? 'internal' : 'contract';

  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);

    try {
      await client.query(
        `insert into tenant (id, name, slug, data_region, status, deleted_at, is_internal)
         values ($1, $2, $3, $4, 'active', null, $5)`,
        [tenantId, name, slug, dataRegion, isInternal],
      );
    } catch (error) {
      if (errorCode(error) === '23505') {
        throw new ProvisioningError('TENANT_SLUG_TAKEN', `Tenant slug ${slug} is already taken`);
      }
      throw error;
    }

    const existingOwner = await client.query<{ id: string; status: string }>(
      'select id, status from app_user where email = $1',
      [ownerEmail],
    );

    let ownerUserId: string;
    const existing = existingOwner.rows[0];
    if (existing) {
      if (existing.status !== 'invited' && existing.status !== 'active') {
        throw new ProvisioningError(
          'OWNER_NOT_ELIGIBLE',
          `User ${ownerEmail} cannot be a tenant owner`,
        );
      }
      ownerUserId = existing.id;
    } else {
      const inserted = await client.query<{ id: string }>(
        `insert into app_user (email, display_name, status)
         values ($1, $2, 'invited')
         returning id`,
        [ownerEmail, ownerDisplayName],
      );
      const row = inserted.rows[0];
      if (!row) {
        throw new Error('Owner user insert returned no row');
      }
      ownerUserId = row.id;
    }

    await client.query(
      `insert into membership (tenant_id, user_id, role, status)
       values ($1, $2, 'owner', 'invited')`,
      [tenantId, ownerUserId],
    );

    const catalog = await resolveModuleCatalog(client, modules, { isInternal, source });

    for (const module of catalog) {
      await client.query(
        `insert into module_entitlement
           (tenant_id, module_id, status, seat_unit, starts_at, ends_at,
            source, read_until, created_by)
         values ($1, $2, 'active', $3, now(), null, $4, null, $5)`,
        [tenantId, module.id, module.defaultSeatUnit, source, ownerUserId],
      );
    }

    const moduleCodes = catalog.map((module) => module.code);

    await appendAuditEvent(client, {
      action: 'tenant.provisioned',
      entityType: 'tenant',
      entityId: tenantId,
      actorType: 'system',
      beforeState: null,
      afterState: {
        slug,
        dataRegion,
        isInternal,
        modules: catalog.map((module) => ({
          code: module.code,
          status: 'active',
          source,
        })),
      },
      metadata: { ownerUserId },
    });

    await client.query('commit');

    return { tenantId, ownerUserId, moduleCodes };
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
