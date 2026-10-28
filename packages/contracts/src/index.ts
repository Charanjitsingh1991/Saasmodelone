export const PRODUCT_NAME = 'SaaSModels One';

export type { ContextModule, ContextResponse, SessionResponse } from './context.js';
export type {
  CompensationCreateInput,
  CompensationItem,
  CompensationListResponse,
  CompensationPayFrequency,
  CompensationUpdateInput,
  EmploymentCreateInput,
  EmploymentItem,
  EmploymentListResponse,
  EmploymentStatus,
  EmploymentType,
  EmploymentUpdateInput,
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
  COMPENSATION_CTC_MINOR_MAX,
  COMPENSATION_PAY_FREQUENCIES,
  EMPLOYMENT_NOTICE_DAYS_MAX,
  EMPLOYMENT_STATUSES,
  EMPLOYMENT_TYPES,
  PERSON_DISPLAY_NAME_MAX_LENGTH,
  PERSON_EMPLOYEE_CODE_MAX_LENGTH,
  PERSON_NAME_MAX_LENGTH,
  PERSON_PHONE_MAX_LENGTH,
  PERSON_WORK_EMAIL_MAX_LENGTH,
  PEOPLE_LIST_DEFAULT_PAGE_SIZE,
  PEOPLE_LIST_MAX_PAGE_SIZE,
  PEOPLE_SEARCH_MAX_LENGTH,
} from './people.js';
export type {
  CrmAccountCreateInput,
  CrmAccountListInput,
  CrmAccountListItem,
  CrmAccountListResponse,
  CrmAccountStatus,
  CrmAccountUpdateInput,
  CrmContactCreateInput,
  CrmContactItem,
  CrmContactListResponse,
  CrmContactUpdateInput,
} from './crm.js';
export {
  CRM_ACCOUNT_STATUSES,
  CRM_LIST_DEFAULT_PAGE_SIZE,
  CRM_LIST_MAX_PAGE_SIZE,
  CRM_PAYMENT_TERMS_DAYS_MAX,
  CRM_SEARCH_MAX_LENGTH,
} from './crm.js';
export type {
  ContentListInput,
  ContentListItem,
  ContentListResponse,
} from './content.js';
export {
  CONTENT_LIST_DEFAULT_PAGE_SIZE,
  CONTENT_LIST_MAX_PAGE_SIZE,
  CONTENT_SEARCH_MAX_LENGTH,
} from './content.js';
export type {
  InvoiceListInput,
  InvoiceListItem,
  InvoiceListResponse,
} from './money.js';
export {
  MONEY_LIST_DEFAULT_PAGE_SIZE,
  MONEY_LIST_MAX_PAGE_SIZE,
  MONEY_SEARCH_MAX_LENGTH,
} from './money.js';
export type {
  ProjectListInput,
  ProjectListItem,
  ProjectListResponse,
} from './work.js';
export {
  WORK_LIST_DEFAULT_PAGE_SIZE,
  WORK_LIST_MAX_PAGE_SIZE,
  WORK_SEARCH_MAX_LENGTH,
} from './work.js';
export type { MembershipRole, ModuleOperation, Permission } from './authorization.js';
export {
  hasPermission,
  MEMBERSHIP_ROLES,
  MODULE_OPERATIONS,
  PERMISSIONS,
  permissionFor,
  permissionsForRole,
} from './authorization.js';
