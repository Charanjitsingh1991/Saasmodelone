import { randomBytes } from 'node:crypto';
import { Client, Pool } from 'pg';
import { expect, test, type Page } from '@playwright/test';
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
const syntheticPassword = 'Synthetic-crm-leads-passphrase-2026';

type Account = {
  slug: string;
  email: string;
};

let database: TestDatabase | undefined;
let runtime: RuntimePool | undefined;
let auth: AuthPool | undefined;
let server: ReturnType<typeof createServer> | undefined;
let crmOwner: Account | undefined;
let peopleOwner: Account | undefined;

function requireAccount(account: Account | undefined, name: string): Account {
  if (!account) {
    throw new Error(`${name} account was not created`);
  }
  return account;
}

// A tenant provisioned through the real owner path, so its entitlement comes
// from the catalog. The holder of the owner role carries every published
// permission, so the journeys exercise the write surface and not a role gate.
async function provisionWorkspace(
  pool: Pool,
  owner: Client,
  passwordHash: string,
  name: string,
  modules: string[],
): Promise<Account> {
  const suffix = randomBytes(4).toString('hex');
  const slug = `${name}-${suffix}`;
  const email = `${name.replace(/-/g, '_')}_${suffix}@example.test`;
  const provisioned = await provisionTenant(pool, {
    name: `CRM leads ${name}`,
    slug,
    dataRegion: 'test',
    ownerEmail: email,
    ownerDisplayName: `CRM leads ${name}`,
    modules,
  });

  await owner.query(
    `update app_user set status = 'active', password_hash = $2 where id = $1`,
    [provisioned.ownerUserId, passwordHash],
  );
  await owner.query(
    `update membership set role = 'owner', status = 'active'
      where tenant_id = $1 and user_id = $2`,
    [provisioned.tenantId, provisioned.ownerUserId],
  );

  return { slug, email };
}

