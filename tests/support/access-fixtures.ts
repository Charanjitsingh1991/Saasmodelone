import { randomBytes } from 'node:crypto';
import type { Client } from 'pg';
import type { MembershipRole } from '@saasmodels/db';

const DAY_MS = 24 * 60 * 60 * 1000;

export type PersonRowFixture = {
  id: string;
  employeeCode: string | null;
  firstName: string;
  lastName: string | null;
  displayName: string;
  workEmail: string | null;
  phone: string | null;
  personalEmail: string | null;
  dateOfBirth: string | null;
  gender: string | null;
  designation: string | null;
  status: string;
  employmentType: string | null;
  legalEntityId: string | null;
  deletedAt: Date | null;
};

export type EmploymentFixture = {
  tenantId: string;
  userId: string;
  role: MembershipRole;
  personId: string;
  person: PersonRowFixture;
  legalEntityId: string;
  employmentId: string;
  employmentStartDate: string;
};

export type ProjectFixture = {
  id: string;
  name: string;
  startDate: string;
};

export type TenancyFixture = EmploymentFixture & {
  project: ProjectFixture;
};

export type AccessFixtures = {
  a: TenancyFixture;
  b: TenancyFixture;
  suspended: EmploymentFixture;
  closed: EmploymentFixture;
  deleted: EmploymentFixture;
  cancelled: EmploymentFixture;
  employee: EmploymentFixture;
  workHr: TenancyFixture;
  exportPeople: PersonRowFixture[];
  softDeletedPerson: PersonRowFixture;
  nonMemberUserId: string;
  suspendedMemberUserId: string;
};

type TenantOptions = {
  status?: string;
  deleted?: boolean;
  internal?: boolean;
  role?: MembershipRole;
  membershipStatus?: string;
  userStatus?: string;
};

type ModuleOptions = {
  status?: string;
  source?: string;
  readUntil?: Date;
};

function suffix(): string {
  return randomBytes(4).toString('hex');
}

async function insertJurisdiction(client: Client): Promise<string> {
  const result = await client.query<{ id: string }>(
    `insert into jurisdiction
       (code, country_code, name, default_currency, default_timezone)
     values ('ZZ', 'ZZ', 'Synthetic request-layer jurisdiction', 'ZZZ', 'UTC')
     returning id`,
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error('Could not create the test jurisdiction');
  }
  return row.id;
}

async function insertTenant(
  client: Client,
  label: string,
  options: TenantOptions = {},
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `insert into tenant (name, slug, data_region, status, deleted_at, is_internal)
     values ($1, $2, 'test', $3, $4, $5)
     returning id`,
    [
      `Request layer ${label}`,
      `req_${label}_${suffix()}`,
      options.status ?? 'active',
      options.deleted ? new Date() : null,
      options.internal ?? false,
    ],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`Could not create tenant ${label}`);
  }
  return row.id;
}

async function insertAppUser(
  client: Client,
  email: string,
  displayName: string,
  status = 'active',
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `insert into app_user (email, display_name, status)
     values ($1, $2, $3)
     returning id`,
    [email, displayName, status],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`Could not create the user ${email}`);
  }
  return row.id;
}

async function insertMembership(
  client: Client,
  tenantId: string,
  userId: string,
  role: MembershipRole,
  status = 'active',
): Promise<void> {
  await client.query(
    `insert into membership (tenant_id, user_id, role, status)
     values ($1, $2, $3, $4)`,
    [tenantId, userId, role, status],
  );
}

async function insertLegalEntity(
  client: Client,
  tenantId: string,
  label: string,
  jurisdictionId: string,
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `insert into legal_entity (tenant_id, name, code, jurisdiction_id, currency, timezone)
     values ($1, $2, $3, $4, 'ZZZ', 'UTC')
     returning id`,
    [tenantId, `Legal ${label}`, `le_${label}_${suffix()}`, jurisdictionId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`Could not create the legal entity for ${label}`);
  }
  return row.id;
}

type PersonInput = {
  employeeCode?: string | null;
  firstName: string;
  lastName?: string | null;
  displayName: string;
  workEmail?: string | null;
  phone?: string | null;
  personalEmail?: string | null;
  dateOfBirth?: string | null;
  gender?: string | null;
  designation?: string | null;
  status?: string;
  employmentType?: string | null;
  legalEntityId?: string | null;
  deletedAt?: Date | null;
};

