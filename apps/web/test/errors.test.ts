import { describe, expect, test } from 'vitest';
import {
  LOGIN_GENERIC_MESSAGE,
  loginFailure,
} from '../src/lib/errors';

describe('login failure mapping', () => {
  test('401 uses one generic message that does not reveal which field failed', () => {
    expect(loginFailure(401)).toEqual({
      kind: 'invalid',
      message: LOGIN_GENERIC_MESSAGE,
    });
    expect(LOGIN_GENERIC_MESSAGE).toBe(
      'Email, password or workspace is incorrect.',
    );
  });

  test('429 has a distinct rate-limit message', () => {
    const failure = loginFailure(429);
    expect(failure.kind).toBe('rate-limited');
    expect(failure.message).not.toBe(LOGIN_GENERIC_MESSAGE);
    expect(failure.message).toMatch(/too many sign-in attempts/i);
  });

  test('a transport failure is a retryable network state', () => {
    const failure = loginFailure(null);
    expect(failure.kind).toBe('network');
    expect(failure.message).toMatch(/could not reach the server/i);
  });

  test('other statuses fall back without claiming invalid credentials', () => {
    expect(loginFailure(500).kind).toBe('unknown');
    expect(loginFailure(400).message).not.toBe(LOGIN_GENERIC_MESSAGE);
  });
});
