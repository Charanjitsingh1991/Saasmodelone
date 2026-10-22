import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { Client } from 'pg';
import { assertLocalDatabaseUrl, databaseUrlWithName } from '@saasmodels/db';

const run = promisify(execFile);

const DEFAULT_PG_BIN_DIR = 'D:/tools/pg17/pgsql/bin';
const ZERO_TENANT_ID = '00000000-0000-0000-0000-000000000000';

export const LOAD_BEARING_TABLES: readonly string[] = [
  'tenant',
  'app_user',
  'membership',
  'module_entitlement',
  'platform_module',
  'platform_module_dependency',
  'legal_entity',
  'org_unit',
  'jurisdiction',
  'person',
  'employment',
  'project',
  'auth_session',
  'invitation',
  'audit_event',
  'domain_event',
];

export type DrillMetrics = {
  databaseName: string;
  publicTableCount: number;
  rowCountByTable: Record<string, number>;
  rlsEnabledTableCount: number;
  rlsPolicyCount: number;
  runtimeTableGrants: string[];
  runtimePersonColumnGrants: string[];
  runtimeSampleTenantId: string;
  runtimeSampleCounts: Record<string, number>;
};

export type DrillComparison = {
  ok: boolean;
  differences: string[];
  source: DrillMetrics;
  restored: DrillMetrics;
};

function quoteIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) {
    throw new Error(`Invalid PostgreSQL identifier "${value}"`);
  }
  return `"${value}"`;
}