async function signIn(page: Page, account: Account): Promise<void> {
  await page.goto('/login');
  await page.locator('#workspace').fill(account.slug);
  await page.locator('#email').fill(account.email);
  await page.locator('#password').fill(syntheticPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

test.beforeAll(async () => {
  database = await createTestDatabase({
    migrate: true,
    seed: true,
    namePrefix: 'saasmodels_e2e_crm_leads',
  });
  runtime = createRuntimePool(database.runtimeUrl);
  auth = createAuthPool(database.authUrl);

  const pool = new Pool({ connectionString: database.ownerUrl });
  const owner = new Client({ connectionString: database.ownerUrl });
  await owner.connect();
  try {
    const passwordHash = await hashPassword(syntheticPassword);

    // A CRM-only workspace: the standalone path this module exists to hold.
    crmOwner = await provisionWorkspace(
      pool,
      owner,
      passwordHash,
      'crm-leads-owner',
      ['crm'],
    );
    // A People-only workspace: CRM is not entitled at all, so the module
    // screen is never mounted and the lead route is never asked for.
    peopleOwner = await provisionWorkspace(
      pool,
      owner,
      passwordHash,
      'crm-leads-people',
      ['people'],
    );
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

test('the CRM-only owner creates a lead, advances it and disqualifies it', async ({
  page,
}) => {
  const owner = requireAccount(crmOwner, 'CRM owner');
  await signIn(page, owner);

  await expect(page).toHaveURL(/\/app\/crm$/);
  // The route holds both views, so the tab strip is the only way between them
  // and the account surface is still the landing view.
  const tabs = page.getByRole('tablist', { name: 'CRM views' });
  await expect(tabs.getByRole('tab', { name: 'Accounts' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await tabs.getByRole('tab', { name: 'Leads' }).click();
  await expect(
    page.getByRole('heading', { name: 'Leads', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('No leads are visible in this view.')).toBeVisible();

  // Create the lead through the form.
  await page.getByRole('button', { name: 'Add lead' }).click();
  await page.locator('#crm-lead-name').fill('Journey Lead');
  await page.locator('#crm-lead-company').fill('Journey Co');
  await page.locator('#crm-lead-email').fill('journey@example.test');
  await page.getByRole('button', { name: 'Save lead' }).click();

  await expect(page.getByText('Lead added.')).toBeVisible();
  const leads = page.getByRole('table', { name: 'Leads' });
  const row = leads
    .getByRole('rowheader', { name: 'Journey Lead', exact: true })
    .locator('xpath=ancestor::tr');
  await expect(row).toBeVisible();
  await expect(row.getByRole('cell', { name: 'Journey Co', exact: true })).toBeVisible();
  await expect(
    row.getByRole('cell', { name: 'journey@example.test', exact: true }),
  ).toBeVisible();

  // Advance it with the row's own stage control.
  await row.getByLabel('Stage for Journey Lead').selectOption('contacted');
  await expect(page.getByText('Stage updated.')).toBeVisible();
  await expect(row.getByRole('cell', { name: 'Contacted', exact: true })).toBeVisible();

  // Disqualification is a confirmation, not a silent stage change.
  await row.getByRole('button', { name: 'Disqualify' }).click();
  await expect(
    page.getByRole('heading', { name: 'Disqualify Journey Lead?' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Disqualify lead' }).click();

  await expect(page.getByText('Lead disqualified.')).toBeVisible();
  // The row stays readable but offers no write control, and its stage is plain
  // text rather than a picker.
  await expect(row.getByRole('cell', { name: 'Disqualified', exact: true })).toBeVisible();
  await expect(row.getByLabel('Stage for Journey Lead')).toHaveCount(0);
  await expect(row.getByRole('button', { name: 'Edit' })).toHaveCount(0);
  await expect(row.getByRole('button', { name: 'Convert' })).toHaveCount(0);
  await expect(row.getByRole('button', { name: 'Disqualify' })).toHaveCount(0);
});

test('the CRM-only owner converts a lead into the account and its primary contact', async ({
  page,
}) => {
  const owner = requireAccount(crmOwner, 'CRM owner');
  await signIn(page, owner);

  await expect(page).toHaveURL(/\/app\/crm$/);
  await page.getByRole('tab', { name: 'Leads' }).click();
  await page.getByRole('button', { name: 'Add lead' }).click();
  await page.locator('#crm-lead-name').fill('Convert Journey');
  await page.locator('#crm-lead-company').fill('Convert Co');
  await page.locator('#crm-lead-email').fill('convert.journey@example.test');
  await page.getByRole('button', { name: 'Save lead' }).click();

  const leads = page.getByRole('table', { name: 'Leads' });
  const row = leads
    .getByRole('rowheader', { name: 'Convert Journey', exact: true })
    .locator('xpath=ancestor::tr');
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Convert' }).click();

  await expect(
    page.getByRole('heading', { name: 'Convert Convert Journey to an account' }),
  ).toBeVisible();
  // The currency has no default: the module stores a code and does not invent
  // one. The account name defaults to the company, stated as a placeholder.
  const currency = page.locator('#crm-lead-currency');
  await expect(currency).toHaveValue('');
  await expect(page.locator('#crm-lead-accountName')).toHaveAttribute(
    'placeholder',
    'Convert Co',
  );
  await page.getByRole('button', { name: 'Convert lead' }).click();
  await expect(
    page.getByText('A three-letter currency code is required.'),
  ).toBeVisible();

  await currency.fill('ZZZ');
  await page.getByRole('button', { name: 'Convert lead' }).click();

  // The success lands where the account now is: the Accounts view, with the
  // new account in the search and its row on the table.
  await expect(page.getByText('Lead converted to account.')).toBeVisible();
  await expect(
    page.getByRole('tab', { name: 'Accounts' }),
  ).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('searchbox', { name: 'Search accounts' })).toHaveValue(
    'Convert Co',
  );
  const accounts = page.getByRole('table', { name: 'Accounts' });
  const accountRow = accounts
    .getByRole('rowheader', { name: 'Convert Co', exact: true })
    .locator('xpath=ancestor::tr');
  await expect(accountRow).toBeVisible();
  await expect(
    accountRow.getByRole('cell', { name: 'ZZZ', exact: true }),
  ).toBeVisible();

  // Conversion wrote the primary contact too.
  await accountRow.getByRole('button', { name: 'Contacts' }).click();
  const contacts = page.getByRole('table', { name: 'Contacts of Convert Co' });
  const contactRow = contacts
    .getByRole('rowheader', { name: 'Convert Journey', exact: true })
    .locator('xpath=ancestor::tr');
  await expect(contactRow).toBeVisible();
  await expect(
    contactRow.getByRole('cell', { name: 'convert.journey@example.test', exact: true }),
  ).toBeVisible();
  await expect(contactRow.getByRole('cell', { name: 'Yes', exact: true })).toBeVisible();

  // The lead itself is final in the list behind the tabs.
  await page.getByRole('tab', { name: 'Leads' }).click();
  const convertedRow = page
    .getByRole('table', { name: 'Leads' })
    .getByRole('rowheader', { name: 'Convert Journey', exact: true })
    .locator('xpath=ancestor::tr');
  await expect(
    convertedRow.getByRole('cell', { name: 'Converted', exact: true }),
  ).toBeVisible();
  await expect(convertedRow.getByRole('button', { name: 'Convert' })).toHaveCount(0);
});

test('a tenant without CRM sees no Leads tab and never asks for the lead route', async ({
  page,
}) => {
  const owner = requireAccount(peopleOwner, 'People owner');

  const requested: string[] = [];
  page.on('request', (request) => {
    requested.push(request.url());
  });

  await signIn(page, owner);
  // People is the only module this workspace holds, so it is the landing.
  await expect(page).toHaveURL(/\/app\/people$/);
  const nav = page.getByRole('navigation', { name: 'Modules' });
  await expect(nav.getByRole('link', { name: /CRM/ })).toHaveCount(0);

  // A direct navigation to the CRM route is answered with the access state,
  // which mounts neither view of the module.
  await page.goto('/app/crm');
  await expect(
    page.getByRole('heading', { name: 'CRM is not available to you' }),
  ).toBeVisible();
  await expect(page.getByRole('tablist', { name: 'CRM views' })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Leads' })).toHaveCount(0);
  await expect(page.getByRole('table')).toHaveCount(0);
  expect(requested.filter((url) => url.includes('/v1/crm'))).toEqual([]);
});
