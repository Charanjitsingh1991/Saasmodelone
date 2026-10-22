import { describe, expect, test } from 'vitest';
import type { ContextModule, ContextResponse } from '@saasmodels/contracts';
import {
  accessLabel,
  availableModuleNames,
  canReadPeople,
  findModule,
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

function context(modules: ContextModule[]): ContextResponse {
  return {
    userId: 'user-1',
    tenantId: 'tenant-1',
    role: 'owner',
    permissions: ['people.read', 'people.write'],
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
});
