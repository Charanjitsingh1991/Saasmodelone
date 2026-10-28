export const MONEY_LIST_DEFAULT_PAGE_SIZE = 20;
export const MONEY_LIST_MAX_PAGE_SIZE = 50;
export const MONEY_SEARCH_MAX_LENGTH = 100;

// One invoice as the Money read surface returns it.
//
// Every amount is a stored count of minor units beside its own ISO currency
// code. Nothing here is a rate, a total of other rows, a converted figure or a
// derived due state: the tax column is the stored tax amount and nothing more,
// and the invoice's own total is the stored total. A caller that wants an
// aggregate, a conversion or an overdue flag has to compute it from these
// stored values, and this build computes none of them.
//
// The client is a shared-directory record. The id always comes back; the name
// is null when the client row is soft-deleted, so a retired client never keeps
// a name in the invoice list while its id stays visible.
export type InvoiceListItem = {
  id: string;
  number: string;
  clientId: string;
  clientName: string | null;
  // The stored status value, exactly as the column holds it. The read does not
  // map it to a label and does not derive a state from it.
  status: string;
  issueDate: string;
  dueDate: string;
  currency: string;
  subtotalMinor: number;
  taxMinor: number;
  totalMinor: number;
  amountPaidMinor: number;
};

export type InvoiceListResponse = {
  items: InvoiceListItem[];
  total: number;
  page: number;
  pageSize: number;
};

// The list input. The search term is a literal substring match: a percent sign
// or an underscore in it is text, never a wildcard.
export type InvoiceListInput = {
  q?: string;
  page?: number;
  pageSize?: number;
};
