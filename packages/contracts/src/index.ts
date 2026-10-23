export const PRODUCT_NAME = 'SaaSModels One';

export type { ContextModule, ContextResponse, SessionResponse } from './context.js';
export type { PeopleListItem, PeopleListResponse } from './people.js';
export {
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
