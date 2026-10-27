import type {
  ContextModule,
  ContextResponse,
  MembershipRole,
} from '@saasmodels/contracts';

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

// Money is stored as a bigint count of minor units, and the compensation table
// records no decimal exponent, so this renders two fractional digits for every
// currency. That is a display convention, not a conversion: the figure is the
// stored value, nothing is annualised, prorated or relabelled, and a currency
// whose minor unit is not a hundredth would be misread - which is why the value
// stays next to its own currency code instead of being called a salary period.
// Grouping is done here rather than with Intl.NumberFormat so the separators do
// not depend on the locale data of whichever machine renders it.
export function formatCompensationAmount(
  minorUnits: number,
  currency: string,
): string {
  const whole = Math.floor(minorUnits / 100);
  const fraction = minorUnits % 100;
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${grouped}.${String(fraction).padStart(2, '0')} ${currency}`;
}

export function accessLabel(module: ContextModule): string {
  return module.canWrite ? 'Read and write' : 'Read only';
}

export function availableModuleNames(context: ContextResponse): string[] {
  return orderModules(context.modules).map((module) => module.name);
}
