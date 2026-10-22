import { Client } from 'pg';
import { expect, test, type Page } from '@playwright/test';
import { createServer } from '@saasmodels/api';
import {
  createAuthPool,
  createRuntimePool,
  hashPassword,
  type AuthPool,
  type RuntimePool,
} from '@saasmodels/db';
import { createTestDatabase, type TestDatabase } from '@saasmodels/testkit';
import {
  createAccessFixtures,
  type AccessFixtures,
} from '../support/access-fixtures';

const appOrigin = 'http://localhost:3000';
const apiPort = 3001;
const syntheticPassword = 'Synthetic-e2e-passphrase-2026';

type Account = {
  slug: string;
  email: string;
};

let database: TestDatabase | undefined;
let runtime: RuntimePool | undefined;
let auth: AuthPool | undefined;
let server: ReturnType<typeof createServer> | undefined;
let peopleAccount: Account | undefined;
let workAccount: Account | undefined;

function requireAccount(account: Account | undefined, name: string): Account {
  if (!account) {
    throw new Error(`${name} account was not created`);
  }
  return account;
}

async function readAccount(
  owner: Client,
  userId: string,
  tenantId: string,
): Promise<Account> {
  const result = await owner.query<{ email: string; slug: string }>(
    `select u.email, t.slug
       from app_user u, tenant t
      where u.id = $1 and t.id = $2`,
    [userId, tenantId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error('Could not read the synthetic account');
  }
  return { email: row.email, slug: row.slug };
}

async function noHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test.beforeAll(async () => {
  database = await createTestDatabase({
    migrate: true,
    seed: true,
    namePrefix: 'saasmodels_e2e',
  });
  runtime = createRuntimePool(database.runtimeUrl);
  auth = createAuthPool(database.authUrl);

  const owner = new Client({ connectionString: database.ownerUrl });
  await owner.connect();
  try {
    const fixtures: AccessFixtures = await createAccessFixtures(owner);
    const passwordHash = await hashPassword(syntheticPassword);

    for (const fixture of [fixtures.a, fixtures.b]) {
      await owner.query(
        `update app_user set password_hash = $2 where id = $1 and status = 'active'`,
        [fixture.userId, passwordHash],
      );
      // The login contract allows lower-case letters, digits and hyphens.
      await owner.query(
        `update tenant set slug = replace(slug, '_', '-') where id = $1`,
        [fixture.tenantId],
      );
    }

    peopleAccount = await readAccount(owner, fixtures.a.userId, fixtures.a.tenantId);
    workAccount = await readAccount(owner, fixtures.b.userId, fixtures.b.tenantId);
  } finally {
    await owner.end();
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

test('signs in through the built shell, gates People and persists only the theme', async ({
  page,
}) => {
  const people = requireAccount(peopleAccount, 'People');
  const work = requireAccount(workAccount, 'Work');

  // An anonymous deep link lands on sign-in.
  await page.goto('/app/people');
  await expect(page).toHaveURL(/\/login$/);
  await expect(
    page.getByRole('heading', { name: 'Enter your workspace' }),
  ).toBeVisible();
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await noHorizontalOverflow(page);
  }
  await page.setViewportSize({ width: 1280, height: 900 });

  // A rejected login uses the generic message.
  await page.locator('#workspace').fill(people.slug);
  await page.locator('#email').fill(people.email);
  await page.locator('#password').fill('not-the-right-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toHaveText(
    'Email, password or workspace is incorrect.',
  );

  // A valid login reaches the empty People screen.
  await page.locator('#password').fill(syntheticPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/app\/people$/);
  await expect(
    page.getByRole('heading', { name: 'People', exact: true }),
  ).toBeVisible();
  await expect(page.locator('.page-head .badge')).toHaveText('Read and write');
  await expect(page.getByText('The directory is enabled.')).toBeVisible();

  const nav = page.getByRole('navigation', { name: 'Modules' });
  await expect(nav.getByRole('link', { name: /People/ })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(nav.getByText('Work')).toHaveCount(0);

  // Credentials and session state stay out of browser storage.
  const storageBeforeToggle = await page.evaluate(() => ({
    local: Object.keys(localStorage),
    session: Object.keys(sessionStorage),
    values: JSON.stringify({ ...localStorage, ...sessionStorage }),
  }));
  expect(storageBeforeToggle.local).toEqual([]);
  expect(storageBeforeToggle.session).toEqual([]);
  expect(storageBeforeToggle.values).not.toContain(people.email);
  expect(storageBeforeToggle.values).not.toContain(syntheticPassword);
  expect(page.url()).not.toContain('csrf');

  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await noHorizontalOverflow(page);
  }

  // The theme toggle persists across a reload; it is the only stored preference.
  await page.getByRole('button', { name: 'Dark theme' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(
    page.getByRole('heading', { name: 'People', exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([
    'saasmodels.theme',
  ]);

  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await noHorizontalOverflow(page);
  }

  // Sign out clears the session cookie and returns to sign-in.
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login$/);
  const cookies = await page.context().cookies(appOrigin);
  expect(cookies.some((cookie) => cookie.name === 'saas_session')).toBe(false);
  await page.setViewportSize({ width: 1280, height: 900 });
  await noHorizontalOverflow(page);

  // A keyboard-only sign-in reaches the Work-only workspace.
  await page.locator('#workspace').waitFor();
  await page.keyboard.press('Tab');
  await expect(page.locator('#workspace')).toBeFocused();
  await page.keyboard.type(work.slug);
  await page.keyboard.press('Tab');
  await expect(page.locator('#email')).toBeFocused();
  await page.keyboard.type(work.email);
  await page.keyboard.press('Tab');
  await expect(page.locator('#password')).toBeFocused();
  await page.keyboard.type(syntheticPassword);
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeFocused();
  const focusRing = await page
    .getByRole('button', { name: 'Sign in' })
    .evaluate((element) => {
      const style = getComputedStyle(element);
      return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth };
    });
  expect(focusRing).toEqual({ outlineStyle: 'solid', outlineWidth: '2px' });
  await page.keyboard.press('Enter');

  await expect(page).toHaveURL(/\/app$/);
  await expect(
    page.getByRole('heading', { name: 'Your workspace is ready.' }),
  ).toBeVisible();
  const workNav = page.getByRole('navigation', { name: 'Modules' });
  await expect(workNav.getByText('Work')).toBeVisible();
  await expect(workNav.getByText('People')).toHaveCount(0);

  // A Work-only member sees an access state, never the People directory shell.
  await page.goto('/app/people');
  await expect(
    page.getByRole('heading', { name: 'People is not available to you' }),
  ).toBeVisible();
  await expect(page.locator('.module-chips').getByText('Work')).toBeVisible();
  await expect(page.getByText('The directory is enabled.')).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: 'People', exact: true }),
  ).toHaveCount(0);
});
