import { randomBytes } from 'node:crypto';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  acceptInvitation,
  createAuthPool,
  createInvitation,
  createRuntimePool,
  findSession,
  hashPassword,
  login,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  revokeSession,
  SESSION_TTL_MS,
  verifyPassword,
  type AuthPool,
  type RuntimePool,
} from '@saasmodels/db';
import { CSRF_HEADER, createServer, SESSION_COOKIE } from '@saasmodels/api';
import { createTestDatabase, type TestDatabase } from '@saasmodels/testkit';
import { randomToken, tokenHash } from './support/auth-fixtures.js';

const appOrigin = 'https://app.example.test';
const testPassword = 'integration-test-password';

type TestServer = ReturnType<typeof createServer>;
type InjectResponse = Awaited<ReturnType<TestServer['inject']>>;

type TenantFixture = { id: string; slug: string };
type UserFixture = { id: string; email: string };
type AccountFixture = UserFixture & { tenantId: string; tenantSlug: string };
type InviteFixture = UserFixture & { tenantId: string; tenantSlug: string };

type Fixtures = {
  active: AccountFixture;
  otherTenant: TenantFixture;
  nonMember: UserFixture;
  suspendedMember: AccountFixture;
  disabledUser: AccountFixture;
  suspendedUser: AccountFixture;
  invitedUser: AccountFixture;
  suspendedTenant: AccountFixture;
  deletedTenant: AccountFixture;
  disableAfterLogin: AccountFixture;
  inviteTenant: TenantFixture;
  inviteStates: InviteFixture;
  inviteExpired: InviteFixture;
  inviteRevoked: InviteFixture;
  inviteSuspendedUser: InviteFixture;
  inviteDisabledUser: InviteFixture;
  inviteOlder: InviteFixture;
  inviteApi: InviteFixture;
  inviteDeletedTenant: InviteFixture;
  secondTenantUser: AccountFixture;
  secondTenant: TenantFixture;
  activeNoPassword: InviteFixture;
};

let database: TestDatabase | undefined;
let owner: Client | undefined;
let ownerPool: Pool | undefined;
let auth: AuthPool | undefined;
let runtime: RuntimePool | undefined;
let fixtures: Fixtures | undefined;

function ownerClient(): Client {
  if (!owner) {
    throw new Error('Owner client has not been created');
  }
  return owner;
}

function ownerPoolRef(): Pool {
  if (!ownerPool) {
    throw new Error('Owner pool has not been created');
  }
  return ownerPool;
}

function authPool(): AuthPool {
  if (!auth) {
    throw new Error('Auth pool has not been created');
  }
  return auth;
}

function fx(): Fixtures {
  if (!fixtures) {
    throw new Error('Fixtures have not been created');
  }
  return fixtures;
}

function suffix(): string {
  return randomBytes(4).toString('hex');
}

async function createTenant(
  label: string,
  options: { status?: string; deleted?: boolean } = {},
): Promise<TenantFixture> {
  const slug = `auth-${label}-${suffix()}`;
  const result = await ownerClient().query<{ id: string; slug: string }>(
    `insert into tenant (name, slug, data_region, status, deleted_at)
     values ($1, $2, 'test', $3, $4)
     returning id, slug`,
    [
      `Auth ${label}`,
      slug,
      options.status ?? 'active',
      options.deleted ? new Date() : null,
    ],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`Could not create tenant ${label}`);
  }
  return row;
}

async function createUser(
  label: string,
  options: { status?: string; passwordHash?: string | null } = {},
): Promise<UserFixture> {
  const email = `${label}.${suffix()}@example.test`;
  const result = await ownerClient().query<{ id: string }>(
    `insert into app_user (email, display_name, status, password_hash)
     values ($1, $2, $3, $4)
     returning id`,
    [email, `Auth ${label}`, options.status ?? 'active', options.passwordHash ?? null],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`Could not create user ${label}`);
  }
  return { id: row.id, email };
}

async function addMembership(
  tenantId: string,
  userId: string,
  role = 'owner',
  status = 'active',
): Promise<void> {
  await ownerClient().query(
    `insert into membership (tenant_id, user_id, role, status)
     values ($1, $2, $3, $4)`,
    [tenantId, userId, role, status],
  );
}

async function invitedMember(
  tenant: TenantFixture,
  label: string,
): Promise<InviteFixture> {
  const user = await createUser(label, { status: 'invited' });
  await addMembership(tenant.id, user.id, 'owner', 'invited');
  return { ...user, tenantId: tenant.id, tenantSlug: tenant.slug };
}

function setCookieHeader(response: InjectResponse): string {
  const value = response.headers['set-cookie'];
  const first = Array.isArray(value) ? value[0] : value;
  if (!first) {
    throw new Error('Expected a Set-Cookie header');
  }
  return first;
}

function cookieToken(response: InjectResponse): string {
  const pair = setCookieHeader(response).split(';', 1)[0] ?? '';
  const prefix = `${SESSION_COOKIE}=`;
  if (!pair.startsWith(prefix)) {
    throw new Error('Session cookie is missing');
  }
  return pair.slice(prefix.length);
}

