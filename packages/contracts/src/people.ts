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
  // The placement ids come straight from the person row. The names are null
  // when the person is unplaced and when the referenced row is soft-deleted, so
  // a name never outlives the record it came from.
  legalEntityId: string | null;
  legalEntityName: string | null;
  orgUnitId: string | null;
  orgUnitName: string | null;
};

export type PeopleListResponse = {
  items: PeopleListItem[];
  total: number;
  page: number;
  pageSize: number;
};

// The only directory identity fields this milestone may write. Status,
// personal_email, demographics and the person-to-user link are deliberately
// absent: the runtime holds no write privilege on them. Placement is not here
// either - it is a separate route with its own contract below, and the runtime
// can only write it onto an existing row.
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

// Placement is always a whole statement about where a person sits: both keys
// are required, and a null clears that half. Both null removes the placement.
// This is a directory attribute only - it creates no employment record.
export type PeoplePlacementInput = {
  legalEntityId: string | null;
  orgUnitId: string | null;
};

export type PeoplePlacementOptionEntity = {
  id: string;
  name: string;
  code: string;
  // False when the member may place org units inside this entity but may not
  // place a person on the entity alone.
  placeable: boolean;
};

export type PeoplePlacementOptionOrgUnit = {
  id: string;
  name: string;
  legalEntityId: string;
  placeable: boolean;
};

export type PeoplePlacementOptions = {
  // True only for a tenant-wide member: removing a placement entirely leaves a
  // person no scoped member can see or maintain.
  canUnplace: boolean;
  legalEntities: PeoplePlacementOptionEntity[];
  orgUnits: PeoplePlacementOptionOrgUnit[];
};
