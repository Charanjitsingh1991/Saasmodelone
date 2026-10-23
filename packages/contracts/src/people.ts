export const PEOPLE_LIST_DEFAULT_PAGE_SIZE = 20;
export const PEOPLE_LIST_MAX_PAGE_SIZE = 50;
export const PEOPLE_SEARCH_MAX_LENGTH = 100;

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
