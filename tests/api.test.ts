import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  createAuthPool,
  createRuntimePool,
  type AuthPool,
  type RuntimePool,
} from '@saasmodels/db';
import { createServer } from '@saasmodels/api';
import { createTestDatabase, type TestDatabase } from '@saasmodels/testkit';
import {
  createAccessFixtures,
  type AccessFixtures,
  type EmploymentFixture,
} from './support/access-fixtures.js';
import {
  createSessionFixture,
  randomToken,
  type SessionFixture,
} from './support/auth-fixtures.js';

const appOrigin = 'https://app.example.test';

type TestServer = ReturnType<typeof createServer>;

type Sessions = {
  a: SessionFixture;
  b: SessionFixture;
  cancelled: SessionFixture;
  suspendedTenant: SessionFixture;
  closedTenant: SessionFixture;
  deletedTenant: SessionFixture;
  nonMember: SessionFixture;
  suspendedMember: SessionFixture;
  crossTenant: SessionFixture;
};

let database: TestDatabase | undefined;
let fixtures: AccessFixtures | undefined;
let runtime: RuntimePool | undefined;
let auth: AuthPool | undefined;
let sessions: Sessions | undefined;

function fx(): AccessFixtures {
  if (!fixtures) {
    throw new Error('Fixtures have not been created');
  }
  return fixtures;
}

function runtimePool(): RuntimePool {
  if (!runtime) {
    throw new Error('Runtime pool has not been created');
  }
  return runtime;
}

function authPool(): AuthPool {
  if (!auth) {
    throw new Error('Auth pool has not been created');
  }
  return auth;
}

function session(name: keyof Sessions): SessionFixture {
  if (!sessions) {
    throw new Error('Sessions have not been created');
  }
  return sessions[name];
}

async function sessionFor(
  owner: Client,
  fixture: EmploymentFixture,
): Promise<SessionFixture> {
  return createSessionFixture(owner, {
    userId: fixture.userId,
    tenantId: fixture.tenantId,
  });
}

async function withApp<T>(
  fn: (app: TestServer) => Promise<T>,
  options: {
    enableProofRoutes?: boolean;
    pool?: RuntimePool;
    authPool?: AuthPool;
    secureCookies?: boolean;
  } = {},
): Promise<T> {
  const app = createServer({
    pool: options.pool ?? runtimePool(),
    authPool: options.authPool ?? authPool(),
    appOrigin,
    secureCookies: options.secureCookies ?? false,
    enableProofRoutes: options.enableProofRoutes ?? true,
    logger: false,
  });
  await app.ready();
  try {
    return await fn(app);
  } finally {
    await app.close();
  }
}

beforeAll(async () => {
  database = await createTestDatabase({ migrate: true, seed: true });
  runtime = createRuntimePool(database.runtimeUrl);
  auth = createAuthPool(database.authUrl);

  const owner = new Client({ connectionString: database.ownerUrl });
  await owner.connect();
  try {
    fixtures = await createAccessFixtures(owner);
    sessions = {
      a: await sessionFor(owner, fixtures.a),
      b: await sessionFor(owner, fixtures.b),
      cancelled: await sessionFor(owner, fixtures.cancelled),
      suspendedTenant: await sessionFor(owner, fixtures.suspended),
      closedTenant: await sessionFor(owner, fixtures.closed),
      deletedTenant: await sessionFor(owner, fixtures.deleted),
      nonMember: await createSessionFixture(owner, {
        userId: fixtures.nonMemberUserId,
        tenantId: fixtures.a.tenantId,
      }),
      suspendedMember: await createSessionFixture(owner, {
        userId: fixtures.suspendedMemberUserId,
        tenantId: fixtures.a.tenantId,
      }),
      crossTenant: await createSessionFixture(owner, {
        userId: fixtures.a.userId,
        tenantId: fixtures.b.tenantId,
      }),
    };
  } finally {
    await owner.end();
  }
});

afterAll(async () => {
  await auth?.end();
  await runtime?.end();
  await database?.drop();
});

