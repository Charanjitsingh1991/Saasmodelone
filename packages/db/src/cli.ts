import 'dotenv/config';
import { Pool } from 'pg';
import { AuthError, createInvitation } from './auth.js';
import { bootstrap } from './bootstrap.js';
import { migrate } from './migrate.js';
import { provisionTenant, ProvisioningError, type ProvisionTenantInput } from './provision.js';
import {
  getMembershipScope,
  linkPersonUser,
  ScopeAdminError,
  setMembershipScope,
  unlinkPersonUser,
  type ScopeValue,
} from './scope.js';
import { seed } from './seed.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

type ScopeCommand = 'link' | 'unlink' | 'set' | 'show';

type ScopeArgs = {
  command: ScopeCommand;
  tenantSlug: string;
  actorEmail: string;
  userEmail: string;
  personRef: string;
  legalEntities: string[];
  orgUnits: string[];
  tenantWide: boolean;
};

const SCOPE_USAGE: Record<ScopeCommand, string> = {
  link: 'Usage: db:scope link --tenant <slug> --person <employee-code|uuid> --user <email> --actor <email>',
  unlink:
    'Usage: db:scope unlink --tenant <slug> --person <employee-code|uuid> --actor <email>',
  set:
    'Usage: db:scope set --tenant <slug> --user <email> --actor <email> ' +
    '[--legal-entity <code|uuid> ...] [--org-unit <uuid> ...] | --tenant-wide',
  show: 'Usage: db:scope show --tenant <slug> --user <email>',
};

function scopeInvalid(message: string): ScopeAdminError {
  return new ScopeAdminError('INVALID_SCOPE_INPUT', message);
}

function nextScopeValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw scopeInvalid(`${flag} requires a value`);
  }
  return value;
}

function parseScopeArgs(command: ScopeCommand, args: string[]): ScopeArgs {
  const parsed: ScopeArgs = {
    command,
    tenantSlug: '',
    actorEmail: '',
    userEmail: '',
    personRef: '',
    legalEntities: [],
    orgUnits: [],
    tenantWide: false,
  };
  const used = new Set<string>();

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index] as string;
    switch (flag) {
      case '--tenant':
        parsed.tenantSlug = nextScopeValue(args, index, flag);
        index += 1;
        break;
      case '--person':
        parsed.personRef = nextScopeValue(args, index, flag);
        index += 1;
        break;
      case '--user':
        parsed.userEmail = nextScopeValue(args, index, flag);
        index += 1;
        break;
      case '--actor':
        parsed.actorEmail = nextScopeValue(args, index, flag);
        index += 1;
        break;
      case '--legal-entity':
        parsed.legalEntities.push(nextScopeValue(args, index, flag));
        index += 1;
        break;
      case '--org-unit':
        parsed.orgUnits.push(nextScopeValue(args, index, flag));
        index += 1;
        break;
      case '--tenant-wide':
        parsed.tenantWide = true;
        break;
      default:
        throw scopeInvalid(`Unknown scope option ${flag}`);
    }
    used.add(flag);
  }

  const requiredFlags: string[] = ['--tenant'];
  if (command === 'link') requiredFlags.push('--person', '--user', '--actor');
  if (command === 'unlink') requiredFlags.push('--person', '--actor');
  if (command === 'set') requiredFlags.push('--user', '--actor');
  if (command === 'show') requiredFlags.push('--user');

  for (const flag of requiredFlags) {
    if (!used.has(flag)) {
      throw scopeInvalid(SCOPE_USAGE[command]);
    }
  }

  if (command !== 'set') {
    for (const flag of ['--legal-entity', '--org-unit', '--tenant-wide']) {
      if (used.has(flag)) {
        throw scopeInvalid(`${flag} is not valid for db:scope ${command}`);
      }
    }
  }
  if (command !== 'link' && command !== 'unlink' && used.has('--person')) {
    throw scopeInvalid('--person is not valid for db:scope set|show');
  }
  if (command === 'set') {
    if (parsed.tenantWide && (parsed.legalEntities.length > 0 || parsed.orgUnits.length > 0)) {
      throw scopeInvalid('--tenant-wide cannot be combined with --legal-entity or --org-unit');
    }
    if (
      !parsed.tenantWide &&
      parsed.legalEntities.length === 0 &&
      parsed.orgUnits.length === 0
    ) {
      throw scopeInvalid(SCOPE_USAGE.set);
    }
  }

  return parsed;
}

async function lookupTenantId(pool: Pool, slug: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    'select id from tenant where slug = $1 and deleted_at is null',
    [slug],
  );
  const row = result.rows[0];
  if (!row) {
    throw new ScopeAdminError('TENANT_NOT_FOUND', 'No active tenant with that slug');
  }
  return row.id;
}

async function lookupUserId(pool: Pool, email: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    'select id from app_user where email = $1',
    [email],
  );
  const row = result.rows[0];
  if (!row) {
    throw new ScopeAdminError('USER_NOT_FOUND', 'No user with that email address');
  }
  return row.id;
}

/**
 * A person is addressed by uuid or by the tenant's employee code. Codes are not
 * globally unique, so the tenant predicate stays on every lookup.
 */
