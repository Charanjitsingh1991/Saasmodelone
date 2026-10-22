import { createHash, randomBytes } from 'node:crypto';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import { Pool, type PoolClient } from 'pg';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

// Argon2id is value 2 in the PHC/NAPI enum. The const enum cannot be
// referenced under verbatimModuleSyntax, so the documented value is used.
const ARGON2_OPTIONS = {
  algorithm: 2,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
};

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export type AuthErrorCode =
  | 'INVALID_CREDENTIALS'
  | 'INVITATION_INVALID'
  | 'INVALID_PASSWORD'
  | 'INVALID_INVITATION_INPUT'
  | 'SESSION_INVALID';

export class AuthError extends Error {
  constructor(
    readonly code: AuthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

declare const authPoolBrand: unique symbol;

export type AuthPool = Pool & { readonly [authPoolBrand]: true };

export type LoginInput = {
  email: string;
  password: string;
  tenantSlug: string;
  ip?: string | null;
  userAgent?: string | null;
  now?: Date;
};

export type SessionInfo = {
  token: string;
  csrfToken: string;
  expiresAt: Date;
  userId: string;
  tenantId: string;
};

export type SessionRecord = {
  sessionId: string;
  userId: string;
  tenantId: string;
  csrfToken: string;
  expiresAt: Date;
};

export type AcceptInvitationInput = {
  token: string;
  password: string;
  ip?: string | null;
  userAgent?: string | null;
  now?: Date;
};

export type CreateInvitationInput = {
  tenantSlug?: string;
  tenantId?: string;
  email: string;
  expiresInDays?: number;
  createdBy?: string;
};

export type CreatedInvitation = {
  invitationId: string;
  token: string;
  expiresAt: Date;
};

type CredentialRow = {
  user_id: string;
  password_hash: string | null;
  user_status: string;
  membership_status: string;
};

type TenantRow = {
  id: string;
  slug: string;
  status: string;
  deleted_at: Date | null;
};

let dummyHashPromise: Promise<string> | undefined;

function invalidPassword(message: string): AuthError {
  return new AuthError('INVALID_PASSWORD', message);
}

function invalidInvitation(message: string): AuthError {
  return new AuthError('INVALID_INVITATION_INPUT', message);
}

function dummyHash(): Promise<string> {
  dummyHashPromise ??= hashPassword('not-a-real-user-password');
  return dummyHashPromise;
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

function sessionExpiry(now: Date): Date {
  return new Date(now.getTime() + SESSION_TTL_MS);
}

function normalizeEmail(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function uuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw invalidInvitation(`${field} must be a UUID`);
  }
  return value;
}

async function insertSession(
  client: PoolClient,
  input: {
    userId: string;
    tenantId: string;
    now: Date;
    ip?: string | null;
    userAgent?: string | null;
  },
): Promise<SessionInfo> {
  const token = randomToken();
  const csrfToken = randomToken();
  const expiresAt = sessionExpiry(input.now);
  await client.query(
    `insert into auth_session
       (user_id, tenant_id, token_hash, csrf_token, created_at, expires_at, ip, user_agent)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      input.userId,
      input.tenantId,
      tokenHash(token),
      csrfToken,
      input.now,
      expiresAt,
      input.ip ?? null,
      input.userAgent ?? null,
    ],
  );
  return {
    token,
    csrfToken,
    expiresAt,
    userId: input.userId,
    tenantId: input.tenantId,
  };
}

export function createAuthPool(connectionString: string): AuthPool {
  const pool = new Pool({
    connectionString,
    max: 5,
    idleTimeoutMillis: 10_000,
    application_name: 'saasmodels-auth',
  });
  return pool as AuthPool;
}

export async function hashPassword(password: string): Promise<string> {
  if (
    typeof password !== 'string' ||
    password.length < PASSWORD_MIN_LENGTH ||
    password.length > PASSWORD_MAX_LENGTH
  ) {
    throw invalidPassword(
      `Password must be between ${PASSWORD_MIN_LENGTH} and ${PASSWORD_MAX_LENGTH} characters`,
    );
  }
  return argonHash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  if (typeof hash !== 'string' || typeof password !== 'string') {
    return false;
  }
  try {
    return await argonVerify(hash, password);
  } catch {
    return false;
  }
}

export async function login(
  authPool: AuthPool,
  input: LoginInput,
): Promise<SessionInfo | null> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return null;
  }

  const email = normalizeEmail(input.email);
  const tenantSlug = typeof input.tenantSlug === 'string' ? input.tenantSlug.trim() : '';
  const password = typeof input.password === 'string' ? input.password : '';
  const now = input.now ?? new Date();

  if (
    email.length === 0 ||
    email.length > 320 ||
    tenantSlug.length < 3 ||
    tenantSlug.length > 63 ||
    !SLUG_PATTERN.test(tenantSlug) ||
    password.length === 0 ||
    password.length > PASSWORD_MAX_LENGTH
  ) {
    await verifyPassword(await dummyHash(), password);
    return null;
  }

  const client = await authPool.connect();
  try {
    await client.query('begin');

    const tenantResult = await client.query<TenantRow>(
      `select id, slug, status, deleted_at
         from app.auth_tenant_by_slug($1)`,
      [tenantSlug],
    );
    const tenant = tenantResult.rows[0];

    let credentials: CredentialRow | undefined;
    if (tenant) {
      const credentialResult = await client.query<CredentialRow>(
        `select user_id, password_hash, user_status, membership_status
           from app.auth_credentials($1, $2)`,
        [tenant.id, email],
      );
      credentials = credentialResult.rows[0];
    }

    const hash = credentials?.password_hash ?? (await dummyHash());
    const passwordValid = await verifyPassword(hash, password);

    if (
      !tenant ||
      tenant.deleted_at !== null ||
      !credentials ||
      !passwordValid ||
      credentials.user_status !== 'active' ||
      credentials.membership_status !== 'active'
    ) {
      await client.query('rollback');
      return null;
    }

    await client.query('update app_user set last_login_at = $2 where id = $1', [
      credentials.user_id,
      now,
    ]);

    const session = await insertSession(client, {
      userId: credentials.user_id,
      tenantId: tenant.id,
      now,
      ip: input.ip,
      userAgent: input.userAgent,
    });

    await client.query('commit');
    return session;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function findSession(
  authPool: AuthPool,
  token: string,
): Promise<SessionRecord | null> {
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) {
    return null;
  }

  const result = await authPool.query<{
    id: string;
    user_id: string;
    tenant_id: string;
    csrf_token: string;
    expires_at: Date;
  }>(
    `select s.id, s.user_id, s.tenant_id, s.csrf_token, s.expires_at
       from auth_session s
       join app_user u on u.id = s.user_id
      where s.token_hash = $1
        and s.revoked_at is null
        and s.expires_at > now()
        and u.status = 'active'
      limit 1`,
    [tokenHash(token)],
  );

  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return {
    sessionId: row.id,
    userId: row.user_id,
    tenantId: row.tenant_id,
    csrfToken: row.csrf_token,
    expiresAt: row.expires_at,
  };
}

export async function revokeSession(authPool: AuthPool, token: string): Promise<void> {
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) {
    return;
  }
  await authPool.query(
    `update auth_session
        set revoked_at = now()
      where token_hash = $1 and revoked_at is null`,
    [tokenHash(token)],
  );
}

export async function createInvitation(
  ownerPool: Pool,
  input: CreateInvitationInput,
): Promise<CreatedInvitation> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw invalidInvitation('input must be an object');
  }

  const email = normalizeEmail(input.email);
  if (email.length === 0 || email.length > 320 || !EMAIL_PATTERN.test(email)) {
    throw invalidInvitation('email is not a valid email address');
  }

  const slugInput = typeof input.tenantSlug === 'string' ? input.tenantSlug.trim() : '';
  const idInput = typeof input.tenantId === 'string' ? input.tenantId.trim() : '';
  if ((slugInput.length === 0) === (idInput.length === 0)) {
    throw invalidInvitation('Provide exactly one of tenantSlug or tenantId');
  }
  if (
    slugInput.length > 0 &&
    (slugInput.length < 3 || slugInput.length > 63 || !SLUG_PATTERN.test(slugInput))
  ) {
    throw invalidInvitation('tenantSlug is invalid');
  }
  if (idInput.length > 0 && !UUID_PATTERN.test(idInput)) {
    throw invalidInvitation('tenantId must be a UUID');
  }

  const expiresInDays = input.expiresInDays ?? 7;
  if (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 30) {
    throw invalidInvitation('expiresInDays must be an integer between 1 and 30');
  }

  const createdBy = input.createdBy === undefined ? null : uuid(input.createdBy, 'createdBy');
  const token = randomToken();

  const client = await ownerPool.connect();
  try {
    await client.query('begin');

    const membershipResult = idInput
      ? await client.query<{
          tenant_id: string;
          user_id: string;
          membership_status: string;
          user_status: string;
          has_password: boolean;
          deleted_at: Date | null;
        }>(
          `select t.id as tenant_id, m.user_id, m.status as membership_status,
                  u.status as user_status, u.password_hash is not null as has_password,
                  t.deleted_at
             from tenant t
             join membership m on m.tenant_id = t.id
             join app_user u on u.id = m.user_id
            where t.id = $1 and u.email = $2
            for update of m`,
          [idInput, email],
        )
      : await client.query<{
          tenant_id: string;
          user_id: string;
          membership_status: string;
          user_status: string;
          has_password: boolean;
          deleted_at: Date | null;
        }>(
          `select t.id as tenant_id, m.user_id, m.status as membership_status,
                  u.status as user_status, u.password_hash is not null as has_password,
                  t.deleted_at
             from tenant t
             join membership m on m.tenant_id = t.id
             join app_user u on u.id = m.user_id
            where t.slug = $1 and u.email = $2
            for update of m`,
          [slugInput, email],
        );
    const membership = membershipResult.rows[0];
    if (
      !membership ||
      membership.deleted_at !== null ||
      membership.membership_status !== 'invited'
    ) {
      throw invalidInvitation(
        'The user is not an invited member of an existing tenant',
      );
    }
    // A first-time invitee has no password yet. An already-active user may be
    // invited to a second tenant, but only if it already holds a password;
    // otherwise accepting the invitation would activate a membership with no
    // credential.
    if (membership.user_status === 'active') {
      if (!membership.has_password) {
        throw invalidInvitation(
          'The invited user is active but has no password set',
        );
      }
    } else if (membership.user_status !== 'invited') {
      throw invalidInvitation(
        'The user is not an invited member of an existing tenant',
      );
    }

    await client.query(
      `update invitation
          set revoked_at = now()
        where tenant_id = $1
          and user_id = $2
          and accepted_at is null
          and revoked_at is null`,
      [membership.tenant_id, membership.user_id],
    );

    const inserted = await client.query<{ id: string; expires_at: Date }>(
      `insert into invitation
         (tenant_id, user_id, token_hash, expires_at, created_by)
       values ($1, $2, $3, now() + make_interval(days => $4::int), $5)
       returning id, expires_at`,
      [membership.tenant_id, membership.user_id, tokenHash(token), expiresInDays, createdBy],
    );
    const invitation = inserted.rows[0];
    if (!invitation) {
      throw new Error('Invitation insert returned no row');
    }

    await client.query('commit');
    return {
      invitationId: invitation.id,
      token,
      expiresAt: invitation.expires_at,
    };
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function acceptInvitation(
  authPool: AuthPool,
  input: AcceptInvitationInput,
): Promise<SessionInfo | null> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return null;
  }

  const token = typeof input.token === 'string' ? input.token : '';
  if (!TOKEN_PATTERN.test(token)) {
    return null;
  }
  const password = typeof input.password === 'string' ? input.password : '';
  const now = input.now ?? new Date();
  const hash = tokenHash(token);

  // Cheap precheck so an unauthenticated caller cannot force Argon2id work
  // with a random token. The authoritative re-check runs under lock below.
  const precheck = await authPool.query(
    `select 1
       from invitation
      where token_hash = $1
        and accepted_at is null
        and revoked_at is null
        and expires_at > $2
      limit 1`,
    [hash, now],
  );
  if (!precheck.rowCount) {
    return null;
  }

  // Invalid passwords only raise for a token that passed the precheck; an
  // unknown or spent token returns null above without hashing.
  const passwordHash = await hashPassword(password);

  const client = await authPool.connect();
  try {
    await client.query('begin');

    const invitationResult = await client.query<{
      id: string;
      tenant_id: string;
      user_id: string;
      expires_at: Date;
      accepted_at: Date | null;
      revoked_at: Date | null;
    }>(
      `select id, tenant_id, user_id, expires_at, accepted_at, revoked_at
         from invitation
        where token_hash = $1
        for update`,
      [hash],
    );
    const invitation = invitationResult.rows[0];
    if (
      !invitation ||
      invitation.accepted_at !== null ||
      invitation.revoked_at !== null ||
      invitation.expires_at.getTime() <= now.getTime()
    ) {
      await client.query('rollback');
      return null;
    }

    const tenantResult = await client.query<TenantRow>(
      'select id, slug, status, deleted_at from app.auth_tenant_by_id($1)',
      [invitation.tenant_id],
    );
    const tenant = tenantResult.rows[0];
    if (!tenant || tenant.deleted_at !== null) {
      await client.query('rollback');
      return null;
    }

    const statuses = await client.query<{
      user_status: string;
      membership_status: string;
    }>('select user_status, membership_status from app.auth_membership_status($1, $2)', [
      invitation.tenant_id,
      invitation.user_id,
    ]);
    const status = statuses.rows[0];
    if (!status || status.membership_status !== 'invited') {
      await client.query('rollback');
      return null;
    }

    if (status.user_status === 'invited') {
      const updatedUser = await client.query(
        `update app_user
            set password_hash = $2, status = 'active', last_login_at = $3
          where id = $1 and status = 'invited'`,
        [invitation.user_id, passwordHash, now],
      );
      if (updatedUser.rowCount !== 1) {
        await client.query('rollback');
        return null;
      }
    } else if (status.user_status === 'active') {
      // An active user invited to a second tenant keeps the credential it
      // already has; the password is verified, never replaced.
      const emailResult = await client.query<{ email: string }>(
        'select email from app_user where id = $1',
        [invitation.user_id],
      );
      const email = emailResult.rows[0]?.email;
      const credentialResult = email
        ? await client.query<{ password_hash: string | null }>(
            'select password_hash from app.auth_credentials($1, $2)',
            [invitation.tenant_id, email],
          )
        : undefined;
      const existingHash = credentialResult?.rows[0]?.password_hash;
      if (!existingHash || !(await verifyPassword(existingHash, password))) {
        await client.query('rollback');
        return null;
      }
      const updatedUser = await client.query(
        `update app_user set last_login_at = $2 where id = $1 and status = 'active'`,
        [invitation.user_id, now],
      );
      if (updatedUser.rowCount !== 1) {
        await client.query('rollback');
        return null;
      }
    } else {
      await client.query('rollback');
      return null;
    }

    const activated = await client.query<{ activated: boolean }>(
      'select app.auth_activate_membership($1, $2) as activated',
      [invitation.tenant_id, invitation.user_id],
    );
    if (activated.rows[0]?.activated !== true) {
      await client.query('rollback');
      return null;
    }

    await client.query('update invitation set accepted_at = $2 where id = $1', [
      invitation.id,
      now,
    ]);

    const session = await insertSession(client, {
      userId: invitation.user_id,
      tenantId: invitation.tenant_id,
      now,
      ip: input.ip,
      userAgent: input.userAgent,
    });

    await client.query('commit');
    return session;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