function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}`;
}

async function withApp<T>(
  fn: (app: TestServer) => Promise<T>,
  options: {
    secureCookies?: boolean;
    loginIpRateLimit?: { max: number; windowMs: number };
    loginRateLimit?: { max: number; windowMs: number };
    invitationRateLimit?: { max: number; windowMs: number };
  } = {},
): Promise<T> {
  if (!runtime || !auth) {
    throw new Error('Pools have not been created');
  }
  const app = createServer({
    pool: runtime,
    authPool: auth,
    appOrigin,
    secureCookies: options.secureCookies ?? false,
    enableProofRoutes: true,
    logger: false,
    ...(options.loginIpRateLimit ? { loginIpRateLimit: options.loginIpRateLimit } : {}),
    ...(options.loginRateLimit ? { loginRateLimit: options.loginRateLimit } : {}),
    ...(options.invitationRateLimit
      ? { invitationRateLimit: options.invitationRateLimit }
      : {}),
  });
  await app.ready();
  try {
    return await fn(app);
  } finally {
    await app.close();
  }
}

function loginRequest(
  app: TestServer,
  overrides: Partial<{ email: string; password: string; tenantSlug: string; origin: string }> = {},
) {
  const { origin = appOrigin, email, password, tenantSlug } = overrides;
  return app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    headers: { origin },
    payload: {
      email: email ?? fx().active.email,
      password: password ?? testPassword,
      tenantSlug: tenantSlug ?? fx().active.tenantSlug,
    },
  });
}

async function sessionCount(userId?: string): Promise<number> {
  const result = userId
    ? await ownerClient().query<{ count: string }>(
        'select count(*)::text as count from auth_session where user_id = $1',
        [userId],
      )
    : await ownerClient().query<{ count: string }>(
        'select count(*)::text as count from auth_session',
      );
  return Number(result.rows[0]?.count ?? '0');
}

async function insertSession(
  user: UserFixture,
  tenantId: string,
  options: { createdAt?: Date; expiresAt?: Date; revokedAt?: Date } = {},
): Promise<{ token: string; csrfToken: string }> {
  const token = randomToken();
  const csrfToken = randomToken();
  const createdAt = options.createdAt ?? new Date();
  await ownerClient().query(
    `insert into auth_session
       (user_id, tenant_id, token_hash, csrf_token, created_at, expires_at, revoked_at)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      user.id,
      tenantId,
      tokenHash(token),
      csrfToken,
      createdAt,
      options.expiresAt ?? new Date(createdAt.getTime() + SESSION_TTL_MS),
      options.revokedAt ?? null,
    ],
  );
  return { token, csrfToken };
}

beforeAll(async () => {
  database = await createTestDatabase({ migrate: true, seed: true });
  ownerPool = new Pool({ connectionString: database.ownerUrl, max: 2 });
  owner = new Client({ connectionString: database.ownerUrl });
  await owner.connect();
  auth = createAuthPool(database.authUrl);
  runtime = createRuntimePool(database.runtimeUrl);

  const passwordHash = await hashPassword(testPassword);

  const activeTenant = await createTenant('login-active');
  const activeUser = await createUser('login-active', { passwordHash });
  await addMembership(activeTenant.id, activeUser.id, 'owner');

  const otherTenant = await createTenant('login-other');

  const nonMember = await createUser('login-non-member', { passwordHash });

  const suspendedMemberUser = await createUser('login-suspended-member', {
    passwordHash,
  });
  await addMembership(activeTenant.id, suspendedMemberUser.id, 'employee', 'suspended');

  const disabledUser = await createUser('login-disabled', {
    passwordHash,
    status: 'disabled',
  });
  await addMembership(activeTenant.id, disabledUser.id, 'employee', 'active');

  const suspendedUser = await createUser('login-suspended', {
    passwordHash,
    status: 'suspended',
  });
  await addMembership(activeTenant.id, suspendedUser.id, 'employee', 'active');

  const invitedUser = await createUser('login-invited', {
    passwordHash,
    status: 'invited',
  });
  await addMembership(activeTenant.id, invitedUser.id, 'owner', 'active');

  const suspendedTenant = await createTenant('login-suspended-tenant', {
    status: 'suspended',
  });
  const suspendedTenantUser = await createUser('login-suspended-tenant', {
    passwordHash,
  });
  await addMembership(suspendedTenant.id, suspendedTenantUser.id, 'owner');

  const deletedTenant = await createTenant('login-deleted-tenant', { deleted: true });
  const deletedTenantUser = await createUser('login-deleted-tenant', {
    passwordHash,
  });
  await addMembership(deletedTenant.id, deletedTenantUser.id, 'owner');

  const disableAfterLogin = await createUser('session-disabled-after-login', {
    passwordHash,
  });
  await addMembership(activeTenant.id, disableAfterLogin.id, 'employee', 'active');

  const inviteTenant = await createTenant('invite');
  const inviteStates = await invitedMember(inviteTenant, 'invite-states');
  const inviteExpired = await invitedMember(inviteTenant, 'invite-expired');
  const inviteRevoked = await invitedMember(inviteTenant, 'invite-revoked');
  const inviteSuspendedUser = await invitedMember(
    inviteTenant,
    'invite-suspended-user',
  );
  const inviteDisabledUser = await invitedMember(
    inviteTenant,
    'invite-disabled-user',
  );
  const inviteOlder = await invitedMember(inviteTenant, 'invite-older');
  const inviteApi = await invitedMember(inviteTenant, 'invite-api');

  const deletedInviteTenant = await createTenant('invite-deleted-tenant');
  const inviteDeletedTenant = await invitedMember(
    deletedInviteTenant,
    'invite-deleted-tenant',
  );

  const secondTenantUserBase = await createUser('invite-second-tenant', {
    passwordHash,
  });
  const secondTenantA = await createTenant('invite-second-a');
  const secondTenantB = await createTenant('invite-second-b');
  await addMembership(secondTenantA.id, secondTenantUserBase.id, 'owner', 'active');
  await addMembership(secondTenantB.id, secondTenantUserBase.id, 'owner', 'invited');

  const activeNoPasswordUser = await createUser('invite-active-no-password', {
    status: 'active',
    passwordHash: null,
  });
  await addMembership(inviteTenant.id, activeNoPasswordUser.id, 'owner', 'invited');

  fixtures = {
    active: {
      ...activeUser,
      tenantId: activeTenant.id,
      tenantSlug: activeTenant.slug,
    },
    otherTenant,
    nonMember,
    suspendedMember: {
      ...suspendedMemberUser,
      tenantId: activeTenant.id,
      tenantSlug: activeTenant.slug,
    },
    disabledUser: {
      ...disabledUser,
      tenantId: activeTenant.id,
      tenantSlug: activeTenant.slug,
    },
    suspendedUser: {
      ...suspendedUser,
      tenantId: activeTenant.id,
      tenantSlug: activeTenant.slug,
    },
    invitedUser: {
      ...invitedUser,
      tenantId: activeTenant.id,
      tenantSlug: activeTenant.slug,
    },
    suspendedTenant: {
      ...suspendedTenantUser,
      tenantId: suspendedTenant.id,
      tenantSlug: suspendedTenant.slug,
    },
    deletedTenant: {
      ...deletedTenantUser,
      tenantId: deletedTenant.id,
      tenantSlug: deletedTenant.slug,
    },
    disableAfterLogin: {
      ...disableAfterLogin,
      tenantId: activeTenant.id,
      tenantSlug: activeTenant.slug,
    },
    inviteTenant,
    inviteStates,
    inviteExpired,
    inviteRevoked,
    inviteSuspendedUser,
    inviteDisabledUser,
    inviteOlder,
    inviteApi,
    inviteDeletedTenant,
    secondTenantUser: {
      ...secondTenantUserBase,
      tenantId: secondTenantA.id,
      tenantSlug: secondTenantA.slug,
    },
    secondTenant: secondTenantB,
    activeNoPassword: {
      ...activeNoPasswordUser,
      tenantId: inviteTenant.id,
      tenantSlug: inviteTenant.slug,
    },
  };
});

