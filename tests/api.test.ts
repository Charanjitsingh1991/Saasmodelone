import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createRuntimePool, type RuntimePool } from '@saasmodels/db';
import { createServer, type Authenticate, type Principal } from '@saasmodels/api';
import { createTestDatabase, type TestDatabase } from '@saasmodels/testkit';
import {
  createAccessFixtures,
  type AccessFixtures,
  type EmploymentFixture,
} from './support/access-fixtures.js';

type TestServer = ReturnType<typeof createServer>;

let database: TestDatabase | undefined;
let fixtures: AccessFixtures | undefined;
const pool = { current: undefined as ReturnType<typeof createRuntimePool> | undefined };

function fx(): AccessFixtures {
  if (!fixtures) {
    throw new Error('Fixtures have not been created');
  }
  return fixtures;
}

function runtimePool(): ReturnType<typeof createRuntimePool> {
  if (!pool.current) {
    throw new Error('Runtime pool has not been created');
  }
  return pool.current;
}

function principalFor(fixture: EmploymentFixture): Principal {
  return { userId: fixture.userId, tenantId: fixture.tenantId };
}

const authenticateAs = (principal: Principal | null): Authenticate => async () => principal;

async function withApp<T>(
  authenticate: Authenticate,
  fn: (app: TestServer) => Promise<T>,
  enableProofRoutes = true,
  serverPool: RuntimePool = runtimePool(),
): Promise<T> {
  const app = createServer({
    pool: serverPool,
    authenticate,
    enableProofRoutes,
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
  pool.current = createRuntimePool(database.runtimeUrl);

  const owner = new Client({ connectionString: database.ownerUrl });
  await owner.connect();
  try {
    fixtures = await createAccessFixtures(owner);
  } finally {
    await owner.end();
  }
});

afterAll(async () => {
  await pool.current?.end();
  await database?.drop();
});

describe('API request layer', () => {
  test('/health returns 200 without a principal or a database call', async () => {
    const noDatabase = {
      connect: async () => {
        throw new Error('health must not touch the database');
      },
    } as unknown as RuntimePool;

    await withApp(
      async () => {
        throw new Error('health must not authenticate');
      },
      async (app) => {
        const response = await app.inject({ method: 'GET', url: '/health' });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ status: 'ok' });
      },
      true,
      noDatabase,
    );
  });

  test('protected routes reject missing, malformed and unknown principals', async () => {
    let current: Principal | null = null;

    await withApp(async () => current, async (app) => {
      const noContext = await app.inject({ method: 'GET', url: '/v1/context' });
      expect(noContext.statusCode).toBe(401);
      expect(noContext.json()).toEqual({ error: { code: 'UNAUTHENTICATED' } });

      const noProof = await app.inject({
        method: 'GET',
        url: '/v1/proof/people/employment',
      });
      expect(noProof.statusCode).toBe(401);
      expect(noProof.json()).toEqual({ error: { code: 'UNAUTHENTICATED' } });

      current = { userId: 'malformed', tenantId: 'not-a-uuid' };
      const malformed = await app.inject({ method: 'GET', url: '/v1/context' });
      expect(malformed.statusCode).toBe(401);
      expect(malformed.json()).toEqual({ error: { code: 'UNAUTHENTICATED' } });

      current = { userId: randomUUID(), tenantId: randomUUID() };
      const unknown = await app.inject({ method: 'GET', url: '/v1/context' });
      expect(unknown.statusCode).toBe(403);
      expect(unknown.json()).toEqual({ error: { code: 'MEMBERSHIP_DENIED' } });
    });
  });

  test('no membership and a suspended membership are denied before platform access', async () => {
    let current: Principal | null = {
      userId: fx().nonMemberUserId,
      tenantId: fx().a.tenantId,
    };

    await withApp(async () => current, async (app) => {
      const nonMemberContext = await app.inject({ method: 'GET', url: '/v1/context' });
      expect(nonMemberContext.statusCode).toBe(403);
      expect(nonMemberContext.json()).toEqual({ error: { code: 'MEMBERSHIP_DENIED' } });

      const nonMemberProof = await app.inject({
        method: 'GET',
        url: '/v1/proof/people/employment',
      });
      expect(nonMemberProof.statusCode).toBe(403);
      expect(nonMemberProof.json()).toEqual({ error: { code: 'MEMBERSHIP_DENIED' } });

      // Membership resolves first, so a non-member cannot tell that this
      // tenant is suspended rather than active.
      current = {
        userId: fx().nonMemberUserId,
        tenantId: fx().suspended.tenantId,
      };
      const suspendedTenant = await app.inject({ method: 'GET', url: '/v1/context' });
      expect(suspendedTenant.statusCode).toBe(403);
      expect(suspendedTenant.json()).toEqual({ error: { code: 'MEMBERSHIP_DENIED' } });

      current = {
        userId: fx().suspendedMemberUserId,
        tenantId: fx().a.tenantId,
      };
      const suspendedMembership = await app.inject({ method: 'GET', url: '/v1/context' });
      expect(suspendedMembership.statusCode).toBe(403);
      expect(suspendedMembership.json()).toEqual({ error: { code: 'MEMBERSHIP_DENIED' } });
    });
  });

  test('a member of one tenant cannot switch to another tenant', async () => {
    const principal = { userId: fx().a.userId, tenantId: fx().b.tenantId };

    await withApp(authenticateAs(principal), async (app) => {
      const context = await app.inject({ method: 'GET', url: '/v1/context' });
      expect(context.statusCode).toBe(403);
      expect(context.json()).toEqual({ error: { code: 'MEMBERSHIP_DENIED' } });

      const proof = await app.inject({
        method: 'GET',
        url: '/v1/proof/work/projects',
      });
      expect(proof.statusCode).toBe(403);
      expect(proof.json()).toEqual({ error: { code: 'MEMBERSHIP_DENIED' } });
    });
  });

  test('suspended, closed and deleted tenants are denied on context and proof routes', async () => {
    const tenants = [fx().suspended, fx().closed, fx().deleted];
    let current: Principal | null = null;

    await withApp(async () => current, async (app) => {
      for (const tenant of tenants) {
        current = principalFor(tenant);

        const context = await app.inject({ method: 'GET', url: '/v1/context' });
        expect(context.statusCode).toBe(403);
        expect(context.json()).toEqual({
          error: { code: 'PLATFORM_ACCESS_DENIED' },
        });

        const proof = await app.inject({
          method: 'GET',
          url: '/v1/proof/people/employment',
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

    await withApp(authenticateAs(principalFor(a)), async (app) => {
      const context = await app.inject({ method: 'GET', url: '/v1/context' });
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

    await withApp(authenticateAs(principalFor(b)), async (app) => {
      const context = await app.inject({ method: 'GET', url: '/v1/context' });
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

    await withApp(authenticateAs(principalFor(c)), async (app) => {
      const context = await app.inject({ method: 'GET', url: '/v1/context' });
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

    await withApp(authenticateAs(principalFor(a)), async (app) => {
      const response = await app.inject({
        method: 'GET',
        url: `/v1/proof/people/employment?tenant_id=${b.tenantId}`,
        headers: { 'x-tenant-id': b.tenantId },
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
    let current: Principal | null = principalFor(a);

    await withApp(async () => current, async (app) => {
      const first = await app.inject({ method: 'GET', url: '/v1/context' });
      expect(first.statusCode).toBe(200);
      expect(first.json()).toMatchObject({
        userId: a.userId,
        tenantId: a.tenantId,
        role: 'owner',
      });

      const firstProof = await app.inject({
        method: 'GET',
        url: '/v1/proof/people/employment',
      });
      expect(firstProof.statusCode).toBe(200);
      expect(firstProof.json().items.map((item: { id: string }) => item.id)).toEqual([
        a.employmentId,
      ]);

      current = principalFor(b);
      const second = await app.inject({ method: 'GET', url: '/v1/context' });
      expect(second.statusCode).toBe(200);
      expect(second.json()).toMatchObject({
        userId: b.userId,
        tenantId: b.tenantId,
        role: 'admin',
      });

      const secondProof = await app.inject({
        method: 'GET',
        url: '/v1/proof/work/projects',
      });
      expect(secondProof.statusCode).toBe(200);
      expect(secondProof.json().items.map((item: { id: string }) => item.id)).toEqual([
        b.project.id,
      ]);

      current = principalFor(c);
      const third = await app.inject({ method: 'GET', url: '/v1/context' });
      expect(third.statusCode).toBe(200);
      expect(third.json()).toMatchObject({
        userId: c.userId,
        tenantId: c.tenantId,
        role: 'employee',
      });

      current = principalFor(a);
      const fourth = await app.inject({ method: 'GET', url: '/v1/context' });
      expect(fourth.statusCode).toBe(200);
      expect(fourth.json()).toMatchObject({
        userId: a.userId,
        tenantId: a.tenantId,
        role: 'owner',
      });
    });
  });

  test('denied module routes return no items', async () => {
    const a = fx().a;
    const b = fx().b;
    let current: Principal | null = principalFor(a);

    await withApp(async () => current, async (app) => {
      const deniedProjects = await app.inject({
        method: 'GET',
        url: '/v1/proof/work/projects',
      });
      expect(deniedProjects.statusCode).toBe(403);
      expect(deniedProjects.json()).not.toHaveProperty('items');

      current = principalFor(b);
      const deniedEmployment = await app.inject({
        method: 'GET',
        url: '/v1/proof/people/employment',
      });
      expect(deniedEmployment.statusCode).toBe(403);
      expect(deniedEmployment.json()).not.toHaveProperty('items');
    });
  });

  test('proof routes are not registered by default', async () => {
    await withApp(
      authenticateAs(principalFor(fx().a)),
      async (app) => {
        const response = await app.inject({
          method: 'GET',
          url: '/v1/proof/people/employment',
        });
        expect(response.statusCode).toBe(404);
      },
      false,
    );
  });

  test('unknown errors are a sanitized 500', async () => {
    const secret = 'select * from employment where id = 42';

    await withApp(
      async () => {
        throw new Error(secret);
      },
      async (app) => {
        const response = await app.inject({ method: 'GET', url: '/v1/context' });
        expect(response.statusCode).toBe(500);
        expect(response.json()).toEqual({ error: { code: 'INTERNAL_ERROR' } });
        expect(response.body).not.toContain('select');
        expect(response.body).not.toContain('employment');
        expect(response.body).not.toContain('42');
        expect(response.body).not.toMatch(/stack/i);
      },
    );
  });
});
