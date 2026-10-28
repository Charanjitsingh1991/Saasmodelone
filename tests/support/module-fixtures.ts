import { randomBytes } from 'node:crypto';
import { Client, Pool } from 'pg';
import { provisionTenant, type MembershipRole } from '@saasmodels/db';
import { createSessionFixture, type SessionFixture } from './auth-fixtures.js';

export type ModuleTenantFixture = {
  tenantId: string;
  userId: string;
  role: MembershipRole;
  session: SessionFixture;
};

export type ModuleTenantOptions = {
  label: string;
  modules: string[];
  role?: MembershipRole;
};

export type ClientRowFixture = {
  id: string;
  name: string;
  code: string | null;
};

export type ProjectRowFixture = {
  id: string;
  clientId: string;
  name: string;
  code: string | null;
  status: string;
  currency: string;
  startDate: string | null;
  endDate: string | null;
  budgetMinor: string | null;
};

export type InvoiceRowFixture = {
  id: string;
  clientId: string;
  number: string;
  status: string;
  currency: string;
  issueDate: string;
  dueDate: string;
  subtotalMinor: string;
  taxMinor: string;
  totalMinor: string;
  amountPaidMinor: string;
};

export type ContentRowFixture = {
  id: string;
  kind: string;
  slug: string;
  title: string;
  locale: string;
  status: string;
  publishedAt: string | null;
  updatedAt: string;
};

function suffix(): string {
  return randomBytes(4).toString('hex');
}

/**
 * A tenant is created through the real provisioning path, so its entitlements
 * are the ones the catalog and the entitlement table agree on and nothing is
 * hand-inserted. Provisioning deliberately leaves the owner invited, because
 * accepting an invitation is a separate flow; the activation and the role are
 * therefore written owner-side here, which is what an operator does.
 */
export async function provisionModuleTenant(
  ownerUrl: string,
  options: ModuleTenantOptions,
): Promise<ModuleTenantFixture> {
  const role = options.role ?? 'owner';
  const slug = `mod-${options.label.toLowerCase()}-${suffix()}`;
  const pool = new Pool({ connectionString: ownerUrl });

  try {
    const provisioned = await provisionTenant(pool, {
      name: `Module ${options.label}`,
      slug,
      dataRegion: 'test',
      ownerEmail: `owner_${slug.replace(/-/g, '_')}@example.test`,
      ownerDisplayName: `Owner ${options.label}`,
      modules: options.modules,
    });

    const client = new Client({ connectionString: ownerUrl });
    await client.connect();
    try {
      await client.query('begin');
      await client.query(
        `update app_user set status = 'active' where id = $1`,
        [provisioned.ownerUserId],
      );
      await client.query(
        `update membership
            set role = $2, status = 'active'
          where tenant_id = $1 and user_id = $3`,
        [provisioned.tenantId, role, provisioned.ownerUserId],
      );
      await client.query('commit');

      const session = await createSessionFixture(client, {
        userId: provisioned.ownerUserId,
        tenantId: provisioned.tenantId,
      });

      return {
        tenantId: provisioned.tenantId,
        userId: provisioned.ownerUserId,
        role,
        session,
      };
    } finally {
      await client.end();
    }
  } finally {
    await pool.end();
  }
}

export async function insertClientRow(
  client: Client,
  tenantId: string,
  input: { name: string; code?: string | null; deletedAt?: string | null },
): Promise<ClientRowFixture> {
  const result = await client.query<ClientRowFixture>(
    `insert into client (tenant_id, name, code, currency, deleted_at)
     values ($1, $2, $3, 'ZZZ', $4::timestamptz)
     returning id, name, code`,
    [
      tenantId,
      input.name,
      input.code ?? null,
      input.deletedAt ? utcInstant(input.deletedAt) : null,
    ],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`Could not create the client ${input.name}`);
  }
  return row;
}

export type ProjectInput = {
  clientId: string;
  name: string;
  code?: string | null;
  status?: string;
  currency?: string;
  startDate?: string | null;
  endDate?: string | null;
  budgetMinor?: string | null;
  sourceSystem?: string | null;
  sourceId?: string | null;
  deletedAt?: string | null;
};

