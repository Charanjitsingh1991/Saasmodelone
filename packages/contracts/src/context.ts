import type { MembershipRole, Permission } from './authorization.js';

export type ContextModule = {
  code: string;
  name: string;
  sortOrder: number;
  canRead: boolean;
  canWrite: boolean;
};

export type ContextResponse = {
  userId: string;
  tenantId: string;
  role: MembershipRole;
  permissions: Permission[];
  switchAccess: boolean;
  modules: ContextModule[];
};

export type SessionResponse = {
  userId: string;
  tenantId: string;
  csrfToken: string;
  expiresAt: string;
};
