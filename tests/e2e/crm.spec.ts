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
const syntheticPassword = 'Synthetic-crm-passphrase-2026';

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
let hrAccount: Account | undefined;

// A member in a tenant, with a role that decides what they may do. The
// membership is written owner-side because role administration has no route in
// this milestone.
async function createMember(
  owner: Client,
  tenantId: string,
  passwordHash: string,
  role: 'manager' | 'hr',
  label: string,
): Promise<Account> {
  const suffix = randomBytes(4).toString('hex');
  const email = `crm_${label}_${suffix}@example.test`;
  const user = await owner.query<{ id: string }>(
    `insert into app_user (email, display_name, status, password_hash)
     values ($1, $2, 'active', $3)
     returning id`,
    [email, `CRM ${label}`, passwordHash],
  );
  const userId = user.rows[0]?.id;
  if (!userId) {
    throw new Error(`Could not create the CRM ${label} account`);
  }
  await owner.query(
    `insert into membership (tenant_id, user_id, role, status)
     values ($1, $2, $3, 'active')`,
    [tenantId, userId, role],
  );
  const slug = await owner.query<{ slug: string }>(
    `select slug from tenant where id = $1`,
    [tenantId],
  );
  const tenantSlug = slug.rows[0]?.slug;
  if (!tenantSlug) {
    throw new Error(`Could not read the slug of the CRM ${label} tenant`);
  }
  return { slug: tenantSlug, email };
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
    namePrefix: 'saasmodels_e2e_crm',
  });
  runtime = createRuntimePool(database.runtimeUrl);
  auth = createAuthPool(database.authUrl);

  const pool = new Pool({ connectionString: database.ownerUrl });
  const owner = new Client({ connectionString: database.ownerUrl });
  await owner.connect();
  try {
    // The tenant is provisioned through the real owner path, so its entitlement
    // comes from the catalog rather than from a row written here. CRM is
    // catalog status 'preview', so a normal tenant may hold it on a contract
    // entitlement, and this tenant holds CRM and nothing else: the standalone
    // thesis this batch exists to prove.
    const suffix = randomBytes(4).toString('hex');
    const slug = `crm-owner-${suffix}`;
    const email = `crm_owner_${suffix}@example.test`;
    const provisioned = await provisionTenant(pool, {
      name: 'CRM journey',
      slug,
      dataRegion: 'test',
      ownerEmail: email,
      ownerDisplayName: 'CRM owner',
      modules: ['crm'],
    });

    const passwordHash = await hashPassword(syntheticPassword);

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

    // One account and one contact, seeded on the owner connection, so the
    // read-only journey has something to read that does not depend on the
    // write journey having run first.
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
      `insert into client_contact
         (tenant_id, client_id, name, email, role, is_primary)
       values ($1, $2, 'Dana Primary', 'dana@aster.example.test', 'Operations', true)`,
      [provisioned.tenantId, clientId],
    );

    await owner.query('commit');

    ownerAccount = { slug, email };
    managerAccount = await createMember(
      owner,
      provisioned.tenantId,
      passwordHash,
      'manager',
      'manager',
    );
    // The hr member lives in the CRM-entitled tenant, so the third journey
    // proves the role denial and not a missing entitlement.
    hrAccount = await createMember(
      owner,
      provisioned.tenantId,
      passwordHash,
      'hr',
      'hr',
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

test('the CRM-only owner creates an account, edits it and manages its contacts', async ({
  page,
}) => {
  const owner = requireAccount(ownerAccount, 'Owner');

  await page.goto('/login');
  await page.locator('#workspace').fill(owner.slug);
  await page.locator('#email').fill(owner.email);
  await page.locator('#password').fill(syntheticPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();

  // CRM is the only module this tenant holds and it has a screen, so it is the
  // landing. The People screen is nowhere in this workspace.
  await expect(page).toHaveURL(/\/app\/crm$/);
  const nav = page.getByRole('navigation', { name: 'Modules' });
  await expect(nav.getByRole('link', { name: /CRM/ })).toBeVisible();
  await expect(nav.getByText('People')).toHaveCount(0);
  await expect(nav.locator('.nav-tag')).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: 'Accounts', exact: true }),
  ).toBeVisible();

  // The owner may write, so the write control is here.
  await expect(
    page.getByRole('button', { name: 'Add account' }),
  ).toBeVisible();

  // Create an account through the form.
  await page.getByRole('button', { name: 'Add account' }).click();
  await page.locator('#crm-account-name').fill('Zephyr Holdings');
  await page.locator('#crm-account-code').fill('CL-ZEPHYR');
  await page.locator('#crm-account-billingEmail').fill('billing@zephyr.example.test');
  await page.locator('#crm-account-phone').fill('+1-555-0142');
  await page.locator('#crm-account-currency').fill('ZZZ');
  await page.locator('#crm-account-paymentTermsDays').fill('45');
  await page.getByRole('button', { name: 'Save account' }).click();

  await expect(page.getByText('Account added.')).toBeVisible();
  const accounts = page.getByRole('table', { name: 'Accounts' });
  await expect(
    accounts.getByRole('rowheader', { name: 'Zephyr Holdings', exact: true }),
  ).toBeVisible();
  await expect(
    accounts.getByRole('cell', { name: 'CL-ZEPHYR', exact: true }),
  ).toBeVisible();
  await expect(
    accounts.getByRole('cell', { name: '45 days', exact: true }),
  ).toBeVisible();

  // Edit it: the name and the status change, the rest is kept.
  const zephyrRow = accounts
    .getByRole('rowheader', { name: 'Zephyr Holdings', exact: true })
    .locator('xpath=ancestor::tr');
  await zephyrRow.getByRole('button', { name: 'Edit' }).click();
  await page.locator('#crm-account-name').fill('Zephyr Holdings Group');
  await page.locator('#crm-account-status').selectOption('active');
  await page.getByRole('button', { name: 'Save changes' }).click();

  await expect(page.getByText('Account updated.')).toBeVisible();
  await expect(
    accounts.getByRole('rowheader', { name: 'Zephyr Holdings Group', exact: true }),
  ).toBeVisible();

  // The contacts of that account, read from their own route.
  const renamedRow = accounts
    .getByRole('rowheader', { name: 'Zephyr Holdings Group', exact: true })
    .locator('xpath=ancestor::tr');
  await renamedRow.getByRole('button', { name: 'Contacts' }).click();

  await expect(
    page.getByRole('heading', { name: 'Contacts of Zephyr Holdings Group' }),
  ).toBeVisible();
  await expect(
    page.getByText('This account has no contacts in this view.'),
  ).toBeVisible();

  // Add a first contact and make it the primary one.
  await page.getByRole('button', { name: 'Add contact' }).click();
  await page.locator('#crm-contact-name').fill('Chris Contact');
  await page.locator('#crm-contact-email').fill('chris@zephyr.example.test');
  await page.locator('#crm-contact-role').fill('Finance');
  await page.locator('#crm-contact-isPrimary').check();
  await page.getByRole('button', { name: 'Save contact' }).click();

  await expect(page.getByText('Contact added.')).toBeVisible();
  const contacts = page.getByRole('table', {
    name: 'Contacts of Zephyr Holdings Group',
  });
  await expect(
    contacts.getByRole('rowheader', { name: 'Chris Contact', exact: true }),
  ).toBeVisible();
  await expect(
    contacts.getByRole('cell', { name: 'chris@zephyr.example.test', exact: true }),
  ).toBeVisible();
  await expect(contacts.getByRole('cell', { name: 'Yes', exact: true })).toBeVisible();

  // Add a second contact and make it the primary one: the first is demoted,
  // and the demotion is visible after the page is loaded again.
  await page.getByRole('button', { name: 'Add contact' }).click();
  await page.locator('#crm-contact-name').fill('Robin Second');
  await page.locator('#crm-contact-isPrimary').check();
  await page.getByRole('button', { name: 'Save contact' }).click();

  await expect(page.getByText('Contact added.')).toBeVisible();
  await expect(
    contacts.getByRole('rowheader', { name: 'Robin Second', exact: true }),
  ).toBeVisible();

  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Accounts', exact: true }),
  ).toBeVisible();
  const reloaded = page.getByRole('table', { name: 'Accounts' });
  const reloadedRow = reloaded
    .getByRole('rowheader', { name: 'Zephyr Holdings Group', exact: true })
    .locator('xpath=ancestor::tr');
  await reloadedRow.getByRole('button', { name: 'Contacts' }).click();

  const reloadedContacts = page.getByRole('table', {
    name: 'Contacts of Zephyr Holdings Group',
  });
  await expect(reloadedContacts.getByRole('rowheader')).toHaveCount(2);
  // The primary is the one that was set last, and the account holds only one.
  const primaryCells = reloadedContacts.getByRole('cell', { name: 'Yes', exact: true });
  await expect(primaryCells).toHaveCount(1);
  await expect(
    reloadedContacts
      .getByRole('rowheader', { name: 'Robin Second', exact: true })
      .locator('xpath=ancestor::tr')
      .getByRole('cell', { name: 'Yes', exact: true }),
  ).toBeVisible();
  await expect(
    reloadedContacts
      .getByRole('rowheader', { name: 'Chris Contact', exact: true })
      .locator('xpath=ancestor::tr')
      .getByRole('cell', { name: 'No', exact: true }),
  ).toBeVisible();
});