afterAll(async () => {
  await owner?.end();
  await ownerPool?.end();
  await auth?.end();
  await runtime?.end();
  await database?.drop();
});

describe('password hashing', () => {
  test('uses Argon2id with the reviewed parameters', async () => {
    const hash = await hashPassword(testPassword);
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    await expect(verifyPassword(hash, testPassword)).resolves.toBe(true);
    await expect(verifyPassword(hash, 'not-the-password')).resolves.toBe(false);
  });

  test('returns false for malformed hashes and never throws', async () => {
    await expect(verifyPassword('not-a-phc-hash', testPassword)).resolves.toBe(false);
    await expect(verifyPassword('', testPassword)).resolves.toBe(false);
    await expect(
      verifyPassword('$argon2id$v=19$m=19456,t=2,p=1$broken', testPassword),
    ).resolves.toBe(false);
  });

  test('enforces 12-128 characters without trimming', async () => {
    expect(PASSWORD_MIN_LENGTH).toBe(12);
    expect(PASSWORD_MAX_LENGTH).toBe(128);

    await expect(hashPassword('a'.repeat(11))).rejects.toMatchObject({
      code: 'INVALID_PASSWORD',
    });
    const minimum = await hashPassword('a'.repeat(12));
    await expect(verifyPassword(minimum, 'a'.repeat(12))).resolves.toBe(true);

    const maximum = await hashPassword('b'.repeat(128));
    await expect(verifyPassword(maximum, 'b'.repeat(128))).resolves.toBe(true);

    await expect(hashPassword('c'.repeat(129))).rejects.toMatchObject({
      code: 'INVALID_PASSWORD',
    });

    const padded = ` ${'d'.repeat(11)} `;
    const paddedHash = await hashPassword(padded);
    await expect(verifyPassword(paddedHash, 'd'.repeat(11))).resolves.toBe(false);
    await expect(verifyPassword(paddedHash, padded)).resolves.toBe(true);
  });
});

describe('login', () => {
  test('issues one opaque session, records the hash and updates last_login_at', async () => {
    const before = await sessionCount(fx().active.id);

    await withApp(async (app) => {
      const beforeLogin = await ownerClient().query<{ last_login_at: Date | null }>(
        'select last_login_at from app_user where id = $1',
        [fx().active.id],
      );

      const response = await loginRequest(app);
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toMatchObject({
        userId: fx().active.id,
        tenantId: fx().active.tenantId,
      });
      expect(typeof body.csrfToken).toBe('string');
      expect(body.csrfToken).toHaveLength(43);
      expect(body).not.toHaveProperty('token');
      expect(body).not.toHaveProperty('password');
      expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now() + 11 * 60 * 60 * 1000);

      const header = setCookieHeader(response);
      expect(header).toContain(`${SESSION_COOKIE}=`);
      expect(header).toContain('HttpOnly');
      expect(header).toContain('SameSite=Strict');
      expect(header).toContain('Path=/');
      expect(header).toContain('Max-Age=43200');
      expect(header).not.toContain('Secure');

      const token = cookieToken(response);
      expect(token).toHaveLength(43);
      expect(response.body).not.toContain(token);
      expect(response.body).not.toContain('$argon2');

      const rows = await ownerClient().query<{
        token_hash: string;
        csrf_token: string;
        user_agent: string | null;
        ip: string | null;
        created_at: Date;
        expires_at: Date;
      }>(
        `select token_hash, csrf_token, user_agent, ip::text as ip, created_at, expires_at
           from auth_session
          where user_id = $1
          order by created_at desc
          limit 1`,
        [fx().active.id],
      );
      const row = rows.rows[0];
      if (!row) {
        throw new Error('Login did not store a session');
      }
      expect(row.token_hash).toBe(tokenHash(token));
      expect(row.token_hash).not.toBe(token);
      expect(row.csrf_token).toBe(body.csrfToken);
      expect(row.ip).not.toBeNull();
      expect(row.user_agent).toBe('lightMyRequest');
      expect(row.expires_at.getTime() - row.created_at.getTime()).toBe(SESSION_TTL_MS);

      expect(await sessionCount(fx().active.id)).toBe(before + 1);

      const afterLogin = await ownerClient().query<{ last_login_at: Date | null }>(
        'select last_login_at from app_user where id = $1',
        [fx().active.id],
      );
      expect(beforeLogin.rows[0]?.last_login_at).toBeNull();
      expect(afterLogin.rows[0]?.last_login_at).not.toBeNull();

      const session = await app.inject({
        method: 'GET',
        url: '/v1/auth/session',
        headers: { cookie: sessionCookie(token) },
      });
      expect(session.statusCode).toBe(200);
      expect(session.json()).toEqual(body);
    });
  });

  test('marks the cookie Secure when configured', async () => {
    await withApp(
      async (app) => {
        const response = await loginRequest(app);
        expect(response.statusCode).toBe(200);
        expect(setCookieHeader(response)).toContain('Secure');
      },
      { secureCookies: true },
    );
  });

  test('trims the email but not the password', async () => {
    await withApp(async (app) => {
      const spacedEmail = await loginRequest(app, {
        email: `  ${fx().active.email}  `,
      });
      expect(spacedEmail.statusCode).toBe(200);

      const spacedPassword = await loginRequest(app, {
        password: ` ${testPassword}`,
      });
      expect(spacedPassword.statusCode).toBe(401);
      expect(spacedPassword.json()).toEqual({
        error: { code: 'INVALID_CREDENTIALS' },
      });
    });
  });

  test('login failures are indistinguishable and create no session', async () => {
    const before = await sessionCount();

    await withApp(async (app) => {
      const cases: Array<{
        label: string;
        email: string;
        password: string;
        tenantSlug: string;
      }> = [
        {
          label: 'wrong password',
          email: fx().active.email,
          password: 'definitely-wrong-password',
          tenantSlug: fx().active.tenantSlug,
        },
        {
          label: 'unknown email',
          email: `unknown.${suffix()}@example.test`,
          password: testPassword,
          tenantSlug: fx().active.tenantSlug,
        },
        {
          label: 'non-member',
          email: fx().nonMember.email,
          password: testPassword,
          tenantSlug: fx().active.tenantSlug,
        },
        {
          label: 'suspended membership',
          email: fx().suspendedMember.email,
          password: testPassword,
          tenantSlug: fx().active.tenantSlug,
        },
        {
          label: 'disabled user',
          email: fx().disabledUser.email,
          password: testPassword,
          tenantSlug: fx().active.tenantSlug,
        },
        {
          label: 'suspended user',
          email: fx().suspendedUser.email,
          password: testPassword,
          tenantSlug: fx().active.tenantSlug,
        },
        {
          label: 'invited user',
          email: fx().invitedUser.email,
          password: testPassword,
          tenantSlug: fx().active.tenantSlug,
        },
        {
          label: 'member of another tenant',
          email: fx().active.email,
          password: testPassword,
          tenantSlug: fx().otherTenant.slug,
        },
        {
          label: 'deleted tenant',
          email: fx().deletedTenant.email,
          password: testPassword,
          tenantSlug: fx().deletedTenant.tenantSlug,
        },
      ];

      for (const entry of cases) {
        const response = await loginRequest(app, entry);
        expect(response.statusCode, entry.label).toBe(401);
        expect(response.json(), entry.label).toEqual({
          error: { code: 'INVALID_CREDENTIALS' },
        });
        expect(response.headers['set-cookie'], entry.label).toBeUndefined();
      }
    });

    expect(await sessionCount()).toBe(before);
  });

  test('a suspended tenant may sign in but protected routes deny platform access', async () => {
    await withApp(async (app) => {
      const loginResponse = await loginRequest(app, {
        email: fx().suspendedTenant.email,
        tenantSlug: fx().suspendedTenant.tenantSlug,
      });
      expect(loginResponse.statusCode).toBe(200);
      const cookie = sessionCookie(cookieToken(loginResponse));

      const session = await app.inject({
        method: 'GET',
        url: '/v1/auth/session',
        headers: { cookie },
      });
      expect(session.statusCode).toBe(200);

      const context = await app.inject({
        method: 'GET',
        url: '/v1/context',
        headers: { cookie },
      });
      expect(context.statusCode).toBe(403);
      expect(context.json()).toEqual({
        error: { code: 'PLATFORM_ACCESS_DENIED' },
      });
    });
  });
});

