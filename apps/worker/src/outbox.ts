import {
  ModuleAccessDeniedError,
  PlatformAccessDeniedError,
  withTenantTransaction,
  type TenantGate,
  type WorkerPool,
} from '@saasmodels/db';

// At-least-once delivery. A handler can run twice for one event: the lease
// expires while the first worker is still running, a second worker re-claims
// the event, and the first worker's late mark-published or record-failure is
// refused by the helpers because the lease timestamp no longer matches. The
// database cannot make the handler itself atomic, so handlers must be
// idempotent. Tests cover the duplicate-delivery path explicitly.

export type OutboxEvent = {
  id: string;
  type: string;
  aggregateType: string;
  aggregateId: string;
  payload: unknown;
  occurredAt: Date;
  attempts: number;
  leaseExpiresAt: Date;
};

export type OutboxHandler = (event: OutboxEvent) => void | Promise<void>;

export type OutboxHandlerRegistry = Readonly<Record<string, OutboxHandler>>;

export type OutboxPassOptions = {
  handlers: OutboxHandlerRegistry;
  gate?: TenantGate;
  batchSize?: number;
  leaseSeconds?: number;
  maxAttempts?: number;
  backoffSeconds?: number;
  maxBackoffSeconds?: number;
  errorMaxLength?: number;
};

export type OutboxSkipReason = 'platform_denied' | 'entitlement_denied';

export type OutboxPassResult = {
  tenantId: string;
  claimed: number;
  handled: number;
  retried: number;
  dead: number;
  refused: number;
  skipped: OutboxSkipReason | null;
};

export type OutboxLoopOptions = OutboxPassOptions & {
  tenantIds: readonly string[];
  workerId: string;
  pollIntervalMs?: number;
  log?: (event: Record<string, unknown>) => void;
};

const DEFAULT_GATE: TenantGate = { module: 'people', operation: 'read' };
const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_LEASE_SECONDS = 60;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BACKOFF_SECONDS = 2;
const DEFAULT_MAX_BACKOFF_SECONDS = 3_600;
const DEFAULT_ERROR_MAX_LENGTH = 2_000;

function assertIntegerRange(
  name: string,
  value: number,
  min: number,
  max: number,
): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new TypeError(`${name} must be an integer between ${min} and ${max}`);
  }
}

function assertConfigured(options: {
  workerId?: string;
  handlers: OutboxHandlerRegistry;
  batchSize?: number;
  leaseSeconds?: number;
  maxAttempts?: number;
  backoffSeconds?: number;
  maxBackoffSeconds?: number;
  errorMaxLength?: number;
}): void {
  if (options.workerId !== undefined) {
    if (
      !/^[^\s]{1,64}$/.test(options.workerId)
    ) {
      throw new TypeError('workerId must be 1-64 non-space characters');
    }
  }
  assertIntegerRange('batchSize', options.batchSize ?? DEFAULT_BATCH_SIZE, 1, 1_000);
  assertIntegerRange('leaseSeconds', options.leaseSeconds ?? DEFAULT_LEASE_SECONDS, 1, 86_400);
  assertIntegerRange('maxAttempts', options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, 1, 1_000);
  assertIntegerRange(
    'backoffSeconds',
    options.backoffSeconds ?? DEFAULT_BACKOFF_SECONDS,
    1,
    86_400,
  );
  assertIntegerRange(
    'maxBackoffSeconds',
    options.maxBackoffSeconds ?? DEFAULT_MAX_BACKOFF_SECONDS,
    1,
    86_400,
  );
  assertIntegerRange(
    'errorMaxLength',
    options.errorMaxLength ?? DEFAULT_ERROR_MAX_LENGTH,
    16,
    4_000,
  );
  for (const type of Object.keys(options.handlers)) {
    if (type.length === 0) {
      throw new TypeError('handler registry keys must be non-empty event types');
    }
  }
}

function retryDelaySeconds(options: {
  backoffSeconds?: number;
  maxBackoffSeconds?: number;
  attempts: number;
}): number {
  const base = options.backoffSeconds ?? DEFAULT_BACKOFF_SECONDS;
  const cap = options.maxBackoffSeconds ?? DEFAULT_MAX_BACKOFF_SECONDS;
  const exponent = Math.min(options.attempts - 1, 16);
  return Math.min(cap, base * 2 ** exponent);
}

type ClaimRow = {
  id: string;
  type: string;
  aggregate_type: string;
  aggregate_id: string;
  payload: unknown;
  occurred_at: Date;
  attempts: number;
  lease_expires_at: Date;
};

