export const MEMBERSHIP_ROLES = [
  'owner',
  'admin',
  'hr',
  'finance',
  'manager',
  'employee',
  'auditor',
] as const;

export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];

export const MODULE_OPERATIONS = ['read', 'write'] as const;

export type ModuleOperation = (typeof MODULE_OPERATIONS)[number];

export const PERMISSIONS = [
  'people.read',
  'people.write',
  'work.read',
  'work.write',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

// M0 covers the two gated modules only. Employee is intentionally empty:
// self-scope needs a person-to-user link and is deferred to M1.
const ROLE_PERMISSIONS = {
  owner: ['people.read', 'people.write', 'work.read', 'work.write'],
  admin: ['people.read', 'people.write', 'work.read', 'work.write'],
  hr: ['people.read', 'people.write'],
  finance: ['people.read', 'work.read'],
  manager: ['people.read', 'work.read', 'work.write'],
  employee: [],
  auditor: ['people.read', 'work.read'],
} satisfies Record<MembershipRole, readonly Permission[]>;

function isMembershipRole(value: string): value is MembershipRole {
  return (MEMBERSHIP_ROLES as readonly string[]).includes(value);
}

function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value);
}

export function permissionsForRole(role: MembershipRole | string): Permission[] {
  if (!isMembershipRole(role)) {
    return [];
  }
  const allowed: readonly Permission[] = ROLE_PERMISSIONS[role];
  return PERMISSIONS.filter((permission) => allowed.includes(permission));
}

export function hasPermission(
  role: MembershipRole | string,
  permission: Permission | string,
): boolean {
  if (!isPermission(permission)) {
    return false;
  }
  return permissionsForRole(role).includes(permission);
}

export function permissionFor(
  module: string,
  operation: ModuleOperation | string,
): Permission | null {
  const candidate = `${module}.${operation}`;
  return isPermission(candidate) ? candidate : null;
}
