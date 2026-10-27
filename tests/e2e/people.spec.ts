import { randomBytes } from 'node:crypto';
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
let readerAccount: Account | undefined;

// A member of the People workspace whose role may read the directory and no
// part of it. Manager carries people.read without people.write, so the screen
// has to show the history and hide every control that would change it. The
// membership is written owner-side because role administration has no route in
// this milestone.
async function createReaderMember(
  owner: Client,
  tenantId: string,
  passwordHash: string,
): Promise<string> {
  const email = `e2e_reader_${randomBytes(4).toString('hex')}@example.test`;
  const user = await owner.query<{ id: string }>(
    `insert into app_user (email, display_name, status, password_hash)
     values ($1, 'E2E reader', 'active', $2)
     returning id`,
    [email, passwordHash],
  );
  const userId = user.rows[0]?.id;
  if (!userId) {
    throw new Error('Could not create the read-only e2e account');
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

    // The directory's legal entity already exists from the shared fixtures; the
    // one org unit inside it is written owner-side, because legal entity and
    // org unit administration has no route in this milestone.
    await owner.query(
      `insert into org_unit (tenant_id, legal_entity_id, parent_id, name, kind)
       values ($1, $2, null, 'E2E placement unit', 'department')`,
      [fixtures.a.tenantId, fixtures.a.legalEntityId],
    );

    // A salary history written owner-side. Nothing in this build can write
    // compensation through a route, so the rows the read is shown against have to
    // arrive the way an operator's own SQL would. It hangs off the directory row
    // the shared fixtures already made, which keeps the person count the journeys
    // assert exactly as it was.
    const salaryPerson = fixtures.exportPeople[0];
    if (!salaryPerson) {
      throw new Error('The e2e salary person row is missing from the fixtures');
    }
    await owner.query(
      `insert into compensation
         (tenant_id, person_id, effective_from, effective_to, ctc_minor, currency,
          pay_frequency)
       values ($1, $2, '2023-04-01', '2024-03-31', 1000000, 'INR', 'monthly'),
              ($1, $2, '2024-04-01', null, 1234567, 'INR', 'semi_monthly')`,
      [fixtures.a.tenantId, salaryPerson.id],
    );

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

    const ownerAccount = await readAccount(owner, fixtures.a.userId, fixtures.a.tenantId);
    peopleAccount = ownerAccount;
    workAccount = await readAccount(owner, fixtures.b.userId, fixtures.b.tenantId);
    readerAccount = {
      // The slug was rewritten to the login contract's character set above, so
      // the reader signs in to the same workspace as the owner.
      slug: ownerAccount.slug,
      email: await createReaderMember(owner, fixtures.a.tenantId, passwordHash),
    };
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

test('signs in, searches, creates and edits the directory, gates People and persists only the theme', async ({
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

  // A valid login reaches the scope-narrowed directory.
  await page.locator('#password').fill(syntheticPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/app\/people$/);
  await expect(
    page.getByRole('heading', { name: 'People', exact: true }),
  ).toBeVisible();
  await expect(page.locator('.page-head .badge')).toHaveText('Read and write');

  const directory = page.getByRole('table', { name: 'People directory' });
  // The directory count and the save announcement are two separate live
  // regions, so each is addressed by its own element rather than by role.
  const liveCount = page.locator('.directory-count');
  await expect(liveCount).toHaveAttribute('aria-live', 'polite');
  await expect(liveCount).toHaveText('4 people');
  await expect(directory.getByRole('rowheader')).toHaveCount(4);
  await expect(
    directory.getByRole('rowheader', { name: 'Ada, "Countess"', exact: true }),
  ).toBeVisible();
  await expect(
    directory.getByRole('cell', { name: 'EXP-001', exact: true }),
  ).toBeVisible();
  await expect(
    directory.getByRole('rowheader', { name: 'Soft Deleted Person' }),
  ).toHaveCount(0);
  await expect(
    directory.getByRole('columnheader', { name: 'Work email' }),
  ).toBeVisible();

  await expect(
    page.getByRole('navigation', { name: 'Directory pages' }),
  ).toContainText('Page 1 of 1');
  await expect(page.getByRole('button', { name: 'Previous' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Next' })).toBeDisabled();

  const search = page.getByRole('searchbox', { name: 'Search people' });
  await search.fill('Grace');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(liveCount).toHaveText('1 person');
  await expect(directory.getByRole('rowheader')).toHaveCount(1);

  await search.fill('');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(liveCount).toHaveText('4 people');
  await expect(directory.getByRole('rowheader')).toHaveCount(4);
  expect(page.url()).not.toContain('Grace');

  // The write path: an owner adds a person, sees the row, and corrects a value.
  await page.getByRole('button', { name: 'Add person' }).click();
  const createForm = page.getByRole('form', { name: 'Add a person' });
  await expect(createForm.locator('.field')).toHaveCount(6);
  await expect(page.locator('#people-form-firstName')).toBeEnabled();
  await expect(page.locator('.people-form-note')).toContainText('use Place afterwards');

  // The panel is a two-column grid, so it has to fold without spilling over.
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await noHorizontalOverflow(page);
  }
  await page.setViewportSize({ width: 1280, height: 900 });

  await page.locator('#people-form-firstName').fill('Nadia');
  await page.locator('#people-form-lastName').fill('Kaur');
  await page.locator('#people-form-employeeCode').fill('E2E-001');
  await page.locator('#people-form-workEmail').fill('e2e-nadia@example.test');
  await page.locator('#people-form-phone').fill('+1 555 0900');
  await page.getByRole('button', { name: 'Save person' }).click();

  const saved = page.locator('.people-saved');
  await expect(saved).toHaveAttribute('aria-live', 'polite');
  await expect(saved).toHaveText('Person created.');
  await expect(liveCount).toHaveText('5 people');
  await expect(createForm).toHaveCount(0);
  await expect(
    directory.getByRole('rowheader', { name: 'Nadia Kaur', exact: true }),
  ).toBeVisible();
  await expect(
    directory.getByRole('cell', { name: 'E2E-001', exact: true }),
  ).toBeVisible();
  await expect(
    directory.getByRole('cell', { name: '+1 555 0900', exact: true }),
  ).toBeVisible();

  // Editing works from the row itself, and the panel starts with stored values.
  await directory
    .getByRole('button', { name: 'Edit Nadia Kaur' })
    .click();
  const editForm = page.getByRole('form', { name: 'Edit this person' });
  await expect(editForm).toBeVisible();
  await expect(page.locator('#people-form-firstName')).toHaveValue('Nadia');
  await expect(page.locator('#people-form-employeeCode')).toHaveValue('E2E-001');
  await expect(page.locator('.people-form-note')).toContainText(
    'Use Place to change the legal entity or org unit',
  );
  await page.locator('#people-form-phone').fill('+1 555 0901');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(saved).toHaveText('Person updated.');
  await expect(
    directory.getByRole('cell', { name: '+1 555 0901', exact: true }),
  ).toBeVisible();

  // A duplicate code is refused with honest copy and no new row.
  await page.getByRole('button', { name: 'Add person' }).click();
  await page.locator('#people-form-firstName').fill('Duplicate');
  await page.locator('#people-form-employeeCode').fill('E2E-001');
  await page.getByRole('button', { name: 'Save person' }).click();
  await expect(page.locator('.form-alert')).toHaveText(
    'That employee code already belongs to someone in this workspace.',
  );
  await expect(liveCount).toHaveText('5 people');
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(editForm).toHaveCount(0);
  await expect(createForm).toHaveCount(0);

  // The new person is searchable like any other row.
  await search.fill('Nadia');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(liveCount).toHaveText('1 person');
  await expect(directory.getByRole('rowheader')).toHaveCount(1);
  await search.fill('');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(liveCount).toHaveText('5 people');

  // Placement: this row is put on the org unit inside the workspace legal
  // entity, checked across a reload, and removed again.
  await expect(
    directory.getByRole('columnheader', { name: 'Placement' }),
  ).toBeVisible();
  const nadiaRow = directory.getByRole('row', { name: /Nadia Kaur/ });
  const nadiaPlacement = nadiaRow.locator('td').nth(3);
  await expect(nadiaPlacement).toHaveText('—');

  await directory.getByRole('button', { name: 'Place Nadia Kaur' }).click();
  const panel = page.locator('.placement-panel');
  await expect(panel).toHaveCount(1);
  await expect(panel.getByRole('heading', { name: 'Place Nadia Kaur' })).toBeVisible();
  // The choices come from the server, so the panel only offers Save once they
  // have arrived: Unplaced for a workspace-wide member, the entity, and its unit.
  const placementSelect = page.locator('#people-placement');
  await expect(placementSelect).toBeEnabled();
  const placementLabels = await placementSelect.evaluate((element) =>
    Array.from((element as HTMLSelectElement).options).map((option) => option.text),
  );
  expect(placementLabels).toEqual(['Unplaced', 'Legal a', 'E2E placement unit']);
  const placementGroups = await placementSelect.evaluate((element) =>
    Array.from(element.querySelectorAll('optgroup')).map((group) => group.label),
  );
  expect(placementGroups).toEqual(['Legal a']);
  await expect(panel.locator('.fine-print')).toContainText(
    'not an employment record',
  );
  await expect(page.getByRole('button', { name: 'Save placement' })).toBeDisabled();

  // The panel has to fold on a phone like any other form on this screen.
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await noHorizontalOverflow(page);
  }
  await page.setViewportSize({ width: 1280, height: 900 });

  await placementSelect.selectOption({ label: 'E2E placement unit' });
  await page.getByRole('button', { name: 'Save placement' }).click();
  await expect(saved).toHaveText('Placement updated.');
  await expect(panel).toHaveCount(0);
  await expect(nadiaPlacement).toHaveText('Legal a · E2E placement unit');

  // The placement is the row, not component state: it survives a reload.
  await page.reload();
  await expect(
    directory.getByRole('rowheader', { name: 'Nadia Kaur', exact: true }),
  ).toBeVisible();
  await expect(nadiaPlacement).toHaveText('Legal a · E2E placement unit');

  // Employment: the person's own history, opened from its row action. It is
  // empty until a record is added, and the legal entity on the record is the
  // placement's entity, taken at the moment the record was made.
  await directory.getByRole('button', { name: 'Employment Nadia Kaur' }).click();
  const employmentPanel = page.locator('.employment-panel');
  await expect(employmentPanel).toHaveCount(1);
  await expect(
    employmentPanel.getByRole('heading', { name: 'Employment for Nadia Kaur' }),
  ).toBeVisible();
  await expect(
    employmentPanel.getByText('No employment is recorded for this person yet.'),
  ).toBeVisible();

  await employmentPanel.getByRole('button', { name: 'Add employment' }).click();
  const employmentForm = page.getByRole('form', { name: 'Add employment' });
  await expect(employmentForm).toBeVisible();
  // Create offers five fields and no status: the server chooses active.
  await expect(employmentForm.locator('.field')).toHaveCount(5);
  await expect(employmentForm.locator('#employment-form-status')).toHaveCount(0);
  await expect(employmentForm.getByRole('button', { name: 'Save employment' })).toBeDisabled();
  await expect(
    employmentForm.locator('.people-form-note'),
  ).toContainText('taken from where this person is placed now');

  // The panel has to fold on a phone like any other form on this screen.
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await noHorizontalOverflow(page);
  }
  await page.setViewportSize({ width: 1280, height: 900 });

  await page.locator('#employment-form-startDate').fill('2024-06-01');
  await page.locator('#employment-form-noticeDays').fill('30');
  await employmentForm.getByRole('button', { name: 'Save employment' }).click();
  await expect(saved).toHaveText('Employment added.');

  const history = employmentPanel.getByRole('table', {
    name: 'Employment history for Nadia Kaur',
  });
  await expect(history.getByRole('rowheader', { name: 'Legal a', exact: true })).toBeVisible();
  await expect(
    history.getByRole('cell', { name: 'Full time', exact: true }),
  ).toBeVisible();
  await expect(
    history.getByRole('cell', { name: '2024-06-01 – open', exact: true }),
  ).toBeVisible();
  await expect(history.getByRole('cell', { name: '30', exact: true })).toBeVisible();
  await expect(history.locator('.employment-status')).toHaveText('Active');
  await expect(history.locator('.employment-status')).toHaveClass(
    /employment-status--active/,
  );

  // Ending the record is a forward move and needs an end date. Without one the
  // server refuses and the panel says so instead of pretending the save worked.
  await history.getByRole('button', { name: 'Edit employment from 2024-06-01' }).click();
  const editEmployment = page.getByRole('form', { name: 'Edit this employment' });
  await expect(editEmployment).toBeVisible();
  // Update offers six fields, because status is the sixth, and it opens on the
  // stored values.
  await expect(editEmployment.locator('.field')).toHaveCount(6);
  await expect(page.locator('#employment-form-startDate')).toHaveValue('2024-06-01');
  await expect(page.locator('#employment-form-noticeDays')).toHaveValue('30');
  await expect(page.locator('#employment-form-status')).toBeEnabled();
  // An active record is offered every status, because every move from active is
  // allowed.
  const activeStatusLabels = await page
    .locator('#employment-form-status')
    .evaluate((element) =>
      Array.from((element as HTMLSelectElement).options).map((option) => option.text),
    );
  expect(activeStatusLabels).toEqual(['Active', 'Ended', 'Cancelled']);
  await expect(editEmployment.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  await page.locator('#employment-form-status').selectOption('ended');
  await editEmployment.getByRole('button', { name: 'Save changes' }).click();
  await expect(editEmployment.locator('.form-alert')).toHaveText(
    'The details were not accepted. A type and a start date are required, an end date and a probation end date cannot precede the start, and notice days must be a whole number from 0 to 3650.',
  );
  await page.locator('#employment-form-endDate').fill('2025-01-31');
  await editEmployment.getByRole('button', { name: 'Save changes' }).click();
  await expect(saved).toHaveText('Employment updated.');

  await expect(
    history.getByRole('cell', { name: '2024-06-01 – 2025-01-31', exact: true }),
  ).toBeVisible();
  await expect(history.locator('.employment-status')).toHaveText('Ended');
  await expect(history.locator('.employment-status')).toHaveClass(
    /employment-status--ended/,
  );

  // Reopening the ended record offers only the status it is stored at: the
  // screen never shows a transition the route would refuse.
  await history.getByRole('button', { name: 'Edit employment from 2024-06-01' }).click();
  const endedStatusLabels = await page
    .locator('#employment-form-status')
    .evaluate((element) =>
      Array.from((element as HTMLSelectElement).options).map((option) => option.text),
    );
  expect(endedStatusLabels).toEqual(['Ended']);
  await expect(
    editEmployment.locator('.field-hint'),
  ).toContainText('This record is already ended, so it stays that way.');
  await editEmployment.getByRole('button', { name: 'Cancel' }).click();
  await expect(editEmployment).toHaveCount(0);

  await employmentPanel.getByRole('button', { name: 'Close' }).click();
  await expect(employmentPanel).toHaveCount(0);

  await directory.getByRole('button', { name: 'Place Nadia Kaur' }).click();
  await expect(placementSelect).toBeEnabled();
  // The panel opens on the stored placement, so there is nothing to save until
  // the caller changes it.
  const selectedLabel = await placementSelect.evaluate(
    (element) =>
      (element as HTMLSelectElement).options[(element as HTMLSelectElement).selectedIndex]?.text ??
      '',
  );
  expect(selectedLabel).toBe('E2E placement unit');
  await expect(page.getByRole('button', { name: 'Save placement' })).toBeDisabled();
  await placementSelect.selectOption({ label: 'Unplaced' });
  await page.getByRole('button', { name: 'Save placement' }).click();
  await expect(saved).toHaveText('Placement updated.');
  await expect(nadiaPlacement).toHaveText('—');

  // The employment record keeps the entity it was written against. Un-placing
  // the person changes the directory cell and nothing on the history row.
  await directory.getByRole('button', { name: 'Employment Nadia Kaur' }).click();
  await expect(nadiaPlacement).toHaveText('—');
  await expect(
    history.getByRole('rowheader', { name: 'Legal a', exact: true }),
  ).toBeVisible();
  await expect(history.getByRole('cell', { name: '2024-06-01 – 2025-01-31' })).toBeVisible();
  await employmentPanel.getByRole('button', { name: 'Close' }).click();
  await expect(employmentPanel).toHaveCount(0);

  // Compensation: the same row-action shape as the employment history, but a
  // read with no write behind it. The owner's role holds
  // people.compensation.read, so the action is offered.
  const compensation = page.locator('[aria-labelledby="compensation-panel-title"]');
  await directory.getByRole('button', { name: 'Compensation Ada' }).click();
  await expect(compensation).toHaveCount(1);
  await expect(
    compensation.getByRole('heading', { name: 'Compensation for Ada, "Countess"' }),
  ).toBeVisible();

  const salary = compensation.getByRole('table', {
    name: 'Compensation history for Ada, "Countess"',
  });
  // Newest period first, which is the order the route answers in.
  await expect(salary.getByRole('rowheader')).toHaveCount(2);
  await expect(salary.getByRole('rowheader').first()).toHaveText('2024-04-01');
  await expect(
    salary.getByRole('cell', { name: '12,345.67 INR', exact: true }),
  ).toBeVisible();
  await expect(salary.getByRole('cell', { name: '—', exact: true })).toBeVisible();
  await expect(
    salary.getByRole('cell', { name: 'Semi-monthly', exact: true }),
  ).toBeVisible();
  await expect(
    salary.getByRole('cell', { name: '10,000.00 INR', exact: true }),
  ).toBeVisible();
  await expect(
    salary.getByRole('cell', { name: '2024-03-31', exact: true }),
  ).toBeVisible();
  await expect(
    salary.getByRole('cell', { name: 'Monthly', exact: true }),
  ).toBeVisible();

  // A four-column history inside a panel: it has to fold within its own
  // scroller rather than widen the page, so the same three viewports the rest of
  // the journey uses are checked with the panel open, before the width the
  // remaining steps run at is restored.
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await noHorizontalOverflow(page);
  }
  await page.setViewportSize({ width: 1280, height: 900 });

  // The panel is read-only in fact as well as in wording: the only control it
  // offers is the one that closes it, and the note says what the build does not
  // do rather than implying a salary can be changed.
  await expect(
    compensation.getByRole('button', { name: /Add|Save|Edit|New|Remove|Delete/ }),
  ).toHaveCount(0);
  await expect(compensation.locator('input, select, textarea')).toHaveCount(0);
  await expect(compensation.locator('.compensation-note')).toContainText(
    'Compensation is read-only in this build.',
  );
  await expect(compensation.locator('.compensation-note')).toContainText(
    'not a monthly or annual salary worked out from it',
  );

  await compensation.getByRole('button', { name: 'Close' }).click();
  await expect(compensation).toHaveCount(0);
  // The figure belongs to this panel alone: the directory row never carried it.
  await expect(directory.getByText('12,345.67')).toHaveCount(0);

  // A person with no history is an empty read, not an error.
  await directory.getByRole('button', { name: 'Compensation Nadia Kaur' }).click();
  await expect(
    compensation.getByText('No compensation is recorded for this person yet.'),
  ).toBeVisible();
  await compensation.getByRole('button', { name: 'Close' }).click();
  await expect(compensation).toHaveCount(0);

  // A failed read is this screen's own copy, announced politely and retryable.
  // The request never reaches the API, so nothing but the network line can show.
  await page.route('**/v1/people/*/compensations', (route) => route.abort());
  await directory.getByRole('button', { name: 'Compensation Ada' }).click();
  const compensationAlert = compensation.locator('.form-alert');
  await expect(compensationAlert).toHaveAttribute('aria-live', 'polite');
  await expect(compensationAlert).toHaveText(
    'The workspace could not be reached. Check your connection and try again.',
  );
  await expect(compensation.getByRole('table')).toHaveCount(0);
  await page.unroute('**/v1/people/*/compensations');

  await compensation.getByRole('button', { name: 'Try again' }).click();
  await expect(
    compensation.getByRole('cell', { name: '12,345.67 INR', exact: true }),
  ).toBeVisible();
  await compensation.getByRole('button', { name: 'Close' }).click();
  await expect(compensation).toHaveCount(0);

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
  // The created person survives the reload: the row is in the database, not
  // just in component state.
  await expect(liveCount).toHaveText('5 people');
  await expect(
    directory.getByRole('rowheader', { name: 'Nadia Kaur', exact: true }),
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
  await expect(directory).toHaveCount(0);
  await expect(search).toHaveCount(0);
  await expect(liveCount).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: 'People', exact: true }),
  ).toHaveCount(0);
});

test('a member whose role reads People sees the employment history, cannot change it and is not offered the salary read', async ({
  page,
}) => {
  const reader = requireAccount(readerAccount, 'Read-only');

  await page.goto('/login');
  await page.locator('#workspace').fill(reader.slug);
  await page.locator('#email').fill(reader.email);
  await page.locator('#password').fill(syntheticPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/app\/people$/);

  // The access label comes from the server's permissions for this membership,
  // not from what the screen would like to offer.
  await expect(page.locator('.page-head .badge')).toHaveText('Read only');
  const directory = page.getByRole('table', { name: 'People directory' });
  await expect(
    directory.getByRole('rowheader', { name: 'Nadia Kaur', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add person' })).toHaveCount(0);
  await expect(
    directory.getByRole('button', { name: 'Edit Nadia Kaur' }),
  ).toHaveCount(0);
  await expect(
    directory.getByRole('button', { name: 'Place Nadia Kaur' }),
  ).toHaveCount(0);

  // Salary history is a stricter read than the directory. This membership holds
  // people.read and not people.compensation.read, so the row action is absent
  // from every row rather than present and disabled, and no figure from another
  // role's panel can be reached on this screen at all.
  await expect(
    directory.getByRole('button', { name: /^Compensation/ }),
  ).toHaveCount(0);
  await expect(page.getByText('12,345.67')).toHaveCount(0);

  // Reading a history is a read, so the row action is here for a reader.
  await directory.getByRole('button', { name: 'Employment Nadia Kaur' }).click();
  const employmentPanel = page.locator('.employment-panel');
  await expect(
    employmentPanel.getByRole('heading', { name: 'Employment for Nadia Kaur' }),
  ).toBeVisible();
  const history = employmentPanel.getByRole('table', {
    name: 'Employment history for Nadia Kaur',
  });
  await expect(history.getByRole('rowheader', { name: 'Legal a', exact: true })).toBeVisible();
  await expect(
    history.getByRole('cell', { name: '2024-06-01 – 2025-01-31', exact: true }),
  ).toBeVisible();
  await expect(history.locator('.employment-status')).toHaveText('Ended');

  // Nothing in this panel writes: no Actions column, no edit control and no add
  // button, because the route would answer ROLE_DENIED for every one of them.
  await expect(
    history.getByRole('columnheader', { name: 'Actions' }),
  ).toHaveCount(0);
  await expect(history.getByRole('button')).toHaveCount(0);
  await expect(
    employmentPanel.getByRole('button', { name: 'Add employment' }),
  ).toHaveCount(0);

  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await noHorizontalOverflow(page);
  }
});