function toEvent(row: ClaimRow): OutboxEvent {
  return {
    id: row.id,
    type: row.type,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    payload: row.payload,
    occurredAt: row.occurred_at,
    attempts: row.attempts,
    leaseExpiresAt: row.lease_expires_at,
  };
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class OutboxCallFailedError extends Error {
  readonly code = 'OUTBOX_CALL_FAILED' as const;

  constructor(operation: string, readonly eventId: string) {
    super(`Outbox ${operation} update failed for event ${eventId}`);
    this.name = 'OutboxCallFailedError';
  }
}

/**
 * One outbox pass for one tenant: platform and entitlement are checked by the
 * existing tenant transaction and tenant gate before anything is claimed, so
 * a suspended or unentitled tenant has no handler run for it at all. Claims
 * happen inside that transaction through app.outbox_claim; handlers run after
 * the transaction closed, and each outcome is written back through its own
 * short transaction so a throwing handler cannot roll the lease bookkeeping
 * back with it.
 */
export async function runOutboxPass(
  pool: WorkerPool,
  tenantId: string,
  options: OutboxPassOptions & { workerId: string },
): Promise<OutboxPassResult> {
  assertConfigured(options);
  const gate = options.gate ?? DEFAULT_GATE;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const leaseSeconds = options.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const errorMaxLength = options.errorMaxLength ?? DEFAULT_ERROR_MAX_LENGTH;
  const workerId = options.workerId;

  let claimedRows: OutboxEvent[];
  try {
    claimedRows = await withTenantTransaction(pool, { tenantId, gate }, async (client) => {
      const claimed = await client.query<ClaimRow>(
        'select * from app.outbox_claim($1, $2, $3, $4)',
        [batchSize, workerId, leaseSeconds, maxAttempts],
      );
      return claimed.rows.map(toEvent);
    });
  } catch (error) {
    if (error instanceof PlatformAccessDeniedError) {
      return {
        tenantId,
        claimed: 0,
        handled: 0,
        retried: 0,
        dead: 0,
        refused: 0,
        skipped: 'platform_denied',
      };
    }
    if (error instanceof ModuleAccessDeniedError) {
      return {
        tenantId,
        claimed: 0,
        handled: 0,
        retried: 0,
        dead: 0,
        refused: 0,
        skipped: 'entitlement_denied',
      };
    }
    throw error;
  }

  const result: OutboxPassResult = {
    tenantId,
    claimed: claimedRows.length,
    handled: 0,
    retried: 0,
    dead: 0,
    refused: 0,
    skipped: null,
  };

  for (const event of claimedRows) {
    const handler = options.handlers[event.type];
    try {
      if (handler) {
        await handler(event);
      } else {
        throw new Error(`no handler registered for event type ${event.type}`);
      }
    } catch (handlerError) {
      const retryIn = retryDelaySeconds({
        backoffSeconds: options.backoffSeconds,
        maxBackoffSeconds: options.maxBackoffSeconds,
        attempts: event.attempts,
      });
      const outcome = await withTenantTransaction(pool, { tenantId, gate }, async (client) => {
        const recorded = await client.query<{ outcome: string }>(
          'select app.outbox_record_failure($1, $2, $3, make_interval(secs => $4), $5) as outcome',
          [
            event.id,
            workerId,
            maxAttempts,
            retryIn,
            failureMessage(handlerError).slice(0, errorMaxLength),
          ],
        );
        return recorded.rows[0]?.outcome ?? 'refused';
      }).catch(() => 'call_failed');

      if (outcome === 'dead') {
        result.dead += 1;
      } else if (outcome === 'retried') {
        result.retried += 1;
      } else if (outcome === 'call_failed') {
        throw new OutboxCallFailedError('record_failure', event.id);
      } else {
        result.refused += 1;
      }
      continue;
    }

    const published = await withTenantTransaction(pool, { tenantId, gate }, async (client) => {
      const marked = await client.query<{ published: boolean }>(
        'select app.outbox_mark_published($1, $2) as published',
        [event.id, workerId],
      );
      return marked.rows[0]?.published === true;
    }).catch(() => undefined);

    if (published === undefined) {
      throw new OutboxCallFailedError('mark_published', event.id);
    }
    if (published) {
      result.handled += 1;
    } else {
      // The lease was stolen or the event is already disposed elsewhere.
      // At-least-once says the duplicate is expected; leave it disposed.
      result.refused += 1;
    }
  }

  return result;
}

export type OutboxWorker = {
  /** One full pass over every configured tenant; exposed for tests and ops. */
  runPass: () => Promise<OutboxPassResult[]>;
  stop: () => void;
};

/**
 * The polling loop. Each pass visits every tenant in order; a tenant error
 * other than the expected denials is logged and the loop keeps running, so
 * one broken tenant cannot stop the others. The tenant list is the operator's
 * configuration: this loop has no discovery of tenants, no HTTP surface, no
 * scheduler and no broker; it runs on Postgres alone.
 */
export function startOutboxWorker(
  pool: WorkerPool,
  options: OutboxLoopOptions,
): OutboxWorker {
  assertConfigured(options);
  const log = options.log ?? (() => undefined);
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  assertIntegerRange('pollIntervalMs', pollIntervalMs, 10, 3_600_000);

  for (const tenantId of options.tenantIds) {
    if (typeof tenantId !== 'string' || tenantId.length === 0) {
      throw new TypeError('tenantIds must contain non-empty tenant ids');
    }
  }

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function runPass(): Promise<OutboxPassResult[]> {
    const results: OutboxPassResult[] = [];
    for (const tenantId of options.tenantIds) {
      if (stopped) {
        return results;
      }
      try {
        const result = await runOutboxPass(pool, tenantId, options);
        results.push(result);
        log({ event: 'outbox.pass', ...result });
      } catch (error) {
        log({
          event: 'outbox.tenant_error',
          tenantId,
          error: failureMessage(error),
        });
      }
    }
    return results;
  }

  function schedule(): void {
    if (stopped) {
      return;
    }
    timer = setTimeout(() => {
      void runPass()
        .catch((error: unknown) => {
          log({ event: 'outbox.pass_error', error: failureMessage(error) });
        })
        .finally(() => schedule());
    }, pollIntervalMs);
    timer.unref?.();
  }

  schedule();

  return {
    runPass,
    stop: () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}