describe('sessions', () => {
  test('the token is stored only as a SHA-256 hash and the library finds and revokes it', async () => {
    const session = await login(authPool(), {
      email: fx().active.email,
      password: testPassword,
      tenantSlug: fx().active.tenantSlug,
    });
    expect(session).not.toBeNull();
    if (!session) {
      throw new Error('Login did not return a session');
    }

    const stored = await ownerClient().query<{ token_hash: string }>(
      'select token_hash from auth_session where user_id = $1 order by created_at desc limit 1',
      [fx().active.id],
    );
    expect(stored.rows[0]?.token_hash).toBe(tokenHash(session.token));
    expect(stored.rows[0]?.token_hash).not.toBe(session.token);

    const found = await findSession(authPool(), session.token);
    expect(found).toMatchObject({
      userId: fx().active.id,
      tenantId: fx().active.tenantId,
      csrfToken: session.csrfToken,
    });
    await expect(findSession(authPool(), `${session.token}x`)).resolves.toBeNull();

    await revokeSession(authPool(), session.token);
    await expect(findSession(authPool(), session.token)).resolves.toBeNull();
  });

  test('expired, revoked, tampered and disabled-user sessions are rejected', async () => {
    const expired = await insertSession(fx().active, fx().active.tenantId, {
      createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      expiresAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    const revoked = await insertSession(fx().active, fx().active.tenantId, {
      revokedAt: new Date(),
    });
    const disabled = await insertSession(fx().disabledUser, fx().disabledUser.tenantId);

    await withApp(async (app) => {
      const validLogin = await loginRequest(app);
      expect(validLogin.statusCode).toBe(200);
      const token = cookieToken(validLogin);
      const tamperedToken = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;

      for (const sessionToken of [expired.token, revoked.token, disabled.token, tamperedToken]) {
        const response = await app.inject({
          method: 'GET',
          url: '/v1/auth/session',
          headers: { cookie: sessionCookie(sessionToken) },
        });
        expect(response.statusCode).toBe(401);
        expect(response.json()).toEqual({ error: { code: 'UNAUTHENTICATED' } });
      }

      const valid = await app.inject({
        method: 'GET',
        url: '/v1/auth/session',
        headers: { cookie: sessionCookie(token) },
      });
      expect(valid.statusCode).toBe(200);
    });
  });

  test('a disabled user loses an existing session immediately', async () => {
    const user = fx().disableAfterLogin;

    await withApp(async (app) => {
      const response = await loginRequest(app, {
        email: user.email,
        tenantSlug: fx().active.tenantSlug,
      });
      expect(response.statusCode).toBe(200);
      const cookie = sessionCookie(cookieToken(response));

      const before = await app.inject({
        method: 'GET',
        url: '/v1/auth/session',
        headers: { cookie },
      });
      expect(before.statusCode).toBe(200);

      await ownerClient().query("update app_user set status = 'disabled' where id = $1", [
        user.id,
      ]);

      const after = await app.inject({
        method: 'GET',
        url: '/v1/auth/session',
        headers: { cookie },
      });
      expect(after.statusCode).toBe(401);
      expect(after.json()).toEqual({ error: { code: 'UNAUTHENTICATED' } });
    });
  });

  test('suspended membership and suspended tenant are enforced on protected routes', async () => {
    const suspendedMember = await insertSession(
      fx().suspendedMember,
      fx().suspendedMember.tenantId,
    );

    await withApp(async (app) => {
      const memberContext = await app.inject({
        method: 'GET',
        url: '/v1/context',
        headers: { cookie: sessionCookie(suspendedMember.token) },
      });
      expect(memberContext.statusCode).toBe(403);
      expect(memberContext.json()).toEqual({
        error: { code: 'MEMBERSHIP_DENIED' },
      });

      const loginResponse = await loginRequest(app, {
        email: fx().suspendedTenant.email,
        tenantSlug: fx().suspendedTenant.tenantSlug,
      });
      expect(loginResponse.statusCode).toBe(200);

      const context = await app.inject({
        method: 'GET',
        url: '/v1/context',
        headers: { cookie: sessionCookie(cookieToken(loginResponse)) },
      });
      expect(context.statusCode).toBe(403);
      expect(context.json()).toEqual({
        error: { code: 'PLATFORM_ACCESS_DENIED' },
      });
    });
  });
});

describe('logout', () => {
  test('requires CSRF, revokes only that session and clears the cookie', async () => {
    await withApp(async (app) => {
      const loginResponse = await loginRequest(app);
      expect(loginResponse.statusCode).toBe(200);
      const body = loginResponse.json();
      const token = cookieToken(loginResponse);
      const cookie = sessionCookie(token);

      const missing = await app.inject({
        method: 'POST',
        url: '/v1/auth/logout',
        headers: { origin: appOrigin, cookie },
      });
      expect(missing.statusCode).toBe(403);
      expect(missing.json()).toEqual({ error: { code: 'CSRF_INVALID' } });

      const wrong = await app.inject({
        method: 'POST',
        url: '/v1/auth/logout',
        headers: {
          origin: appOrigin,
          cookie,
          [CSRF_HEADER]: 'not-the-csrf-token',
        },
      });
      expect(wrong.statusCode).toBe(403);
      expect(wrong.json()).toEqual({ error: { code: 'CSRF_INVALID' } });

      const stillValid = await app.inject({
        method: 'GET',
        url: '/v1/auth/session',
        headers: { cookie },
      });
      expect(stillValid.statusCode).toBe(200);

      const logout = await app.inject({
        method: 'POST',
        url: '/v1/auth/logout',
        headers: {
          origin: appOrigin,
          cookie,
          [CSRF_HEADER]: body.csrfToken,
        },
      });
      expect(logout.statusCode).toBe(204);

      const cleared = setCookieHeader(logout);
      expect(cleared).toContain('HttpOnly');
      expect(cleared).toContain('SameSite=Strict');
      expect(cleared).toContain('Path=/');
      expect(cleared).toContain('Expires=Thu, 01 Jan 1970');

      const after = await app.inject({
        method: 'GET',
        url: '/v1/auth/session',
        headers: { cookie },
      });
      expect(after.statusCode).toBe(401);

      const stored = await ownerClient().query<{ revoked_at: Date | null }>(
        'select revoked_at from auth_session where token_hash = $1',
        [tokenHash(token)],
      );
      expect(stored.rows[0]?.revoked_at).not.toBeNull();
    });
  });

  test('rejects logout without a valid session', async () => {
    await withApp(async (app) => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/auth/logout',
        headers: {
          origin: appOrigin,
          cookie: sessionCookie(randomToken()),
          [CSRF_HEADER]: randomToken(),
        },
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: { code: 'UNAUTHENTICATED' } });
    });
  });
});

