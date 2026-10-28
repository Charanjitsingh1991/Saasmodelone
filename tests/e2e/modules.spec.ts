import { randomBytes } from 'node:crypto';
import { Client, Pool } from 'pg';
import { expect, test } from '@playwright/test';
import { appOrigin } from './ports.js';
import { createServer } from '@saasmodels/api';
import {
  createAuthPool,
  createRuntimePool,
  hashPassword,
  provisionTenant,
  type AuthPool,
  type RuntimePool,
} from '@saasmodels/db';
import { createTestDatabase, type TestDatabase } from '@saasmodels/testkit';

const apiPort = 3001;
const syntheticPassword = 'Synthetic-modules-passphrase-2026';

type Account = {
  slug: string;
  email: string;
};

let database: TestDatabase | undefined;
let runtime: RuntimePool | undefined;
let auth: AuthPool | undefined;
let server: ReturnType<typeof createServer> | undefined;
let ownerAccount: Account | undefined;
let managerAccount: Account | undefined;

// A member whose role reads People and Work but holds neither money.read nor
// content.read. The membership is written owner-side because role
// administration has no route in this milestone.
async function createManagerMember(
  owner: Client,
  tenantId: string,
  passwordHash: string,
): Promise<string> {
  const email = `modules_reader_${randomBytes(4).toString('hex')}@example.test`;
  const user = await owner.query<{ id: string }>(
    `insert into app_user (email, display_name, status, password_hash)
     values ($1, 'Modules reader', 'active', $2)
     returning id`,
    [email, passwordHash],
  );
  const userId = user.rows[0]?.id;
  if (!userId) {
    throw new Error('Could not create the modules reader account');
  }
  await owner.query(
    `insert into membership (tenant_id, user_id, role, status)
     values ($1, $2, 'manager', 'active')`,
    [tenantId, userId],
  );
  return email;
}

function requireAccount(account: Account | undefined, name: string): Account {
  if (!account) {
    throw new Error(`${name} account was not created`);
  }
  return account;
}

test.beforeAll(async () => {
  database = await createTestDatabase({
    migrate: true,
    seed: true,
    namePrefix: 'saasmodels_e2e_modules',
  });
  runtime = createRuntimePool(database.runtimeUrl);
  auth = createAuthPool(database.authUrl);

  const pool = new Pool({ connectionString: database.ownerUrl });
  const owner = new Client({ connectionString: database.ownerUrl });
  await owner.connect();
  try {
    // The tenant is provisioned through the real owner path, so the four
    // entitlements it holds come from the catalog rather than from rows written
    // here. Work, Money and Content are catalog status 'preview', so a normal
    // tenant may hold them on a contract entitlement.
    const suffix = randomBytes(4).toString('hex');
    const slug = `modules-owner-${suffix}`;
    const email = `modules_owner_${suffix}@example.test`;
    const provisioned = await provisionTenant(pool, {
      name: 'Modules journey',
      slug,
      dataRegion: 'test',
      ownerEmail: email,
      ownerDisplayName: 'Modules owner',
      modules: ['people', 'work', 'money', 'content'],
    });

    const passwordHash = await hashPassword(syntheticPassword);

    // The owner rows are written on the owner connection, as the directory rows
    // are: the runtime role may read them but may not write them, and none of
    // these modules has a write surface in this build.
    await owner.query('begin');
    await owner.query(
      `update app_user set status = 'active', password_hash = $2 where id = $1`,
      [provisioned.ownerUserId, passwordHash],
    );
    await owner.query(
      `update membership set role = 'owner', status = 'active'
        where tenant_id = $1 and user_id = $2`,
      [provisioned.tenantId, provisioned.ownerUserId],
    );

    const client = await owner.query<{ id: string }>(
      `insert into client (tenant_id, name, code, currency)
       values ($1, 'Aster Logistics', 'CL-ASTER', 'ZZZ')
       returning id`,
      [provisioned.tenantId],
    );
    const clientId = client.rows[0]?.id;
    if (!clientId) {
      throw new Error('Could not create the journey client');
    }

    await owner.query(
      `insert into project
         (tenant_id, client_id, name, code, status, currency, start_date, end_date,
          budget_minor)
       values ($1, $2, 'Aster rollout', 'PR-ASTER-1', 'active', 'ZZZ',
               '2026-01-05', '2026-06-30', 2500000)`,
      [provisioned.tenantId, clientId],
    );

    await owner.query(
      `insert into invoice
         (tenant_id, client_id, number, status, issue_date, due_date, currency,
          subtotal_minor, tax_minor, total_minor, amount_paid_minor)
       values ($1, $2, 'INV-2026-0001', 'sent', '2026-01-05', '2026-02-04',
               'ZZZ', 1000000, 180000, 1180000, 500000)`,
      [provisioned.tenantId, clientId],
    );

    await owner.query(
      `insert into content_item
         (tenant_id, kind, slug, title, locale, status, published_at, updated_at)
       values ($1, 'page', 'getting-started', 'Getting started', 'en', 'published',
               '2026-01-10T00:00:00Z', '2026-02-01T00:00:00Z')`,
      [provisioned.tenantId],
    );

    await owner.query('commit');

    ownerAccount = { slug, email };
    managerAccount = {
      slug,
      email: await createManagerMember(owner, provisioned.tenantId, passwordHash),
    };
  } finally {
    await owner.end();
    await pool.end();
  }

  server = createServer({
    pool: runtime,
    authPool: auth,
    appOrigin,
    secureCookies: false,
  });
  await server.listen({ host: '127.0.0.1', port: apiPort });
});

