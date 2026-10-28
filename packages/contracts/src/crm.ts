export const CRM_LIST_DEFAULT_PAGE_SIZE = 20;
export const CRM_LIST_MAX_PAGE_SIZE = 50;
export const CRM_SEARCH_MAX_LENGTH = 100;

// One account as the CRM read surface returns it.
//
// An account is a shared client record, not a CRM-private row: the platform
// owns client identity, and CRM is the module that reads and writes it. The
// item therefore carries exactly the eight fields the CRM surface names, and
// nothing else. Tenant, owner, provenance, timestamps and the soft-delete
// column stay on the row: a member never needs them and the route never
// selects them.
export type CrmAccountListItem = {
  id: string;
  name: string;
  code: string | null;
  // The stored status value, exactly as the column holds it. The read does not
  // map it to a label and does not derive a state from it.
  status: string;
  billingEmail: string | null;
  phone: string | null;
  // The stored currency code. It is a code and nothing more: no registry
  // resolves it, no rate converts it and no jurisdiction is implied by it.
  currency: string;
  // The stored payment terms, in days, exactly as the column holds it.
  paymentTermsDays: number;
};

export type CrmAccountListResponse = {
  items: CrmAccountListItem[];
  total: number;
  page: number;
  pageSize: number;
};

// The list input. The search term is a literal substring match: a percent sign
// or an underscore in it is text, never a wildcard.
export type CrmAccountListInput = {
  q?: string;
  page?: number;
  pageSize?: number;
};

// The account status the table accepts. A stored status is exactly one of
// these four values and nothing else.
export const CRM_ACCOUNT_STATUSES = [
  'prospect',
  'active',
  'dormant',
  'archived',
] as const;

export type CrmAccountStatus = (typeof CRM_ACCOUNT_STATUSES)[number];

// The stored payment terms in days. The bound is the PostgreSQL integer range,
// which is the widest value the column can hold; a larger number is a client
// error rather than a number to round.
export const CRM_PAYMENT_TERMS_DAYS_MAX = 2_147_483_647;

// A new account. The body is closed: a key that is not named here is refused,
// so a caller cannot smuggle a column the route never writes.
//
// name and currency are required. status and paymentTermsDays may be left out
// and take the database's own defaults; the other three (code, billingEmail and
// phone) are optional and stand empty when they are absent.
export type CrmAccountCreateInput = {
  name: string;
  code?: string | null;
  status?: CrmAccountStatus;
  billingEmail?: string | null;
  phone?: string | null;
  currency: string;
  paymentTermsDays?: number;
};

// A change to an existing account. At least one key must be present, and the
// merged record is validated as a whole. Only code, billingEmail and phone
// may be stated as null: name, status, currency and paymentTermsDays are the
// four columns the table does not let stand empty.
export type CrmAccountUpdateInput = {
  name?: string;
  code?: string | null;
  status?: CrmAccountStatus;
  billingEmail?: string | null;
  phone?: string | null;
  currency?: string;
  paymentTermsDays?: number;
};

// One contact as the CRM contact surface returns it.
//
// A contact hangs off one account and is a shared client_contact row, not a
// CRM-private one: the platform owns client identity, and CRM is the module
// that reads and writes it. The item therefore carries exactly the six fields
// the contact surface names. The account it belongs to is named by the route,
// not by the item, and the timestamps and the tenant stay on the row.
export type CrmContactItem = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  role: string | null;
  // Whether this is the account's primary contact. The table holds at most one
  // primary per account, and the write route demotes the others to keep it so.
  isPrimary: boolean;
};

// The contact list of one account. It is a panel rather than a paged list, so
// it carries a total and no paging.
export type CrmContactListResponse = {
  items: CrmContactItem[];
  total: number;
};

// A new contact. The body is closed: a key that is not named here is refused.
// name is required; email, phone and role are optional and stand empty when
// they are absent; isPrimary defaults to false.
export type CrmContactCreateInput = {
  name: string;
  email?: string | null;
  phone?: string | null;
  role?: string | null;
  isPrimary?: boolean;
};

// A change to an existing contact. At least one key must be present. Only
// email, phone and role may be stated as null: the name and the primary flag
// are the two values a row always holds.
export type CrmContactUpdateInput = {
  name?: string;
  email?: string | null;
  phone?: string | null;
  role?: string | null;
  isPrimary?: boolean;
};
