import { describe, expect, test } from 'vitest';
import { parseRoute, routeTitle } from '../src/lib/router';

describe('history routes', () => {
  test('maps the three supported routes and accepts a trailing slash', () => {
    expect(parseRoute('/login')).toEqual({ name: 'login' });
    expect(parseRoute('/login/')).toEqual({ name: 'login' });
    expect(parseRoute('/app')).toEqual({ name: 'home' });
    expect(parseRoute('/app/')).toEqual({ name: 'home' });
    expect(parseRoute('/app/people')).toEqual({ name: 'people' });
    expect(parseRoute('/app/people/')).toEqual({ name: 'people' });
  });

  test('does not treat arbitrary paths as module screens', () => {
    expect(parseRoute('/app/work')).toEqual({
      name: 'not-found',
      path: '/app/work',
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
    expect(routeTitle({ name: 'not-found', path: '/x' })).toContain('Not found');
  });
});
