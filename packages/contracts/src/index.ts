export const PRODUCT_NAME = 'SaaSModels One';

export type { ContextModule, ContextResponse, SessionResponse } from './context.js';
export type {
  PeopleCreateInput,
  PeopleListItem,
  PeopleListResponse,
  PeoplePlacementInput,
  PeoplePlacementOptionEntity,
  PeoplePlacementOptionOrgUnit,
  PeoplePlacementOptions,
  PeopleUpdateInput,
} from './people.js';
export {
  PERSON_DISPLAY_NAME_MAX_LENGTH,
  PERSON_EMPLOYEE_CODE_MAX_LENGTH,
  PERSON_NAME_MAX_LENGTH,
  PERSON_PHONE_MAX_LENGTH,
  PERSON_WORK_EMAIL_MAX_LENGTH,
  PEOPLE_LIST_DEFAULT_PAGE_SIZE,
  PEOPLE_LIST_MAX_PAGE_SIZE,
  PEOPLE_SEARCH_MAX_LENGTH,
} from './people.js';
export type { MembershipRole, ModuleOperation, Permission } from './authorization.js';
export {
  hasPermission,
  MEMBERSHIP_ROLES,
  MODULE_OPERATIONS,
  PERMISSIONS,
  permissionFor,
  permissionsForRole,
} from './authorization.js';