async function lookupPersonId(
  pool: Pool,
  tenantId: string,
  ref: string,
): Promise<string> {
  const byUuid = UUID_PATTERN.test(ref);
  const result = await pool.query<{ id: string }>(
    byUuid
      ? 'select id from person where tenant_id = $1 and id = $2 and deleted_at is null'
      : 'select id from person where tenant_id = $1 and employee_code = $2 and deleted_at is null',
    [tenantId, byUuid ? ref.toLowerCase() : ref],
  );
  const row = result.rows[0];
  if (!row) {
    throw new ScopeAdminError('PERSON_NOT_FOUND', 'No person with that id or employee code');
  }
  return row.id;
}

async function lookupMembershipId(
  pool: Pool,
  tenantId: string,
  userId: string,
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    'select id from membership where tenant_id = $1 and user_id = $2',
    [tenantId, userId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new ScopeAdminError('MEMBERSHIP_NOT_FOUND', 'That user is not a member of the tenant');
  }
  return row.id;
}

async function lookupLegalEntityId(
  pool: Pool,
  tenantId: string,
  ref: string,
): Promise<string> {
  const byUuid = UUID_PATTERN.test(ref);
  const result = await pool.query<{ id: string }>(
    byUuid
      ? 'select id from legal_entity where tenant_id = $1 and id = $2 and deleted_at is null'
      : 'select id from legal_entity where tenant_id = $1 and code = $2 and deleted_at is null',
    [tenantId, byUuid ? ref.toLowerCase() : ref],
  );
  const row = result.rows[0];
  if (!row) {
    throw new ScopeAdminError(
      'LEGAL_ENTITY_NOT_FOUND',
      'No legal entity with that code or id in the tenant',
    );
  }
  return row.id;
}

async function lookupOrgUnitId(pool: Pool, tenantId: string, ref: string): Promise<string> {
  if (!UUID_PATTERN.test(ref)) {
    throw scopeInvalid('org units have no code; --org-unit takes a uuid');
  }
  const result = await pool.query<{ id: string }>(
    'select id from org_unit where tenant_id = $1 and id = $2 and deleted_at is null',
    [tenantId, ref.toLowerCase()],
  );
  const row = result.rows[0];
  if (!row) {
    throw new ScopeAdminError('ORG_UNIT_NOT_FOUND', 'No org unit with that id in the tenant');
  }
  return row.id;
}

async function runScopeCommand(pool: Pool, args: ScopeArgs): Promise<void> {
  const tenantId = await lookupTenantId(pool, args.tenantSlug);

  if (args.command === 'link') {
    const personId = await lookupPersonId(pool, tenantId, args.personRef);
    const userId = await lookupUserId(pool, args.userEmail);
    const actorUserId = await lookupUserId(pool, args.actorEmail);
    const result = await linkPersonUser(pool, { tenantId, personId, userId, actorUserId });
    log({ event: 'scope.link.complete', tenantId, personId, userId, changed: result.changed });
    return;
  }

  if (args.command === 'unlink') {
    const personId = await lookupPersonId(pool, tenantId, args.personRef);
    const actorUserId = await lookupUserId(pool, args.actorEmail);
    const result = await unlinkPersonUser(pool, { tenantId, personId, actorUserId });
    log({ event: 'scope.unlink.complete', tenantId, personId, changed: result.changed });
    return;
  }

  const userId = await lookupUserId(pool, args.userEmail);
  const membershipId = await lookupMembershipId(pool, tenantId, userId);

  if (args.command === 'show') {
    const view = await getMembershipScope(pool, { tenantId, membershipId });
    log({
      event: 'scope.show.complete',
      tenantId: view.tenantId,
      membershipId: view.membershipId,
      role: view.role,
      membershipStatus: view.membershipStatus,
      tenantWide: view.tenantWide,
      scopes: view.scopes,
    });
    return;
  }

  const scopes: ScopeValue[] = [];
  for (const ref of args.legalEntities) {
    scopes.push({
      scopeType: 'legal_entity',
      scopeId: await lookupLegalEntityId(pool, tenantId, ref),
    });
  }
  for (const ref of args.orgUnits) {
    scopes.push({ scopeType: 'org_unit', scopeId: await lookupOrgUnitId(pool, tenantId, ref) });
  }

  const actorUserId = await lookupUserId(pool, args.actorEmail);
  const result = await setMembershipScope(pool, {
    tenantId,
    membershipId,
    scopes,
    tenantWide: args.tenantWide,
    actorUserId,
  });
  log({
    event: 'scope.set.complete',
    tenantId,
    membershipId,
    tenantWide: args.tenantWide,
    scopes,
    changed: result.changed,
  });
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
        workerPassword: required('SAAS_WORKER_PASSWORD'),
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
    case 'scope': {
      const subcommand = process.argv[3];
      if (
        subcommand !== 'link' &&
        subcommand !== 'unlink' &&
        subcommand !== 'set' &&
        subcommand !== 'show'
      ) {
        throw scopeInvalid('Usage: db:scope <link|unlink|set|show>');
      }
      const args = parseScopeArgs(subcommand, process.argv.slice(4));
      const pool = new Pool({ connectionString: required('DB_OWNER_URL') });
      try {
        await runScopeCommand(pool, args);
      } finally {
        await pool.end();
      }
      return;
    }
    default:
      throw new Error('Usage: cli.ts <bootstrap|migrate|seed|provision|invite|scope>');
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
