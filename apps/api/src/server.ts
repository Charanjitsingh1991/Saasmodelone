import { createHash, timingSafeEqual } from 'node:crypto';
import cookie from '@fastify/cookie';
import {
  hasPermission,
  permissionFor,
  permissionsForRole,
  PEOPLE_LIST_DEFAULT_PAGE_SIZE,
  PEOPLE_LIST_MAX_PAGE_SIZE,
  PEOPLE_SEARCH_MAX_LENGTH,
  type ContextModule,
  type ContextResponse,
  type PeopleListItem,
  type PeopleListResponse,
  type SessionResponse,
} from '@saasmodels/contracts';
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import {
  appendAuditEvent,
  AuthError,
  findSession,
  InvalidTenantContextError,
  login,
  MembershipDeniedError,
  ModuleAccessDeniedError,
  PlatformAccessDeniedError,
  recordAccessDenial,
  revokeSession,
  RoleAccessDeniedError,
  SESSION_TTL_MS,
  acceptInvitation,
  withMemberTransaction,
  type AccessDenialReason,
  type AuthPool,
  type ModuleOperation,
  type SessionInfo,
  type SessionRecord,
  type RuntimePool,
} from '@saasmodels/db';
import {
  csvRecord,
  PEOPLE_EXPORT_COLUMNS,
  PEOPLE_EXPORT_HEADER,
} from './csv.js';
import { writeWithBackpressure } from './csv-stream.js';

export {
  csvField,
  csvRecord,
  PEOPLE_EXPORT_COLUMNS,
  PEOPLE_EXPORT_HEADER,
} from './csv.js';
export { ClientClosedError, writeWithBackpressure } from './csv-stream.js';

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
  exportBatchSize?: number;
  enableProofRoutes?: boolean;
  logger?: boolean;
};

type PersonExportRow = {
  person_id: string;
  employee_code: string | null;
  first_name: string;
  last_name: string | null;
  display_name: string;
  work_email: string | null;
  phone: string | null;
};

type PeopleListRow = {
  id: string;
  employee_code: string | null;
  first_name: string;
  last_name: string | null;
  display_name: string;
  work_email: string | null;
  phone: string | null;
};

