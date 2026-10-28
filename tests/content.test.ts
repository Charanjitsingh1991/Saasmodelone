import { Client, Pool } from 'pg';
import type { OutgoingHttpHeaders } from 'node:http';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  createAuthPool,
  createRuntimePool,
  type AuthPool,
  type RuntimePool,
} from '@saasmodels/db';
import {
  CONTENT_LIST_DEFAULT_PAGE_SIZE,
  CONTENT_LIST_MAX_PAGE_SIZE,
  CONTENT_SEARCH_MAX_LENGTH,
  type ContentListResponse,
} from '@saasmodels/contracts';
import { createServer } from '@saasmodels/api';
import { createTestDatabase, type TestDatabase } from '@saasmodels/testkit';
import { randomToken } from './support/auth-fixtures.js';
import {
  insertContentRow,
  provisionModuleTenant,
  type ContentRowFixture,
  type ModuleTenantFixture,
} from './support/module-fixtures.js';

const appOrigin = 'https://app.example.test';
const USER_AGENT = 'Content read test/1.0';

type ContentResponse = {
  statusCode: number;
  headers: OutgoingHttpHeaders;
  body: string;
  data: ContentListResponse;
};

type DenialRow = {
  action: string;
  entity_type: string;
  entity_id: string | null;
  actor_type: string;
  actor_user_id: string | null;
  metadata: Record<string, unknown>;
};

type ContentTenants = {
  owner: ModuleTenantFixture;
  other: ModuleTenantFixture;
  unentitled: ModuleTenantFixture;
  hr: ModuleTenantFixture;
  employee: ModuleTenantFixture;
  empty: ModuleTenantFixture;
};

let database: TestDatabase | undefined;
let runtime: RuntimePool | undefined;
let auth: AuthPool | undefined;
let owner: Pool | undefined;
let tenants: ContentTenants | undefined;
let ownerItems: ContentRowFixture[] | undefined;
let otherItem: ContentRowFixture | undefined;
let ownerRetiredItem: ContentRowFixture | undefined;

function db(): TestDatabase {
  if (!database) {
    throw new Error('Test database has not been created');
  }
  return database;
}

