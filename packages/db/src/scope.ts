import type { Pool, PoolClient } from 'pg';
import type { MembershipRole } from '@saasmodels/contracts';
import { appendAuditEvent } from './audit.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCOPE_TYPES = ['legal_entity', 'org_unit'] as const;

export type ScopeType = (typeof SCOPE_TYPES)[number];

export type ScopeAdminErrorCode =
  | 'INVALID_SCOPE_INPUT'
  | 'TENANT_NOT_FOUND'
  | 'ACTOR_NOT_OWNER'
  | 'USER_NOT_FOUND'
  | 'PERSON_NOT_FOUND'
  | 'LEGAL_ENTITY_NOT_FOUND'
  | 'ORG_UNIT_NOT_FOUND'
  | 'MEMBERSHIP_NOT_FOUND'
  | 'MEMBERSHIP_NOT_ACTIVE'
  | 'MEMBERSHIP_IS_EMPLOYEE'
  | 'PERSON_ALREADY_LINKED'
  | 'USER_ALREADY_LINKED'
  | 'SCOPE_TARGET_NOT_FOUND'
  | 'SCOPE_DUPLICATE'
  | 'SCOPE_LIST_EMPTY'
  | 'TENANT_WIDE_WITH_SCOPES';

export class ScopeAdminError extends Error {
  constructor(
    readonly code: ScopeAdminErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ScopeAdminError';
  }
}

export type ScopeValue = {
  scopeType: ScopeType;
  scopeId: string;
};

export type LinkPersonUserInput = {
  tenantId: string;
  personId: string;
  userId: string;
  actorUserId: string;
};

export type UnlinkPersonUserInput = {
  tenantId: string;
  personId: string;
  actorUserId: string;
};

export type SetMembershipScopeInput = {
  tenantId: string;
  membershipId: string;
  scopes: ScopeValue[];
  tenantWide?: boolean;
  actorUserId: string;
};

export type GetMembershipScopeInput = {
  tenantId: string;
  membershipId: string;
};

export type ScopeChangeResult = { changed: boolean };

export type MembershipScopeEntry = ScopeValue & { label: string };

export type MembershipScopeView = {
  tenantId: string;
  membershipId: string;
  role: MembershipRole;
  membershipStatus: string;
  tenantWide: boolean;
  scopes: MembershipScopeEntry[];
};

type MembershipRow = {
  id: string;
  role: string;
  status: string;
  user_status: string;
};

type ScopeStateRow = {
  scope_type: string;
  legal_entity_id: string | null;
  org_unit_id: string | null;
};

function invalid(message: string): ScopeAdminError {
  return new ScopeAdminError('INVALID_SCOPE_INPUT', message);
}

function assertInput(input: unknown): void {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw invalid('input must be an object');
  }
}

/**
 * Owner paths bypass row level security because the owner role owns the tables,
 * so every predicate here is tenant-scoped by hand. Nothing trusts a caller
 * supplied id to be inside `tenantId`.
 */
function uuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw invalid(`${field} must be a UUID`);
  }
  return value.toLowerCase();
}

function scopeKey(scope: ScopeValue): string {
  return `${scope.scopeType}:${scope.scopeId}`;
}

function sortedValues<T extends ScopeValue>(scopes: T[]): T[] {
  return [...scopes].sort((left, right) => {
    const a = scopeKey(left);
    const b = scopeKey(right);
    if (a === b) return 0;
    return a < b ? -1 : 1;
  });
}

function sameScopeSet(left: ScopeValue[], right: ScopeValue[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = sortedValues(left);
  const sortedRight = sortedValues(right);
  return sortedLeft.every(
    (scope, index) => scopeKey(scope) === scopeKey(sortedRight[index] as ScopeValue),
  );
}

function auditScopes(scopes: ScopeValue[]): { scope_type: string; id: string }[] {
  return sortedValues(scopes).map((scope) => ({
    scope_type: scope.scopeType,
    id: scope.scopeId,
  }));
}

function rowToValue(row: ScopeStateRow): ScopeValue {
  if (row.scope_type === 'legal_entity') {
    if (!row.legal_entity_id) {
      throw new Error('A legal_entity scope row is missing its legal entity id');
    }
    return { scopeType: 'legal_entity', scopeId: row.legal_entity_id };
  }
  if (!row.org_unit_id) {
    throw new Error('An org_unit scope row is missing its org unit id');
  }
  return { scopeType: 'org_unit', scopeId: row.org_unit_id };
}

function normalizeScopes(value: unknown): ScopeValue[] {
  if (!Array.isArray(value)) {
    throw invalid('scopes must be an array');
  }

  const seen = new Set<string>();
  const scopes: ScopeValue[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw invalid('each scope must be an object with scopeType and scopeId');
    }
    const candidate = entry as { scopeType?: unknown; scopeId?: unknown };
    const scopeType = candidate.scopeType;
    if (
      typeof scopeType !== 'string' ||
      !(SCOPE_TYPES as readonly string[]).includes(scopeType)
    ) {
      throw invalid('scopeType must be "legal_entity" or "org_unit"');
    }
    const scopeId = uuid(candidate.scopeId, 'scopeId');
    const key = `${scopeType}:${scopeId}`;
    if (seen.has(key)) {
      throw new ScopeAdminError(
        'SCOPE_DUPLICATE',
        `scopes repeats ${scopeType} ${scopeId}`,
      );
    }
    seen.add(key);
    scopes.push({ scopeType: scopeType as ScopeType, scopeId });
  }
  return scopes;
}

