export const PRODUCT_NAME = 'SaaSModels One';

export type { MembershipRole, ModuleOperation, Permission } from './authorization.js';
export {
  hasPermission,
  MEMBERSHIP_ROLES,
  MODULE_OPERATIONS,
  PERMISSIONS,
  permissionFor,
  permissionsForRole,
} from './authorization.js';
