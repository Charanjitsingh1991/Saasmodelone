export type { AuditActorType, AuditEventInput } from './audit.js';
export { appendAuditEvent, InvalidAuditEventError } from './audit.js';
export type {
  AcceptInvitationInput,
  AuthErrorCode,
  AuthPool,
  CreateInvitationInput,
  CreatedInvitation,
  LoginInput,
  SessionInfo,
  SessionRecord,
} from './auth.js';
export {
  acceptInvitation,
  AuthError,
  createAuthPool,
  createInvitation,
  findSession,
  hashPassword,
  login,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  revokeSession,
  SESSION_TTL_MS,
  verifyPassword,
} from './auth.js';
export type { BootstrapOptions, BootstrapResult } from './bootstrap.js';
export { AUTH_ROLE, bootstrap, OWNER_ROLE, RUNTIME_ROLE } from './bootstrap.js';
export {
  assertLocalDatabaseUrl,
  databaseUrlWithName,
  redactDatabaseUrl,
} from './config.js';
export type { AccessDenialInput, AccessDenialReason } from './denials.js';
export { ACCESS_DENIAL_REASONS, recordAccessDenial } from './denials.js';
export type {
  CancelEntitlementInput,
  EntitlementErrorCode,
  GrantEntitlementInput,
} from './entitlements.js';
export {
  cancelEntitlement,
  EntitlementError,
  grantEntitlement,
} from './entitlements.js';
export type { MigrationOptions, MigrationResult } from './migrate.js';
export { listSqlFiles, migrate } from './migrate.js';
export type {
  CatalogModule,
  EntitlementSource,
  ModuleCatalogErrorCode,
  ModuleStatus,
  SeatUnit,
} from './modules.js';
export { ModuleCatalogError, resolveModuleCatalog } from './modules.js';
export type {
  ProvisionTenantInput,
  ProvisionTenantResult,
  ProvisioningErrorCode,
} from './provision.js';
export { provisionTenant, ProvisioningError } from './provision.js';
export type { SeedOptions } from './seed.js';
export { seed } from './seed.js';
export type {
  MemberContext,
  MemberTransactionOptions,
  MembershipRole,
  ModuleOperation,
  RuntimePool,
  TenantGate,
  TenantTransactionOptions,
} from './tenant.js';
export {
  createRuntimePool,
  InvalidMembershipRoleError,
  InvalidTenantContextError,
  MembershipDeniedError,
  ModuleAccessDeniedError,
  PlatformAccessDeniedError,
  RoleAccessDeniedError,
  withMemberTransaction,
  withTenantTransaction,
} from './tenant.js';