type AccessErrorBody = {
  error: {
    code: string;
    module?: string;
    operation?: string;
    permission?: string;
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

async function accessError(
  pool: RuntimePool,
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
  session: SessionRecord,
): Promise<AccessErrorBody> {
  let reason: AccessDenialReason | null = null;
  let module: string | undefined;
  let operation: ModuleOperation | undefined;
  let permission: string | undefined;

  if (error instanceof MembershipDeniedError) {
    reason = 'MEMBERSHIP_DENIED';
  } else if (error instanceof PlatformAccessDeniedError) {
    reason = 'PLATFORM_ACCESS_DENIED';
  } else if (error instanceof ModuleAccessDeniedError) {
    reason = 'MODULE_NOT_ENTITLED';
    module = error.module;
    operation = error.operation;
  } else if (error instanceof RoleAccessDeniedError) {
    reason = 'ROLE_DENIED';
    module = error.module;
    operation = error.operation;
    permission = error.permission;
  }

  if (reason) {
    try {
      // The registered route template, never the raw URL: a query string can
      // carry secrets and must not reach the audit row.
      const path = request.routeOptions.url;
      if (!path) {
        throw new Error('Route template is unavailable for a denial audit');
      }
      await recordAccessDenial(pool, {
        tenantId: session.tenantId,
        userId: session.userId,
        reason,
        method: request.method,
        path,
        module,
        operation,
        permission,
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });
    } catch (auditError) {
      request.log.error(auditError);
    }
  }

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
  if (error instanceof RoleAccessDeniedError) {
    reply.code(403);
    return { error: { code: 'ROLE_DENIED', permission: error.permission } };
  }
  throw error;
}

function sessionBody(session: SessionInfo | SessionRecord): SessionResponse {
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

// The last page a caller may ask for. Anything larger, or a value that is not
// a plain non-negative integer, is a client error rather than a database error.
const PEOPLE_MAX_PAGE = 1_000_000;

function peopleQueryStringParam(
  query: Record<string, unknown>,
  name: string,
): string | null {
  const value = query[name];
  if (value === undefined) {
    return null;
  }
  // A repeated parameter arrives as an array: the caller has sent two answers
  // for one filter, so there is no safe way to honour it.
  if (typeof value !== 'string') {
    throw new ApiError(400, 'INVALID_QUERY');
  }
  return value;
}

function peopleSearchTerm(query: Record<string, unknown>): string {
  const raw = peopleQueryStringParam(query, 'q');
  if (raw === null) {
    return '';
  }
  const term = raw.trim();
  if (term.length > PEOPLE_SEARCH_MAX_LENGTH) {
    throw new ApiError(400, 'INVALID_QUERY');
  }
  return term;
}

function peopleIntegerParam(
  query: Record<string, unknown>,
  name: string,
  fallback: number,
  max: number,
): number {
  const raw = peopleQueryStringParam(query, name);
  if (raw === null) {
    return fallback;
  }
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new ApiError(400, 'INVALID_QUERY');
  }
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new ApiError(400, 'INVALID_QUERY');
  }
  return value;
}

function validateExportBatchSize(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 1000) {
    throw new Error('exportBatchSize must be an integer between 1 and 1000');
  }
  return value;
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
  const exportBatchSize = validateExportBatchSize(options.exportBatchSize ?? 200);
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

  // Auth, context and directory responses carry credentials, session,
  // authorization or tenant data and must never be cached by a browser, proxy
  // or shared cache, including error responses.
  app.addHook('onSend', async (request, reply) => {
    if (
      request.url.startsWith('/v1/auth/') ||
      request.url.startsWith('/v1/context') ||
      request.url === '/v1/people' ||
      request.url.startsWith('/v1/people?')
    ) {
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
                    m.name,
                    m.sort_order as "sortOrder",
                    app.has_module_read(m.code) as "canRead",
                    app.has_module_write(m.code) as "canWrite"
               from platform_module m
              where m.is_licensable
              order by m.sort_order, m.code`,
          );

          // The database answers entitlement; the role policy answers authorization.
          // A module is effective only where both allow the operation.
          const effective = modules.rows.flatMap((row) => {
            const read = permissionFor(row.code, 'read');
            const write = permissionFor(row.code, 'write');
            const canRead =
              row.canRead && read !== null && hasPermission(member.role, read);
            const canWrite =
              row.canWrite && write !== null && hasPermission(member.role, write);
            return canRead || canWrite ? [{ ...row, canRead, canWrite }] : [];
          });

          const body: ContextResponse = {
            userId: session.userId,
            tenantId: session.tenantId,
            role: member.role,
            permissions: permissionsForRole(member.role),
            switchAccess: switchAccess.rows[0]?.allowed ?? false,
            modules: effective,
          };
          return body;
        },
      );
    } catch (error) {
      return await accessError(pool, error, request, reply, session);
    }
  });

  app.get('/v1/people', async (request, reply) => {
    const session = await currentSession(request);
    if (!session) {
      return unauthenticated(reply);
    }

    const query = request.query as Record<string, unknown>;
    const searchTerm = peopleSearchTerm(query);
    const page = peopleIntegerParam(query, 'page', 1, PEOPLE_MAX_PAGE);
    const pageSize = peopleIntegerParam(
      query,
      'pageSize',
      PEOPLE_LIST_DEFAULT_PAGE_SIZE,
      PEOPLE_LIST_MAX_PAGE_SIZE,
    );

    try {
      // The transaction sets both app.tenant_id and app.user_id, so the
      // restrictive scope policies narrow this read. No scope predicate is
      // re-implemented here.
      return await withMemberTransaction(
        pool,
        {
          tenantId: session.tenantId,
          userId: session.userId,
          gate: { module: 'people', operation: 'read' },
        },
        async (client) => {
          const clauses = ['deleted_at is null'];
          const filterValues: string[] = [];
          if (searchTerm !== '') {
            filterValues.push(searchTerm);
            const needle = `$${filterValues.length}`;
            // strpos over the lowered columns is a literal match, so a search
            // for "%" or "_" cannot behave like a LIKE wildcard.
            clauses.push(
              `(strpos(lower(display_name), lower(${needle})) > 0
                 or strpos(lower(coalesce(employee_code, '')), lower(${needle})) > 0
                 or strpos(lower(coalesce(work_email::text, '')), lower(${needle})) > 0)`,
            );
          }
          const where = clauses.join(' and ');
          const limitIndex = filterValues.length + 1;

          const matching = await client.query<{ total: string }>(
            `select count(*) as total from person where ${where}`,
            filterValues,
          );
          const pageRows = await client.query<PeopleListRow>(
            `select id,
                    employee_code,
                    first_name,
                    last_name,
                    display_name,
                    work_email::text as work_email,
                    phone
               from person
              where ${where}
              order by lower(display_name), id
              limit $${limitIndex} offset $${limitIndex + 1}`,
            [...filterValues, pageSize, (page - 1) * pageSize],
          );

          const items: PeopleListItem[] = pageRows.rows.map((row) => ({
            id: row.id,
            employeeCode: row.employee_code,
            firstName: row.first_name,
            lastName: row.last_name,
            displayName: row.display_name,
            workEmail: row.work_email,
            phone: row.phone,
          }));

          const body: PeopleListResponse = {
            items,
            total: Number(matching.rows[0]?.total ?? '0'),
            page,
            pageSize,
          };
          return body;
        },
      );
    } catch (error) {
      return await accessError(pool, error, request, reply, session);
    }
  });

  app.get('/v1/people/export', async (request, reply) => {
    const session = await currentSession(request);
    if (!session) {
      return unauthenticated(reply);
    }

    const gate = { module: 'people', operation: 'read' } as const;

    // The audit row must be durable before any CSV byte is disclosed. A
    // failure here sends a sanitized 500 and no download.
    try {
      await withMemberTransaction(
        pool,
        { tenantId: session.tenantId, userId: session.userId, gate },
        async (client) => {
          await appendAuditEvent(client, {
            action: 'people.directory.exported',
            entityType: 'tenant',
            entityId: session.tenantId,
            actorType: 'user',
            actorUserId: session.userId,
            metadata: {
              module: 'people',
              format: 'csv',
              columns: [...PEOPLE_EXPORT_COLUMNS],
            },
            ip: request.ip,
            userAgent: request.headers['user-agent'] ?? null,
          });
        },
      );
    } catch (error) {
      return await accessError(pool, error, request, reply, session);
    }

    let hijacked = false;

    try {
      await withMemberTransaction(
        pool,
        { tenantId: session.tenantId, userId: session.userId, gate },
        async (client) => {
          // The cursor is declared before headers so a query failure can still
          // produce a typed denial or error response.
          await client.query(
            `declare people_export no scroll cursor for
               select id as person_id,
                      employee_code,
                      first_name,
                      last_name,
                      display_name,
                      work_email::text as work_email,
                      phone
                 from person
                where deleted_at is null
                order by employee_code nulls last, id`,
          );

          reply.hijack();
          hijacked = true;
          const today = new Date().toISOString().slice(0, 10);
          reply.raw.writeHead(200, {
            'content-type': 'text/csv; charset=utf-8',
            'content-disposition': `attachment; filename="people-directory-${today}.csv"`,
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
          });

          await writeWithBackpressure(reply.raw, PEOPLE_EXPORT_HEADER);

          for (;;) {
            const batch = await client.query<PersonExportRow>(
              `fetch forward ${exportBatchSize} from people_export`,
            );
            if (batch.rows.length === 0) {
              break;
            }
            let chunk = '';
            for (const row of batch.rows) {
              chunk += csvRecord([
                row.person_id,
                row.employee_code,
                row.first_name,
                row.last_name,
                row.display_name,
                row.work_email,
                row.phone,
              ]);
            }
            await writeWithBackpressure(reply.raw, chunk);
          }

          await client.query('close people_export');
          reply.raw.end();
        },
      );
    } catch (error) {
      if (hijacked || reply.raw.headersSent) {
        request.log.error(error);
        if (!reply.raw.destroyed) {
          reply.raw.destroy();
        }
        return reply;
      }
      return await accessError(pool, error, request, reply, session);
    }

    return reply;
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
        return await accessError(pool, error, request, reply, session);
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
        return await accessError(pool, error, request, reply, session);
      }
    });
  }

  return app;
}
