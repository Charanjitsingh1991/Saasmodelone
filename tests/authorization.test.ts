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
// question the People module asks, not a variant of either.
const ALL_PERMISSIONS = [
  'people.read',
  'people.write',
  'people.compensation.read',
  'work.read',
  'work.write',
];

const COMPENSATION_READ = 'people.compensation.read';

const ROLE_MATRIX: Record<MembershipRole, string[]> = {
  owner: ALL_PERMISSIONS,
  admin: ALL_PERMISSIONS,
  hr: ['people.read', 'people.write', COMPENSATION_READ],
  finance: ['people.read', COMPENSATION_READ, 'work.read'],
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

  test('publishes the two module operations and the five published permissions', () => {
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
    // Reading pay is the compensation permission in this milestone. Writing it
    // does not exist yet, and no role holds a name for it.
    expect(PERMISSIONS).not.toContain('people.compensation.write');
  });

  test('permissionFor never answers with the compensation permission', () => {
    // The module still has only read and write, so people.compensation.read is
    // reachable only when a gate states it. An empty or read-only People gate can
    // never widen into salary history by accident.
    expect(permissionFor('people', 'read')).not.toBe(COMPENSATION_READ);
    expect(permissionFor('people', 'write')).not.toBe(COMPENSATION_READ);
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
