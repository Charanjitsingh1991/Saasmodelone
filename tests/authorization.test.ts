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

const ALL_PERMISSIONS = ['people.read', 'people.write', 'work.read', 'work.write'];

const ROLE_MATRIX: Record<MembershipRole, string[]> = {
  owner: ALL_PERMISSIONS,
  admin: ALL_PERMISSIONS,
  hr: ['people.read', 'people.write'],
  finance: ['people.read', 'work.read'],
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

  test('publishes the two module operations and the four M0 permissions', () => {
    expect(MODULE_OPERATIONS).toEqual(['read', 'write']);
    expect(PERMISSIONS).toEqual(ALL_PERMISSIONS);
    expect(new Set(PERMISSIONS).size).toBe(PERMISSIONS.length);
  });

  test.each(MEMBERSHIP_ROLES)('%s receives exactly its M0 permissions in order', (role) => {
    expect(permissionsForRole(role)).toEqual(ROLE_MATRIX[role]);
    expect(new Set(permissionsForRole(role)).size).toBe(permissionsForRole(role).length);
  });

  test('owner and admin hold every M0 permission', () => {
    expect(permissionsForRole('owner')).toEqual(ALL_PERMISSIONS);
    expect(permissionsForRole('admin')).toEqual(ALL_PERMISSIONS);
  });

  test('employee is intentionally permissionless until self-scope exists', () => {
    expect(permissionsForRole('employee')).toEqual([]);
    expect(hasPermission('employee', 'people.read')).toBe(false);
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