// The provenance columns exist on the row on purpose: project carries a
// table-level grant to the runtime role, so the route is the only thing that
// keeps them out of an answer.
export async function insertProjectRow(
  client: Client,
  tenantId: string,
  input: ProjectInput,
): Promise<ProjectRowFixture> {
  const result = await client.query<ProjectRowFixture>(
    `insert into project
       (tenant_id, client_id, name, code, status, currency, start_date, end_date,
        budget_minor, source_system, source_id, deleted_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::timestamptz)
     returning id,
               client_id as "clientId",
               name,
               code,
               status,
               currency,
               start_date::text as "startDate",
               end_date::text as "endDate",
               budget_minor::text as "budgetMinor"`,
    [
      tenantId,
      input.clientId,
      input.name,
      input.code ?? null,
      input.status ?? 'active',
      input.currency ?? 'ZZZ',
      input.startDate ?? null,
      input.endDate ?? null,
      input.budgetMinor ?? null,
      input.sourceSystem ?? null,
      input.sourceId ?? null,
      input.deletedAt ? utcInstant(input.deletedAt) : null,
    ],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`Could not create the project ${input.name}`);
  }
  return row;
}

export type InvoiceInput = {
  clientId: string;
  number: string;
  status?: string;
  currency?: string;
  issueDate?: string;
  dueDate?: string;
  subtotalMinor?: string;
  taxMinor?: string;
  totalMinor?: string;
  amountPaidMinor?: string;
};

export async function insertInvoiceRow(
  client: Client,
  tenantId: string,
  input: InvoiceInput,
): Promise<InvoiceRowFixture> {
  const result = await client.query<InvoiceRowFixture>(
    `insert into invoice
       (tenant_id, client_id, number, status, issue_date, due_date, currency,
        subtotal_minor, tax_minor, total_minor, amount_paid_minor)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     returning id,
               client_id as "clientId",
               number,
               status,
               currency,
               issue_date::text as "issueDate",
               due_date::text as "dueDate",
               subtotal_minor::text as "subtotalMinor",
               tax_minor::text as "taxMinor",
               total_minor::text as "totalMinor",
               amount_paid_minor::text as "amountPaidMinor"`,
    [
      tenantId,
      input.clientId,
      input.number,
      input.status ?? 'sent',
      input.issueDate ?? '2026-01-15',
      input.dueDate ?? '2026-02-14',
      input.currency ?? 'ZZZ',
      input.subtotalMinor ?? '10000',
      input.taxMinor ?? '1800',
      input.totalMinor ?? '11800',
      input.amountPaidMinor ?? '0',
    ],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`Could not create the invoice ${input.number}`);
  }
  return row;
}

export type ContentInput = {
  kind?: string;
  slug: string;
  title: string;
  locale?: string;
  status?: string;
  publishedAt?: string | null;
  updatedAt?: string;
  deletedAt?: string | null;
};

// The route renders the calendar day in UTC, so a seeded instant is stated in
// UTC as well: a bare date would be read in the session time zone and could
// land on the previous day.
function utcInstant(value: string): string {
  return /(Z|[+-]\d{2}:?\d{2})$/.test(value) ? value : `${value}T00:00:00Z`;
}

export async function insertContentRow(
  client: Client,
  tenantId: string,
  input: ContentInput,
): Promise<ContentRowFixture> {
  const result = await client.query<ContentRowFixture>(
    `insert into content_item
       (tenant_id, kind, slug, title, locale, status, published_at, updated_at,
        deleted_at)
     values ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz,
             $9::timestamptz)
     returning id,
               kind,
               slug,
               title,
               locale,
               status,
               published_at::text as "publishedAt",
               to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD') as "updatedAt"`,
    [
      tenantId,
      input.kind ?? 'page',
      input.slug,
      input.title,
      input.locale ?? 'en',
      input.status ?? 'draft',
      input.publishedAt === null || input.publishedAt === undefined
        ? null
        : utcInstant(input.publishedAt),
      utcInstant(input.updatedAt ?? '2026-02-01'),
      input.deletedAt ? utcInstant(input.deletedAt) : null,
    ],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`Could not create the content item ${input.slug}`);
  }
  return row;
}
