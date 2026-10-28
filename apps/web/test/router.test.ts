import { describe, expect, test } from 'vitest';
import { parseRoute, routeTitle } from '../src/lib/router';

describe('history routes', () => {
  test('maps the seven supported routes and accepts a trailing slash', () => {
    expect(parseRoute('/login')).toEqual({ name: 'login' });
    expect(parseRoute('/login/')).toEqual({ name: 'login' });
    expect(parseRoute('/app')).toEqual({ name: 'home' });
    expect(parseRoute('/app/')).toEqual({ name: 'home' });
    expect(parseRoute('/app/people')).toEqual({ name: 'people' });
    expect(parseRoute('/app/people/')).toEqual({ name: 'people' });
    expect(parseRoute('/app/crm')).toEqual({ name: 'crm' });
    expect(parseRoute('/app/crm/')).toEqual({ name: 'crm' });
    expect(parseRoute('/app/work')).toEqual({ name: 'work' });
    expect(parseRoute('/app/work/')).toEqual({ name: 'work' });
    expect(parseRoute('/app/money')).toEqual({ name: 'money' });
    expect(parseRoute('/app/money/')).toEqual({ name: 'money' });
    expect(parseRoute('/app/content')).toEqual({ name: 'content' });
    expect(parseRoute('/app/content/')).toEqual({ name: 'content' });
  });

  test('does not treat arbitrary paths as module screens', () => {
    expect(parseRoute('/app/projects')).toEqual({
      name: 'not-found',
      path: '/app/projects',
    });
    expect(parseRoute('/app/people/1')).toEqual({
      name: 'not-found',
      path: '/app/people/1',
    });
  });

  test('gives every route a document title', () => {
    expect(routeTitle({ name: 'login' })).toContain('Sign in');
    expect(routeTitle({ name: 'home' })).toContain('Workspace');
    expect(routeTitle({ name: 'people' })).toContain('People');
    expect(routeTitle({ name: 'work' })).toContain('Work');
    expect(routeTitle({ name: 'money' })).toContain('Money');
    expect(routeTitle({ name: 'content' })).toContain('Content');
    expect(routeTitle({ name: 'not-found', path: '/x' })).toContain('Not found');
  });
});
