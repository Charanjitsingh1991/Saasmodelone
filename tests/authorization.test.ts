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
// sits beside the read it belongs to. The two CRM permissions follow the four
// People ones because CRM is the second module in the catalog order. The three
// module reads come last, one per module that has a shipped read surface.
const ALL_PERMISSIONS = [
  'people.read',
  'people.write',
  'people.compensation.read',
  'people.compensation.write',
  'crm.read',
  'crm.write',
  'work.read',
  'money.read',
  'content.read',
];

const COMPENSATION_READ = 'people.compensation.read';
const COMPENSATION_WRITE = 'people.compensation.write';

const ROLE_MATRIX: Record<MembershipRole, string[]> = {
  owner: ALL_PERMISSIONS,
  admin: ALL_PERMISSIONS,
  hr: ['people.read', 'people.write', COMPENSATION_READ, COMPENSATION_WRITE],
  finance: [
    'people.read',
    COMPENSATION_READ,
    COMPENSATION_WRITE,
    'crm.read',
    'work.read',
    'money.read',
  ],
  manager: ['people.read', 'crm.read', 'work.read'],
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

  test('publishes the two module operations and the nine published permissions', () => {
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
    expect(hasPermission('manager', 'work.read')).toBe(true);
    expect(hasPermission('auditor', 'work.read')).toBe(true);
    expect(hasPermission('auditor', 'work.write')).toBe(false);
    expect(hasPermission('finance', 'people.write')).toBe(false);
    expect(hasPermission('superuser', 'people.read')).toBe(false);
    expect(hasPermission('owner', 'payroll.read')).toBe(false);
    expect(permissionsForRole('superuser')).toEqual([]);
  });

  test('withdraws work.write and publishes no write for the three new modules', () => {
    // work.write was withdrawn on 27 October 2026. It was the only published
    // permission no route asked for, and while it stayed published /v1/context
    // answered canWrite = true for Work: a capability the product cannot
    // perform. permissionFor derives from PERMISSIONS, so the withdrawal is
    // visible in the context answer without any change to the route that asks.
    expect(PERMISSIONS).not.toContain('work.write');
    expect(permissionFor('work', 'write')).toBeNull();
    expect(hasPermission('manager', 'work.write')).toBe(false);
    expect(hasPermission('owner', 'work.write')).toBe(false);
    expect(hasPermission('admin', 'work.write')).toBe(false);

    // No write surface ships in Work, Money or Content, so none of them
    // publishes a write permission either.
    expect(permissionFor('money', 'write')).toBeNull();
    expect(permissionFor('content', 'write')).toBeNull();
  });

  test('gives the three module reads to the roles that need them', () => {
    // Finance reads money because invoices are what it reconciles. Manager and
    // auditor read work because projects are what they are staffed and reviewed
    // against. The auditor exclusion from money.read and content.read is an
    // accepted residual recorded in the threat model, with a review question
    // attached, and the map is a deliberately minimal first cut.
    for (const role of ['owner', 'admin', 'finance'] as const) {
      expect(hasPermission(role, 'money.read')).toBe(true);
    }
    for (const role of ['hr', 'manager', 'employee', 'auditor'] as const) {
      expect(hasPermission(role, 'money.read')).toBe(false);
    }

    for (const role of ['owner', 'admin'] as const) {
      expect(hasPermission(role, 'content.read')).toBe(true);
    }
    for (const role of ['hr', 'finance', 'manager', 'employee', 'auditor'] as const) {
      expect(hasPermission(role, 'content.read')).toBe(false);
    }

    for (const role of ['owner', 'admin', 'finance', 'manager', 'auditor'] as const) {
      expect(hasPermission(role, 'work.read')).toBe(true);
    }
    for (const role of ['hr', 'employee'] as const) {
      expect(hasPermission(role, 'work.read')).toBe(false);
    }
  });

  test('gives the CRM read to four roles and the CRM write to two', () => {
    // The standalone-CRM thesis: a member whose only module is CRM still has
    // to be able to read accounts, so the read cannot depend on holding a
    // People permission.
    for (const role of ['owner', 'admin', 'finance', 'manager'] as const) {
      expect(hasPermission(role, 'crm.read')).toBe(true);
    }
    for (const role of ['hr', 'employee', 'auditor'] as const) {
      expect(hasPermission(role, 'crm.read')).toBe(false);
    }

    // The write is an administrative act on a commercial record, so only the
    // two roles that administer the workspace hold it. A manager and a finance
    // member read accounts to work against them; neither renames one.
    for (const role of ['owner', 'admin'] as const) {
      expect(hasPermission(role, 'crm.write')).toBe(true);
    }
    for (const role of ['hr', 'finance', 'manager', 'employee', 'auditor'] as const) {
      expect(hasPermission(role, 'crm.write')).toBe(false);
    }
  });

  test('permissionFor maps only known module and operation pairs', () => {
    expect(permissionFor('people', 'read')).toBe('people.read');
    expect(permissionFor('people', 'write')).toBe('people.write');
    expect(permissionFor('crm', 'read')).toBe('crm.read');
    expect(permissionFor('crm', 'write')).toBe('crm.write');
    expect(permissionFor('work', 'read')).toBe('work.read');
    expect(permissionFor('money', 'read')).toBe('money.read');
    expect(permissionFor('content', 'read')).toBe('content.read');
    expect(permissionFor('payroll', 'read')).toBeNull();
    expect(permissionFor('people', 'delete')).toBeNull();
  });
});
