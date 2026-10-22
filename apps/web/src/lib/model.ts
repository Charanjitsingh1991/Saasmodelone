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

export function accessLabel(module: ContextModule): string {
  return module.canWrite ? 'Read and write' : 'Read only';
}

export function availableModuleNames(context: ContextResponse): string[] {
  return orderModules(context.modules).map((module) => module.name);
}