describe('API request layer', () => {
  test('/health returns 200 without a session or a database call', async () => {
    const deadPool = {
      connect: async () => {
        throw new Error('health must not touch the database');
      },
    } as unknown as RuntimePool;
    const deadAuth = {
      connect: async () => {
        throw new Error('health must not touch the database');
      },
      query: async () => {
        throw new Error('health must not touch the database');
      },
    } as unknown as AuthPool;

    await withApp(
      async (app) => {
        const response = await app.inject({ method: 'GET', url: '/health' });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ status: 'ok' });
      },
      { pool: deadPool, authPool: deadAuth },
    );
  });

  test('protected routes reject missing, malformed and unknown session cookies', async () => {
    await withApp(async (app) => {
      for (const cookie of [
        undefined,
        'saas_session=not-a-session-token',
        `saas_session=${randomToken()}`,
      ]) {
        const noContext = await app.inject({
          method: 'GET',
          url: '/v1/context',
          headers: cookie ? { cookie } : {},
        });
        expect(noContext.statusCode).toBe(401);
        expect(noContext.json()).toEqual({ error: { code: 'UNAUTHENTICATED' } });

        const noProof = await app.inject({
          method: 'GET',
          url: '/v1/proof/people/employment',
          headers: cookie ? { cookie } : {},
        });
        expect(noProof.statusCode).toBe(401);
        expect(noProof.json()).toEqual({ error: { code: 'UNAUTHENTICATED' } });
      }
    });
  });

  test('no membership and a suspended membership are denied before platform access', async () => {
    await withApp(async (app) => {
      const nonMemberContext = await app.inject({
        method: 'GET',
        url: '/v1/context',
        headers: { cookie: session('nonMember').cookie },
      });
      expect(nonMemberContext.statusCode).toBe(403);
      expect(nonMemberContext.json()).toEqual({ error: { code: 'MEMBERSHIP_DENIED' } });

      const nonMemberProof = await app.inject({
        method: 'GET',
        url: '/v1/proof/people/employment',
        headers: { cookie: session('nonMember').cookie },
      });
      expect(nonMemberProof.statusCode).toBe(403);
      expect(nonMemberProof.json()).toEqual({ error: { code: 'MEMBERSHIP_DENIED' } });

      const suspendedMembership = await app.inject({
        method: 'GET',
        url: '/v1/context',
        headers: { cookie: session('suspendedMember').cookie },
      });
      expect(suspendedMembership.statusCode).toBe(403);
      expect(suspendedMembership.json()).toEqual({ error: { code: 'MEMBERSHIP_DENIED' } });
    });
  });

  test('a session cannot select another tenant through a forged membership', async () => {
    await withApp(async (app) => {
      const context = await app.inject({
        method: 'GET',
        url: '/v1/context',
        headers: { cookie: session('crossTenant').cookie },
      });
      expect(context.statusCode).toBe(403);
      expect(context.json()).toEqual({ error: { code: 'MEMBERSHIP_DENIED' } });

      const proof = await app.inject({
        method: 'GET',
        url: '/v1/proof/work/projects',
        headers: { cookie: session('crossTenant').cookie },
      });
      expect(proof.statusCode).toBe(403);
      expect(proof.json()).toEqual({ error: { code: 'MEMBERSHIP_DENIED' } });
    });
  });

  test('suspended, closed and deleted tenants are denied on context and proof routes', async () => {
    await withApp(async (app) => {
      for (const key of ['suspendedTenant', 'closedTenant', 'deletedTenant'] as const) {
        const context = await app.inject({
          method: 'GET',
          url: '/v1/context',
          headers: { cookie: session(key).cookie },
        });
        expect(context.statusCode).toBe(403);
        expect(context.json()).toEqual({
          error: { code: 'PLATFORM_ACCESS_DENIED' },
        });

        const proof = await app.inject({
          method: 'GET',
          url: '/v1/proof/people/employment',
          headers: { cookie: session(key).cookie },
        });
        expect(proof.statusCode).toBe(403);
        expect(proof.json()).toEqual({
          error: { code: 'PLATFORM_ACCESS_DENIED' },
        });
      }
    });
  });

  test('tenant A sees People only and only its own employment', async () => {
    const a = fx().a;

    await withApp(async (app) => {
      const context = await app.inject({
        method: 'GET',
        url: '/v1/context',
        headers: { cookie: session('a').cookie },
      });
      expect(context.statusCode).toBe(200);
      expect(context.json()).toEqual({
        userId: a.userId,
        tenantId: a.tenantId,
        role: 'owner',
        switchAccess: true,
        modules: [{ code: 'people', canRead: true, canWrite: true }],
      });

      const employment = await app.inject({
        method: 'GET',
        url: '/v1/proof/people/employment',
        headers: { cookie: session('a').cookie },
      });
      expect(employment.statusCode).toBe(200);
      expect(employment.json()).toEqual({
        items: [
          {
            id: a.employmentId,
            personId: a.personId,
            employmentType: 'full_time',
            startDate: a.employmentStartDate,
            status: 'active',
          },
        ],
      });

      const projects = await app.inject({
        method: 'GET',
        url: '/v1/proof/work/projects',
        headers: { cookie: session('a').cookie },
      });
      expect(projects.statusCode).toBe(403);
      expect(projects.json()).toEqual({
        error: {
          code: 'MODULE_NOT_ENTITLED',
          module: 'work',
          operation: 'read',
        },
      });
    });
  });

  test('tenant B sees Work only and only its own project', async () => {
    const b = fx().b;

    await withApp(async (app) => {
      const context = await app.inject({
        method: 'GET',
        url: '/v1/context',
        headers: { cookie: session('b').cookie },
      });
      expect(context.statusCode).toBe(200);
      expect(context.json()).toEqual({
        userId: b.userId,
        tenantId: b.tenantId,
        role: 'admin',
        switchAccess: true,
        modules: [{ code: 'work', canRead: true, canWrite: true }],
      });

      const projects = await app.inject({
        method: 'GET',
        url: '/v1/proof/work/projects',
        headers: { cookie: session('b').cookie },
      });
      expect(projects.statusCode).toBe(200);
      expect(projects.json()).toEqual({
        items: [
          {
            id: b.project.id,
            name: b.project.name,
            status: 'planned',
            currency: 'ZZZ',
            startDate: b.project.startDate,
            endDate: null,
          },
        ],
      });

      const employment = await app.inject({
        method: 'GET',
        url: '/v1/proof/people/employment',
        headers: { cookie: session('b').cookie },
      });
      expect(employment.statusCode).toBe(403);
      expect(employment.json()).toEqual({
        error: {
          code: 'MODULE_NOT_ENTITLED',
          module: 'people',
          operation: 'read',
        },
      });
    });
  });

  test('tenant C is read-only inside read_until', async () => {
    const c = fx().cancelled;

    await withApp(async (app) => {
      const context = await app.inject({
        method: 'GET',
        url: '/v1/context',
        headers: { cookie: session('cancelled').cookie },
      });
      expect(context.statusCode).toBe(200);
      expect(context.json()).toEqual({
        userId: c.userId,
        tenantId: c.tenantId,
        role: 'employee',
        switchAccess: false,
        modules: [{ code: 'people', canRead: true, canWrite: false }],
      });

      const employment = await app.inject({
        method: 'GET',
        url: '/v1/proof/people/employment',
        headers: { cookie: session('cancelled').cookie },
      });
      expect(employment.statusCode).toBe(200);
      expect(employment.json()).toEqual({
        items: [
          {
            id: c.employmentId,
            personId: c.personId,
            employmentType: 'full_time',
            startDate: c.employmentStartDate,
            status: 'active',
          },
        ],
      });
    });
  });

  test('tenant override headers and query strings are ignored', async () => {
    const a = fx().a;
    const b = fx().b;

    await withApp(async (app) => {
      const response = await app.inject({
        method: 'GET',
        url: `/v1/proof/people/employment?tenant_id=${b.tenantId}`,
        headers: {
          cookie: session('a').cookie,
          'x-tenant-id': b.tenantId,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        items: [
          {
            id: a.employmentId,
            personId: a.personId,
            employmentType: 'full_time',
            startDate: a.employmentStartDate,
            status: 'active',
          },
        ],
      });
    });
  });

  test('sequential tenants and users through one pool do not leak context or role', async () => {
    const a = fx().a;
    const b = fx().b;
    const c = fx().cancelled;

    await withApp(async (app) => {
      const first = await app.inject({
        method: 'GET',
        url: '/v1/context',
        headers: { cookie: session('a').cookie },
      });
      expect(first.statusCode).toBe(200);
      expect(first.json()).toMatchObject({
        userId: a.userId,
        tenantId: a.tenantId,
        role: 'owner',
      });

      const firstProof = await app.inject({
        method: 'GET',
        url: '/v1/proof/people/employment',
        headers: { cookie: session('a').cookie },
      });
      expect(firstProof.statusCode).toBe(200);
      expect(firstProof.json().items.map((item: { id: string }) => item.id)).toEqual([
        a.employmentId,
      ]);

      const second = await app.inject({
        method: 'GET',
        url: '/v1/context',
        headers: { cookie: session('b').cookie },
      });
      expect(second.statusCode).toBe(200);
      expect(second.json()).toMatchObject({
        userId: b.userId,
        tenantId: b.tenantId,
        role: 'admin',
      });

      const secondProof = await app.inject({
        method: 'GET',
        url: '/v1/proof/work/projects',
        headers: { cookie: session('b').cookie },
      });
      expect(secondProof.statusCode).toBe(200);
      expect(secondProof.json().items.map((item: { id: string }) => item.id)).toEqual([
        b.project.id,
      ]);

      const third = await app.inject({
        method: 'GET',
        url: '/v1/context',
        headers: { cookie: session('cancelled').cookie },
      });
      expect(third.statusCode).toBe(200);
      expect(third.json()).toMatchObject({
        userId: c.userId,
        tenantId: c.tenantId,
        role: 'employee',
      });

      const fourth = await app.inject({
        method: 'GET',
        url: '/v1/context',
        headers: { cookie: session('a').cookie },
      });
      expect(fourth.statusCode).toBe(200);
      expect(fourth.json()).toMatchObject({
        userId: a.userId,
        tenantId: a.tenantId,
        role: 'owner',
      });
    });
  });

  test('denied module routes return no items', async () => {
    await withApp(async (app) => {
      const deniedProjects = await app.inject({
        method: 'GET',
        url: '/v1/proof/work/projects',
        headers: { cookie: session('a').cookie },
      });
      expect(deniedProjects.statusCode).toBe(403);
      expect(deniedProjects.json()).not.toHaveProperty('items');

      const deniedEmployment = await app.inject({
        method: 'GET',
        url: '/v1/proof/people/employment',
        headers: { cookie: session('b').cookie },
      });
      expect(deniedEmployment.statusCode).toBe(403);
      expect(deniedEmployment.json()).not.toHaveProperty('items');
    });
  });

  test('proof routes are not registered by default', async () => {
    await withApp(
      async (app) => {
        const response = await app.inject({
          method: 'GET',
          url: '/v1/proof/people/employment',
          headers: { cookie: session('a').cookie },
        });
        expect(response.statusCode).toBe(404);
      },
      { enableProofRoutes: false },
    );
  });

  test('unknown errors are a sanitized 500', async () => {
    const secret = 'select * from employment where id = 42';
    const brokenPool = {
      connect: async () => {
        throw new Error(secret);
      },
    } as unknown as RuntimePool;

    await withApp(
      async (app) => {
        const response = await app.inject({
          method: 'GET',
          url: '/v1/context',
          headers: { cookie: session('a').cookie },
        });
        expect(response.statusCode).toBe(500);
        expect(response.json()).toEqual({ error: { code: 'INTERNAL_ERROR' } });
        expect(response.body).not.toContain('select');
        expect(response.body).not.toContain('employment');
        expect(response.body).not.toContain('42');
        expect(response.body).not.toMatch(/stack/i);
      },
      { pool: brokenPool },
    );
  });
});
