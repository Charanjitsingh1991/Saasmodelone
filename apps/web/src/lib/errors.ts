export type LoginFailureKind = 'invalid' | 'rate-limited' | 'network' | 'unknown';

export type LoginFailure = {
  kind: LoginFailureKind;
  message: string;
};

export const LOGIN_GENERIC_MESSAGE =
  'Email, password or workspace is incorrect.';

export function loginFailure(status: number | null): LoginFailure {
  if (status === null) {
    return {
      kind: 'network',
      message:
        'We could not reach the server. Check your connection and try again.',
    };
  }
  if (status === 401) {
    return { kind: 'invalid', message: LOGIN_GENERIC_MESSAGE };
  }
  if (status === 429) {
    return {
      kind: 'rate-limited',
      message: 'Too many sign-in attempts. Wait a few minutes, then try again.',
    };
  }
  return {
    kind: 'unknown',
    message: 'Sign-in is unavailable right now. Try again.',
  };
}