test('a member who may read CRM but not write it sees the records and no write control', async ({
  page,
}) => {
  const manager = requireAccount(managerAccount, 'Manager');

  await page.goto('/login');
  await page.locator('#workspace').fill(manager.slug);
  await page.locator('#email').fill(manager.email);
  await page.locator('#password').fill(syntheticPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page).toHaveURL(/\/app\/crm$/);
  const accounts = page.getByRole('table', { name: 'Accounts' });
  await expect(
    accounts.getByRole('rowheader', { name: 'Aster Logistics', exact: true }),
  ).toBeVisible();

  // No write control anywhere on the screen: the read is offered, the write
  // is not.
  await expect(page.getByRole('button', { name: 'Add account' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Edit' })).toHaveCount(0);

  // The contacts of an account are readable, and they carry no write control
  // either.
  const row = accounts
    .getByRole('rowheader', { name: 'Aster Logistics', exact: true })
    .locator('xpath=ancestor::tr');
  await row.getByRole('button', { name: 'Contacts' }).click();

  const contacts = page.getByRole('table', { name: 'Contacts of Aster Logistics' });
  await expect(
    contacts.getByRole('rowheader', { name: 'Dana Primary', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add contact' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Edit' })).toHaveCount(0);
});

test('an entitled member whose role holds no CRM permission gets no CRM navigation, no data and no request', async ({
  page,
}) => {
  // This member is in the CRM-entitled tenant, so the refusal is the role and
  // not a missing entitlement.
  const hr = requireAccount(hrAccount, 'HR member');

  // Every request the page makes is recorded, so the journey can prove that
  // the CRM surface is never asked for.
  const requested: string[] = [];
  page.on('request', (request) => {
    requested.push(request.url());
  });

  await page.goto('/login');
  await page.locator('#workspace').fill(hr.slug);
  await page.locator('#email').fill(hr.email);
  await page.locator('#password').fill(syntheticPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();

  // CRM is the only module the tenant holds and this role may not read it, so
  // the landing is the workspace home rather than the CRM screen.
  await expect(page).toHaveURL(/\/app$/);
  const nav = page.getByRole('navigation', { name: 'Modules' });
  await expect(nav.getByRole('link', { name: /CRM/ })).toHaveCount(0);
  await expect(page.getByText('Aster Logistics')).toHaveCount(0);

  // A direct navigation to the CRM route is answered with the access state,
  // and the account read is never issued.
  await page.goto('/app/crm');
  await expect(
    page.getByRole('heading', { name: 'CRM is not available to you' }),
  ).toBeVisible();
  await expect(page.getByRole('table')).toHaveCount(0);
  await expect(page.getByText('Aster Logistics')).toHaveCount(0);
  await expect(page.getByText('Dana Primary')).toHaveCount(0);
  expect(requested.filter((url) => url.includes('/v1/crm'))).toEqual([]);
});
