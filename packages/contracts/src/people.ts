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

// The employment history values this slice may write. They are the CHECK lists
// already on the employment table, restated so a route can reject a value
// before it reaches SQL and a screen can offer exactly the allowed choices.
export const EMPLOYMENT_TYPES = [
  'full_time',
  'part_time',
  'contract',
  'intern',
  'consultant',
] as const;

export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

export const EMPLOYMENT_STATUSES = ['active', 'ended', 'cancelled'] as const;

export type EmploymentStatus = (typeof EMPLOYMENT_STATUSES)[number];

// The table only requires notice_days >= 0, so the upper bound is a request
// contract: without it a single keystroke could store a notice period of
// centuries. The screen and the route both read this one number.
export const EMPLOYMENT_NOTICE_DAYS_MAX = 3650;

// Dates on the wire are always 'YYYY-MM-DD' strings, never Date objects, so a
// list, a create and an update read-back serialise identically and no timezone
// can shift a stored day.
export type EmploymentItem = {
  id: string;
  personId: string;
  // The legal entity is non-null because a row cannot exist without one; the
  // name follows the same rule the directory uses - it is read from the
  // reference row and is null once that row is soft-deleted.
  legalEntityId: string;
  legalEntityName: string | null;
  employmentType: EmploymentType;
  startDate: string;
  endDate: string | null;
  probationEndDate: string | null;
  noticeDays: number | null;
  status: EmploymentStatus;
};

// Every row the member can see for this person, newest first. There is no
// paging: one person's history is small, and a page boundary would hide the end
// of a career behind a "next" click.
export type EmploymentListResponse = {
  items: EmploymentItem[];
  total: number;
};

// What a create accepts. There is no personId - it comes from the path - and no
// legalEntityId, because the entity is derived from the person's placement at
// the moment of writing. No status (a new row is active), no
// work_jurisdiction_id, no source or import columns and no timestamps: the
// runtime holds no write privilege on any of them.
export type EmploymentCreateInput = {
  employmentType: EmploymentType;
  startDate: string;
  endDate?: string | null;
  probationEndDate?: string | null;
  noticeDays?: number | null;
};

// Partial by design, like the identity patch: an absent key means "unchanged".
// A null clears one of the two optional dates or the notice days, and is
// rejected for employmentType, startDate and status, which a row always has.
export type EmploymentUpdateInput = {
  employmentType?: EmploymentType;
  startDate?: string;
  endDate?: string | null;
  probationEndDate?: string | null;
  noticeDays?: number | null;
  status?: EmploymentStatus;
};
