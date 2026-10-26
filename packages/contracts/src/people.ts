export const PEOPLE_LIST_DEFAULT_PAGE_SIZE = 20;
export const PEOPLE_LIST_MAX_PAGE_SIZE = 50;
export const PEOPLE_SEARCH_MAX_LENGTH = 100;

// The longest value each writable directory field may hold. They are a request
// contract, not a database constraint: person has no length CHECK, and the
// display name limit is what lets a derived "first last" value fit.
export const PERSON_NAME_MAX_LENGTH = 100;
export const PERSON_DISPLAY_NAME_MAX_LENGTH = 200;
export const PERSON_EMPLOYEE_CODE_MAX_LENGTH = 64;
export const PERSON_WORK_EMAIL_MAX_LENGTH = 254;
export const PERSON_PHONE_MAX_LENGTH = 40;

export type PeopleListItem = {
  id: string;
  employeeCode: string | null;
  firstName: string;
  lastName: string | null;
  displayName: string;
  workEmail: string | null;
  phone: string | null;
};

export type PeopleListResponse = {
  items: PeopleListItem[];
  total: number;
  page: number;
  pageSize: number;
};

// The only directory fields this milestone may write. Placement, status,
// personal contact, demographics and the person-to-user link are deliberately
// absent: the runtime holds no write privilege on them.
export type PeopleCreateInput = {
  firstName: string;
  lastName?: string | null;
  displayName?: string | null;
  employeeCode?: string | null;
  workEmail?: string | null;
  phone?: string | null;
};

// Partial by design: an absent key means "unchanged", so a caller cannot clear
// a field it never intended to touch.
export type PeopleUpdateInput = {
  firstName?: string;
  lastName?: string | null;
  displayName?: string | null;
  employeeCode?: string | null;
  workEmail?: string | null;
  phone?: string | null;
};