describe('request protections', () => {
  test('requires an exact Origin on every state-changing request', async () => {
    await withApp(async (app) => {
      for (const origin of [undefined, 'https://evil.example.test', `${appOrigin}/`]) {
        const headers = origin ? { origin } : {};
        const login = await app.inject({
          method: 'POST',
          url: '/v1/auth/login',
          headers,
          payload: {
            email: fx().active.email,
            password: testPassword,
            tenantSlug: fx().active.tenantSlug,
          },
        });
        expect(login.statusCode).toBe(403);
        expect(login.json()).toEqual({ error: { code: 'ORIGIN_DENIED' } });

        const accept = await app.inject({
          method: 'POST',
          url: '/v1/auth/invitations/accept',
          headers,
          payload: { token: randomToken(), password: testPassword },
        });
        expect(accept.statusCode).toBe(403);
        expect(accept.json()).toEqual({ error: { code: 'ORIGIN_DENIED' } });
      }

      const missingOriginGet = await app.inject({
        method: 'GET',
        url: '/v1/auth/session',
      });
      expect(missingOriginGet.statusCode).toBe(401);
      expect(missingOriginGet.json()).toEqual({ error: { code: 'UNAUTHENTICATED' } });
    });
  });

  test('limits login attempts by address and email', async () => {
    await withApp(
      async (app) => {
        const attempt = (email: string, password: string) =>
          app.inject({
            method: 'POST',
            url: '/v1/auth/login',
            headers: { origin: appOrigin },
            payload: { email, password, tenantSlug: fx().active.tenantSlug },
          });

        expect((await attempt(fx().active.email, 'wrong-password-1')).statusCode).toBe(401);
        expect((await attempt(fx().active.email, 'wrong-password-2')).statusCode).toBe(401);
        const limited = await attempt(fx().active.email, testPassword);
        expect(limited.statusCode).toBe(429);
        expect(limited.json()).toEqual({ error: { code: 'RATE_LIMITED' } });

        const other = await attempt(fx().nonMember.email, testPassword);
        expect(other.statusCode).toBe(401);
      },
      { loginRateLimit: { max: 2, windowMs: 60_000 } },
    );
  });

  test('limits login attempts by source address across different emails', async () => {
    await withApp(
      async (app) => {
        const attempt = (email: string) =>
          app.inject({
            method: 'POST',
            url: '/v1/auth/login',
            headers: { origin: appOrigin },
            payload: {
              email,
              password: 'wrong-password-values',
              tenantSlug: fx().active.tenantSlug,
            },
          });

        expect((await attempt(fx().active.email)).statusCode).toBe(401);
        expect((await attempt(fx().nonMember.email)).statusCode).toBe(401);
        const limited = await attempt('spray.third@example.test');
        expect(limited.statusCode).toBe(429);
        expect(limited.json()).toEqual({ error: { code: 'RATE_LIMITED' } });
      },
      { loginIpRateLimit: { max: 2, windowMs: 60_000 } },
    );
  });

  test('limits invitation acceptance attempts by address', async () => {
    await withApp(
      async (app) => {
        const attempt = () =>
          app.inject({
            method: 'POST',
            url: '/v1/auth/invitations/accept',
            headers: { origin: appOrigin },
            payload: { token: randomToken(), password: testPassword },
          });

        expect((await attempt()).statusCode).toBe(401);
        const limited = await attempt();
        expect(limited.statusCode).toBe(429);
        expect(limited.json()).toEqual({ error: { code: 'RATE_LIMITED' } });
      },
      { invitationRateLimit: { max: 1, windowMs: 60_000 } },
    );
  });

  test('maps malformed, unsupported, oversized and invalid bodies to safe errors', async () => {
    await withApp(async (app) => {
      const malformed = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        headers: { origin: appOrigin, 'content-type': 'application/json' },
        payload: '{"email":',
      });
      expect(malformed.statusCode).toBe(400);
      expect(malformed.json()).toEqual({ error: { code: 'BAD_REQUEST' } });

      const extraProperty = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        headers: { origin: appOrigin },
        payload: {
          email: fx().active.email,
          password: testPassword,
          tenantSlug: fx().active.tenantSlug,
          tenantId: fx().active.tenantId,
        },
      });
      expect(extraProperty.statusCode).toBe(400);
      expect(extraProperty.json()).toEqual({ error: { code: 'BAD_REQUEST' } });

      const longPassword = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        headers: { origin: appOrigin },
        payload: {
          email: fx().active.email,
          password: 'x'.repeat(129),
          tenantSlug: fx().active.tenantSlug,
        },
      });
      expect(longPassword.statusCode).toBe(400);

      const uppercaseSlug = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        headers: { origin: appOrigin },
        payload: {
          email: fx().active.email,
          password: testPassword,
          tenantSlug: 'UPPERCASE-SLUG',
        },
      });
      expect(uppercaseSlug.statusCode).toBe(400);

      const weakInvitationPassword = await app.inject({
        method: 'POST',
        url: '/v1/auth/invitations/accept',
        headers: { origin: appOrigin },
        payload: { token: randomToken(), password: 'short-pass1' },
      });
      expect(weakInvitationPassword.statusCode).toBe(400);

      const unsupported = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        headers: { origin: appOrigin, 'content-type': 'application/xml' },
        payload: '<login />',
      });
      expect(unsupported.statusCode).toBe(415);
      expect(unsupported.json()).toEqual({
        error: { code: 'UNSUPPORTED_MEDIA_TYPE' },
      });

      const oversized = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        headers: { origin: appOrigin, 'content-type': 'application/json' },
        payload: `"${'x'.repeat(1_100_000)}"`,
      });
      expect(oversized.statusCode).toBe(413);
      expect(oversized.json()).toEqual({ error: { code: 'PAYLOAD_TOO_LARGE' } });
    });
  });

  test('marks login, session, logout and auth errors as no-store', async () => {
    await withApp(async (app) => {
      const success = await loginRequest(app);
      expect(success.statusCode).toBe(200);
      expect(success.headers['cache-control']).toBe('no-store');

      const token = cookieToken(success);
      const csrfToken = success.json().csrfToken as string;

      const session = await app.inject({
        method: 'GET',
        url: '/v1/auth/session',
        headers: { cookie: sessionCookie(token) },
      });
      expect(session.statusCode).toBe(200);
      expect(session.headers['cache-control']).toBe('no-store');

      const failure = await loginRequest(app, { password: 'wrong-password-1' });
      expect(failure.statusCode).toBe(401);
      expect(failure.headers['cache-control']).toBe('no-store');

      const logout = await app.inject({
        method: 'POST',
        url: '/v1/auth/logout',
        headers: {
          origin: appOrigin,
          cookie: sessionCookie(token),
          [CSRF_HEADER]: csrfToken,
        },
      });
      expect(logout.statusCode).toBe(204);
      expect(logout.headers['cache-control']).toBe('no-store');
    });
  });
});

