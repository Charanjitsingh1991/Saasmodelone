import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from 'pg';
import { assertLocalDatabaseUrl } from './config.js';

export type MigrationResult = {
  applied: string[];
  skipped: string[];
};

export type MigrationOptions = {
  ownerUrl: string;
  migrationsDir?: string;
  grantsFiles?: string[];
  log?: (event: Record<string, unknown>) => void;
};

const ADVISORY_LOCK_KEY = 741_923_001;

function defaultMigrationsDir(): string {
  return process.env.SUITE_DB_DIR
    ? path.join(process.env.SUITE_DB_DIR, 'migrations')
    : path.resolve(process.cwd(), 'suite', 'db', 'migrations');
}

function defaultGrantsFiles(): string[] {
  const directory = path.resolve(process.cwd(), 'packages', 'db', 'sql');
  return [
    path.join(directory, 'runtime-grants.sql'),
    path.join(directory, 'auth-grants.sql'),
  ];
}

export async function listSqlFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

function checksum(contents: Buffer): string {
  return createHash('sha256').update(contents).digest('hex');
}

async function ensureLedger(client: Client): Promise<void> {
  await client.query(`
    create schema if not exists infra;

    create table if not exists infra.schema_migration (
      version text primary key,
      checksum text not null,
      status text not null
        check (status in ('applying', 'applied', 'failed')),
      started_at timestamptz not null default now(),
      applied_at timestamptz,
      duration_ms integer,
      error text,
      applied_by text not null default current_user
    );
  `);
}

export async function migrate(options: MigrationOptions): Promise<MigrationResult> {
  const ownerUrl = assertLocalDatabaseUrl('DB_OWNER_URL', options.ownerUrl);
  const migrationsDir = options.migrationsDir ?? defaultMigrationsDir();
  const grantsFiles = options.grantsFiles ?? defaultGrantsFiles();
  const log = options.log ?? (() => undefined);
  const files = await listSqlFiles(migrationsDir);

  if (files.length === 0) {
    throw new Error(`No migrations found in ${migrationsDir}`);
  }

  const client = new Client({ connectionString: ownerUrl });
  await client.connect();
  let lockHeld = false;
  const result: MigrationResult = { applied: [], skipped: [] };

  try {
    await client.query('select pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
    lockHeld = true;
    await ensureLedger(client);

    for (const file of files) {
      const contents = await readFile(path.join(migrationsDir, file));
      const fileChecksum = checksum(contents);
      const existing = await client.query<{
        checksum: string;
        status: 'applying' | 'applied' | 'failed';
        error: string | null;
      }>(
        'select checksum, status, error from infra.schema_migration where version = $1',
        [file],
      );

      if (existing.rowCount === 1) {
        const row = existing.rows[0];
        if (!row) {
          throw new Error(`Could not read migration ledger row for ${file}`);
        }
        if (row.checksum !== fileChecksum) {
          throw new Error(
            `Applied migration ${file} has a different checksum. ` +
              'Do not rewrite a reviewed baseline; add a forward migration.',
          );
        }
        if (row.status === 'applying') {
          throw new Error(
            `Migration ${file} was interrupted while applying. Inspect the database and resolve the ledger row manually.`,
          );
        }
        if (row.status === 'failed') {
          throw new Error(
            `Migration ${file} previously failed (${row.error ?? 'no error recorded'}). ` +
              'Resolve it and reset the ledger row manually; it will not be retried automatically.',
          );
        }
        result.skipped.push(file);
        log({ event: 'migration.skipped', version: file });
        continue;
      }

      const startedAt = Date.now();
      await client.query(
        `insert into infra.schema_migration (version, checksum, status)
         values ($1, $2, 'applying')`,
        [file, fileChecksum],
      );

      try {
        await client.query(contents.toString('utf8'));
      } catch (error) {
        await client.query('rollback').catch(() => undefined);
        const message = error instanceof Error ? error.message : String(error);
        await client
          .query(
            `update infra.schema_migration
             set status = 'failed', error = $2, duration_ms = $3
             where version = $1`,
            [file, message.slice(0, 4000), Date.now() - startedAt],
          )
          .catch(() => undefined);
        throw new Error(`Migration ${file} failed: ${message}`, { cause: error });
      }

      const durationMs = Date.now() - startedAt;
      await client.query(
        `update infra.schema_migration
         set status = 'applied', applied_at = now(), duration_ms = $2, error = null
         where version = $1`,
        [file, durationMs],
      );
      result.applied.push(file);
      log({ event: 'migration.applied', version: file, durationMs });
    }

    for (const grantsFile of grantsFiles) {
      const grants = await readFile(grantsFile, 'utf8');
      await client.query(grants);
      log({ event: 'grants.applied', file: path.basename(grantsFile) });
    }

    return result;
  } finally {
    if (lockHeld) {
      await client.query('select pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]).catch(() => undefined);
    }
    await client.end();
  }
}
