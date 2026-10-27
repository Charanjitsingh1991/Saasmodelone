import type {
  ContextResponse,
  CompensationListResponse,
  EmploymentCreateInput,
  EmploymentItem,
  EmploymentListResponse,
  EmploymentUpdateInput,
  PeopleCreateInput,
  PeopleListItem,
  PeopleListResponse,
  PeoplePlacementInput,
  PeoplePlacementOptions,
  PeopleUpdateInput,
  SessionResponse,
} from '@saasmodels/contracts';

export type LoginInput = {
  tenantSlug: string;
  email: string;
  password: string;
};

export type PeopleListInput = {
  q?: string;
  page?: number;
  pageSize?: number;
};

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; code: string | null };

type ErrorBody = {
  error?: { code?: unknown };
};

// The CSRF token is authorization state for logout. It lives only in module
// memory and is never written to localStorage, sessionStorage or a URL.
let csrfToken: string | null = null;
let onUnauthorized: (() => void) | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

export function setUnauthorizedListener(listener: (() => void) | null): void {
  onUnauthorized = listener;
}

function errorCode(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const candidate = (body as ErrorBody).error?.code;
  return typeof candidate === 'string' ? candidate : null;
}

async function request<T>(
  path: string,
  init: RequestInit = {},
): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(path, {
      credentials: 'same-origin',
      ...init,
      headers: {
        accept: 'application/json',
        ...(init.headers ?? {}),
      },
    });
  } catch {
    return { ok: false, status: 0, code: 'NETWORK' };
  }

  let body: unknown = null;
  if (response.status !== 204) {
    try {
      body = await response.json();
    } catch {
      body = null;
    }
  }

  if (response.status === 401 && path !== '/v1/auth/login') {
    onUnauthorized?.();
  }

  if (!response.ok) {
    return { ok: false, status: response.status, code: errorCode(body) };
  }
  return { ok: true, data: body as T };
}

// A write needs both halves: a JSON body and the in-memory CSRF token. The API
// refuses either one alone, so no caller can send a "simple" cross-site request.
function writeHeaders(): Record<string, string> {
  return {
    'content-type': 'application/json',
    ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
  };
}

export const api = {
  session: () => request<SessionResponse>('/v1/auth/session'),

  context: () => request<ContextResponse>('/v1/context'),

  people: (input: PeopleListInput = {}) => {
    const params = new URLSearchParams();
    const term = input.q?.trim();
    if (term) {
      params.set('q', term);
    }
    if (input.page !== undefined) {
      params.set('page', String(input.page));
    }
    if (input.pageSize !== undefined) {
      params.set('pageSize', String(input.pageSize));
    }
    const query = params.toString();
    return request<PeopleListResponse>(
      query === '' ? '/v1/people' : `/v1/people?${query}`,
    );
  },

  createPerson: (input: PeopleCreateInput) =>
    request<PeopleListItem>('/v1/people', {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify(input),
    }),

  updatePerson: (id: string, input: PeopleUpdateInput) =>
    request<PeopleListItem>(`/v1/people/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: writeHeaders(),
      body: JSON.stringify(input),
    }),

  // The placement choice list. A GET, so no CSRF header; the server gates it on
  // people.write and filters every row by the member's own scope.
  placementOptions: () =>
    request<PeoplePlacementOptions>('/v1/people/placement-options'),

  updatePlacement: (id: string, input: PeoplePlacementInput) =>
    request<PeopleListItem>(`/v1/people/${encodeURIComponent(id)}/placement`, {
      method: 'PATCH',
      headers: writeHeaders(),
      body: JSON.stringify(input),
    }),

  // One person's employment history. A GET, so no CSRF header; the server gates
  // it on people.read and every row is narrowed by this member's own scope.
  employments: (id: string) =>
    request<EmploymentListResponse>(
      `/v1/people/${encodeURIComponent(id)}/employments`,
    ),

  // The legal entity is not sent: the server takes it from the person's current
  // placement, so a client cannot name an entity it was never offered.
  createEmployment: (id: string, input: EmploymentCreateInput) =>
    request<EmploymentItem>(`/v1/people/${encodeURIComponent(id)}/employments`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify(input),
    }),

  updateEmployment: (
    id: string,
    employmentId: string,
    input: EmploymentUpdateInput,
  ) =>
    request<EmploymentItem>(
      `/v1/people/${encodeURIComponent(id)}/employments/${encodeURIComponent(employmentId)}`,
      {
        method: 'PATCH',
        headers: writeHeaders(),
        body: JSON.stringify(input),
      },
    ),

  // One person's compensation history. A GET, so no CSRF header. This is the
  // only compensation call the client has: no route writes salary yet, so the
  // screen can offer no add, edit or save. The server gates it on
  // people.compensation.read - a stricter test than the directory's people.read -
  // and narrows every row by this member's own scope.
  compensations: (id: string) =>
    request<CompensationListResponse>(
      `/v1/people/${encodeURIComponent(id)}/compensations`,
    ),

  login: (input: LoginInput) =>
    request<SessionResponse>('/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }),

  logout: () =>
    request<null>('/v1/auth/logout', {
      method: 'POST',
      headers: csrfToken ? { 'x-csrf-token': csrfToken } : {},
    }),
};
