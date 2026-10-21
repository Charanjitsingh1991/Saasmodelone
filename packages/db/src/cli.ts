import 'dotenv/config';
import { bootstrap } from './bootstrap.js';
import { migrate } from './migrate.js';
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
    default:
      throw new Error('Usage: cli.ts <bootstrap|migrate|seed>');
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  if (process.env.DEBUG && error instanceof Error && error.stack) {
    process.stderr.write(`${error.stack}\n`);
  }
  process.exitCode = 1;
});
