import { isIP } from 'node:net';
import { PERMISSIONS } from '@saasmodels/contracts';
import { appendAuditEvent } from './audit.js';
import type { ModuleOperation, RuntimePool } from './tenant.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODULE_CODE_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;
const METHOD_PATTERN = /^[A-Z][A-Z0-9-]{0,31}$/;

export const ACCESS_DENIAL_REASONS = [
  'MEMBERSHIP_DENIED',
  'PLATFORM_ACCESS_DENIED',
  'MODULE_NOT_ENTITLED',
  'ROLE_DENIED',
] as const;

export type AccessDenialReason = (typeof ACCESS_DENIAL_REASONS)[number];

export type AccessDenialInput = {
  tenantId: string;
  userId: string;
  reason: AccessDenialReason;
  method: string;
  path: string;
  module?: string;
  operation?: ModuleOperation;
  permission?: string;
  ip?: string | null;
  userAgent?: string | null;
};

function requiredUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new TypeError(`${field} must be a UUID`);
  }
  return value;
}

function requiredMethod(value: unknown): string {
  if (typeof value !== 'string' || !METHOD_PATTERN.test(value)) {
    throw new TypeError('method must be an upper-case HTTP method');
  }
  return value;
}

function requiredPath(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.startsWith('/') ||
    value.includes('?') ||
    value.includes('#')
  ) {
    throw new TypeError('path must start with / and carry no query or fragment');
  }
  return value;
}

function optionalIp(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string' || isIP(value) === 0) {
    throw new TypeError('ip must be an IP address or null');
  }
  return value;
}

function optionalUserAgent(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new TypeError('userAgent must be a string or null');
  }
  return value;
}

/**
 * Records one authenticated access denial on its own runtime transaction.
 * This cannot use withTenantTransaction: that path re-checks platform access
 * (the very condition being denied) and would suppress the row. Membership is
 * not required either, because a missing membership may be the denial reason.
 */
export async function recordAccessDenial(
  pool: RuntimePool,
  input: AccessDenialInput,
): Promise<void> {
  const tenantId = requiredUuid(input.tenantId, 'tenantId');
  const userId = requiredUuid(input.userId, 'userId');
  const method = requiredMethod(input.method);
  const path = requiredPath(input.path);

  if (!(ACCESS_DENIAL_REASONS as readonly string[]).includes(input.reason)) {
    throw new TypeError('reason is not a known access denial reason');
  }

  if (
    input.module !== undefined &&
    (typeof input.module !== 'string' || !MODULE_CODE_PATTERN.test(input.module))
  ) {
    throw new TypeError('module must be a module code');
  }
  if (
    input.operation !== undefined &&
    input.operation !== 'read' &&
    input.operation !== 'write'
  ) {
    throw new TypeError('operation must be read or write');
  }
  if (
    input.permission !== undefined &&
    (typeof input.permission !== 'string' ||
      !(PERMISSIONS as readonly string[]).includes(input.permission))
  ) {
    // The published list, not a shape: a dotted-name regex that assumed
    // module.operation would silently reject people.compensation.read, and the
    // rejection lands in a catch that only logs, so the denial row would simply
    // never appear.
    throw new TypeError('permission must be a published permission');
  }

  const metadata: Record<string, unknown> = { reason: input.reason, method, path };
  if (input.module !== undefined) {
    metadata.module = input.module;
  }
  if (input.operation !== undefined) {
    metadata.operation = input.operation;
  }
  if (input.reason === 'ROLE_DENIED' && input.permission !== undefined) {
    metadata.permission = input.permission;
  }

  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
    await client.query("select set_config('app.user_id', $1, true)", [userId]);
    await appendAuditEvent(client, {
      action: 'authorization.denied',
      entityType: 'request',
      entityId: null,
      actorType: 'user',
      actorUserId: userId,
      metadata,
      ip: optionalIp(input.ip),
      userAgent: optionalUserAgent(input.userAgent),
    });
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