async function insertPerson(
  client: Client,
  tenantId: string,
  input: PersonInput,
): Promise<PersonRowFixture> {
  const result = await client.query<PersonRowFixture>(
    `insert into person
       (tenant_id, employee_code, first_name, last_name, display_name, work_email,
        phone, personal_email, date_of_birth, gender, designation, status,
        employment_type, legal_entity_id, deleted_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     returning id,
               employee_code as "employeeCode",
               first_name as "firstName",
               last_name as "lastName",
               display_name as "displayName",
               work_email::text as "workEmail",
               phone,
               personal_email::text as "personalEmail",
               date_of_birth::text as "dateOfBirth",
               gender,
               designation,
               status,
               employment_type as "employmentType",
               legal_entity_id as "legalEntityId",
               deleted_at as "deletedAt"`,
    [
      tenantId,
      input.employeeCode ?? null,
      input.firstName,
      input.lastName ?? null,
      input.displayName,
      input.workEmail ?? null,
      input.phone ?? null,
      input.personalEmail ?? null,
      input.dateOfBirth ?? null,
      input.gender ?? null,
      input.designation ?? null,
      input.status ?? 'active',
      input.employmentType ?? null,
      input.legalEntityId ?? null,
      input.deletedAt ?? null,
    ],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`Could not create the person ${input.displayName}`);
  }
  return row;
}

async function insertEmployment(
  client: Client,
  tenantId: string,
  personId: string,
  legalEntityId: string,
  startDate: string,
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `insert into employment
       (tenant_id, person_id, legal_entity_id, employment_type, start_date)
     values ($1, $2, $3, 'full_time', $4)
     returning id`,
    [tenantId, personId, legalEntityId, startDate],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error('Could not create the employment row');
  }
  return row.id;
}

async function insertClientRecord(
  client: Client,
  tenantId: string,
  label: string,
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `insert into client (tenant_id, name, code, currency)
     values ($1, $2, $3, 'ZZZ')
     returning id`,
    [tenantId, `Client ${label}`, `cl_${label}_${suffix()}`],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`Could not create the client for ${label}`);
  }
  return row.id;
}

async function insertProject(
  client: Client,
  tenantId: string,
  clientId: string,
  name: string,
  startDate: string,
  label: string,
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `insert into project (tenant_id, client_id, name, code, currency, start_date)
     values ($1, $2, $3, $4, 'ZZZ', $5)
     returning id`,
    [tenantId, clientId, name, `pr_${label}_${suffix()}`, startDate],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`Could not create the project for ${label}`);
  }
  return row.id;
}

async function grantModule(
  client: Client,
  tenantId: string,
  code: string,
  options: ModuleOptions = {},
): Promise<void> {
  await client.query(
    `insert into module_entitlement
       (tenant_id, module_id, status, source, starts_at, ends_at, read_until)
     values ($1, (select id from platform_module where code = $2), $3, $4,
             now() - interval '1 day', null, $5)`,
    [
      tenantId,
      code,
      options.status ?? 'active',
      options.source ?? 'contract',
      options.readUntil ?? null,
    ],
  );
}

async function createEmploymentFixture(
  client: Client,
  jurisdictionId: string,
  label: string,
  startDate: string,
  options: TenantOptions = {},
): Promise<EmploymentFixture> {
  const tenantId = await insertTenant(client, label, options);
  const role = options.role ?? 'owner';
  const userId = await insertAppUser(
    client,
    `${label}_${suffix()}@example.test`,
    `User ${label}`,
    options.userStatus ?? 'active',
  );
  await insertMembership(
    client,
    tenantId,
    userId,
    role,
    options.membershipStatus ?? 'active',
  );
  const legalEntityId = await insertLegalEntity(client, tenantId, label, jurisdictionId);
  const person = await insertPerson(client, tenantId, {
    firstName: 'Ada',
    displayName: `Person ${label}`,
    workEmail: `${label}_${suffix()}@example.test`,
  });
  const employmentId = await insertEmployment(
    client,
    tenantId,
    person.id,
    legalEntityId,
    startDate,
  );
  return {
    tenantId,
    userId,
    role,
    personId: person.id,
    person,
    legalEntityId,
    employmentId,
    employmentStartDate: startDate,
  };
}

async function createTenancyFixture(
  client: Client,
  jurisdictionId: string,
  label: string,
  startDate: string,
  projectStartDate: string,
  options: TenantOptions = {},
): Promise<TenancyFixture> {
  const base = await createEmploymentFixture(
    client,
    jurisdictionId,
    label,
    startDate,
    options,
  );
  const clientId = await insertClientRecord(client, base.tenantId, label);
  const projectName = `${label.toUpperCase()} original project`;
  const projectId = await insertProject(
    client,
    base.tenantId,
    clientId,
    projectName,
    projectStartDate,
    label,
  );
  return {
    ...base,
    project: { id: projectId, name: projectName, startDate: projectStartDate },
  };
}

