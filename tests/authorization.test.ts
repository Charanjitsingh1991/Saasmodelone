import { describe, expect, test } from 'vitest';
import {
  hasPermission,
  MEMBERSHIP_ROLES,
  MODULE_OPERATIONS,
  PERMISSIONS,
  permissionFor,
  permissionsForRole,
  type MembershipRole,
} from '@saasmodels/contracts';

// In PERMISSIONS order, which is the order /v1/context answers in. Salary
// history comes after both People directory permissions because it is a third
// question the People module asks, not a variant of either, and its write half
// sits beside the read it belongs to.
const ALL_PERMISSIONS = [
  'people.read',
  'people.write',
  'people.compensation.read',
  'people.compensation.write',
  'work.read',
  'work.write',
];

const COMPENSATION_READ = 'people.compensation.read';
const COMPENSATION_WRITE = 'people.compensation.write';

const ROLE_MATRIX: Record<MembershipRole, string[]> = {
  owner: ALL_PERMISSIONS,
  admin: ALL_PERMISSIONS,
  hr: ['people.read', 'people.write', COMPENSATION_READ, COMPENSATION_WRITE],
  finance: ['people.read', COMPENSATION_READ, COMPENSATION_WRITE, 'work.read'],
  manager: ['people.read', 'work.read', 'work.write'],
  employee: [],
  auditor: ['people.read', 'work.read'],
};

describe('authorization policy', () => {
  test('publishes exactly the seven membership roles in canonical order', () => {
    expect(MEMBERSHIP_ROLES).toEqual([
      'owner',
      'admin',
      'hr',
      'finance',
      'manager',
      'employee',
      'auditor',
    ]);
    expect(new Set(MEMBERSHIP_ROLES).size).toBe(7);
  });

  test('publishes the two module operations and the six published permissions', () => {
    expect(MODULE_OPERATIONS).toEqual(['read', 'write']);
    expect(PERMISSIONS).toEqual(ALL_PERMISSIONS);
    expect(new Set(PERMISSIONS).size).toBe(PERMISSIONS.length);
  });

  test.each(MEMBERSHIP_ROLES)('%s receives exactly its published permissions in order', (role) => {
    expect(permissionsForRole(role)).toEqual(ROLE_MATRIX[role]);
    expect(new Set(permissionsForRole(role)).size).toBe(permissionsForRole(role).length);
  });

  test('owner and admin hold every published permission', () => {
    expect(permissionsForRole('owner')).toEqual(ALL_PERMISSIONS);
    expect(permissionsForRole('admin')).toEqual(ALL_PERMISSIONS);
  });

  test('employee is intentionally permissionless until self-scope exists', () => {
    expect(permissionsForRole('employee')).toEqual([]);
    expect(hasPermission('employee', 'people.read')).toBe(false);
  });

  test('gives salary history to the four paying roles and to nobody else', () => {
    // people.compensation.read is its own question, so a role can hold the
    // directory read and still be refused the pay column. The auditor exclusion
    // is a policy choice, not a capability limit: it is recorded as a residual in
    // suite/docs/security/m0-threat-model.md and asked as review question 14.
    for (const role of ['owner', 'admin', 'hr', 'finance'] as const) {
      expect(hasPermission(role, COMPENSATION_READ)).toBe(true);
      expect(permissionsForRole(role)).toContain(COMPENSATION_READ);
    }
    for (const role of ['manager', 'employee', 'auditor'] as const) {
      expect(hasPermission(role, COMPENSATION_READ)).toBe(false);
      expect(permissionsForRole(role)).not.toContain(COMPENSATION_READ);
    }
  });

  test('gives the compensation write to the four paying roles and to nobody else', () => {
    // The write half is a separate name, so a role that may list salaries is not
    // thereby allowed to change one. The same four roles hold both, for the same
    // reason: they are the roles that administer pay.
    for (const role of ['owner', 'admin', 'hr', 'finance'] as const) {
      expect(hasPermission(role, COMPENSATION_WRITE)).toBe(true);
      expect(permissionsForRole(role)).toContain(COMPENSATION_WRITE);
    }
    for (const role of ['manager', 'employee', 'auditor'] as const) {
      expect(hasPermission(role, COMPENSATION_WRITE)).toBe(false);
      expect(permissionsForRole(role)).not.toContain(COMPENSATION_WRITE);
    }

    // Finance is the grant that only makes sense on a separate axis: it may put a
    // figure on a colleague's pay row and may not touch that colleague's name or
    // placement. Reading the directory is the shared half; writing the directory
    // is not.
    expect(hasPermission('finance', COMPENSATION_WRITE)).toBe(true);
    expect(hasPermission('finance', 'people.write')).toBe(false);

    // HR holds both writes, because it maintains the person and the pay.
    expect(hasPermission('hr', 'people.write')).toBe(true);
    expect(hasPermission('hr', COMPENSATION_WRITE)).toBe(true);

    // The write never implies the read, either: no role holds one compensation
    // permission without the other, and the matrix would have to change for that
    // to become possible.
    for (const role of MEMBERSHIP_ROLES) {
      const held = permissionsForRole(role);
      expect(held.includes(COMPENSATION_WRITE)).toBe(held.includes(COMPENSATION_READ));
    }
  });

  test('permissionFor never answers with either compensation permission', () => {
    // The module still has only read and write, so neither compensation name is
    // reachable except when a gate states it. An empty or read-only People gate
    // can never widen into salary history, or into a salary write, by accident.
    for (const operation of MODULE_OPERATIONS) {
      expect(permissionFor('people', operation)).not.toBe(COMPENSATION_READ);
      expect(permissionFor('people', operation)).not.toBe(COMPENSATION_WRITE);
    }
  });

  test('hasPermission allows only a policy grant and fails closed', () => {
    expect(hasPermission('owner', 'people.write')).toBe(true);
    expect(hasPermission('manager', 'work.write')).toBe(true);
    expect(hasPermission('auditor', 'work.read')).toBe(true);
    expect(hasPermission('auditor', 'work.write')).toBe(false);
    expect(hasPermission('finance', 'people.write')).toBe(false);
    expect(hasPermission('superuser', 'people.read')).toBe(false);
    expect(hasPermission('owner', 'payroll.read')).toBe(false);
    expect(permissionsForRole('superuser')).toEqual([]);
  });

  test('permissionFor maps only known module and operation pairs', () => {
    expect(permissionFor('people', 'read')).toBe('people.read');
    expect(permissionFor('people', 'write')).toBe('people.write');
    expect(permissionFor('work', 'read')).toBe('work.read');
    expect(permissionFor('work', 'write')).toBe('work.write');
    expect(permissionFor('payroll', 'read')).toBeNull();
    expect(permissionFor('people', 'delete')).toBeNull();
  });
});
