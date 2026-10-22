import type { PoolClient } from 'pg';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTOR_TYPES = ['user', 'system', 'api_key', 'support'] as const;

export type AuditActorType = (typeof ACTOR_TYPES)[number];

export type AuditEventInput = {
  action: string;
  entityType: string;
  entityId?: string | null;
  actorType: AuditActorType;
  actorUserId?: string | null;
  beforeState?: unknown;
  afterState?: unknown;
  metadata?: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
};

export class InvalidAuditEventError extends Error {
  readonly code = 'INVALID_AUDIT_EVENT' as const;

  constructor(message: string) {
    super(message);
    this.name = 'InvalidAuditEventError';
  }
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidAuditEventError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function optionalUuid(value: unknown, field: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new InvalidAuditEventError(`${field} must be a UUID`);
  }
  return value;
}

function json(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

/**
 * Appends one audit row for the tenant in app.tenant_id. The tenant is never a
 * caller argument. There is no RETURNING: the runtime role has INSERT only.
 */
export async function appendAuditEvent(
  client: PoolClient,
  event: AuditEventInput,
): Promise<void> {
  const action = requiredText(event.action, 'action');
  const entityType = requiredText(event.entityType, 'entityType');

  if (!(ACTOR_TYPES as readonly string[]).includes(event.actorType)) {
    throw new InvalidAuditEventError(`Unknown actor type ${event.actorType}`);
  }

  const actorUserId = optionalUuid(event.actorUserId, 'actorUserId');
  if (event.actorType === 'user' && !actorUserId) {
    throw new InvalidAuditEventError('A user audit event requires actorUserId');
  }
  if (event.actorType === 'system' && actorUserId) {
    throw new InvalidAuditEventError('A system audit event must not set actorUserId');
  }

  const entityId = optionalUuid(event.entityId, 'entityId');

  await client.query(
    `insert into audit_event
       (tenant_id, actor_user_id, actor_type, action, entity_type, entity_id,
        before_state, after_state, metadata, ip, user_agent)
     values
       (app.current_tenant_id(), $1, $2, $3, $4, $5,
        $6::jsonb, $7::jsonb, $8::jsonb, $9::inet, $10)`,
    [
      actorUserId,
      event.actorType,
      action,
      entityType,
      entityId,
      json(event.beforeState),
      json(event.afterState),
      json(event.metadata ?? {}),
      event.ip ?? null,
      event.userAgent ?? null,
    ],
  );
}
