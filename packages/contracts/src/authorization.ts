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

// Compensation is its own permission rather than a facet of people.read, because
// the directory read and a salary read are different disclosures: a member who
// may list colleagues is not thereby entitled to see what they cost. It is
// read-only here by design - people.compensation.write arrives with the write slice.
export const PERMISSIONS = [
  'people.read',
  'people.write',
  'people.compensation.read',
  'work.read',
  'work.write',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

// M0 covers the two gated modules only. Employee is intentionally empty:
// self-scope needs a person-to-user link and is deferred to M1.
//
// Compensation reads belong to the four roles that maintain or pay people. An
// auditor holds people.read and deliberately does not hold this permission: an
// audit role is built for aggregates and reconciliation, not for reading named
// colleagues' salaries, and nothing about the role's capability makes the rows
// necessary. That exclusion is a policy choice and is recorded as a residual in
// the threat model with a review question attached.
const ROLE_PERMISSIONS = {
  owner: [
    'people.read',
    'people.write',
    'people.compensation.read',
    'work.read',
    'work.write',
  ],
  admin: [
    'people.read',
    'people.write',
    'people.compensation.read',
    'work.read',
    'work.write',
  ],
  hr: ['people.read', 'people.write', 'people.compensation.read'],
  finance: ['people.read', 'people.compensation.read', 'work.read'],
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