test.afterAll(async () => {
  await server?.close();
  await auth?.end();
  await runtime?.end();
  await database?.drop();
});

test('the owner opens Work, Money and Content and each screen shows its own rows', async ({
  page,
}) => {
  const owner = requireAccount(ownerAccount, 'Owner');

  await page.goto('/login');
  await page.locator('#workspace').fill(owner.slug);
  await page.locator('#email').fill(owner.email);
  await page.locator('#password').fill(syntheticPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();

  // People sorts first in the catalog and has a screen, so it is the landing.
  await expect(page).toHaveURL(/\/app\/people$/);

  // A module with a screen is a link. None of the four modules this tenant
  // holds is a pending item, so no Soon tag appears at all.
  const nav = page.getByRole('navigation', { name: 'Modules' });
  await expect(nav.getByRole('link', { name: /Work/ })).toBeVisible();
  await expect(nav.getByRole('link', { name: /Money/ })).toBeVisible();
  await expect(nav.getByRole('link', { name: /Content/ })).toBeVisible();
  await expect(nav.locator('.nav-tag')).toHaveCount(0);
  await expect(nav.locator('.nav-item--pending')).toHaveCount(0);

  // Work: the project, the client it belongs to and the stored budget beside
  // its own currency.
  await nav.getByRole('link', { name: /Work/ }).click();
  await expect(page).toHaveURL(/\/app\/work$/);
  await expect(
    page.getByRole('heading', { name: 'Projects', exact: true }),
  ).toBeVisible();
  await expect(page.locator('.directory-count')).toHaveText('1 project');

  const projects = page.getByRole('table', { name: 'Projects' });
  await expect(projects.getByRole('rowheader')).toHaveCount(1);
  await expect(
    projects.getByRole('rowheader', { name: 'Aster rollout', exact: true }),
  ).toBeVisible();
  await expect(projects.getByRole('cell', { name: 'PR-ASTER-1', exact: true })).toBeVisible();
  await expect(
    projects.getByRole('cell', { name: 'Aster Logistics', exact: true }),
  ).toBeVisible();
  await expect(projects.getByRole('cell', { name: 'active', exact: true })).toBeVisible();
  await expect(
    projects.getByRole('cell', { name: '25,000.00 ZZZ', exact: true }),
  ).toBeVisible();
  await expect(projects.getByRole('cell', { name: '2026-01-05', exact: true })).toBeVisible();
  // The count describes this view, never the workspace.
  await expect(page.locator('.directory-note')).toContainText(
    'fewer records than the workspace holds',
  );

  // Money: the stored figures beside their own currency, under a column headed
  // Tax that carries an amount and not a rate.
  await nav.getByRole('link', { name: /Money/ }).click();
  await expect(page).toHaveURL(/\/app\/money$/);
  await expect(
    page.getByRole('heading', { name: 'Invoices', exact: true }),
  ).toBeVisible();
  await expect(page.locator('.directory-count')).toHaveText('1 invoice');

  const invoices = page.getByRole('table', { name: 'Invoices' });
  await expect(
    invoices.getByRole('columnheader', { name: 'Tax', exact: true }),
  ).toBeVisible();
  await expect(invoices.getByRole('rowheader')).toHaveCount(1);
  await expect(
    invoices.getByRole('rowheader', { name: 'INV-2026-0001', exact: true }),
  ).toBeVisible();
  await expect(
    invoices.getByRole('cell', { name: 'Aster Logistics', exact: true }),
  ).toBeVisible();
  await expect(invoices.getByRole('cell', { name: 'sent', exact: true })).toBeVisible();
  await expect(
    invoices.getByRole('cell', { name: '10,000.00 ZZZ', exact: true }),
  ).toBeVisible();
  await expect(
    invoices.getByRole('cell', { name: '1,800.00 ZZZ', exact: true }),
  ).toBeVisible();
  await expect(
    invoices.getByRole('cell', { name: '11,800.00 ZZZ', exact: true }),
  ).toBeVisible();
  await expect(
    invoices.getByRole('cell', { name: '5,000.00 ZZZ', exact: true }),
  ).toBeVisible();
  // No jurisdiction word anywhere on the screen: the stored amount carries no
  // rate and no tax rule.
  await expect(page.getByText(/VAT|GST|tax rate|jurisdiction/i)).toHaveCount(0);

  // Content: the kind, the slug, the locale and the stored status.
  await nav.getByRole('link', { name: /Content/ }).click();
  await expect(page).toHaveURL(/\/app\/content$/);
  await expect(
    page.getByRole('heading', { name: 'Content', exact: true }),
  ).toBeVisible();
  await expect(page.locator('.directory-count')).toHaveText('1 content item');

  const content = page.getByRole('table', { name: 'Content items' });
  await expect(content.getByRole('rowheader')).toHaveCount(1);
  await expect(
    content.getByRole('rowheader', { name: 'Getting started', exact: true }),
  ).toBeVisible();
  await expect(content.getByRole('cell', { name: 'page', exact: true })).toBeVisible();
  await expect(
    content.getByRole('cell', { name: 'getting-started', exact: true }),
  ).toBeVisible();
  await expect(content.getByRole('cell', { name: 'en', exact: true })).toBeVisible();
  await expect(content.getByRole('cell', { name: 'published', exact: true })).toBeVisible();
  await expect(
    content.getByRole('cell', { name: '2026-02-01', exact: true }),
  ).toBeVisible();

  // The current route is marked in the navigation.
  await expect(nav.getByRole('link', { name: /Content/ })).toHaveAttribute(
    'aria-current',
    'page',
  );
});

test('a member whose role cannot read money sees no Money entry and no invoice figure', async ({
  page,
}) => {
  const manager = requireAccount(managerAccount, 'Manager');

  await page.goto('/login');
  await page.locator('#workspace').fill(manager.slug);
  await page.locator('#email').fill(manager.email);
  await page.locator('#password').fill(syntheticPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/app\/people$/);

  // The navigation offers the two modules this role may read and nothing else.
  const nav = page.getByRole('navigation', { name: 'Modules' });
  await expect(nav.getByRole('link', { name: /People/ })).toBeVisible();
  await expect(nav.getByRole('link', { name: /Work/ })).toBeVisible();
  await expect(nav.getByText('Money')).toHaveCount(0);
  await expect(nav.getByText('Content')).toHaveCount(0);

  // The route itself is answered with the access state, and no figure from the
  // invoices is anywhere on the page.
  await page.goto('/app/money');
  await expect(
    page.getByRole('heading', { name: 'Money is not available to you' }),
  ).toBeVisible();
  await expect(page.getByRole('table')).toHaveCount(0);
  await expect(page.getByText('INV-2026-0001')).toHaveCount(0);
  await expect(page.getByText('11,800.00')).toHaveCount(0);
  await expect(page.getByText('10,000.00')).toHaveCount(0);
  await expect(page.getByText('1,800.00')).toHaveCount(0);
  await expect(page.getByText('5,000.00')).toHaveCount(0);
  // The access state names the modules this member does have.
  await expect(page.locator('.module-chips').getByText('People')).toBeVisible();
  await expect(page.locator('.module-chips').getByText('Work')).toBeVisible();

  await page.goto('/app/content');
  await expect(
    page.getByRole('heading', { name: 'Content is not available to you' }),
  ).toBeVisible();
  await expect(page.getByText('Getting started')).toHaveCount(0);

  // Work is readable for this role, so the project and its budget are here.
  await page.goto('/app/work');
  await expect(
    page.getByRole('heading', { name: 'Projects', exact: true }),
  ).toBeVisible();
  const projects = page.getByRole('table', { name: 'Projects' });
  await expect(
    projects.getByRole('rowheader', { name: 'Aster rollout', exact: true }),
  ).toBeVisible();
  await expect(
    projects.getByRole('cell', { name: '25,000.00 ZZZ', exact: true }),
  ).toBeVisible();
});
