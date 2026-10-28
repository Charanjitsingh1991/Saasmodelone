import type {
  ContextModule,
  ContextResponse,
  MembershipRole,
} from '@saasmodels/contracts';
import { formatMinorAmount } from './money.js';
import { moduleScreenPath } from './router.js';

const ROLE_LABELS: Record<MembershipRole, string> = {
  owner: 'Owner',
  admin: 'Administrator',
  hr: 'People lead',
  finance: 'Finance',
  manager: 'Manager',
  employee: 'Employee',
  auditor: 'Auditor',
};

export function roleLabel(role: string): string {
  return ROLE_LABELS[role as MembershipRole] ?? 'Member';
}

export function orderModules(modules: readonly ContextModule[]): ContextModule[] {
  return [...modules].sort(
    (left, right) =>
      left.sortOrder - right.sortOrder || left.code.localeCompare(right.code),
  );
}

export function navigationModules(context: ContextResponse): ContextModule[] {
  return orderModules(context.modules).filter(
    (module) => module.canRead || module.canWrite,
  );
}

export function findModule(
  context: ContextResponse,
  code: string,
): ContextModule | undefined {
  return context.modules.find((module) => module.code === code);
}

export function canReadPeople(context: ContextResponse): boolean {
  return findModule(context, 'people')?.canRead === true;
}

// Compensation has a permission of its own because salary history is a stricter
// read than the directory: people.read says a member may list colleagues, not
// that they may see what each costs. The API re-checks it on every call, so this
// decides only whether the screen offers the action at all.
export function canReadCompensation(context: ContextResponse): boolean {
  return context.permissions.includes('people.compensation.read');
}

// The write half of the same axis, and deliberately not a test of the
// directory's write: finance administers pay without being allowed to rename a
// colleague, so this asks only for people.compensation.write. Hiding the control
// is presentation, never authorization - the route checks the permission, the
// module entitlement and the member's scope over the person again.
export function canWriteCompensation(context: ContextResponse): boolean {
  return context.permissions.includes('people.compensation.write');
}

// The salary history renders a stored amount, and so does every other money
// column in the product. There is one implementation of that convention:
// formatMinorAmount in lib/money. This stays as the name the directory panel
// already uses.
export function formatCompensationAmount(
  minorUnits: number,
  currency: string,
): string {
  return formatMinorAmount(minorUnits, currency);
}

// A module is readable when the server's own context says so. The screen asks
// the same question for every module it can show, so a module without a read
// is never offered a screen that the API would refuse.
export function canReadModule(context: ContextResponse, code: string): boolean {
  return findModule(context, code)?.canRead === true;
}

// The landing rule: the first navigation module, in catalog order, that has a
// screen. A module without a screen cannot be a landing page, so a member whose
// only module is Work lands on the Work screen rather than on a home page that
// only lists modules. A member with no module that has a screen lands on the
// home page, which is where the module roster is.
export function landingPath(context: ContextResponse): string {
  for (const module of navigationModules(context)) {
    const path = moduleScreenPath(module.code);
    if (path) {
      return path;
    }
  }
  return '/app';
}

export function accessLabel(module: ContextModule): string {
  return module.canWrite ? 'Read and write' : 'Read only';
}

export function availableModuleNames(context: ContextResponse): string[] {
  return orderModules(context.modules).map((module) => module.name);
}
