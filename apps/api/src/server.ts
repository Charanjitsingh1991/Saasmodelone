import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import {
  InvalidTenantContextError,
  MembershipDeniedError,
  ModuleAccessDeniedError,
  PlatformAccessDeniedError,
  withMemberTransaction,
  type RuntimePool,
} from '@saasmodels/db';

export type Principal = {
  userId: string;
  tenantId: string;
};

export type Authenticate = (request: FastifyRequest) => Promise<Principal | null>;

export type CreateServerOptions = {
  pool: RuntimePool;
  authenticate: Authenticate;
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
  reply.code(500);
  return { error: { code: 'INTERNAL_ERROR' } };
}

export function createServer(options: CreateServerOptions): FastifyInstance {
  const { pool, authenticate, enableProofRoutes = false, logger = false } = options;
  const app = Fastify({ logger });

  app.setErrorHandler((error, _request, reply) => {
    reply.send(accessError(error, reply));
  });

  app.get('/health', async () => ({ status: 'ok' }));

  app.get('/v1/context', async (request, reply) => {
    const principal = await authenticate(request);
    if (!principal) {
      return unauthenticated(reply);
    }

    try {
      return await withMemberTransaction(
        pool,
        { tenantId: principal.tenantId, userId: principal.userId },
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
            userId: principal.userId,
            tenantId: principal.tenantId,
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
      const principal = await authenticate(request);
      if (!principal) {
        return unauthenticated(reply);
      }

      try {
        return await withMemberTransaction(
          pool,
          {
            tenantId: principal.tenantId,
            userId: principal.userId,
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
              [principal.tenantId],
            );
            return { items: result.rows };
          },
        );
      } catch (error) {
        return accessError(error, reply);
      }
    });

    app.get('/v1/proof/work/projects', async (request, reply) => {
      const principal = await authenticate(request);
      if (!principal) {
        return unauthenticated(reply);
      }

      try {
        return await withMemberTransaction(
          pool,
          {
            tenantId: principal.tenantId,
            userId: principal.userId,
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
              [principal.tenantId],
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