async function withScopeTransaction<T>(
  pool: Pool,
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
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

async function assertTenant(client: PoolClient, tenantId: string): Promise<void> {
  const result = await client.query<{ id: string }>(
    'select id from tenant where id = $1 and deleted_at is null',
    [tenantId],
  );
  if (!result.rows[0]) {
    throw new ScopeAdminError('TENANT_NOT_FOUND', 'Tenant does not exist or is deleted');
  }
}

async function assertActiveOwner(
  client: PoolClient,
  tenantId: string,
  actorUserId: string,
): Promise<void> {
  const result = await client.query<{ role: string; status: string; user_status: string }>(
    `select m.role, m.status, u.status as user_status
       from membership m
       join app_user u on u.id = m.user_id
      where m.tenant_id = $1 and m.user_id = $2`,
    [tenantId, actorUserId],
  );
  const row = result.rows[0];
  if (!row || row.role !== 'owner' || row.status !== 'active' || row.user_status !== 'active') {
    throw new ScopeAdminError(
      'ACTOR_NOT_OWNER',
      'The acting user is not an active owner of this tenant',
    );
  }
}

/**
 * The membership of `userId` inside `tenantId`, active for both the user and
 * the membership row. A suspended or never-accepted member is refused: an
 * employee self-link would otherwise point at an identity that cannot sign in,
 * and a scope row on an inactive membership is dead data.
 */
async function resolveActiveMembership(
  client: PoolClient,
  tenantId: string,
  userId: string,
): Promise<MembershipRow> {
  const result = await client.query<MembershipRow>(
    `select m.id, m.role, m.status, u.status as user_status
       from membership m
       join app_user u on u.id = m.user_id
      where m.tenant_id = $1 and m.user_id = $2`,
    [tenantId, userId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new ScopeAdminError(
      'MEMBERSHIP_NOT_FOUND',
      'This user is not a member of the tenant',
    );
  }
  if (row.status !== 'active' || row.user_status !== 'active') {
    throw new ScopeAdminError(
      'MEMBERSHIP_NOT_ACTIVE',
      'The membership or the user is not active',
    );
  }
  return row;
}

async function lockPerson(
  client: PoolClient,
  tenantId: string,
  personId: string,
): Promise<{ user_id: string | null }> {
  const result = await client.query<{ user_id: string | null }>(
    `select user_id from person
      where tenant_id = $1 and id = $2 and deleted_at is null
      for update`,
    [tenantId, personId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new ScopeAdminError('PERSON_NOT_FOUND', 'Person does not exist in this tenant');
  }
  return { user_id: row.user_id?.toLowerCase() ?? null };
}

async function assertUserLinksThisPerson(
  client: PoolClient,
  tenantId: string,
  userId: string,
  personId: string,
): Promise<void> {
  const result = await client.query<{ id: string }>(
    `select id from person
      where tenant_id = $1 and user_id = $2 and id <> $3`,
    [tenantId, userId, personId],
  );
  if (result.rows[0]) {
    throw new ScopeAdminError(
      'USER_ALREADY_LINKED',
      'This user is already linked to another person in the tenant',
    );
  }
}

/**
 * Owner/operator path. Never wire this into the API: saas_runtime holds no DML
 * privilege on person, so a link can only be written through an owner
 * connection, which is what makes the audit row the record of who did it.
 */
export async function linkPersonUser(
  pool: Pool,
  input: LinkPersonUserInput,
): Promise<ScopeChangeResult> {
  assertInput(input);
  const tenantId = uuid(input.tenantId, 'tenantId');
  const personId = uuid(input.personId, 'personId');
  const userId = uuid(input.userId, 'userId');
  const actorUserId = uuid(input.actorUserId, 'actorUserId');

  return withScopeTransaction(pool, tenantId, async (client) => {
    await assertTenant(client, tenantId);
    await assertActiveOwner(client, tenantId, actorUserId);
    await resolveActiveMembership(client, tenantId, userId);

    const person = await lockPerson(client, tenantId, personId);
    if (person.user_id === userId) {
      return { changed: false };
    }
    if (person.user_id) {
      throw new ScopeAdminError(
        'PERSON_ALREADY_LINKED',
        'This person is already linked to another user',
      );
    }
    await assertUserLinksThisPerson(client, tenantId, userId, personId);

    try {
      await client.query(
        `update person set user_id = $3, updated_at = now()
          where tenant_id = $1 and id = $2`,
        [tenantId, personId, userId],
      );
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code: unknown }).code === '23505'
      ) {
        throw new ScopeAdminError(
          'USER_ALREADY_LINKED',
          'This user is already linked to another person in the tenant',
        );
      }
      throw error;
    }

    await appendAuditEvent(client, {
      action: 'person.user.linked',
      entityType: 'person',
      entityId: personId,
      actorType: 'user',
      actorUserId,
      beforeState: { user_id: null },
      afterState: { user_id: userId },
    });

    return { changed: true };
  });
}

