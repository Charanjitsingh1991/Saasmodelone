import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import {
  assertLocalDatabaseUrl,
  databaseUrlWithName,
  migrate,
  OWNER_ROLE,
  seed,
} from '@saasmodels/db';

export type TestDatabaseUrls = {
  adminUrl: string;
  ownerUrl: string;
  runtimeUrl: string;
};

export type TestDatabase = {
  name: string;
  ownerUrl: string;
  runtimeUrl: string;
  drop: () => Promise<void>;
};

export type CreateTestDatabaseOptions = {
  migrate?: boolean;
  seed?: boolean;
  namePrefix?: string;
  urls?: TestDatabaseUrls;
};

function quoteIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) {
    throw new Error(`Invalid PostgreSQL identifier "${value}"`);
  }
  return `"${value}"`;
}

export function readTestDatabaseUrls(): TestDatabaseUrls {
  return {
    adminUrl: assertLocalDatabaseUrl('TEST_DB_ADMIN_URL', process.env.TEST_DB_ADMIN_URL),
    ownerUrl: assertLocalDatabaseUrl('TEST_DB_OWNER_URL', process.env.TEST_DB_OWNER_URL),
    runtimeUrl: assertLocalDatabaseUrl('TEST_DB_RUNTIME_URL', process.env.TEST_DB_RUNTIME_URL),
  };
}

function makeDatabaseName(prefix: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(prefix)) {
    throw new Error(`Invalid test database prefix "${prefix}"`);
  }
  const suffix = `${process.pid.toString(36)}_${randomBytes(4).toString('hex')}`;
  return `${prefix}_${suffix}`.slice(0, 63);
}

export async function createTestDatabase(
  options: CreateTestDatabaseOptions = {},
): Promise<TestDatabase> {
  const urls = options.urls ?? readTestDatabaseUrls();
  const adminUrl = assertLocalDatabaseUrl('TEST_DB_ADMIN_URL', urls.adminUrl);
  const ownerSourceUrl = assertLocalDatabaseUrl('TEST_DB_OWNER_URL', urls.ownerUrl);
  const runtimeSourceUrl = assertLocalDatabaseUrl('TEST_DB_RUNTIME_URL', urls.runtimeUrl);
  const name = makeDatabaseName(options.namePrefix ?? 'saasmodels_test');
  const databaseIdentifier = quoteIdentifier(name);
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();

  try {
    const owner = await admin.query('select 1 from pg_roles where rolname = $1', [OWNER_ROLE]);
    if (owner.rowCount === 0) {
      throw new Error(`Role ${OWNER_ROLE} does not exist. Run pnpm db:bootstrap first.`);
    }
    await admin.query(`create database ${databaseIdentifier} owner ${quoteIdentifier(OWNER_ROLE)}`);
  } finally {
    await admin.end();
  }

  const ownerUrl = databaseUrlWithName(ownerSourceUrl, name);
  const runtimeUrl = databaseUrlWithName(runtimeSourceUrl, name);

  const drop = async (): Promise<void> => {
    const dropper = new Client({ connectionString: adminUrl });
    await dropper.connect();
    try {
      await dropper.query(`drop database if exists ${databaseIdentifier} with (force)`);
    } finally {
      await dropper.end();
    }
  };

  try {
    if (options.migrate ?? true) {
      await migrate({ ownerUrl });
    }
    if (options.seed ?? false) {
      await seed({ ownerUrl });
    }
  } catch (error) {
    await drop().catch(() => undefined);
    throw error;
  }

  return { name, ownerUrl, runtimeUrl, drop };
}
