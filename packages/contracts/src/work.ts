export const WORK_LIST_DEFAULT_PAGE_SIZE = 20;
export const WORK_LIST_MAX_PAGE_SIZE = 50;
export const WORK_SEARCH_MAX_LENGTH = 100;

// One project as the Work read surface returns it. The list deliberately
// excludes the project's engagement, its manager, its hours, its import
// provenance and its cost rows: none of them is on this surface, and a screen
// that cannot show them has no reason to receive them.
//
// The budget is a stored amount in minor units with its own currency code. It
// is never converted, annualised or prorated here - the column records what
// the workspace stored, and no table records a decimal exponent or a period.
//
// The client is a shared-directory record. The id always comes back; the name
// is null when the client row is soft-deleted, so a retired client never keeps
// a name in the project list while its id stays visible.
export type ProjectListItem = {
  id: string;
  code: string | null;
  name: string;
  clientId: string;
  clientName: string | null;
  // The stored status value, exactly as the column holds it. The read does not
  // map it to a label and does not derive a state from it.
  status: string;
  currency: string;
  startDate: string | null;
  endDate: string | null;
  budgetMinor: number | null;
};

export type ProjectListResponse = {
  items: ProjectListItem[];
  total: number;
  page: number;
  pageSize: number;
};

// The list input. The search term is a literal substring match: a percent sign
// or an underscore in it is text, never a wildcard.
export type ProjectListInput = {
  q?: string;
  page?: number;
  pageSize?: number;
};