describe('invitations', () => {
  test('creates a one-time hashed token with a seven-day default expiry', async () => {
    const before = Date.now();
    const invitation = await createInvitation(ownerPoolRef(), {
      tenantSlug: fx().inviteTenant.slug,
      email: fx().inviteOlder.email,
    });

    expect(invitation.token).toHaveLength(43);
    expect(invitation.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const ttl = invitation.expiresAt.getTime() - before;
    expect(ttl).toBeGreaterThan(6.9 * 24 * 60 * 60 * 1000);
    expect(ttl).toBeLessThan(7.1 * 24 * 60 * 60 * 1000);

    const stored = await ownerClient().query<{
      token_hash: string;
      accepted_at: Date | null;
      revoked_at: Date | null;
    }>('select token_hash, accepted_at, revoked_at from invitation where id = $1', [
      invitation.invitationId,
    ]);
    expect(stored.rows[0]?.token_hash).toBe(tokenHash(invitation.token));
    expect(stored.rows[0]?.token_hash).not.toBe(invitation.token);
    expect(stored.rows[0]?.accepted_at).toBeNull();
    expect(stored.rows[0]?.revoked_at).toBeNull();
  });

  test('creating a newer invitation revokes older unconsumed rows', async () => {
    const first = await createInvitation(ownerPoolRef(), {
      tenantSlug: fx().inviteTenant.slug,
      email: fx().inviteOlder.email,
    });
    const second = await createInvitation(ownerPoolRef(), {
      tenantSlug: fx().inviteTenant.slug,
      email: fx().inviteOlder.email,
    });

    const firstState = await ownerClient().query<{ revoked_at: Date | null }>(
      'select revoked_at from invitation where id = $1',
      [first.invitationId],
    );
    expect(firstState.rows[0]?.revoked_at).not.toBeNull();

    await expect(
      acceptInvitation(authPool(), { token: first.token, password: testPassword }),
    ).resolves.toBeNull();

    const accepted = await acceptInvitation(authPool(), {
      token: second.token,
      password: testPassword,
    });
    expect(accepted).not.toBeNull();

    const status = await ownerClient().query<{
      user_status: string;
      membership_status: string;
      accepted_at: Date | null;
    }>(
      `select u.status as user_status, m.status as membership_status, i.accepted_at
         from app_user u
         join membership m on m.user_id = u.id and m.tenant_id = $2
         join invitation i on i.id = $3
        where u.id = $1`,
      [fx().inviteOlder.id, fx().inviteOlder.tenantId, second.invitationId],
    );
    expect(status.rows[0]?.user_status).toBe('active');
    expect(status.rows[0]?.membership_status).toBe('active');
    expect(status.rows[0]?.accepted_at).not.toBeNull();
  });

  test('rejects invalid invitation input', async () => {
    const cases: Array<() => Promise<unknown>> = [
      () =>
        createInvitation(ownerPoolRef(), {
          tenantSlug: fx().inviteTenant.slug,
          email: 'not-an-email',
        }),
      () =>
        createInvitation(ownerPoolRef(), {
          email: fx().inviteStates.email,
        }),
      () =>
        createInvitation(ownerPoolRef(), {
          tenantSlug: fx().inviteTenant.slug,
          tenantId: fx().inviteTenant.id,
          email: fx().inviteStates.email,
        }),
      () =>
        createInvitation(ownerPoolRef(), {
          tenantSlug: fx().inviteTenant.slug,
          email: fx().inviteStates.email,
          expiresInDays: 0,
        }),
      () =>
        createInvitation(ownerPoolRef(), {
          tenantSlug: fx().inviteTenant.slug,
          email: fx().inviteStates.email,
          expiresInDays: 31,
        }),
      () =>
        createInvitation(ownerPoolRef(), {
          tenantSlug: fx().inviteTenant.slug,
          email: fx().active.email,
        }),
    ];

    for (const call of cases) {
      await expect(call()).rejects.toMatchObject({
        code: 'INVALID_INVITATION_INPUT',
      });
    }
  });

  test('accepts once, activates the membership and signs the user in', async () => {
    const invitation = await createInvitation(ownerPoolRef(), {
      tenantSlug: fx().inviteTenant.slug,
      email: fx().inviteStates.email,
    });

    const session = await acceptInvitation(authPool(), {
      token: invitation.token,
      password: testPassword,
    });
    expect(session).not.toBeNull();
    if (!session) {
      throw new Error('Invitation acceptance did not return a session');
    }

    const stored = await ownerClient().query<{
      user_status: string;
      membership_status: string;
      password_hash: string | null;
      accepted_at: Date | null;
    }>(
      `select u.status as user_status, m.status as membership_status,
              u.password_hash, i.accepted_at
         from app_user u
         join membership m on m.user_id = u.id and m.tenant_id = $2
         join invitation i on i.id = $3
        where u.id = $1`,
      [fx().inviteStates.id, fx().inviteStates.tenantId, invitation.invitationId],
    );
    const row = stored.rows[0];
    expect(row?.user_status).toBe('active');
    expect(row?.membership_status).toBe('active');
    expect(row?.password_hash).not.toBeNull();
    await expect(verifyPassword(row?.password_hash ?? '', testPassword)).resolves.toBe(true);
    expect(row?.accepted_at).not.toBeNull();

    const second = await acceptInvitation(authPool(), {
      token: invitation.token,
      password: testPassword,
    });
    expect(second).toBeNull();
  });

  test('expired, revoked and unknown invitations fail without changes', async () => {
    const expired = await createInvitation(ownerPoolRef(), {
      tenantSlug: fx().inviteTenant.slug,
      email: fx().inviteExpired.email,
    });
    await ownerClient().query(
      `update invitation
          set created_at = now() - interval '2 days',
              expires_at = now() - interval '1 day'
        where id = $1`,
      [expired.invitationId],
    );

    const revoked = await createInvitation(ownerPoolRef(), {
      tenantSlug: fx().inviteTenant.slug,
      email: fx().inviteRevoked.email,
    });
    await ownerClient().query('update invitation set revoked_at = now() where id = $1', [
      revoked.invitationId,
    ]);

    const attempts = [
      { token: expired.token, user: fx().inviteExpired, label: 'expired' },
      { token: revoked.token, user: fx().inviteRevoked, label: 'revoked' },
      { token: randomToken(), user: undefined, label: 'unknown' },
    ];

    for (const attempt of attempts) {
      await expect(
        acceptInvitation(authPool(), { token: attempt.token, password: testPassword }),
      ).resolves.toBeNull();
    }

    for (const user of [fx().inviteExpired, fx().inviteRevoked]) {
      const state = await ownerClient().query<{ status: string; accepted: number }>(
        `select u.status,
                (select count(*) from invitation i where i.user_id = u.id and i.accepted_at is not null)::int as accepted
           from app_user u where u.id = $1`,
        [user.id],
      );
      expect(state.rows[0]?.status).toBe('invited');
      expect(state.rows[0]?.accepted).toBe(0);
    }
  });

  test('rejects weak passwords, ineligible users and deleted tenants', async () => {
    const weak = await createInvitation(ownerPoolRef(), {
      tenantSlug: fx().inviteTenant.slug,
      email: fx().inviteExpired.email,
    });
    await expect(
      acceptInvitation(authPool(), { token: weak.token, password: 'too-short' }),
    ).rejects.toMatchObject({ code: 'INVALID_PASSWORD' });

    const suspended = await createInvitation(ownerPoolRef(), {
      tenantSlug: fx().inviteTenant.slug,
      email: fx().inviteSuspendedUser.email,
    });
    await ownerClient().query("update app_user set status = 'suspended' where id = $1", [
      fx().inviteSuspendedUser.id,
    ]);
    await expect(
      acceptInvitation(authPool(), { token: suspended.token, password: testPassword }),
    ).resolves.toBeNull();

    const disabled = await createInvitation(ownerPoolRef(), {
      tenantSlug: fx().inviteTenant.slug,
      email: fx().inviteDisabledUser.email,
    });
    await ownerClient().query("update app_user set status = 'disabled' where id = $1", [
      fx().inviteDisabledUser.id,
    ]);
    await expect(
      acceptInvitation(authPool(), { token: disabled.token, password: testPassword }),
    ).resolves.toBeNull();

    const deletedTenant = await createInvitation(ownerPoolRef(), {
      tenantSlug: fx().inviteDeletedTenant.tenantSlug,
      email: fx().inviteDeletedTenant.email,
    });
    await ownerClient().query('update tenant set deleted_at = now() where id = $1', [
      fx().inviteDeletedTenant.tenantId,
    ]);
    await expect(
      acceptInvitation(authPool(), {
        token: deletedTenant.token,
        password: testPassword,
      }),
    ).resolves.toBeNull();

    for (const user of [
      fx().inviteSuspendedUser,
      fx().inviteDisabledUser,
      fx().inviteDeletedTenant,
    ]) {
      const state = await ownerClient().query<{ membership_status: string }>(
        'select status as membership_status from membership where user_id = $1',
        [user.id],
      );
      expect(state.rows[0]?.membership_status).toBe('invited');
    }
  });

  test('accepts an invitation through the API and sets the session cookie', async () => {
    const invitation = await createInvitation(ownerPoolRef(), {
      tenantSlug: fx().inviteTenant.slug,
      email: fx().inviteApi.email,
    });

    await withApp(async (app) => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/auth/invitations/accept',
        headers: { origin: appOrigin },
        payload: { token: invitation.token, password: testPassword },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toMatchObject({
        userId: fx().inviteApi.id,
        tenantId: fx().inviteApi.tenantId,
      });
      expect(body.csrfToken).toHaveLength(43);

      const header = setCookieHeader(response);
      expect(header).toContain('HttpOnly');
      expect(header).toContain('SameSite=Strict');
      expect(header).toContain('Max-Age=43200');
      const token = cookieToken(response);
      expect(response.body).not.toContain(token);

      const session = await app.inject({
        method: 'GET',
        url: '/v1/auth/session',
        headers: { cookie: sessionCookie(token) },
      });
      expect(session.statusCode).toBe(200);
      expect(session.json()).toEqual(body);

      const context = await app.inject({
        method: 'GET',
        url: '/v1/context',
        headers: { cookie: sessionCookie(token) },
      });
      expect(context.statusCode).toBe(200);
      expect(context.json()).toMatchObject({
        userId: fx().inviteApi.id,
        tenantId: fx().inviteApi.tenantId,
        role: 'owner',
      });

      const reused = await app.inject({
        method: 'POST',
        url: '/v1/auth/invitations/accept',
        headers: { origin: appOrigin },
        payload: { token: invitation.token, password: testPassword },
      });
      expect(reused.statusCode).toBe(401);
      expect(reused.json()).toEqual({ error: { code: 'INVITATION_INVALID' } });

      const unknown = await app.inject({
        method: 'POST',
        url: '/v1/auth/invitations/accept',
        headers: { origin: appOrigin },
        payload: { token: randomToken(), password: testPassword },
      });
      expect(unknown.statusCode).toBe(401);
      expect(unknown.json()).toEqual({ error: { code: 'INVITATION_INVALID' } });
      expect(unknown.body).not.toContain('token_hash');
      expect(unknown.body).not.toContain('invitation');
    });
  });

  test('an unknown invitation token returns null and creates no session', async () => {
    const before = await sessionCount();
    await expect(
      acceptInvitation(authPool(), { token: randomToken(), password: testPassword }),
    ).resolves.toBeNull();
    expect(await sessionCount()).toBe(before);
  });

  test('invites an active user to a second tenant and reuses the existing credential', async () => {
    const before = await ownerClient().query<{ password_hash: string | null }>(
      'select password_hash from app_user where id = $1',
      [fx().secondTenantUser.id],
    );
    const originalHash = before.rows[0]?.password_hash;
    expect(originalHash).not.toBeNull();

    const invitation = await createInvitation(ownerPoolRef(), {
      tenantSlug: fx().secondTenant.slug,
      email: fx().secondTenantUser.email,
    });

    const sessionsBefore = await sessionCount(fx().secondTenantUser.id);
    await expect(
      acceptInvitation(authPool(), {
        token: invitation.token,
        password: 'wrong-password-values',
      }),
    ).resolves.toBeNull();

    const afterWrong = await ownerClient().query<{
      password_hash: string | null;
      membership_status: string;
      accepted_at: Date | null;
    }>(
      `select u.password_hash, m.status as membership_status, i.accepted_at
         from app_user u
         join membership m on m.user_id = u.id and m.tenant_id = $2
         join invitation i on i.id = $3
        where u.id = $1`,
      [fx().secondTenantUser.id, fx().secondTenant.id, invitation.invitationId],
    );
    expect(afterWrong.rows[0]?.password_hash).toBe(originalHash);
    expect(afterWrong.rows[0]?.membership_status).toBe('invited');
    expect(afterWrong.rows[0]?.accepted_at).toBeNull();
    expect(await sessionCount(fx().secondTenantUser.id)).toBe(sessionsBefore);

    const session = await acceptInvitation(authPool(), {
      token: invitation.token,
      password: testPassword,
    });
    expect(session?.tenantId).toBe(fx().secondTenant.id);

    const afterAccept = await ownerClient().query<{
      password_hash: string | null;
      membership_status: string;
      accepted_at: Date | null;
    }>(
      `select u.password_hash, m.status as membership_status, i.accepted_at
         from app_user u
         join membership m on m.user_id = u.id and m.tenant_id = $2
         join invitation i on i.id = $3
        where u.id = $1`,
      [fx().secondTenantUser.id, fx().secondTenant.id, invitation.invitationId],
    );
    expect(afterAccept.rows[0]?.password_hash).toBe(originalHash);
    expect(afterAccept.rows[0]?.membership_status).toBe('active');
    expect(afterAccept.rows[0]?.accepted_at).not.toBeNull();

    const firstTenantLogin = await login(authPool(), {
      email: fx().secondTenantUser.email,
      password: testPassword,
      tenantSlug: fx().secondTenantUser.tenantSlug,
    });
    const secondTenantLogin = await login(authPool(), {
      email: fx().secondTenantUser.email,
      password: testPassword,
      tenantSlug: fx().secondTenant.slug,
    });
    expect(firstTenantLogin?.tenantId).toBe(fx().secondTenantUser.tenantId);
    expect(secondTenantLogin?.tenantId).toBe(fx().secondTenant.id);
  });

  test('refuses to invite an active user that has no password', async () => {
    const before = await ownerClient().query<{ count: string }>(
      'select count(*)::text as count from invitation where user_id = $1',
      [fx().activeNoPassword.id],
    );

    await expect(
      createInvitation(ownerPoolRef(), {
        tenantSlug: fx().inviteTenant.slug,
        email: fx().activeNoPassword.email,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INVITATION_INPUT' });

    const after = await ownerClient().query<{ count: string }>(
      'select count(*)::text as count from invitation where user_id = $1',
      [fx().activeNoPassword.id],
    );
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  });
});
