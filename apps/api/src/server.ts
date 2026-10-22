import { createHash, timingSafeEqual } from 'node:crypto';
import cookie from '@fastify/cookie';
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import {
  AuthError,
  findSession,
  InvalidTenantContextError,
  login,
  MembershipDeniedError,
  ModuleAccessDeniedError,
  PlatformAccessDeniedError,
  revokeSession,
  SESSION_TTL_MS,
  acceptInvitation,
  withMemberTransaction,
  type AuthPool,
  type SessionInfo,
  type SessionRecord,
  type RuntimePool,
} from '@saasmodels/db';

export const SESSION_COOKIE = 'saas_session';
export const CSRF_HEADER = 'x-csrf-token';
export const DEFAULT_RATE_LIMIT = { max: 10, windowMs: 15 * 60 * 1000 };
// Login is also limited per source address so a single source cannot spray
// unlimited distinct emails against the per-identity bucket.
export const DEFAULT_LOGIN_IP_RATE_LIMIT = { max: 100, windowMs: 15 * 60 * 1000 };

export type RateLimitOptions = {
  max: number;
  windowMs: number;
};

export type CreateServerOptions = {
  pool: RuntimePool;
  authPool: AuthPool;
  appOrigin: string;
  secureCookies: boolean;
  loginIpRateLimit?: RateLimitOptions;
  loginRateLimit?: RateLimitOptions;
  invitationRateLimit?: RateLimitOptions;
  enableProofRoutes?: boolean;
  logger?: boolean;
};

type ContextModule = {
  code: string;
  canRead: boolean;
  canWrite: boolean;
};

type AccessErrorBody = {
  error: {
    code: string;
    module?: string;
    operation?: string;
  };
};

class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
  ) {
    super(code);
    this.name = 'ApiError';
  }
}

function unauthenticated(reply: FastifyReply): AccessErrorBody {
  reply.code(401);
  return { error: { code: 'UNAUTHENTICATED' } };
}

function accessError(error: unknown, reply: FastifyReply): AccessErrorBody {
  if (error instanceof InvalidTenantContextError) {
    reply.code(401);
    return { error: { code: 'UNAUTHENTICATED' } };
  }
  if (error instanceof MembershipDeniedError) {
    reply.code(403);
    return { error: { code: 'MEMBERSHIP_DENIED' } };
  }
  if (error instanceof PlatformAccessDeniedError) {
    reply.code(403);
    return { error: { code: 'PLATFORM_ACCESS_DENIED' } };
  }
  if (error instanceof ModuleAccessDeniedError) {
    reply.code(403);
    return {
      error: {
        code: 'MODULE_NOT_ENTITLED',
        module: error.module,
        operation: error.operation,
      },
    };
  }
  throw error;
}

function sessionBody(session: SessionInfo | SessionRecord) {
  return {
    userId: session.userId,
    tenantId: session.tenantId,
    csrfToken: session.csrfToken,
    expiresAt: session.expiresAt.toISOString(),
  };
}

function secretsEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function validateRateLimit(options: RateLimitOptions, name: string): RateLimitOptions {
  if (
    !Number.isInteger(options.max) ||
    options.max < 1 ||
    !Number.isFinite(options.windowMs) ||
    options.windowMs < 1
  ) {
    throw new Error(`${name} must be positive integers`);
  }
  return options;
}

function createRateLimiter(options: RateLimitOptions) {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  return (key: string, now = Date.now()): boolean => {
    if (buckets.size > 10_000) {
      for (const [entry, bucket] of buckets) {
        if (bucket.resetAt <= now) {
          buckets.delete(entry);
        }
      }
    }
    const bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + options.windowMs });
      return true;
    }
    if (bucket.count >= options.max) {
      return false;
    }
    bucket.count += 1;
    return true;
  };
}

const loginBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['email', 'password', 'tenantSlug'],
  properties: {
    email: { type: 'string', minLength: 1, maxLength: 320 },
    password: { type: 'string', minLength: 1, maxLength: 128 },
    tenantSlug: {
      type: 'string',
      minLength: 3,
      maxLength: 63,
      pattern: '^[a-z0-9][a-z0-9-]*[a-z0-9]$',
    },
  },
} as const;

const acceptBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['token', 'password'],
  properties: {
    token: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' },
    password: { type: 'string', minLength: 12, maxLength: 128 },
  },
} as const;

export function createServer(options: CreateServerOptions): FastifyInstance {
  const {
    pool,
    authPool,
    appOrigin,
    secureCookies,
    enableProofRoutes = false,
    logger = false,
  } = options;
  if (typeof appOrigin !== 'string' || appOrigin.length === 0) {
    throw new Error('appOrigin is required');
  }

  const loginIpLimit = validateRateLimit(
    options.loginIpRateLimit ?? DEFAULT_LOGIN_IP_RATE_LIMIT,
    'loginIpRateLimit',
  );
  const loginLimit = validateRateLimit(
    options.loginRateLimit ?? DEFAULT_RATE_LIMIT,
    'loginRateLimit',
  );
  const invitationLimit = validateRateLimit(
    options.invitationRateLimit ?? DEFAULT_RATE_LIMIT,
    'invitationRateLimit',
  );
  const loginIpAllowed = createRateLimiter(loginIpLimit);
  const loginAllowed = createRateLimiter(loginLimit);
  const invitationAllowed = createRateLimiter(invitationLimit);

  const app = Fastify({
    logger,
    ajv: { customOptions: { removeAdditional: false } },
  });
  void app.register(cookie);

  const cookieOptions = {
    httpOnly: true,
    sameSite: 'strict' as const,
    path: '/',
    secure: secureCookies,
  };

  function setSessionCookie(reply: FastifyReply, session: SessionInfo): void {
    reply.setCookie(SESSION_COOKIE, session.token, {
      ...cookieOptions,
      maxAge: Math.floor(SESSION_TTL_MS / 1000),
    });
  }

  function clearSessionCookie(reply: FastifyReply): void {
    reply.clearCookie(SESSION_COOKIE, cookieOptions);
  }

  async function currentSession(request: FastifyRequest): Promise<SessionRecord | null> {
    const token = request.cookies[SESSION_COOKIE];
    if (!token) {
      return null;
    }
    return findSession(authPool, token);
  }

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      reply.code(error.statusCode);
      return reply.send({ error: { code: error.code } });
    }
    const statusCode = (error as { statusCode?: unknown }).statusCode;
    const status =
      typeof statusCode === 'number' && statusCode >= 400 ? statusCode : 500;
    if (status >= 500) {
      request.log.error(error);
      reply.code(500);
      return reply.send({ error: { code: 'INTERNAL_ERROR' } });
    }
    const code =
      status === 400
        ? 'BAD_REQUEST'
        : status === 413
          ? 'PAYLOAD_TOO_LARGE'
          : status === 415
            ? 'UNSUPPORTED_MEDIA_TYPE'
            : status === 429
              ? 'RATE_LIMITED'
              : status === 404
                ? 'NOT_FOUND'
                : 'REQUEST_REJECTED';
    reply.code(status);
    return reply.send({ error: { code } });
  });

  app.addHook('onRequest', async (request) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) {
      return;
    }
    if (request.headers.origin !== appOrigin) {
      throw new ApiError(403, 'ORIGIN_DENIED');
    }
  });

  // Auth responses carry credentials or session state and must never be cached
  // by a browser, proxy or shared cache, including error responses.
  app.addHook('onSend', async (request, reply) => {
    if (request.url.startsWith('/v1/auth/')) {
      reply.header('cache-control', 'no-store');
    }
  });

  app.get('/health', async () => ({ status: 'ok' }));

  app.post('/v1/auth/login', { schema: { body: loginBodySchema } }, async (request, reply) => {
    const body = request.body as { email: string; password: string; tenantSlug: string };
    if (!loginIpAllowed(`login-ip:${request.ip}`)) {
      throw new ApiError(429, 'RATE_LIMITED');
    }
    const key = `login:${request.ip}:${createHash('sha256')
      .update(body.email.trim().toLowerCase())
      .digest('hex')}`;
    if (!loginAllowed(key)) {
      throw new ApiError(429, 'RATE_LIMITED');
    }

    const session = await login(authPool, {
      email: body.email,
      password: body.password,
      tenantSlug: body.tenantSlug,
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
    });
    if (!session) {
      throw new ApiError(401, 'INVALID_CREDENTIALS');
    }

    setSessionCookie(reply, session);
    return sessionBody(session);
  });

  app.post(
    '/v1/auth/invitations/accept',
    { schema: { body: acceptBodySchema } },
    async (request, reply) => {
      const body = request.body as { token: string; password: string };
      if (!invitationAllowed(`invitation:${request.ip}`)) {
        throw new ApiError(429, 'RATE_LIMITED');
      }

      let session: SessionInfo | null;
      try {
        session = await acceptInvitation(authPool, {
          token: body.token,
          password: body.password,
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
        });
      } catch (error) {
        if (error instanceof AuthError && error.code === 'INVALID_PASSWORD') {
          throw new ApiError(400, 'INVALID_PASSWORD');
        }
        throw error;
      }
      if (!session) {
        throw new ApiError(401, 'INVITATION_INVALID');
      }

      setSessionCookie(reply, session);
      return sessionBody(session);
    },
  );

  app.get('/v1/auth/session', async (request, reply) => {
    const session = await currentSession(request);
    if (!session) {
      return unauthenticated(reply);
    }
    return sessionBody(session);
  });

  app.post('/v1/auth/logout', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    const session = token ? await findSession(authPool, token) : null;
    if (!session || !token) {
      return unauthenticated(reply);
    }

    const csrf = request.headers[CSRF_HEADER];
    if (typeof csrf !== 'string' || !secretsEqual(csrf, session.csrfToken)) {
      throw new ApiError(403, 'CSRF_INVALID');
    }

    await revokeSession(authPool, token);
    clearSessionCookie(reply);
    reply.code(204);
    return null;
  });

  app.get('/v1/context', async (request, reply) => {
    const session = await currentSession(request);
    if (!session) {
      return unauthenticated(reply);
    }

    try {
      return await withMemberTransaction(
        pool,
        { tenantId: session.tenantId, userId: session.userId },
        async (client, member) => {
          const switchAccess = await client.query<{ allowed: boolean }>(
            'select app.has_switch_access() as allowed',
          );
          const modules = await client.query<ContextModule>(
            `select m.code,
                    app.has_module_read(m.code) as "canRead",
                    app.has_module_write(m.code) as "canWrite"
               from platform_module m
              where m.is_licensable
              order by m.code`,
          );

          return {
            userId: session.userId,
            tenantId: session.tenantId,
            role: member.role,
            switchAccess: switchAccess.rows[0]?.allowed ?? false,
            modules: modules.rows.filter((row) => row.canRead || row.canWrite),
          };
        },
      );
    } catch (error) {
      return accessError(error, reply);
    }
  });

  if (enableProofRoutes) {
    app.get('/v1/proof/people/employment', async (request, reply) => {
      const session = await currentSession(request);
      if (!session) {
        return unauthenticated(reply);
      }

      try {
        return await withMemberTransaction(
          pool,
          {
            tenantId: session.tenantId,
            userId: session.userId,
            gate: { module: 'people', operation: 'read' },
          },
          async (client) => {
            const result = await client.query<{
              id: string;
              personId: string;
              employmentType: string;
              startDate: string;
              status: string;
            }>(
              `select id,
                      person_id as "personId",
                      employment_type as "employmentType",
                      start_date::text as "startDate",
                      status
                 from employment
                where tenant_id = $1
                order by start_date desc, id`,
              [session.tenantId],
            );
            return { items: result.rows };
          },
        );
      } catch (error) {
        return accessError(error, reply);
      }
    });

    app.get('/v1/proof/work/projects', async (request, reply) => {
      const session = await currentSession(request);
      if (!session) {
        return unauthenticated(reply);
      }

      try {
        return await withMemberTransaction(
          pool,
          {
            tenantId: session.tenantId,
            userId: session.userId,
            gate: { module: 'work', operation: 'read' },
          },
          async (client) => {
            const result = await client.query<{
              id: string;
              name: string;
              status: string;
              currency: string;
              startDate: string | null;
              endDate: string | null;
            }>(
              `select id,
                      name,
                      status,
                      currency,
                      start_date::text as "startDate",
                      end_date::text as "endDate"
                 from project
                where tenant_id = $1
                order by name, id`,
              [session.tenantId],
            );
            return { items: result.rows };
          },
        );
      } catch (error) {
        return accessError(error, reply);
      }
    });
  }

  return app;
}
