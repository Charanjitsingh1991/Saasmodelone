export const CONTENT_LIST_DEFAULT_PAGE_SIZE = 20;
export const CONTENT_LIST_MAX_PAGE_SIZE = 50;
export const CONTENT_SEARCH_MAX_LENGTH = 100;

// One content item as the Content read surface returns it.
//
// The item is the record itself, not a version of it: the seo block, the
// current version, the author and the reviewer stay behind. A content item has
// no client, so this list carries no client reference at all.
//
// The dates are calendar days and timestamps formatted by the database, so no
// session timezone can shift a stored day. publishedAt is null while the item
// has never been published.
export type ContentListItem = {
  id: string;
  kind: string;
  slug: string;
  title: string;
  locale: string;
  // The stored status value, exactly as the column holds it. The read does not
  // map it to a label and does not derive a state from it.
  status: string;
  publishedAt: string | null;
  updatedAt: string;
};

export type ContentListResponse = {
  items: ContentListItem[];
  total: number;
  page: number;
  pageSize: number;
};

// The list input. The search term is a literal substring match: a percent sign
// or an underscore in it is text, never a wildcard.
export type ContentListInput = {
  q?: string;
  page?: number;
  pageSize?: number;
};