function tenants_(): ContentTenants {
  if (!tenants) {
    throw new Error('Tenants have not been provisioned');
  }
  return tenants;
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

function one<T>(rows: T[]): T {
  const row = rows[0];
  if (!row) {
    throw new Error('Expected exactly one row');
  }
  return row;
}

async function withOwner<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: db().ownerUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function auditRows(tenantId: string): Promise<DenialRow[]> {
  return withOwner(async (client) => {
    const result = await client.query<DenialRow>(
      `select action, entity_type, entity_id, actor_type, actor_user_id, metadata
         from audit_event
        where tenant_id = $1
        order by occurred_at, id`,
      [tenantId],
    );
    return result.rows;
  });
}

async function denialRows(tenantId: string): Promise<DenialRow[]> {
  const rows = await auditRows(tenantId);
  return rows.filter((row) => row.action === 'authorization.denied');
}

// The soft-deleted row is counted in the table itself, so a route proof
// cannot pass on an empty table.
async function softDeletedContentCount(tenantId: string): Promise<number> {
  return withOwner(async (client) => {
    const result = await client.query<{ total: string }>(
      `select count(*) as total from content_item
        where tenant_id = $1 and deleted_at is not null`,
      [tenantId],
    );
    return Number(result.rows[0]?.total ?? '0');
  });
}

type TestServer = ReturnType<typeof createServer>;

async function withApp<T>(fn: (app: TestServer) => Promise<T>): Promise<T> {
  const app = createServer({
    pool: runtimePool(),
    authPool: authPool(),
    appOrigin,
    secureCookies: false,
    logger: false,
  });
  await app.ready();
  try {
    return await fn(app);
  } finally {
    await app.close();
  }
}

async function list(
  app: TestServer,
  cookie: string,
  query = '',
): Promise<ContentResponse> {
  const response = await app.inject({
    method: 'GET',
    url: `/v1/content/items${query}`,
    headers: { cookie, 'user-agent': USER_AGENT },
  });
  return {
    statusCode: response.statusCode,
    headers: response.headers,
    body: response.body,
    data: response.json() as ContentListResponse,
  };
}

beforeAll(async () => {
  database = await createTestDatabase({ migrate: true, seed: true });
  runtime = createRuntimePool(database.runtimeUrl);
  auth = createAuthPool(database.authUrl);
  owner = new Pool({ connectionString: database.ownerUrl });

  const [ownerTenant, otherTenant, unentitled, hr, employee, empty] =
    await Promise.all([
      provisionModuleTenant(db().ownerUrl, {
        label: 'contentowner',
        modules: ['people', 'work', 'money', 'content'],
      }),
      provisionModuleTenant(db().ownerUrl, {
        label: 'contentother',
        modules: ['people', 'work', 'money', 'content'],
      }),
      // No Content entitlement, and a role that holds no Content permission
      // either: the entitlement is answered before the role.
      provisionModuleTenant(db().ownerUrl, {
        label: 'contentunentitled',
        modules: ['people'],
        role: 'employee',
      }),
      provisionModuleTenant(db().ownerUrl, {
        label: 'contenthr',
        modules: ['people', 'work', 'money', 'content'],
        role: 'hr',
      }),
      provisionModuleTenant(db().ownerUrl, {
        label: 'contentemployee',
        modules: ['people', 'work', 'money', 'content'],
        role: 'employee',
      }),
      provisionModuleTenant(db().ownerUrl, {
        label: 'contentempty',
        modules: ['people', 'work', 'money', 'content'],
      }),
    ]);

  tenants = {
    owner: ownerTenant,
    other: otherTenant,
    unentitled,
    hr,
    employee,
    empty,
  };

  await withOwner(async (client) => {
    ownerItems = [
      await insertContentRow(client, ownerTenant.tenantId, {
        kind: 'page',
        slug: 'getting-started',
        title: 'Getting started',
        locale: 'en',
        status: 'published',
        publishedAt: '2026-01-10',
        updatedAt: '2026-02-01',
      }),
      await insertContentRow(client, ownerTenant.tenantId, {
        kind: 'knowledge',
        slug: 'payroll-runbook',
        title: 'Payroll runbook',
        locale: 'en',
        status: 'draft',
        publishedAt: null,
        updatedAt: '2026-02-03',
      }),
    ];

    otherItem = await insertContentRow(client, otherTenant.tenantId, {
      kind: 'post',
      slug: 'zephyr-news',
      title: 'Zephyr news',
      locale: 'en',
      status: 'archived',
      publishedAt: '2025-12-01',
      updatedAt: '2025-12-02',
    });

    // A withdrawn item in the owner workspace. The owner page answers two
    // items, so the row proves the route drops a soft-deleted row from the
    // list and from the total rather than the table being empty.
    ownerRetiredItem = await insertContentRow(client, ownerTenant.tenantId, {
      kind: 'page',
      slug: 'retired-policy',
      title: 'Retired policy',
      locale: 'en',
      status: 'archived',
      publishedAt: null,
      updatedAt: '2026-02-20',
      deletedAt: '2026-03-01',
    });
  });
});

afterAll(async () => {
  await owner?.end();
  await auth?.end();
  await runtime?.end();
  await database?.drop();
});

describe('Content item read path', () => {
  test('rejects requests without a valid session', async () => {
    await withApp(async (app) => {
      for (const headers of [
        {},
        { cookie: `saas_session=${randomToken()}` },
      ]) {
        const response = await app.inject({
          method: 'GET',
          url: '/v1/content/items',
          headers,
        });
        expect(response.statusCode).toBe(401);
        expect(response.json()).toEqual({ error: { code: 'UNAUTHENTICATED' } });
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.body).not.toContain('Getting started');
      }
    });
  });

  test('returns the content items with the stored status and dates', async () => {
    const session = tenants_().owner.session;
    const items = ownerItems ?? [];

    await withApp(async (app) => {
      const result = await list(app, session.cookie);
      expect(result.statusCode).toBe(200);

      const body = result.data;
      expect(Object.keys(body).sort()).toEqual([
        'items',
        'page',
        'pageSize',
        'total',
      ]);
      expect(body.total).toBe(2);
      expect(body.page).toBe(1);
      expect(body.pageSize).toBe(CONTENT_LIST_DEFAULT_PAGE_SIZE);
      expect(body.items).toHaveLength(2);

      for (const item of body.items) {
        expect(Object.keys(item).sort()).toEqual([
          'id',
          'kind',
          'locale',
          'publishedAt',
          'slug',
          'status',
          'title',
          'updatedAt',
        ]);
      }

      expect(one(body.items)).toEqual({
        id: one(items).id,
        kind: 'page',
        slug: 'getting-started',
        title: 'Getting started',
        locale: 'en',
        status: 'published',
        publishedAt: '2026-01-10',
        updatedAt: '2026-02-01',
      });

      // A draft has no publication date, and the answer says so rather than
      // inventing one.
      expect(body.items[1]).toMatchObject({
        id: items[1]?.id,
        kind: 'knowledge',
        slug: 'payroll-runbook',
        status: 'draft',
        publishedAt: null,
        updatedAt: '2026-02-03',
      });

      // A content item has no client, so the answer carries no client
      // reference at all, and the version, review and search metadata stay
      // behind the route.
      for (const disclosure of [
        'clientId',
        'clientName',
        'client',
        'seo',
        'author_user_id',
        'authorUserId',
        'reviewer_user_id',
        'reviewerUserId',
        'current_version_id',
        'currentVersionId',
        'tenant_id',
        'tenantId',
      ]) {
        expect(result.body).not.toContain(disclosure);
      }
    });
  });

  test('never discloses another tenant content items', async () => {
    const ownerSession = tenants_().owner.session;
    const otherSession = tenants_().other.session;
    const foreign = otherItem;

    await withApp(async (app) => {
      const result = await list(app, ownerSession.cookie);
      expect(result.statusCode).toBe(200);
      expect(result.data.total).toBe(2);
      expect(result.body).not.toContain('Zephyr news');
      expect(result.body).not.toContain('zephyr-news');
      if (foreign) {
        expect(result.body).not.toContain(foreign.id);
      }

      const otherView = await list(app, otherSession.cookie);
      expect(otherView.statusCode).toBe(200);
      expect(otherView.data.total).toBe(1);
      expect(otherView.data.items).toHaveLength(1);
      expect(one(otherView.data.items)).toMatchObject({
        id: foreign?.id,
        slug: 'zephyr-news',
      });
      expect(otherView.body).not.toContain('Getting started');
    });
  });

  test('denies an unentitled tenant before the role is considered', async () => {
    const unentitled = tenants_().unentitled;
    const before = await denialRows(unentitled.tenantId);

    await withApp(async (app) => {
      const result = await list(app, unentitled.session.cookie);
      expect(result.statusCode).toBe(403);
      expect(JSON.parse(result.body)).toEqual({
        error: { code: 'MODULE_NOT_ENTITLED', module: 'content', operation: 'read' },
      });
      expect(result.headers['cache-control']).toBe('no-store');
      expect(result.body).not.toContain('Getting started');
    });

    const after = await denialRows(unentitled.tenantId);
    expect(after).toHaveLength(before.length + 1);
    expect(one(after.slice(-1))).toMatchObject({
      action: 'authorization.denied',
      entity_type: 'request',
      entity_id: null,
      actor_type: 'user',
      actor_user_id: unentitled.userId,
      metadata: {
        reason: 'MODULE_NOT_ENTITLED',
        method: 'GET',
        path: '/v1/content/items',
        module: 'content',
        operation: 'read',
      },
    });
  });

  test.each([
    ['hr', 'hr'],
    ['employee', 'employee'],
  ] as const)('denies the %s role with one ROLE_DENIED audit row', async (_label, key) => {
    const tenant = tenants_()[key];
    const before = await denialRows(tenant.tenantId);

    await withApp(async (app) => {
      const result = await list(app, tenant.session.cookie);
      expect(result.statusCode).toBe(403);
      expect(JSON.parse(result.body)).toEqual({
        error: { code: 'ROLE_DENIED', permission: 'content.read' },
      });
      expect(result.headers['cache-control']).toBe('no-store');
      expect(result.body).not.toContain('Getting started');
    });

    const after = await denialRows(tenant.tenantId);
    expect(after).toHaveLength(before.length + 1);
    expect(one(after.slice(-1))).toMatchObject({
      action: 'authorization.denied',
      actor_user_id: tenant.userId,
      metadata: {
        reason: 'ROLE_DENIED',
        method: 'GET',
        path: '/v1/content/items',
        module: 'content',
        operation: 'read',
        permission: 'content.read',
      },
    });
  });

  test('matches the title, slug and kind literally', async () => {
    await withApp(async (app) => {
      const cookie = tenants_().owner.session.cookie;

      const byTitle = await list(app, cookie, '?q=runBOOK');
      expect(byTitle.statusCode).toBe(200);
      expect(byTitle.data.total).toBe(1);
      expect(one(byTitle.data.items).slug).toBe('payroll-runbook');

      const bySlug = await list(app, cookie, '?q=getting-started');
      expect(bySlug.data.total).toBe(1);
      expect(one(bySlug.data.items).title).toBe('Getting started');

      const byKind = await list(app, cookie, '?q=knowledge');
      expect(byKind.data.total).toBe(1);

      const empty = await list(app, cookie, '?q=');
      expect(empty.data.total).toBe(2);

      const noMatch = await list(app, cookie, '?q=nothing-here');
      expect(noMatch.data).toMatchObject({ items: [], total: 0 });

      // A wildcard cannot widen the search: these are ordinary characters.
      const wildcard = await list(app, cookie, '?q=%25');
      expect(wildcard.statusCode).toBe(200);
      expect(wildcard.data).toMatchObject({ items: [], total: 0 });

      const underscore = await list(app, cookie, '?q=_');
      expect(underscore.statusCode).toBe(200);
      expect(underscore.data).toMatchObject({ items: [], total: 0 });

      const embedded = await list(app, cookie, '?q=getting%25started');
      expect(embedded.data.total).toBe(0);
    });
  });

  test('pages deterministically and reports the true total past the end', async () => {
    await withApp(async (app) => {
      const cookie = tenants_().owner.session.cookie;
      const first = await list(app, cookie, '?page=1&pageSize=1');
      const second = await list(app, cookie, '?page=2&pageSize=1');
      const third = await list(app, cookie, '?page=3&pageSize=1');

      expect(first.statusCode).toBe(200);
      expect(first.data.items).toHaveLength(1);
      expect(first.data).toMatchObject({ page: 1, pageSize: 1, total: 2 });

      expect(second.data.items).toHaveLength(1);
      expect(second.data).toMatchObject({ page: 2, pageSize: 1, total: 2 });

      expect(third.statusCode).toBe(200);
      expect(third.data).toMatchObject({ items: [], page: 3, pageSize: 1, total: 2 });

      const beyond = await list(app, cookie, '?page=999999');
      expect(beyond.statusCode).toBe(200);
      expect(beyond.data).toMatchObject({ items: [], total: 2, page: 999999 });
    });
  });

  test('rejects malformed paging and search parameters with 400', async () => {
    const invalid = [
      '?page=0',
      '?page=abc',
      '?page=1.5',
      '?page=2&page=3',
      '?pageSize=0',
      `?pageSize=${CONTENT_LIST_MAX_PAGE_SIZE + 1}`,
      '?pageSize=abc',
      '?pageSize=50&pageSize=50',
      `?q=${'x'.repeat(CONTENT_SEARCH_MAX_LENGTH + 1)}`,
      '?q=a&q=b',
    ];

    await withApp(async (app) => {
      for (const query of invalid) {
        const response = await app.inject({
          method: 'GET',
          url: `/v1/content/items${query}`,
          headers: { cookie: tenants_().owner.session.cookie },
        });
        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({ error: { code: 'INVALID_QUERY' } });
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.body).not.toContain('Getting started');
      }
    });
  });

  test('marks every content response uncacheable', async () => {
    await withApp(async (app) => {
      const allowed = await list(app, tenants_().owner.session.cookie);
      expect(allowed.statusCode).toBe(200);
      expect(allowed.headers['cache-control']).toBe('no-store');

      const denied = await list(app, tenants_().hr.session.cookie);
      expect(denied.statusCode).toBe(403);
      expect(denied.headers['cache-control']).toBe('no-store');
    });
  });

  test('writes no audit row for a successful content read', async () => {
    const tenant = tenants_().owner;
    const before = await auditRows(tenant.tenantId);

    await withApp(async (app) => {
      for (const query of ['', '?q=getting', '?page=2&pageSize=1']) {
        const result = await list(app, tenant.session.cookie, query);
        expect(result.statusCode).toBe(200);
      }
    });

    expect(await auditRows(tenant.tenantId)).toHaveLength(before.length);
  });

  test('answers an empty list for a workspace with no content', async () => {
    const empty = tenants_().empty;

    await withApp(async (app) => {
      const result = await list(app, empty.session.cookie);
      expect(result.statusCode).toBe(200);
      expect(result.data).toMatchObject({ items: [], total: 0, page: 1 });
      expect(result.data.pageSize).toBe(CONTENT_LIST_DEFAULT_PAGE_SIZE);
    });
  });

  test('drops a soft-deleted content item from the list and from the total', async () => {
    const withdrawn = ownerRetiredItem;
    const tenant = tenants_().owner;

    // The row is in the table and it is soft deleted.
    expect(await softDeletedContentCount(tenant.tenantId)).toBe(1);

    await withApp(async (app) => {
      const cookie = tenants_().owner.session.cookie;
      const result = await list(app, cookie);
      expect(result.statusCode).toBe(200);

      // The workspace holds three item rows and one of them is soft deleted,
      // so the total counts the two live rows and not the third.
      expect(result.data.total).toBe(2);
      expect(result.data.items).toHaveLength(2);
      expect(result.data.items.map((item) => item.title)).not.toContain(
        'Retired policy',
      );
      expect(result.body).not.toContain('Retired policy');
      expect(result.body).not.toContain('retired-policy');
      if (withdrawn) {
        expect(result.body).not.toContain(withdrawn.id);
      }

      // A soft-deleted row is not searchable either.
      const byTitle = await list(app, cookie, '?q=retired');
      expect(byTitle.statusCode).toBe(200);
      expect(byTitle.data).toMatchObject({ items: [], total: 0 });

      const bySlug = await list(app, cookie, '?q=retired-policy');
      expect(bySlug.statusCode).toBe(200);
      expect(bySlug.data).toMatchObject({ items: [], total: 0 });
    });
  });
});
