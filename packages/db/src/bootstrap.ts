import { Client } from 'pg';
import { assertLocalDatabaseUrl, databaseUrlWithName, redactDatabaseUrl } from './config.js';

export type BootstrapOptions = {
  adminUrl: string;
  ownerPassword: string;
  runtimePassword: string;
  databaseName?: string;
  log?: (event: Record<string, unknown>) => void;
};

export type BootstrapResult = {
  databaseName: string;
  ownerRole: string;
  runtimeRole: string;
};

export const OWNER_ROLE = 'saas_owner';
export const RUNTIME_ROLE = 'saas_runtime';
const DEFAULT_DATABASE = 'saasmodels';

function quoteIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) {
    throw new Error(`Invalid PostgreSQL identifier "${value}"`);
  }
  return `"${value}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function ensureRole(
  admin: Client,
  role: string,
  password: string,
  log: (event: Record<string, unknown>) => void,
): Promise<void> {
  const identifier = quoteIdentifier(role);
  const exists = await admin.query('select 1 from pg_roles where rolname = $1', [role]);

  if (exists.rowCount === 0) {
    await admin.query(
      `create role ${identifier} login password ${quoteLiteral(password)}
       nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls`,
    );
    log({ event: 'role.created', role });
  }

  await admin.query(
    `alter role ${identifier} with login password ${quoteLiteral(password)}
     nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls`,
  );
  log({ event: 'role.ensured', role });
}

export async function bootstrap(options: BootstrapOptions): Promise<BootstrapResult> {
  const adminUrl = assertLocalDatabaseUrl('DB_ADMIN_URL', options.adminUrl);
  const databaseName = options.databaseName ?? DEFAULT_DATABASE;
  const databaseIdentifier = quoteIdentifier(databaseName);
  const log = options.log ?? (() => undefined);

  if (!options.ownerPassword) {
    throw new Error('SAAS_OWNER_PASSWORD is required');
  }
  if (!options.runtimePassword) {
    throw new Error('SAAS_RUNTIME_PASSWORD is required');
  }

  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();

  try {
    await ensureRole(admin, OWNER_ROLE, options.ownerPassword, log);
    await ensureRole(admin, RUNTIME_ROLE, options.runtimePassword, log);

    const database = await admin.query('select 1 from pg_database where datname = $1', [
      databaseName,
    ]);
    if (database.rowCount === 0) {
      await admin.query(`create database ${databaseIdentifier} owner ${quoteIdentifier(OWNER_ROLE)}`);
      log({ event: 'database.created', database: databaseName });
    } else {
      await admin.query(`alter database ${databaseIdentifier} owner to ${quoteIdentifier(OWNER_ROLE)}`);
    }

    await admin.query(`revoke all on database ${databaseIdentifier} from public`);
    await admin.query(
      `grant connect on database ${databaseIdentifier} to ${quoteIdentifier(OWNER_ROLE)}`,
    );
    await admin.query(
      `grant connect on database ${databaseIdentifier} to ${quoteIdentifier(RUNTIME_ROLE)}`,
    );
    await admin.query(
      `revoke create on database ${databaseIdentifier} from ${quoteIdentifier(RUNTIME_ROLE)}`,
    );

    const databaseAdminUrl = databaseUrlWithName(adminUrl, databaseName);
    const scoped = new Client({ connectionString: databaseAdminUrl });
    await scoped.connect();
    try {
      await scoped.query(`alter schema public owner to ${quoteIdentifier(OWNER_ROLE)}`);
      await scoped.query('revoke all on schema public from public');
      await scoped.query(
        `grant usage, create on schema public to ${quoteIdentifier(OWNER_ROLE)}`,
      );
      await scoped.query(`revoke create on schema public from ${quoteIdentifier(RUNTIME_ROLE)}`);
      await scoped.query(`revoke all on schema public from ${quoteIdentifier(RUNTIME_ROLE)}`);
    } finally {
      await scoped.end();
    }

    log({
      event: 'database.ready',
      database: databaseName,
      adminUrl: redactDatabaseUrl(adminUrl),
    });

    return {
      databaseName,
      ownerRole: OWNER_ROLE,
      runtimeRole: RUNTIME_ROLE,
    };
  } finally {
    await admin.end().catch(() => undefined);
  }
}
