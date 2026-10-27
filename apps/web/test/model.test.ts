import { describe, expect, test } from 'vitest';
import type {
  ContextModule,
  ContextResponse,
  Permission,
} from '@saasmodels/contracts';
import {
  accessLabel,
  availableModuleNames,
  canReadCompensation,
  canReadPeople,
  canWriteCompensation,
  findModule,
  formatCompensationAmount,
  navigationModules,
  orderModules,
  roleLabel,
} from '../src/lib/model';

function module(
  code: string,
  sortOrder: number,
  canRead = true,
  canWrite = true,
): ContextModule {
  return { code, name: code.replace(/^./, (letter) => letter.toUpperCase()), sortOrder, canRead, canWrite };
}

// The owner array /v1/context answers with today, so this fixture cannot drift
// into claiming a screen may show something the server would refuse.
const OWNER_PERMISSIONS: Permission[] = [
  'people.read',
  'people.write',
  'people.compensation.read',
  'people.compensation.write',
  'work.read',
  'work.write',
];

function context(modules: ContextModule[], permissions = OWNER_PERMISSIONS): ContextResponse {
  return {
    userId: 'user-1',
    tenantId: 'tenant-1',
    role: 'owner',
    permissions,
    switchAccess: true,
    modules,
  };
}

describe('module presentation', () => {
  test('orders modules by catalog sort order, then code, without mutating input', () => {
    const input = [module('work', 30), module('people', 10), module('assets', 70)];
    const ordered = orderModules(input);

    expect(ordered.map((entry) => entry.code)).toEqual([
      'people',
      'work',
      'assets',
    ]);
    expect(input.map((entry) => entry.code)).toEqual(['work', 'people', 'assets']);
  });

  test('breaks equal sort orders by code', () => {
    expect(
      orderModules([module('work', 10), module('people', 10)]).map(
        (entry) => entry.code,
      ),
    ).toEqual(['people', 'work']);
  });

  test('navigation keeps only modules with a read or write capability', () => {
    const ordered = navigationModules(
      context([
        module('work', 30),
        module('people', 10),
        module('money', 40, false, false),
      ]),
    );

    expect(ordered.map((entry) => entry.code)).toEqual(['people', 'work']);
  });

  test('People is readable only when the effective People module grants read', () => {
    expect(canReadPeople(context([module('people', 10)]))).toBe(true);
    expect(canReadPeople(context([module('people', 10, false, true)]))).toBe(false);
    expect(canReadPeople(context([module('work', 30)]))).toBe(false);
    expect(canReadPeople(context([]))).toBe(false);
  });

  test('labels the read and write badge from the effective module', () => {
    expect(accessLabel(module('people', 10, true, true))).toBe('Read and write');
    expect(accessLabel(module('people', 10, true, false))).toBe('Read only');
  });

  test('labels known roles and falls back for an unknown role string', () => {
    expect(roleLabel('owner')).toBe('Owner');
    expect(roleLabel('hr')).toBe('People lead');
    expect(roleLabel('auditor')).toBe('Auditor');
    expect(roleLabel('contractor')).toBe('Member');
  });

  test('lists available module names in catalog order for the access state', () => {
    expect(
      availableModuleNames(
        context([module('work', 30), module('people', 10)]),
      ),
    ).toEqual(['People', 'Work']);
    expect(findModule(context([module('work', 30)]), 'people')).toBeUndefined();
  });

  test('offers salary history only to a context holding its own permission', () => {
    expect(canReadCompensation(context([module('people', 10)]))).toBe(true);
    // The directory read and the module's own read flag are not the pay
    // permission: a manager sees colleagues and their employment, not their cost.
    expect(
      canReadCompensation(
        context([module('people', 10)], ['people.read', 'work.read', 'work.write']),
      ),
    ).toBe(false);
    expect(canReadCompensation(context([module('people', 10)], []))).toBe(false);
  });

  test('offers the salary write only to a context holding the write permission', () => {
    expect(canWriteCompensation(context([module('people', 10)]))).toBe(true);

    // The read is not the write: a member who may list pay sees the panel closed.
    expect(
      canWriteCompensation(
        context([module('people', 10)], ['people.read', 'people.compensation.read']),
      ),
    ).toBe(false);

    // And the directory write is not the pay write either. This is the finance
    // shape seen from the other side: a role can hold the pay write without ever
    // being allowed to rename a colleague.
    expect(
      canWriteCompensation(context([module('people', 10)], ['people.write'])),
    ).toBe(false);
    expect(
      canWriteCompensation(
        context([module('people', 10, false, false)], [
          'people.compensation.read',
          'people.compensation.write',
        ]),
      ),
    ).toBe(true);

    expect(canWriteCompensation(context([module('people', 10)], []))).toBe(false);

    // Hiding the control is presentation, not authorization, and the two helpers
    // stay independent questions: on a read-only pay context the panel opens and
    // no write control is offered.
    const readOnlyPay = context([module('people', 10)], ['people.compensation.read']);
    expect(canReadCompensation(readOnlyPay)).toBe(true);
    expect(canWriteCompensation(readOnlyPay)).toBe(false);
  });

  test('renders a stored amount as its own minor units and currency, unchanged', () => {
    // Two fractional digits because the table records no decimal exponent, and
    // nothing else: no annualising, no prorating, no period label.
    expect(formatCompensationAmount(1234567, 'INR')).toBe('12,345.67 INR');
    expect(formatCompensationAmount(0, 'USD')).toBe('0.00 USD');
    expect(formatCompensationAmount(5, 'USD')).toBe('0.05 USD');
    expect(formatCompensationAmount(100, 'EUR')).toBe('1.00 EUR');
    expect(formatCompensationAmount(1234567890123, 'ZZZ')).toBe(
      '12,345,678,901.23 ZZZ',
    );
  });
});
