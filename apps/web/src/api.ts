import type {
  ContextResponse,
  CompensationCreateInput,
  CompensationItem,
  CompensationListResponse,
  CompensationUpdateInput,
  ContentListInput,
  ContentListResponse,
  CrmAccountCreateInput,
  CrmAccountListInput,
  CrmAccountListItem,
  CrmAccountListResponse,
  CrmAccountUpdateInput,
  CrmContactCreateInput,
  CrmContactItem,
  CrmContactListResponse,
  CrmContactUpdateInput,
  EmploymentCreateInput,
  EmploymentItem,
  EmploymentListResponse,
  EmploymentUpdateInput,
  InvoiceListInput,
  InvoiceListResponse,
  PeopleCreateInput,
  PeopleListItem,
  PeopleListResponse,
  PeoplePlacementInput,
  PeoplePlacementOptions,
  PeopleUpdateInput,
  ProjectListInput,
  ProjectListResponse,
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

// The query string every list route takes: a search term, a page and a page
// size. One builder for all five list surfaces, so the directory and the four
// module screens ask for exactly the same page.
function listQuery(input: {
  q?: string;
  page?: number;
  pageSize?: number;
}): string {
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
  return params.toString();
}

export const api = {
  session: () => request<SessionResponse>('/v1/auth/session'),

  context: () => request<ContextResponse>('/v1/context'),

  people: (input: PeopleListInput = {}) => {
    const query = listQuery(input);
    return request<PeopleListResponse>(
      query === '' ? '/v1/people' : `/v1/people?${query}`,
    );
  },

  // The CRM account read surface. A GET, so no CSRF header; the server gates it
  // on crm.read and the rows are the shared client records this tenant holds.
  crmAccounts: (input: CrmAccountListInput = {}) => {
    const query = listQuery(input);
    return request<CrmAccountListResponse>(
      query === '' ? '/v1/crm/accounts' : `/v1/crm/accounts?${query}`,
    );
  },

  // A CRM account write. The server gates it on crm.write, names the columns
  // itself and audits the field names only.
  createCrmAccount: (input: CrmAccountCreateInput) =>
    request<CrmAccountListItem>('/v1/crm/accounts', {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify(input),
    }),

  updateCrmAccount: (id: string, input: CrmAccountUpdateInput) =>
    request<CrmAccountListItem>(`/v1/crm/accounts/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: writeHeaders(),
      body: JSON.stringify(input),
    }),

  // The contacts of one account. A GET, so no CSRF header; the server gates it
  // on crm.read and settles the account in the path before it looks for a
  // contact.
  crmContacts: (accountId: string) =>
    request<CrmContactListResponse>(
      `/v1/crm/accounts/${encodeURIComponent(accountId)}/contacts`,
    ),

  // A contact write. The server gates it on crm.write, names the columns
  // itself and audits the field names only.
  createCrmContact: (accountId: string, input: CrmContactCreateInput) =>
    request<CrmContactItem>(
      `/v1/crm/accounts/${encodeURIComponent(accountId)}/contacts`,
      {
        method: 'POST',
        headers: writeHeaders(),
        body: JSON.stringify(input),
      },
    ),

  updateCrmContact: (
    accountId: string,
    contactId: string,
    input: CrmContactUpdateInput,
  ) =>
    request<CrmContactItem>(
      `/v1/crm/accounts/${encodeURIComponent(accountId)}/contacts/${encodeURIComponent(contactId)}`,
      {
        method: 'PATCH',
        headers: writeHeaders(),
        body: JSON.stringify(input),
      },
    ),

  // The Work read surface. A GET, so no CSRF header; the server gates it on
  // work.read and the module policy narrows the rows.
  workProjects: (input: ProjectListInput = {}) => {
    const query = listQuery(input);
    return request<ProjectListResponse>(
      query === '' ? '/v1/work/projects' : `/v1/work/projects?${query}`,
    );
  },
  // The Money read surface. The server gates it on money.read.
  moneyInvoices: (input: InvoiceListInput = {}) => {
    const query = listQuery(input);
    return request<InvoiceListResponse>(
      query === '' ? '/v1/money/invoices' : `/v1/money/invoices?${query}`,
    );
  },

  // The Content read surface. The server gates it on content.read.
  contentItems: (input: ContentListInput = {}) => {
    const query = listQuery(input);
    return request<ContentListResponse>(
      query === '' ? '/v1/content/items' : `/v1/content/items?${query}`,
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

  // One person's compensation history. A GET, so no CSRF header. The server gates
  // it on people.compensation.read - a stricter test than the directory's
  // people.read - and narrows every row by this member's own scope.
  compensations: (id: string) =>
    request<CompensationListResponse>(
      `/v1/people/${encodeURIComponent(id)}/compensations`,
    ),

  // A salary row. The server gates both writes on people.compensation.write, a
  // permission of its own on either side of the read above, and on the member's
  // scope over the person in the path. The person is never in the body.
  createCompensation: (id: string, input: CompensationCreateInput) =>
    request<CompensationItem>(`/v1/people/${encodeURIComponent(id)}/compensations`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify(input),
    }),

  updateCompensation: (
    id: string,
    compensationId: string,
    input: CompensationUpdateInput,
  ) =>
    request<CompensationItem>(
      `/v1/people/${encodeURIComponent(id)}/compensations/${encodeURIComponent(compensationId)}`,
      {
        method: 'PATCH',
        headers: writeHeaders(),
        body: JSON.stringify(input),
      },
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
