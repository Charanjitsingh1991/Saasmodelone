import 'dotenv/config';
import { Pool } from 'pg';
import { bootstrap } from './bootstrap.js';
import { migrate } from './migrate.js';
import { provisionTenant, ProvisioningError, type ProvisionTenantInput } from './provision.js';
import { seed } from './seed.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function log(event: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function nextValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new ProvisioningError('INVALID_PROVISION_INPUT', `${flag} requires a value`);
  }
  return value;
}

function parseProvisionArgs(args: string[]): ProvisionTenantInput {
  const values: Partial<
    Record<'name' | 'slug' | 'region' | 'ownerEmail' | 'ownerName', string>
  > = {};
  const modules: string[] = [];
  let isInternal = false;

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    switch (flag) {
      case '--name':
        values.name = nextValue(args, index, flag);
        index += 1;
        break;
      case '--slug':
        values.slug = nextValue(args, index, flag);
        index += 1;
        break;
      case '--region':
        values.region = nextValue(args, index, flag);
        index += 1;
        break;
      case '--owner-email':
        values.ownerEmail = nextValue(args, index, flag);
        index += 1;
        break;
      case '--owner-name':
        values.ownerName = nextValue(args, index, flag);
        index += 1;
        break;
      case '--module':
        modules.push(nextValue(args, index, flag));
        index += 1;
        break;
      case '--internal':
        isInternal = true;
        break;
      default:
        throw new ProvisioningError(
          'INVALID_PROVISION_INPUT',
          `Unknown provisioning option ${flag}`,
        );
    }
  }

  if (
    !values.name ||
    !values.slug ||
    !values.region ||
    !values.ownerEmail ||
    !values.ownerName
  ) {
    throw new ProvisioningError(
      'INVALID_PROVISION_INPUT',
      'Usage: db:provision --name <name> --slug <slug> --region <region> ' +
        '--owner-email <email> --owner-name <name> --module <code> [--module <code>] [--internal]',
    );
  }

  return {
    name: values.name,
    slug: values.slug,
    dataRegion: values.region,
    ownerEmail: values.ownerEmail,
    ownerDisplayName: values.ownerName,
    modules,
    isInternal,
  };
}

async function main(): Promise<void> {
  const command = process.argv[2];

  switch (command) {
    case 'bootstrap': {
      const result = await bootstrap({
        adminUrl: required('DB_ADMIN_URL'),
        ownerPassword: required('SAAS_OWNER_PASSWORD'),
        runtimePassword: required('SAAS_RUNTIME_PASSWORD'),
        log,
      });
      log({ event: 'bootstrap.complete', ...result });
      return;
    }
    case 'migrate': {
      const result = await migrate({ ownerUrl: required('DB_OWNER_URL'), log });
      log({ event: 'migrate.complete', applied: result.applied, skipped: result.skipped });
      return;
    }
    case 'seed': {
      const files = await seed({ ownerUrl: required('DB_OWNER_URL'), log });
      log({ event: 'seed.complete', files });
      return;
    }
    case 'provision': {
      const input = parseProvisionArgs(process.argv.slice(3));
      const pool = new Pool({ connectionString: required('DB_OWNER_URL') });
      try {
        const result = await provisionTenant(pool, input);
        log({
          event: 'provision.complete',
          tenantId: result.tenantId,
          ownerUserId: result.ownerUserId,
        });
      } finally {
        await pool.end();
      }
      return;
    }
    default:
      throw new Error('Usage: cli.ts <bootstrap|migrate|seed|provision>');
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code: unknown }).code)
      : 'COMMAND_FAILED';
  process.stderr.write(`${code}: ${message}\n`);
  if (process.env.DEBUG && error instanceof Error && error.stack) {
    process.stderr.write(`${error.stack}\n`);
  }
  process.exitCode = 1;
});