function redact(text: string): string {
  return text.replace(/postgres(ql)?:\/\/[^\s"']+/gi, '<db-url>');
}

function toNumber(value: string | null | undefined): number {
  return Number(value ?? 0);
}

export function resolvePgBinaries(binDir: string): { pgDump: string; pgRestore: string } {
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const pgDump = path.join(binDir, `pg_dump${suffix}`);
  const pgRestore = path.join(binDir, `pg_restore${suffix}`);
  for (const binary of [pgDump, pgRestore]) {
    if (!existsSync(binary)) {
      throw new Error(
        `${path.basename(binary)} not found in "${binDir}". ` +
          'Set PG_BIN_DIR to the directory holding the PostgreSQL 17 client binaries.',
      );
    }
  }
  return { pgDump, pgRestore };
}

export type CollectMetricsOptions = {
  databaseName: string;
  ownerUrl: string;
  runtimeUrl: string;
};

export async function collectDrillMetrics(
  options: CollectMetricsOptions,
): Promise<DrillMetrics> {
  const owner = new Client({ connectionString: options.ownerUrl });
  await owner.connect();
  const metrics: DrillMetrics = {
    databaseName: options.databaseName,
    publicTableCount: 0,
    rowCountByTable: {},
    rlsEnabledTableCount: 0,
    rlsPolicyCount: 0,
    runtimeTableGrants: [],
    runtimePersonColumnGrants: [],
    runtimeSampleTenantId: ZERO_TENANT_ID,
    runtimeSampleCounts: {},
  };
  try {
    const tables = await owner.query<{ count: string }>(
      `select count(*)::text as count
         from information_schema.tables
        where table_schema = 'public' and table_type = 'BASE TABLE'`,
    );
    metrics.publicTableCount = toNumber(tables.rows[0]?.count);

    for (const table of LOAD_BEARING_TABLES) {
      const rows = await owner.query<{ count: string }>(
        `select count(*)::text as count from public.${quoteIdentifier(table)}`,
      );
      metrics.rowCountByTable[table] = toNumber(rows.rows[0]?.count);
    }

    const rls = await owner.query<{ count: string }>(
      `select count(*)::text as count
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity`,
    );
    metrics.rlsEnabledTableCount = toNumber(rls.rows[0]?.count);

    const policies = await owner.query<{ count: string }>(
      `select count(*)::text as count
         from pg_policy p
         join pg_class c on c.oid = p.polrelid
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'`,
    );
    metrics.rlsPolicyCount = toNumber(policies.rows[0]?.count);

    const tableGrants = await owner.query<{ table_name: string; privilege_type: string }>(
      `select table_name, privilege_type
         from information_schema.role_table_grants
        where grantee = 'saas_runtime' and table_schema = 'public'
        order by table_name, privilege_type`,
    );
    metrics.runtimeTableGrants = tableGrants.rows.map(
      (row) => `${row.table_name}:${row.privilege_type}`,
    );

    const columnGrants = await owner.query<{ column_name: string }>(
      `select column_name
         from information_schema.column_privileges
        where grantee = 'saas_runtime'
          and table_schema = 'public'
          and table_name = 'person'
          and privilege_type = 'SELECT'
        order by column_name`,
    );
    metrics.runtimePersonColumnGrants = columnGrants.rows.map((row) => row.column_name);

    const tenant = await owner.query<{ id: string }>(
      'select id::text as id from tenant order by id limit 1',
    );
    metrics.runtimeSampleTenantId = tenant.rows[0]?.id ?? ZERO_TENANT_ID;
  } finally {
    await owner.end();
  }

  const runtime = new Client({ connectionString: options.runtimeUrl });
  await runtime.connect();
  try {
    await runtime.query('begin');
    await runtime.query("select set_config('app.tenant_id', $1, true)", [
      metrics.runtimeSampleTenantId,
    ]);
    for (const table of ['employment', 'project']) {
      const rows = await runtime.query<{ count: string }>(
        `select count(*)::text as count from public.${quoteIdentifier(table)}`,
      );
      metrics.runtimeSampleCounts[table] = toNumber(rows.rows[0]?.count);
    }
    const people = await runtime.query<{ count: string }>(
      'select count(id)::text as count from public.person where deleted_at is null',
    );
    metrics.runtimeSampleCounts['person'] = toNumber(people.rows[0]?.count);
    await runtime.query('commit');
  } finally {
    await runtime.end();
  }

  return metrics;
}

export function compareDrillMetrics(
  source: DrillMetrics,
  restored: DrillMetrics,
): DrillComparison {
  const differences: string[] = [];
  const diff = (label: string, left: unknown, right: unknown): void => {
    if (JSON.stringify(left) !== JSON.stringify(right)) {
      differences.push(`${label}: source=${JSON.stringify(left)} restored=${JSON.stringify(right)}`);
    }
  };

  diff('publicTableCount', source.publicTableCount, restored.publicTableCount);
  diff('rlsEnabledTableCount', source.rlsEnabledTableCount, restored.rlsEnabledTableCount);
  diff('rlsPolicyCount', source.rlsPolicyCount, restored.rlsPolicyCount);
  diff('runtimeTableGrants', source.runtimeTableGrants, restored.runtimeTableGrants);
  diff(
    'runtimePersonColumnGrants',
    source.runtimePersonColumnGrants,
    restored.runtimePersonColumnGrants,
  );
  diff('runtimeSampleCounts', source.runtimeSampleCounts, restored.runtimeSampleCounts);

  for (const table of LOAD_BEARING_TABLES) {
    diff(`rowCountByTable.${table}`, source.rowCountByTable[table], restored.rowCountByTable[table]);
  }

  return { ok: differences.length === 0, differences, source, restored };
}

export type RestoreDrillOptions = {
  adminUrl: string;
  ownerUrl: string;
  runtimeUrl: string;
  binDir?: string;
  backupDir?: string;
  now?: Date;
  log?: (event: Record<string, unknown>) => void;
};

export type DrillReport = {
  dumpFile: string;
  dumpBytes: number;
  dumpSha256: string;
  drillDatabase: string;
  comparison: DrillComparison;
  timingsMs: Record<string, number>;
};

export async function runRestoreDrill(
  options: RestoreDrillOptions,
): Promise<DrillReport> {
  const log = options.log ?? (() => undefined);
  const adminUrl = assertLocalDatabaseUrl('DB_ADMIN_URL', options.adminUrl);
  const ownerUrl = assertLocalDatabaseUrl('DB_OWNER_URL', options.ownerUrl);
  const runtimeUrl = assertLocalDatabaseUrl('DB_RUNTIME_URL', options.runtimeUrl);

  const sourceDatabase = new URL(ownerUrl).pathname.replace(/^\//, '');
  if (!sourceDatabase) {
    throw new Error('DB_OWNER_URL must name the source developer database');
  }

  const { pgDump, pgRestore } = resolvePgBinaries(options.binDir ?? process.env.PG_BIN_DIR ?? DEFAULT_PG_BIN_DIR);

  const now = options.now ?? new Date();
  const utc = now.toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15);
  const drillDatabase = `${sourceDatabase}_drill_${utc.slice(0, 8)}_${utc.slice(9, 15)}`;
  if (drillDatabase === sourceDatabase) {
    throw new Error(`Refusing to target the source database "${sourceDatabase}"`);
  }
  quoteIdentifier(drillDatabase);

  const backupDir = options.backupDir ?? path.resolve(process.cwd(), 'var', 'backups');
  mkdirSync(backupDir, { recursive: true });
  const dumpFile = path.join(backupDir, `${sourceDatabase}_${utc}Z.dump`);

  const timingsMs: Record<string, number> = {};
  const totalStart = Date.now();

  const dumpStart = Date.now();
  const sourceAdminUrl = databaseUrlWithName(adminUrl, sourceDatabase);
  try {
    await run(pgDump, ['-d', sourceAdminUrl, '--format=custom', '--file', dumpFile]);
  } catch (error) {
    throw new Error(`pg_dump failed: ${redact(error instanceof Error ? error.message : String(error))}`, {
      cause: error,
    });
  }
  timingsMs.dump = Date.now() - dumpStart;

  const dumpBytes = statSync(dumpFile).size;
  const dumpSha256 = createHash('sha256').update(readFileSync(dumpFile)).digest('hex');
  log({ event: 'drill.dumped', file: dumpFile, bytes: dumpBytes, sha256: dumpSha256, ms: timingsMs.dump });

  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  let comparison: DrillComparison;
  try {
    const existing = await admin.query('select 1 from pg_database where datname = $1', [
      drillDatabase,
    ]);
    if (existing.rowCount !== 0) {
      throw new Error(`Drill database "${drillDatabase}" already exists; refusing to reuse it`);
    }
    await admin.query(
      `create database ${quoteIdentifier(drillDatabase)} owner "saas_owner"`,
    );
    log({ event: 'drill.database.created', database: drillDatabase });

    const drillAdminUrl = databaseUrlWithName(adminUrl, drillDatabase);
    const restoreStart = Date.now();
    try {
      await run(pgRestore, ['-e', '-d', drillAdminUrl, dumpFile]);
    } catch (error) {
      throw new Error(
        `pg_restore failed into "${drillDatabase}": ${redact(error instanceof Error ? error.message : String(error))}`,
        { cause: error },
      );
    }
    timingsMs.restore = Date.now() - restoreStart;
    log({ event: 'drill.restored', database: drillDatabase, ms: timingsMs.restore });

    const verifyStart = Date.now();
    const source = await collectDrillMetrics({
      databaseName: sourceDatabase,
      ownerUrl,
      runtimeUrl,
    });
    const restored = await collectDrillMetrics({
      databaseName: drillDatabase,
      ownerUrl: databaseUrlWithName(ownerUrl, drillDatabase),
      runtimeUrl: databaseUrlWithName(runtimeUrl, drillDatabase),
    });
    comparison = compareDrillMetrics(source, restored);
    timingsMs.verify = Date.now() - verifyStart;
    log({
      event: 'drill.verified',
      ok: comparison.ok,
      differences: comparison.differences,
      source: comparison.source,
      restored: comparison.restored,
      ms: timingsMs.verify,
    });
  } finally {
    const dropStart = Date.now();
    await admin.query(`drop database if exists ${quoteIdentifier(drillDatabase)} with (force)`);
    timingsMs.drop = Date.now() - dropStart;
    log({ event: 'drill.database.dropped', database: drillDatabase, ms: timingsMs.drop });
    await admin.end();
  }

  timingsMs.total = Date.now() - totalStart;

  if (!comparison.ok) {
    throw new Error(
      `Restore drill verification failed:\n${comparison.differences.join('\n')}`,
    );
  }

  return { dumpFile, dumpBytes, dumpSha256, drillDatabase, comparison, timingsMs };
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

async function main(): Promise<void> {
  try {
    const report = await runRestoreDrill({
      adminUrl: requiredEnv('DB_ADMIN_URL'),
      ownerUrl: requiredEnv('DB_OWNER_URL'),
      runtimeUrl: requiredEnv('DB_RUNTIME_URL'),
      log: (event) => process.stdout.write(`${JSON.stringify(event)}\n`),
    });
    process.stdout.write(
      `${JSON.stringify({
        event: 'drill.complete',
        ok: true,
        dumpBytes: report.dumpBytes,
        dumpSha256: report.dumpSha256,
        drillDatabase: report.drillDatabase,
        timingsMs: report.timingsMs,
      })}\n`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${redact(message)}\n`);
    process.exitCode = 1;
  }
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(path.resolve(entryPoint)).href) {
  void main();
}