export async function unlinkPersonUser(
  pool: Pool,
  input: UnlinkPersonUserInput,
): Promise<ScopeChangeResult> {
  assertInput(input);
  const tenantId = uuid(input.tenantId, 'tenantId');
  const personId = uuid(input.personId, 'personId');
  const actorUserId = uuid(input.actorUserId, 'actorUserId');

  return withScopeTransaction(pool, tenantId, async (client) => {
    await assertTenant(client, tenantId);
    await assertActiveOwner(client, tenantId, actorUserId);

    const person = await lockPerson(client, tenantId, personId);
    if (!person.user_id) {
      return { changed: false };
    }

    await client.query(
      'update person set user_id = null, updated_at = now() where tenant_id = $1 and id = $2',
      [tenantId, personId],
    );

    await appendAuditEvent(client, {
      action: 'person.user.unlinked',
      entityType: 'person',
      entityId: personId,
      actorType: 'user',
      actorUserId,
      beforeState: { user_id: person.user_id },
      afterState: { user_id: null },
    });

    return { changed: true };
  });
}

async function assertScopeTargets(
  client: PoolClient,
  tenantId: string,
  scopes: ScopeValue[],
): Promise<void> {
  const legalEntityIds = scopes
    .filter((scope) => scope.scopeType === 'legal_entity')
    .map((scope) => scope.scopeId);
  if (legalEntityIds.length > 0) {
    const found = await client.query<{ id: string }>(
      `select id from legal_entity
        where tenant_id = $1 and id = any($2::uuid[]) and deleted_at is null`,
      [tenantId, legalEntityIds],
    );
    const present = new Set(found.rows.map((row) => row.id.toLowerCase()));
    const missing = legalEntityIds.filter((id) => !present.has(id));
    if (missing.length > 0) {
      throw new ScopeAdminError(
        'SCOPE_TARGET_NOT_FOUND',
        `Unknown or deleted legal entity scope target: ${missing.join(', ')}`,
      );
    }
  }

  const orgUnitIds = scopes
    .filter((scope) => scope.scopeType === 'org_unit')
    .map((scope) => scope.scopeId);
  if (orgUnitIds.length > 0) {
    const found = await client.query<{ id: string }>(
      `select id from org_unit
        where tenant_id = $1 and id = any($2::uuid[]) and deleted_at is null`,
      [tenantId, orgUnitIds],
    );
    const present = new Set(found.rows.map((row) => row.id.toLowerCase()));
    const missing = orgUnitIds.filter((id) => !present.has(id));
    if (missing.length > 0) {
      throw new ScopeAdminError(
        'SCOPE_TARGET_NOT_FOUND',
        `Unknown or deleted org unit scope target: ${missing.join(', ')}`,
      );
    }
  }
}

async function readScopeRows(
  client: PoolClient,
  tenantId: string,
  membershipId: string,
): Promise<ScopeValue[]> {
  const result = await client.query<ScopeStateRow>(
    `select scope_type, legal_entity_id, org_unit_id
       from membership_scope
      where tenant_id = $1 and membership_id = $2
      for update`,
    [tenantId, membershipId],
  );
  return result.rows.map(rowToValue);
}

/**
 * Full replacement of one membership's scope rows. Absence of rows is the
 * tenant-wide state and is only reachable through an explicit `tenantWide`,
 * never as the side effect of an empty list.
 */
