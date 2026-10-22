import { createHash, randomBytes } from 'node:crypto';
import type { Client } from 'pg';

export const SESSION_COOKIE = 'saas_session';
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}`;
}

export type SessionFixture = {
  token: string;
  csrfToken: string;
  cookie: string;
  expiresAt: Date;
};

export type CreateSessionInput = {
  userId: string;
  tenantId: string;
  token?: string;
  csrfToken?: string;
  createdAt?: Date;
  expiresAt?: Date;
  revokedAt?: Date | null;
};

export async function createSessionFixture(
  owner: Client,
  input: CreateSessionInput,
): Promise<SessionFixture> {
  const token = input.token ?? randomToken();
  const csrfToken = input.csrfToken ?? randomToken();
  const createdAt = input.createdAt ?? new Date();
  const expiresAt = input.expiresAt ?? new Date(createdAt.getTime() + SESSION_TTL_MS);
  await owner.query(
    `insert into auth_session
       (user_id, tenant_id, token_hash, csrf_token, created_at, expires_at, revoked_at)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      input.userId,
      input.tenantId,
      tokenHash(token),
      csrfToken,
      createdAt,
      expiresAt,
      input.revokedAt ?? null,
    ],
  );
  return { token, csrfToken, cookie: sessionCookie(token), expiresAt };
}
