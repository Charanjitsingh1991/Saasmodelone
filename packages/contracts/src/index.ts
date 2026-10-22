export const PRODUCT_NAME = 'SaaSModels One';

export type { ContextModule, ContextResponse, SessionResponse } from './context.js';
export type { MembershipRole, ModuleOperation, Permission } from './authorization.js';
export {
  hasPermission,
  MEMBERSHIP_ROLES,
  MODULE_OPERATIONS,
  PERMISSIONS,
  permissionFor,
  permissionsForRole,
} from './authorization.js';
