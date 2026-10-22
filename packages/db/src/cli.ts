import 'dotenv/config';
import { Pool } from 'pg';
import { AuthError, createInvitation } from './auth.js';
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

type InviteArgs = {
  tenantSlug: string;
  email: string;
  days?: number;
};

function nextInviteValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new AuthError('INVALID_INVITATION_INPUT', `${flag} requires a value`);
  }
  return value;
}

function parseInviteArgs(args: string[]): InviteArgs {
  let tenantSlug: string | undefined;
  let email: string | undefined;
  let days: number | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    switch (flag) {
      case '--tenant':
        tenantSlug = nextInviteValue(args, index, flag);
        index += 1;
        break;
      case '--email':
        email = nextInviteValue(args, index, flag);
        index += 1;
        break;
      case '--days': {
        const value = nextInviteValue(args, index, flag);
        days = Number(value);
        if (!Number.isInteger(days)) {
          throw new AuthError('INVALID_INVITATION_INPUT', '--days must be an integer');
        }
        index += 1;
        break;
      }
      default:
        throw new AuthError(
          'INVALID_INVITATION_INPUT',
          `Unknown invite option ${flag}`,
        );
    }
  }

  if (!tenantSlug || !email) {
    throw new AuthError(
      'INVALID_INVITATION_INPUT',
      'Usage: db:invite --tenant <slug> --email <email> [--days 7]',
    );
  }

  return { tenantSlug, email, ...(days === undefined ? {} : { days }) };
}

async function main(): Promise<void> {
  const command = process.argv[2];

  switch (command) {
    case 'bootstrap': {
      const result = await bootstrap({
        adminUrl: required('DB_ADMIN_URL'),
        ownerPassword: required('SAAS_OWNER_PASSWORD'),
        runtimePassword: required('SAAS_RUNTIME_PASSWORD'),
        authPassword: required('SAAS_AUTH_PASSWORD'),
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
    case 'invite': {
      const input = parseInviteArgs(process.argv.slice(3));
      const pool = new Pool({ connectionString: required('DB_OWNER_URL') });
      try {
        const invitation = await createInvitation(pool, {
          tenantSlug: input.tenantSlug,
          email: input.email,
          ...(input.days === undefined ? {} : { expiresInDays: input.days }),
        });
        const tenant = await pool.query<{ id: string }>(
          'select id from tenant where slug = $1',
          [input.tenantSlug],
        );
        const tenantId = tenant.rows[0]?.id;
        if (!tenantId) {
          throw new AuthError(
            'INVALID_INVITATION_INPUT',
            `Tenant ${input.tenantSlug} was not found`,
          );
        }
        log({
          event: 'invite.complete',
          invitationId: invitation.invitationId,
          tenantId,
          email: input.email,
          expiresAt: invitation.expiresAt.toISOString(),
          token: invitation.token,
          warning:
            'Treat this invitation token as a secret and deliver it out of band. ' +
            'It is shown once and cannot be retrieved again.',
        });
      } finally {
        await pool.end();
      }
      return;
    }
    default:
      throw new Error('Usage: cli.ts <bootstrap|migrate|seed|provision|invite>');
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