export async function createAccessFixtures(
  client: Client,
): Promise<AccessFixtures> {
  const jurisdictionId = await insertJurisdiction(client);

  const a = await createTenancyFixture(
    client,
    jurisdictionId,
    'a',
    '2024-01-01',
    '2024-02-01',
  );
  // Work is catalog status 'planned', so only an internal tenant may hold it,
  // and its entitlement must carry an internal source.
  const b = await createTenancyFixture(
    client,
    jurisdictionId,
    'b',
    '2023-05-01',
    '2024-03-01',
    { internal: true, role: 'admin' },
  );

  await grantModule(client, a.tenantId, 'people');
  await grantModule(client, b.tenantId, 'work', { source: 'internal' });

  // Directory rows with controlled values: quoting, embedded CRLF, formula
  // prefixes, nulls and fields the export must never read.
  const exportPeople = [
    await insertPerson(client, a.tenantId, {
      employeeCode: 'EXP-001',
      firstName: 'Ada',
      lastName: 'Lovelace',
      displayName: 'Ada, "Countess"',
      workEmail: `export_ada_${suffix()}@example.test`,
      phone: '+1 555 0100',
      personalEmail: `secret_personal_${suffix()}@example.test`,
      dateOfBirth: '1980-01-02',
      gender: 'female',
      designation: 'Secret Designation',
      status: 'probation',
      employmentType: 'contract',
      legalEntityId: a.legalEntityId,
    }),
    await insertPerson(client, a.tenantId, {
      employeeCode: 'EXP-002',
      firstName: 'Grace',
      lastName: 'Hopper',
      displayName: 'Line\r\nBreak',
      workEmail: `export_grace_${suffix()}@example.test`,
      phone: '=1+1',
    }),
    await insertPerson(client, a.tenantId, {
      employeeCode: 'EXP-003',
      firstName: 'Alan',
      displayName: '@SUM(A1,A2)',
      workEmail: null,
      phone: null,
    }),
  ];

  const softDeletedPerson = await insertPerson(client, a.tenantId, {
    employeeCode: 'EXP-999',
    firstName: 'Deleted',
    displayName: 'Soft Deleted Person',
    workEmail: `export_deleted_${suffix()}@example.test`,
    deletedAt: new Date(),
  });

  const suspended = await createEmploymentFixture(
    client,
    jurisdictionId,
    's',
    '2022-01-01',
    { status: 'suspended' },
  );
  await grantModule(client, suspended.tenantId, 'people');

  const closed = await createEmploymentFixture(
    client,
    jurisdictionId,
    'l',
    '2022-02-01',
    { status: 'closed' },
  );
  await grantModule(client, closed.tenantId, 'people');

  const deleted = await createEmploymentFixture(
    client,
    jurisdictionId,
    'd',
    '2022-03-01',
    { deleted: true },
  );
  await grantModule(client, deleted.tenantId, 'people');

  const cancelled = await createEmploymentFixture(
    client,
    jurisdictionId,
    'c',
    '2022-04-01',
    { role: 'hr' },
  );
  await grantModule(client, cancelled.tenantId, 'people', {
    status: 'cancelled',
    readUntil: new Date(Date.now() + 30 * DAY_MS),
  });

  // Employee is intentionally permissionless in M0: role denial needs an
  // entitled People membership to prove the entitlement check comes first.
  const employee = await createEmploymentFixture(
    client,
    jurisdictionId,
    'e',
    '2024-04-01',
    { role: 'employee' },
  );
  await grantModule(client, employee.tenantId, 'people');

  // HR has People permissions but no Work permission, which separates the
  // role check from the entitlement check.
  const workHr = await createTenancyFixture(
    client,
    jurisdictionId,
    'h',
    '2024-05-01',
    '2024-06-01',
    { internal: true, role: 'hr' },
  );
  await grantModule(client, workHr.tenantId, 'work', { source: 'internal' });

  const nonMemberUserId = await insertAppUser(
    client,
    `nonmember_${suffix()}@example.test`,
    'Non-member user',
  );

  const suspendedMemberUserId = await insertAppUser(
    client,
    `suspendedmember_${suffix()}@example.test`,
    'Suspended member user',
  );
  await insertMembership(client, a.tenantId, suspendedMemberUserId, 'employee', 'suspended');

  return {
    a,
    b,
    suspended,
    closed,
    deleted,
    cancelled,
    employee,
    workHr,
    exportPeople,
    softDeletedPerson,
    nonMemberUserId,
    suspendedMemberUserId,
  };
}