export async function setMembershipScope(
  pool: Pool,
  input: SetMembershipScopeInput,
): Promise<ScopeChangeResult> {
  assertInput(input);
  const tenantId = uuid(input.tenantId, 'tenantId');
  const membershipId = uuid(input.membershipId, 'membershipId');
  const actorUserId = uuid(input.actorUserId, 'actorUserId');
  const scopes = normalizeScopes(input.scopes);

  const tenantWide = input.tenantWide ?? false;
  if (typeof input.tenantWide !== 'boolean' && input.tenantWide !== undefined) {
    throw invalid('tenantWide must be a boolean');
  }
  if (tenantWide && scopes.length > 0) {
    throw new ScopeAdminError(
      'TENANT_WIDE_WITH_SCOPES',
      'tenantWide cannot be combined with scope rows',
    );
  }
  if (!tenantWide && scopes.length === 0) {
    throw new ScopeAdminError(
      'SCOPE_LIST_EMPTY',
      'An empty scope list must be an explicit tenantWide: true',
    );
  }

  const desired = sortedValues(scopes);

  return withScopeTransaction(pool, tenantId, async (client) => {
    await assertTenant(client, tenantId);
    await assertActiveOwner(client, tenantId, actorUserId);

    const membership = await client.query<{ role: string; status: string }>(
      `select role, status from membership
        where tenant_id = $1 and id = $2
        for update`,
      [tenantId, membershipId],
    );
    const membershipRow = membership.rows[0];
    if (!membershipRow) {
      throw new ScopeAdminError(
        'MEMBERSHIP_NOT_FOUND',
        'Membership does not exist in this tenant',
      );
    }
    if (membershipRow.status !== 'active') {
      throw new ScopeAdminError(
        'MEMBERSHIP_NOT_ACTIVE',
        'The membership is not active',
      );
    }
    if (membershipRow.role === 'employee') {
      throw new ScopeAdminError(
        'MEMBERSHIP_IS_EMPLOYEE',
        'An employee membership is self-scope only; scope rows would be dead data',
      );
    }

    await assertScopeTargets(client, tenantId, desired);

    const current = await readScopeRows(client, tenantId, membershipId);
    if (sameScopeSet(current, desired)) {
      return { changed: false };
    }

    await client.query(
      'delete from membership_scope where tenant_id = $1 and membership_id = $2',
      [tenantId, membershipId],
    );
    for (const scope of desired) {
      await client.query(
        `insert into membership_scope
           (tenant_id, membership_id, scope_type, legal_entity_id, org_unit_id)
         values ($1, $2, $3, $4, $5)`,
        [
          tenantId,
          membershipId,
          scope.scopeType,
          scope.scopeType === 'legal_entity' ? scope.scopeId : null,
          scope.scopeType === 'org_unit' ? scope.scopeId : null,
        ],
      );
    }

    await appendAuditEvent(client, {
      action: 'membership.scope.changed',
      entityType: 'membership',
      entityId: membershipId,
      actorType: 'user',
      actorUserId,
      beforeState: auditScopes(current),
      afterState: auditScopes(desired),
    });

    return { changed: true };
  });
}

export async function getMembershipScope(
  pool: Pool,
  input: GetMembershipScopeInput,
): Promise<MembershipScopeView> {
  assertInput(input);
  const tenantId = uuid(input.tenantId, 'tenantId');
  const membershipId = uuid(input.membershipId, 'membershipId');

  return withScopeTransaction(pool, tenantId, async (client) => {
    await assertTenant(client, tenantId);

    const membership = await client.query<{ role: string; status: string }>(
      `select role, status from membership
        where tenant_id = $1 and id = $2`,
      [tenantId, membershipId],
    );
    const membershipRow = membership.rows[0];
    if (!membershipRow) {
      throw new ScopeAdminError(
        'MEMBERSHIP_NOT_FOUND',
        'Membership does not exist in this tenant',
      );
    }

    const rows = await client.query<ScopeStateRow & { label: string }>(
      `select s.scope_type, s.legal_entity_id, s.org_unit_id,
              coalesce(
                le.code || ' (' || le.name || ')',
                ou.name,
                'missing target'
              ) as label
         from membership_scope s
         left join legal_entity le
           on le.tenant_id = s.tenant_id and le.id = s.legal_entity_id
         left join org_unit ou
           on ou.tenant_id = s.tenant_id and ou.id = s.org_unit_id
        where s.tenant_id = $1 and s.membership_id = $2`,
      [tenantId, membershipId],
    );

    const entries: MembershipScopeEntry[] = rows.rows.map((row) => ({
      ...rowToValue(row),
      label: row.label,
    }));

    return {
      tenantId,
      membershipId,
      role: membershipRow.role as MembershipRole,
      membershipStatus: membershipRow.status,
      tenantWide: entries.length === 0,
      scopes: sortedValues(entries),
    };
  });
}
