import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import cookie from '@fastify/cookie';
import {
  hasPermission,
  permissionFor,
  permissionsForRole,
  COMPENSATION_CTC_MINOR_MAX,
  COMPENSATION_PAY_FREQUENCIES,
  CONTENT_LIST_DEFAULT_PAGE_SIZE,
  CONTENT_LIST_MAX_PAGE_SIZE,
  CONTENT_SEARCH_MAX_LENGTH,
  CRM_ACCOUNT_STATUSES,
  CRM_LEAD_OPEN_STAGES,
  CRM_LEAD_STAGES,
  CRM_LIST_DEFAULT_PAGE_SIZE,
  CRM_LIST_MAX_PAGE_SIZE,
  CRM_PAYMENT_TERMS_DAYS_MAX,
  CRM_SEARCH_MAX_LENGTH,
  EMPLOYMENT_NOTICE_DAYS_MAX,
  EMPLOYMENT_STATUSES,
  EMPLOYMENT_TYPES,
  MONEY_LIST_DEFAULT_PAGE_SIZE,
  MONEY_LIST_MAX_PAGE_SIZE,
  MONEY_SEARCH_MAX_LENGTH,
  PEOPLE_LIST_DEFAULT_PAGE_SIZE,
  PEOPLE_LIST_MAX_PAGE_SIZE,
  PEOPLE_SEARCH_MAX_LENGTH,
  PERSON_DISPLAY_NAME_MAX_LENGTH,
  PERSON_EMPLOYEE_CODE_MAX_LENGTH,
  PERSON_NAME_MAX_LENGTH,
  PERSON_PHONE_MAX_LENGTH,
  PERSON_WORK_EMAIL_MAX_LENGTH,
  WORK_LIST_DEFAULT_PAGE_SIZE,
  WORK_LIST_MAX_PAGE_SIZE,
  WORK_SEARCH_MAX_LENGTH,
  type ContextModule,
  type ContextResponse,
  type CompensationItem,
  type CompensationListResponse,
  type CompensationPayFrequency,
  type ContentListItem,
  type ContentListResponse,
  type CrmAccountListItem,
  type CrmAccountListResponse,
  type CrmContactItem,
  type CrmContactListResponse,
  type CrmLeadConversionResponse,
  type CrmLeadItem,
  type CrmLeadListResponse,
  type CrmLeadStage,
  type EmploymentItem,
  type EmploymentListResponse,
  type EmploymentStatus,
  type EmploymentType,
  type InvoiceListItem,
  type InvoiceListResponse,
  type PeopleListItem,
  type PeopleListResponse,
  type PeoplePlacementInput,
  type PeoplePlacementOptions,
  type ProjectListItem,
  type ProjectListResponse,
  type SessionResponse,
} from '@saasmodels/contracts';
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import type { PoolClient } from 'pg';
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
  legal_entity_id: string | null;
  legal_entity_name: string | null;
  org_unit_id: string | null;
  org_unit_name: string | null;
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

// The session cookie proves who is calling; this proves the call came from our
// own page rather than a forged cross-site form. Every state-changing endpoint
// uses it, before any tenant data is touched.
function requireCsrfToken(session: SessionRecord, request: FastifyRequest): void {
  const csrf = request.headers[CSRF_HEADER];
  if (typeof csrf !== 'string' || !secretsEqual(csrf, session.csrfToken)) {
    throw new ApiError(403, 'CSRF_INVALID');
  }
}

// The last page a caller may ask for. Anything larger, or a value that is not
// a plain non-negative integer, is a client error rather than a database error.
const LIST_MAX_PAGE = 1_000_000;

// The three list parameters are read the same way for every list route - the
// directory, the projects, the invoices and the content items - so a malformed
// page or a repeated parameter is answered identically wherever it arrives.
function queryStringParam(
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

function listSearchTerm(
  query: Record<string, unknown>,
  maxLength: number,
): string {
  const raw = queryStringParam(query, 'q');
  if (raw === null) {
    return '';
  }
  const term = raw.trim();
  if (term.length > maxLength) {
    throw new ApiError(400, 'INVALID_QUERY');
  }
  return term;
}

function listIntegerParam(
  query: Record<string, unknown>,
  name: string,
  fallback: number,
  max: number,
): number {
  const raw = queryStringParam(query, name);
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

// The person identity columns this milestone may write, in the order the
// contract names them. Status, personal email, demographics and the user link
// are absent because the runtime holds no write privilege on them. Placement is
// absent too: it is a separate route with its own contract below, and the
// runtime INSERT list has no placement column, so a person is only ever created
// unplaced and placed afterwards.
const PEOPLE_WRITE_FIELDS = [
  'firstName',
  'lastName',
  'displayName',
  'employeeCode',
  'workEmail',
  'phone',
] as const;

type PeopleWriteField = (typeof PEOPLE_WRITE_FIELDS)[number];

const PEOPLE_WRITE_COLUMNS: Record<PeopleWriteField, string> = {
  firstName: 'first_name',
  lastName: 'last_name',
  displayName: 'display_name',
  employeeCode: 'employee_code',
  workEmail: 'work_email',
  phone: 'phone',
};

const PEOPLE_WRITE_MAX_LENGTH: Record<PeopleWriteField, number> = {
  firstName: PERSON_NAME_MAX_LENGTH,
  lastName: PERSON_NAME_MAX_LENGTH,
  displayName: PERSON_DISPLAY_NAME_MAX_LENGTH,
  employeeCode: PERSON_EMPLOYEE_CODE_MAX_LENGTH,
  workEmail: PERSON_WORK_EMAIL_MAX_LENGTH,
  phone: PERSON_PHONE_MAX_LENGTH,
};

type PeopleWriteParse = {
  // Field names the caller actually sent, so the audit can record which fields
  // were written without recording any of their values.
  present: PeopleWriteField[];
  // Trimmed values. A blank or null optional field is null; an absent field is
  // undefined, which the update path reads as "unchanged".
  values: Partial<Record<PeopleWriteField, string | null>>;
};

function peopleWriteObject(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(400, 'INVALID_BODY');
  }
  return body as Record<string, unknown>;
}

function isWorkEmail(value: string): boolean {
  if (/\s/.test(value)) {
    return false;
  }
  const parts = value.split('@');
  if (parts.length !== 2) {
    return false;
  }
  const [local, domain] = parts;
  if (!local || !domain || domain.startsWith('.') || domain.endsWith('.')) {
    return false;
  }
  return domain.includes('.') && !domain.split('.').some((label) => label === '');
}

// One parser for both writes: create requires firstName, update treats every
// key as "send it to change it, omit it to keep it".
function parsePeopleWrite(body: Record<string, unknown>, mode: 'create' | 'update'): PeopleWriteParse {
  for (const key of Object.keys(body)) {
    if (!(PEOPLE_WRITE_FIELDS as readonly string[]).includes(key)) {
      throw new ApiError(400, 'INVALID_BODY');
    }
  }

  const present: PeopleWriteField[] = [];
  const values: Partial<Record<PeopleWriteField, string | null>> = {};

  for (const field of PEOPLE_WRITE_FIELDS) {
    if (!Object.hasOwn(body, field)) {
      continue;
    }
    const raw = body[field];
    if (raw !== null && typeof raw !== 'string') {
      throw new ApiError(400, 'INVALID_BODY');
    }
    const trimmed = typeof raw === 'string' ? raw.trim() : '';
    if (trimmed === '') {
      // firstName is the one field that must always hold a value, and the only
      // one that can never be cleared.
      if (field === 'firstName') {
        throw new ApiError(400, 'INVALID_BODY');
      }
      present.push(field);
      values[field] = null;
      continue;
    }
    if (trimmed.length > PEOPLE_WRITE_MAX_LENGTH[field]) {
      throw new ApiError(400, 'INVALID_BODY');
    }
    if (field === 'workEmail' && !isWorkEmail(trimmed)) {
      throw new ApiError(400, 'INVALID_BODY');
    }
    present.push(field);
    values[field] = trimmed;
  }

  if (mode === 'create' && typeof values.firstName !== 'string') {
    throw new ApiError(400, 'INVALID_BODY');
  }
  if (present.length === 0) {
    throw new ApiError(400, 'INVALID_BODY');
  }
  return { present, values };
}

// An absent key leaves the stored value alone; a null or blank key clears it.
function pickPeopleField(
  parsed: PeopleWriteParse,
  field: PeopleWriteField,
  current: string | null,
): string | null {
  if (!Object.hasOwn(parsed.values, field)) {
    return current;
  }
  return parsed.values[field] ?? null;
}

// The directory shows one name per person, so the two halves have to fit the
// display column together with the separator that joins them.
function checkCombinedName(firstName: string, lastName: string | null): void {
  if (`${firstName} ${lastName ?? ''}`.trim().length > PERSON_DISPLAY_NAME_MAX_LENGTH) {
    throw new ApiError(400, 'INVALID_BODY');
  }
}

function deriveDisplayName(firstName: string, lastName: string | null): string {
  const displayName = `${firstName} ${lastName ?? ''}`.trim();
  if (displayName === '' || displayName.length > PERSON_DISPLAY_NAME_MAX_LENGTH) {
    throw new ApiError(400, 'INVALID_BODY');
  }
  return displayName;
}

function peopleItemFromRow(row: PeopleListRow): PeopleListItem {
  return {
    id: row.id,
    employeeCode: row.employee_code,
    firstName: row.first_name,
    lastName: row.last_name,
    displayName: row.display_name,
    workEmail: row.work_email,
    phone: row.phone,
    legalEntityId: row.legal_entity_id,
    legalEntityName: row.legal_entity_name,
    orgUnitId: row.org_unit_id,
    orgUnitName: row.org_unit_name,
  };
}

// One shared read behind every directory item response - list, create, identity
// update and placement - so all four answer with the same eleven keys. The
// placement ids come from the person row; the names come from the reference
// tables and are null when the person is unplaced or the referenced row is
// soft-deleted, so a retired legal entity or org unit never keeps a name in the
// directory while its id stays visible on the person.
const DIRECTORY_SELECT = `select p.id,
                    p.employee_code,
                    p.first_name,
                    p.last_name,
                    p.display_name,
                    p.work_email::text as work_email,
                    p.phone,
                    p.legal_entity_id,
                    le.name as legal_entity_name,
                    p.org_unit_id,
                    ou.name as org_unit_name`;

// The joins address a reference row by its globally unique id and never filter
// on tenant_id: the composite (tenant_id, id) foreign key from person plus each
// reference table's tenant_isolation policy make a cross-tenant reference
// unreadable. ADR 0009 records the reasoning.
const DIRECTORY_FROM = `from person p
          left join legal_entity le on le.id = p.legal_entity_id and le.deleted_at is null
          left join org_unit ou on ou.id = p.org_unit_id and ou.deleted_at is null`;

const UUID_TEXT_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PEOPLE_PLACEMENT_FIELDS = ['legalEntityId', 'orgUnitId'] as const;

// A placement is always written as one pair, so the body must carry exactly
// these two keys and each is a UUID or null. There is no "omit it to keep it"
// here: an absent or unknown key, a non-string id, an empty object and an array
// are all one INVALID_BODY.
function parsePeoplePlacement(body: unknown): PeoplePlacementInput {
  const object = peopleWriteObject(body);

  const keys = Object.keys(object).sort();
  if (
    keys.length !== PEOPLE_PLACEMENT_FIELDS.length ||
    keys.some((key, index) => key !== PEOPLE_PLACEMENT_FIELDS[index])
  ) {
    throw new ApiError(400, 'INVALID_BODY');
  }

  const ids: Record<(typeof PEOPLE_PLACEMENT_FIELDS)[number], string | null> = {
    legalEntityId: null,
    orgUnitId: null,
  };
  for (const field of PEOPLE_PLACEMENT_FIELDS) {
    const raw = object[field];
    if (raw === null) {
      continue;
    }
    if (typeof raw !== 'string' || !UUID_TEXT_PATTERN.test(raw)) {
      throw new ApiError(400, 'INVALID_BODY');
    }
    // Lowercased so a comparison against the value the database reads back is
    // one comparison, not two spellings of the same id.
    ids[field] = raw.toLowerCase();
  }

  // An org unit is always placed under its own legal entity, so a unit with no
  // entity names no placement this route can store.
  if (ids.legalEntityId === null && ids.orgUnitId !== null) {
    throw new ApiError(400, 'INVALID_BODY');
  }
  return ids;
}

// The employment values this slice may write. work_jurisdiction_id, the source
// and import columns and both timestamps are absent because no route here
// records a jurisdiction, an import or a system-managed history, and status is
// absent from create because a new row always starts active.
const EMPLOYMENT_WRITE_FIELDS = [
  'employmentType',
  'startDate',
  'endDate',
  'probationEndDate',
  'noticeDays',
] as const;

const EMPLOYMENT_PATCH_FIELDS = [...EMPLOYMENT_WRITE_FIELDS, 'status'] as const;

type EmploymentPatchField = (typeof EMPLOYMENT_PATCH_FIELDS)[number];

const EMPLOYMENT_COLUMNS: Record<EmploymentPatchField, string> = {
  employmentType: 'employment_type',
  startDate: 'start_date',
  endDate: 'end_date',
  probationEndDate: 'probation_end_date',
  noticeDays: 'notice_days',
  status: 'status',
};

// The five writable values of one row. The patch route fills the gaps from the
// stored row, so both routes decide their invariants over one complete shape.
type EmploymentValues = {
  employmentType: EmploymentType;
  startDate: string;
  endDate: string | null;
  probationEndDate: string | null;
  noticeDays: number | null;
};

type EmploymentWriteParse = {
  // Field names the caller actually sent, so the audit can record which fields
  // were written without recording a date, a notice period or a status.
  present: EmploymentPatchField[];
  values: Partial<EmploymentValues>;
  status: EmploymentStatus | undefined;
};

// A date column holds one real day, so both the shape and the calendar are
// checked here: 2026-02-30 has a valid shape and no such day exists, and an
// impossible date that reached SQL would answer as a 500 the client cannot act
// on. Years are four digits and zero-padded on the way in, which is also what
// makes the string comparison below a date comparison.
function employmentDate(value: unknown): string {
  if (typeof value !== 'string') {
    throw new ApiError(400, 'INVALID_BODY');
  }
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (parts === null) {
    throw new ApiError(400, 'INVALID_BODY');
  }
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month)
  ) {
    throw new ApiError(400, 'INVALID_BODY');
  }
  return value;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    return isLeapYear(year) ? 29 : 28;
  }
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

// The table only requires notice_days >= 0, so this ceiling exists nowhere else.
function employmentNoticeDays(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > EMPLOYMENT_NOTICE_DAYS_MAX
  ) {
    throw new ApiError(400, 'INVALID_BODY');
  }
  return value;
}

// One list check for both enums, so a value outside the contract never reaches
// the column CHECK and answers as a database error.
function employmentEnumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new ApiError(400, 'INVALID_BODY');
  }
  return value as T;
}

// One parser for both writes: create takes exactly the five writable fields and
// must name the type and the start date, patch takes any non-empty subset of
// those five plus status. An absent key leaves the stored value alone, a null
// clears an optional date or the notice days, and a null for employmentType,
// startDate or status is refused because a row always holds all three.
function parseEmploymentWrite(
  body: Record<string, unknown>,
  mode: 'create' | 'patch',
): EmploymentWriteParse {
  const allowed = mode === 'create' ? EMPLOYMENT_WRITE_FIELDS : EMPLOYMENT_PATCH_FIELDS;
  for (const key of Object.keys(body)) {
    if (!(allowed as readonly string[]).includes(key)) {
      throw new ApiError(400, 'INVALID_BODY');
    }
  }

  const present: EmploymentPatchField[] = [];
  const values: Partial<EmploymentValues> = {};
  let status: EmploymentStatus | undefined;

  for (const field of allowed) {
    if (!Object.hasOwn(body, field)) {
      continue;
    }
    const raw = body[field];

    if (field === 'employmentType') {
      values.employmentType = employmentEnumValue(raw, EMPLOYMENT_TYPES);
    } else if (field === 'noticeDays') {
      // notice_days is nullable, so a null is a clearing rather than a type
      // error, on both modes.
      values.noticeDays = raw === null ? null : employmentNoticeDays(raw);
    } else if (field === 'status') {
      status = employmentEnumValue(raw, EMPLOYMENT_STATUSES);
    } else if (field === 'startDate') {
      values.startDate = employmentDate(raw);
    } else if (raw === null) {
      values[field] = null;
    } else {
      values[field] = employmentDate(raw);
    }
    present.push(field);
  }

  if (present.length === 0) {
    throw new ApiError(400, 'INVALID_BODY');
  }
  if (
    mode === 'create' &&
    (values.employmentType === undefined || values.startDate === undefined)
  ) {
    throw new ApiError(400, 'INVALID_BODY');
  }
  return { present, values, status };
}

// Two dates or a status that contradict each other are a bad request, not a
// database rejection: the end date follows the start, probation follows the
// start, and a row that says it has ended has to say when. The probation rule
// and the ended-needs-an-end-date rule have no database CHECK, so they live here
// with the one that does.
function checkEmploymentValues(
  values: EmploymentValues,
  status: EmploymentStatus,
): void {
  if (
    (values.endDate !== null && values.endDate < values.startDate) ||
    (values.probationEndDate !== null &&
      values.probationEndDate < values.startDate) ||
    (status === 'ended' && values.endDate === null)
  ) {
    throw new ApiError(400, 'INVALID_BODY');
  }
}

// Status only moves forward. Reopening an ended row, cancelling an ended one, or
// reviving a cancelled one would rewrite history the directory has already
// reported, and a payroll run built on that row later would inherit the rewrite.
function checkEmploymentTransition(
  current: EmploymentStatus,
  next: EmploymentStatus,
): void {
  if (current === next || (current === 'active' && next !== 'active')) {
    return;
  }
  throw new ApiError(409, 'EMPLOYMENT_STATUS_TRANSITION_INVALID');
}

// One shared read behind every employment response - list, create read-back and
// patch read-back - so all three answer with the same ten keys. The dates are
// formatted in SQL because the wire shape is one calendar day, not a timestamp a
// session timezone can shift; the entity id comes from the employment row and the
// name from the reference row, so a retired legal entity loses its name while
// the history keeps naming the entity it was written against.
const EMPLOYMENT_SELECT = `select e.id,
                    e.person_id,
                    e.legal_entity_id,
                    le.name as legal_entity_name,
                    e.employment_type,
                    to_char(e.start_date, 'YYYY-MM-DD') as start_date,
                    to_char(e.end_date, 'YYYY-MM-DD') as end_date,
                    to_char(e.probation_end_date, 'YYYY-MM-DD') as probation_end_date,
                    e.notice_days,
                    e.status`;

const EMPLOYMENT_FROM = `from employment e
          left join legal_entity le on le.id = e.legal_entity_id and le.deleted_at is null`;

const EMPLOYMENT_ORDER = 'order by e.start_date desc, e.id';

type EmploymentRow = {
  id: string;
  person_id: string;
  legal_entity_id: string;
  legal_entity_name: string | null;
  employment_type: EmploymentType;
  start_date: string;
  end_date: string | null;
  probation_end_date: string | null;
  notice_days: number | null;
  status: EmploymentStatus;
};

function employmentItemFromRow(row: EmploymentRow): EmploymentItem {
  return {
    id: row.id,
    personId: row.person_id,
    legalEntityId: row.legal_entity_id,
    legalEntityName: row.legal_entity_name,
    employmentType: row.employment_type,
    startDate: row.start_date,
    endDate: row.end_date,
    probationEndDate: row.probation_end_date,
    noticeDays: row.notice_days,
    status: row.status,
  };
}

// One shared read behind every compensation response. There is only one - the
// list - but it is spelled out as fragments the way the employment and identity
// reads are, so the columns the runtime is granted are visible in one place.
//
// The dates are formatted in SQL because the wire shape is one calendar day, not
// a timestamp a session timezone can shift. ctc_minor is read as text: the
// column is a bigint and only the database can promise its full range, so the
// conversion to a JavaScript number happens in compensationItemFromRow, where a
// value outside Number.MAX_SAFE_INTEGER is refused instead of rounded. The
// amount is never converted, annualised or prorated here or anywhere else in
// this build - see suite/docs/adr/0011-compensation-read.md.
const COMPENSATION_SELECT = `select c.id,
                    c.person_id,
                    to_char(c.effective_from, 'YYYY-MM-DD') as effective_from,
                    to_char(c.effective_to, 'YYYY-MM-DD') as effective_to,
                    c.ctc_minor::text as ctc_minor,
                    c.currency,
                    c.pay_frequency`;

const COMPENSATION_FROM = 'from compensation c';

// Newest period first, with the id as the tie-breaker so two rows sharing an
// effective_from answer in a stable order.
const COMPENSATION_ORDER = 'order by c.effective_from desc, c.id';

type CompensationRow = {
  id: string;
  person_id: string;
  effective_from: string;
  effective_to: string | null;
  ctc_minor: string;
  currency: string;
  pay_frequency: CompensationPayFrequency;
};

function compensationItemFromRow(row: CompensationRow): CompensationItem {
  const ctcMinor = Number.parseInt(row.ctc_minor, 10);
  // A bigint the runtime can read but a JavaScript number cannot hold exactly.
  // Answering 500 is honest; answering a rounded figure on a money column is
  // not, and no caller downstream can tell the difference.
  if (!Number.isSafeInteger(ctcMinor)) {
    throw new ApiError(500, 'INTERNAL_ERROR');
  }
  return {
    id: row.id,
    personId: row.person_id,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    ctcMinor,
    currency: row.currency,
    payFrequency: row.pay_frequency,
  };
}

// The compensation columns this slice may write, in the order the contract names
// them. person_id, tenant_id and id are writable on the INSERT grant but are not
// here: the first comes from the path, the second is the session's tenant and the
// third is generated by the route. structure, the source and import columns and
// the timestamps are absent because the runtime holds no privilege on any of
// them, so a caller has no way to name them.
const COMPENSATION_WRITE_FIELDS = [
  'effectiveFrom',
  'effectiveTo',
  'ctcMinor',
  'currency',
  'payFrequency',
] as const;

type CompensationWriteField = (typeof COMPENSATION_WRITE_FIELDS)[number];

const COMPENSATION_COLUMNS: Record<CompensationWriteField, string> = {
  effectiveFrom: 'effective_from',
  effectiveTo: 'effective_to',
  ctcMinor: 'ctc_minor',
  currency: 'currency',
  payFrequency: 'pay_frequency',
};

// The five values of one row, always complete. The patch route fills the gaps
// from the stored row, so both routes decide the table's invariants over one
// shape rather than over a half-supplied one.
type CompensationValues = {
  effectiveFrom: string;
  effectiveTo: string | null;
  ctcMinor: number;
  currency: string;
  payFrequency: CompensationPayFrequency;
};

type CompensationWriteParse = {
  // Field names the caller actually sent, so the audit can record which fields
  // were written without recording the amount, the currency, a date or a
  // frequency - all of which are still readable on the row itself.
  present: CompensationWriteField[];
  values: Partial<CompensationValues>;
};

// Money is bigint minor units plus an ISO code, so the two halves of an amount
// are validated separately and neither is ever coerced. The scale factor is a
// database convention with no exponent table behind it, so an amount that a
// JavaScript number could round is refused rather than tidied.
function compensationCtcMinor(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > COMPENSATION_CTC_MINOR_MAX
  ) {
    throw new ApiError(400, 'INVALID_BODY');
  }
  return value;
}

// Three upper-case ASCII letters and nothing else. Lower case is refused rather
// than upper-cased: a client that sends "inr" has a bug in its own currency
// handling, and silently storing "INR" would hide it while inventing a value the
// caller never sent.
function compensationCurrency(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Z]{3}$/.test(value)) {
    throw new ApiError(400, 'INVALID_BODY');
  }
  return value;
}

// One parser for both writes: create must name the four values a row cannot
// exist without, patch takes any non-empty subset of the five. An absent key
// leaves the stored value alone, and a null is accepted only for effective_to -
// the table's CHECKs give amount, currency and frequency no null to hold.
function parseCompensationWrite(
  body: Record<string, unknown>,
  mode: 'create' | 'patch',
): CompensationWriteParse {
  for (const key of Object.keys(body)) {
    if (!(COMPENSATION_WRITE_FIELDS as readonly string[]).includes(key)) {
      throw new ApiError(400, 'INVALID_BODY');
    }
  }

  const present: CompensationWriteField[] = [];
  const values: Partial<CompensationValues> = {};

  for (const field of COMPENSATION_WRITE_FIELDS) {
    if (!Object.hasOwn(body, field)) {
      continue;
    }
    const raw = body[field];
    if (field === 'effectiveTo') {
      values.effectiveTo = raw === null ? null : employmentDate(raw);
    } else if (field === 'effectiveFrom') {
      values.effectiveFrom = employmentDate(raw);
    } else if (field === 'ctcMinor') {
      values.ctcMinor = compensationCtcMinor(raw);
    } else if (field === 'currency') {
      values.currency = compensationCurrency(raw);
    } else {
      values.payFrequency = employmentEnumValue(raw, COMPENSATION_PAY_FREQUENCIES);
    }
    present.push(field);
  }

  if (present.length === 0) {
    throw new ApiError(400, 'INVALID_BODY');
  }
  if (
    mode === 'create' &&
    (values.effectiveFrom === undefined ||
      values.ctcMinor === undefined ||
      values.currency === undefined ||
      values.payFrequency === undefined)
  ) {
    throw new ApiError(400, 'INVALID_BODY');
  }
  return { present, values };
}

// The one ordering rule this table has a CHECK for: a period cannot end before
// it begins. Overlap is deliberately not checked here or anywhere else - see
// suite/docs/adr/0012-compensation-write.md.
function checkCompensationValues(values: CompensationValues): void {
  if (values.effectiveTo !== null && values.effectiveTo < values.effectiveFrom) {
    throw new ApiError(400, 'INVALID_BODY');
  }
}

// ---------------------------------------------------------------------------
// The Work, Money and Content read surfaces.
//
// Three list routes, one shape: the same page parameters, the same literal
// search, the same count over the same predicate and the same body. What
// differs is the table and the columns it names.
//
// Two rules hold for all three:
//
// - No scope predicate is restated here. The transaction sets app.tenant_id
//   and app.user_id, the permissive tenant_isolation policy keeps the rows
//   inside the tenant, and the restrictive module_work_read,
//   module_money_read and module_content_read policies narrow them further.
//   The route never filters on tenant_id.
// - Money is read as text and converted here. The columns are bigint minor
//   units and only the database can promise their full range, so a value
//   outside Number.MAX_SAFE_INTEGER is refused rather than rounded. This is
//   the same convention as the compensation read in ADR 0011.
// ---------------------------------------------------------------------------

// A bigint the runtime can read but a JavaScript number cannot hold exactly.
// Answering 500 is honest; answering a rounded figure on a money column is
// not, and no caller downstream can tell the difference.
function minorAmount(value: string): number {
  const amount = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(amount)) {
    throw new ApiError(500, 'INTERNAL_ERROR');
  }
  return amount;
}

// The Work route names only the columns it returns. project carries the M0
// table-level grant, so the runtime could read more of it than this route
// chooses to: source_system, source_id, import_batch_id, imported_at,
// budget_hours, manager_user_id and tenant_id are never selected here.
const PROJECT_SELECT = `select p.id,
                    p.code,
                    p.name,
                    p.client_id,
                    c.name as client_name,
                    p.status,
                    p.currency,
                    to_char(p.start_date, 'YYYY-MM-DD') as start_date,
                    to_char(p.end_date, 'YYYY-MM-DD') as end_date,
                    p.budget_minor::text as budget_minor`;

// The client is shared-directory data with no module policy of its own, so it
// is joined the way the directory joins its reference tables: by the globally
// unique id, never by tenant_id, and a soft-deleted client answers with a null
// name rather than a retired one.
const PROJECT_FROM = `from project p
          left join client c on c.id = p.client_id and c.deleted_at is null`;

type ProjectRow = {
  id: string;
  code: string | null;
  name: string;
  client_id: string;
  client_name: string | null;
  status: string;
  currency: string;
  start_date: string | null;
  end_date: string | null;
  budget_minor: string | null;
};

function projectItemFromRow(row: ProjectRow): ProjectListItem {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    clientId: row.client_id,
    clientName: row.client_name,
    status: row.status,
    currency: row.currency,
    startDate: row.start_date,
    endDate: row.end_date,
    budgetMinor: row.budget_minor === null ? null : minorAmount(row.budget_minor),
  };
}

// The Money route names only the columns it returns, and every amount is the
// stored minor-unit figure beside its own currency code. There is no rate, no
// jurisdiction and no derived state in this query: tax_minor is the stored tax
// amount and total_minor is the stored total.
const INVOICE_SELECT = `select i.id,
                    i.number,
                    i.client_id,
                    c.name as client_name,
                    i.status,
                    to_char(i.issue_date, 'YYYY-MM-DD') as issue_date,
                    to_char(i.due_date, 'YYYY-MM-DD') as due_date,
                    i.currency,
                    i.subtotal_minor::text as subtotal_minor,
                    i.tax_minor::text as tax_minor,
                    i.total_minor::text as total_minor,
                    i.amount_paid_minor::text as amount_paid_minor`;

const INVOICE_FROM = `from invoice i
          left join client c on c.id = i.client_id and c.deleted_at is null`;

type InvoiceRow = {
  id: string;
  number: string;
  client_id: string;
  client_name: string | null;
  status: string;
  issue_date: string;
  due_date: string;
  currency: string;
  subtotal_minor: string;
  tax_minor: string;
  total_minor: string;
  amount_paid_minor: string;
};

function invoiceItemFromRow(row: InvoiceRow): InvoiceListItem {
  return {
    id: row.id,
    number: row.number,
    clientId: row.client_id,
    clientName: row.client_name,
    status: row.status,
    issueDate: row.issue_date,
    dueDate: row.due_date,
    currency: row.currency,
    subtotalMinor: minorAmount(row.subtotal_minor),
    taxMinor: minorAmount(row.tax_minor),
    totalMinor: minorAmount(row.total_minor),
    amountPaidMinor: minorAmount(row.amount_paid_minor),
  };
}

// The Content route names only the columns it returns. A content item has no
// client column, so this query joins nothing. The two timestamps are rendered
// as calendar days in UTC, so a session timezone cannot shift a stored day and
// a published item reads the same for every reader.
const CONTENT_SELECT = `select ct.id,
                    ct.kind,
                    ct.slug,
                    ct.title,
                    ct.locale,
                    ct.status,
                    to_char(ct.published_at at time zone 'UTC', 'YYYY-MM-DD') as published_at,
                    to_char(ct.updated_at at time zone 'UTC', 'YYYY-MM-DD') as updated_at`;

const CONTENT_FROM = 'from content_item ct';

type ContentRow = {
  id: string;
  kind: string;
  slug: string;
  title: string;
  locale: string;
  status: string;
  published_at: string | null;
  updated_at: string;
};

function contentItemFromRow(row: ContentRow): ContentListItem {
  return {
    id: row.id,
    kind: row.kind,
    slug: row.slug,
    title: row.title,
    locale: row.locale,
    status: row.status,
    publishedAt: row.published_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// The CRM account surface.
//
// A CRM account is a shared client record. The platform owns client identity
// and CRM is the module that reads and writes it, so this is not a second
// account table and not a copy of one. The route therefore selects the client
// row directly, and the module policy that protects it is the module gate on
// the route rather than a restrictive policy on the table: client carries the
// permissive tenant_isolation policy only, because a Work or Money read must
// still be able to name a client without holding a CRM licence.
// ---------------------------------------------------------------------------

// The eight fields the account surface names, and nothing else. tenant_id,
// owner_user_id, the provenance columns, the timestamps and deleted_at are
// never selected here: deleted_at is used only to drop a soft-deleted row, and
// it is not an answer.
const CRM_ACCOUNT_SELECT = `select c.id,
                    c.name,
                    c.code,
                    c.status,
                    c.billing_email::text as billing_email,
                    c.phone,
                    c.currency::text as currency,
                    c.payment_terms_days`;

const CRM_ACCOUNT_FROM = 'from client c';

type CrmAccountRow = {
  id: string;
  name: string;
  code: string | null;
  status: string;
  billing_email: string | null;
  phone: string | null;
  currency: string;
  payment_terms_days: number;
};

function crmAccountItemFromRow(row: CrmAccountRow): CrmAccountListItem {
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    status: row.status,
    billingEmail: row.billing_email,
    phone: row.phone,
    currency: row.currency,
    paymentTermsDays: row.payment_terms_days,
  };
}

// The contact surface reads the shared client_contact table. The item carries
// exactly the six fields the surface names: the account a contact belongs to
// is named by the route, and the tenant and the timestamps stay on the row.
// This table has no soft-delete column, which is why there is no delete route.
const CRM_CONTACT_SELECT = `select ct.id,
                    ct.name,
                    ct.email::text as email,
                    ct.phone,
                    ct.role,
                    ct.is_primary as "isPrimary"`;

const CRM_CONTACT_FROM = 'from client_contact ct';

type CrmContactRow = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  role: string | null;
  isPrimary: boolean;
};

function crmContactItemFromRow(row: CrmContactRow): CrmContactItem {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    role: row.role,
    isPrimary: row.isPrimary,
  };
}

// The five fields a contact write may name. The body is closed: a key that is
// not on this list is refused, so a caller cannot reach a column the route
// never writes.
const CRM_CONTACT_WRITE_FIELDS = [
  'name',
  'email',
  'phone',
  'role',
  'isPrimary',
] as const;

type CrmContactWriteField = (typeof CRM_CONTACT_WRITE_FIELDS)[number];

const CRM_CONTACT_COLUMNS: Record<CrmContactWriteField, string> = {
  name: 'name',
  email: 'email',
  phone: 'phone',
  role: 'role',
  isPrimary: 'is_primary',
};

// The five values of one contact, always complete. The patch route fills the
// gaps from the stored row, so both routes decide the table's invariants over
// one shape rather than over a half-supplied one.
type CrmContactValues = {
  name: string;
  email: string | null;
  phone: string | null;
  role: string | null;
  isPrimary: boolean;
};

type CrmContactWriteParse = {
  // Field names the caller actually sent, so the audit can record which
  // fields were written without recording any of their values.
  present: CrmContactWriteField[];
  // Trimmed values. A blank or null optional field is null; an absent field is
  // undefined, which the patch route reads as "unchanged".
  values: Partial<CrmContactValues>;
};

// One parser for both writes: create requires a name, patch takes any
// non-empty subset of the five and validates the merged record afterwards.
// Only email, phone and role may be null; the name and the primary flag are
// the two values a row always holds.
function parseCrmContactWrite(
  body: Record<string, unknown>,
  mode: 'create' | 'patch',
): CrmContactWriteParse {
  for (const key of Object.keys(body)) {
    if (!(CRM_CONTACT_WRITE_FIELDS as readonly string[]).includes(key)) {
      throw new ApiError(400, 'INVALID_BODY');
    }
  }

  const present: CrmContactWriteField[] = [];
  const values: Partial<CrmContactValues> = {};

  for (const field of CRM_CONTACT_WRITE_FIELDS) {
    if (!Object.hasOwn(body, field)) {
      continue;
    }
    const raw = body[field];
    present.push(field);

    if (field === 'name') {
      if (typeof raw !== 'string' || raw.trim() === '') {
        throw new ApiError(400, 'INVALID_BODY');
      }
      values.name = raw.trim();
      continue;
    }

    if (field === 'isPrimary') {
      if (typeof raw !== 'boolean') {
        throw new ApiError(400, 'INVALID_BODY');
      }
      values.isPrimary = raw;
      continue;
    }

    // email, phone and role: a blank or null clears them.
    if (raw !== null && typeof raw !== 'string') {
      throw new ApiError(400, 'INVALID_BODY');
    }
    const trimmed = typeof raw === 'string' ? raw.trim() : '';
    values[field] = trimmed === '' ? null : trimmed;
  }

  if (mode === 'create' && values.name === undefined) {
    throw new ApiError(400, 'INVALID_BODY');
  }
  if (present.length === 0) {
    throw new ApiError(400, 'INVALID_BODY');
  }
  return { present, values };
}

// The merged record, always complete. The two values that may not stand empty
// are checked again over the merged shape, so a patch cannot build a record
// the create path would have refused.
function checkCrmContactValues(values: CrmContactValues): void {
  if (values.name.trim() === '') {
    throw new ApiError(400, 'INVALID_BODY');
  }
}

// One answer for every way an account id can fail to name a live account in
// this tenant: malformed, unknown, another tenant's, or withdrawn. The account
// is settled before any contact is looked at, so a caller who cannot see the
// account learns nothing about the contacts that hang off it.
async function requireCrmAccount(
  client: PoolClient,
  accountId: unknown,
): Promise<string> {
  if (typeof accountId !== 'string' || !UUID_TEXT_PATTERN.test(accountId)) {
    throw new ApiError(404, 'ACCOUNT_NOT_FOUND');
  }
  const account = await client.query(
    `${CRM_ACCOUNT_SELECT}
      ${CRM_ACCOUNT_FROM}
      where c.id = $1 and c.deleted_at is null`,
    [accountId],
  );
  if (account.rowCount !== 1) {
    throw new ApiError(404, 'ACCOUNT_NOT_FOUND');
  }
  return accountId;
}

// Demote the account's other primary contacts and answer with the ids that
// moved. The account holds at most one primary contact, and the write that
// names a new primary demotes the old one in the same transaction, so the
// partial unique index on the table holds at every point another session can
// see the rows.
async function demoteOtherPrimaries(
  client: PoolClient,
  accountId: string,
  exceptId: string | null,
): Promise<string[]> {
  const demoted = await client.query<{ id: string }>(
    `update client_contact
        set is_primary = false
      where client_id = $1
        and is_primary
        and ($2::uuid is null or id <> $2::uuid)
      returning id`,
    [accountId, exceptId],
  );
  return demoted.rows.map((row) => row.id);
}

// The seven fields an account write may name. The body is closed: a key that
// is not on this list is refused, so a caller cannot reach a column the route
// never writes.
const CRM_ACCOUNT_WRITE_FIELDS = [
  'name',
  'code',
  'status',
  'billingEmail',
  'phone',
  'currency',
  'paymentTermsDays',
] as const;

type CrmAccountWriteField = (typeof CRM_ACCOUNT_WRITE_FIELDS)[number];

const CRM_ACCOUNT_COLUMNS: Record<CrmAccountWriteField, string> = {
  name: 'name',
  code: 'code',
  status: 'status',
  billingEmail: 'billing_email',
  phone: 'phone',
  currency: 'currency',
  paymentTermsDays: 'payment_terms_days',
};

// The seven values of one account, always complete. The patch route fills the
// gaps from the stored row, so both routes decide the table's invariants over
// one shape rather than over a half-supplied one.
type CrmAccountValues = {
  name: string;
  code: string | null;
  status: string;
  billingEmail: string | null;
  phone: string | null;
  currency: string;
  paymentTermsDays: number;
};

type CrmAccountWriteParse = {
  // Field names the caller actually sent, so the audit can record which
  // fields were written without recording their values.
  present: CrmAccountWriteField[];
  // Trimmed values. A blank or null optional field is null; an absent field is
  // undefined, which the patch route reads as "unchanged".
  values: Partial<CrmAccountValues>;
};

// Three upper-case ASCII letters and nothing else. This is a stored code and
// nothing more: no registry resolves it, no rate converts it and no
// jurisdiction is implied by it. Lower case is refused rather than
// upper-cased, because a client that sends "inr" has a bug in its own
// currency handling and silently storing "INR" would hide it.
function crmAccountCurrency(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Z]{3}$/.test(value)) {
    throw new ApiError(400, 'INVALID_BODY');
  }
  return value;
}

// The stored payment terms, in days. The bound is the PostgreSQL integer
// range, which is the widest value the column can hold; a number outside it
// is a client error rather than a number to round.
function crmAccountPaymentTermsDays(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > CRM_PAYMENT_TERMS_DAYS_MAX
  ) {
    throw new ApiError(400, 'INVALID_BODY');
  }
  return value;
}

// One parser for both writes: create requires name and currency, patch takes
// any non-empty subset of the seven and validates the merged record
// afterwards. The four columns the table does not let stand empty - name,
// status, currency and payment_terms_days - may never be null; the other
// three may.
function parseCrmAccountWrite(
  body: Record<string, unknown>,
  mode: 'create' | 'patch',
): CrmAccountWriteParse {
  for (const key of Object.keys(body)) {
    if (!(CRM_ACCOUNT_WRITE_FIELDS as readonly string[]).includes(key)) {
      throw new ApiError(400, 'INVALID_BODY');
    }
  }

  const present: CrmAccountWriteField[] = [];
  const values: Partial<CrmAccountValues> = {};

  for (const field of CRM_ACCOUNT_WRITE_FIELDS) {
    if (!Object.hasOwn(body, field)) {
      continue;
    }
    const raw = body[field];
    present.push(field);

    if (field === 'name') {
      if (typeof raw !== 'string' || raw.trim() === '') {
        throw new ApiError(400, 'INVALID_BODY');
      }
      values.name = raw.trim();
      continue;
    }

    if (field === 'status') {
      if (
        typeof raw !== 'string' ||
        !(CRM_ACCOUNT_STATUSES as readonly string[]).includes(raw)
      ) {
        throw new ApiError(400, 'INVALID_BODY');
      }
      values.status = raw;
      continue;
    }

    if (field === 'currency') {
      values.currency = crmAccountCurrency(raw);
      continue;
    }

    if (field === 'paymentTermsDays') {
      values.paymentTermsDays = crmAccountPaymentTermsDays(raw);
      continue;
    }

    // code, billingEmail and phone: a blank or null clears them.
    if (raw !== null && typeof raw !== 'string') {
      throw new ApiError(400, 'INVALID_BODY');
    }
    const trimmed = typeof raw === 'string' ? raw.trim() : '';
    values[field] = trimmed === '' ? null : trimmed;
  }

  if (mode === 'create' && (values.name === undefined || values.currency === undefined)) {
    throw new ApiError(400, 'INVALID_BODY');
  }
  if (present.length === 0) {
    throw new ApiError(400, 'INVALID_BODY');
  }
  return { present, values };
}

// The merged record, always complete. The four columns that may not stand
// empty are checked again over the merged shape, so a patch cannot build a
// record the create path would have refused.
function checkCrmAccountValues(values: CrmAccountValues): void {
  if (values.name.trim() === '') {
    throw new ApiError(400, 'INVALID_BODY');
  }
  if (!(CRM_ACCOUNT_STATUSES as readonly string[]).includes(values.status)) {
    throw new ApiError(400, 'INVALID_BODY');
  }
  crmAccountCurrency(values.currency);
  crmAccountPaymentTermsDays(values.paymentTermsDays);
}

// ---------------------------------------------------------------------------
// The CRM lead surface.
//
// A lead is CRM-private: nothing outside this module reads or writes one, so
// crm_lead carries restrictive crm_read and crm_write_* policies of its own
// (0015_crm_leads.sql), and an unentitled workspace is stopped at the table as
// well as at the route. The select names the nine fields the surface returns
// and nothing else; the conversion instant stays on the row.
// ---------------------------------------------------------------------------

const CRM_LEAD_SELECT = `select l.id,
                    l.name,
                    l.company,
                    l.email::text as email,
                    l.phone,
                    l.source,
                    l.stage,
                    l.converted_client_id,
                    l.converted_contact_id`;

const CRM_LEAD_FROM = 'from crm_lead l';

type CrmLeadRow = {
  id: string;
  name: string;
  company: string | null;
  email: string | null;
  phone: string | null;
  source: string | null;
  stage: string;
  converted_client_id: string | null;
  converted_contact_id: string | null;
};

function crmLeadItemFromRow(row: CrmLeadRow): CrmLeadItem {
  return {
    id: row.id,
    name: row.name,
    company: row.company,
    email: row.email,
    phone: row.phone,
    source: row.source,
    stage: row.stage as CrmLeadStage,
    convertedAccountId: row.converted_client_id,
    convertedContactId: row.converted_contact_id,
  };
}

// The six fields a lead write may name. The body is closed: a key that is not
// on this list is refused, so a caller cannot reach a column the route never
// writes - and in particular cannot name converted_client_id, converted_at or
// tenant_id, which only the conversion route and the session may set.
const CRM_LEAD_WRITE_FIELDS = [
  'name',
  'company',
  'email',
  'phone',
  'source',
  'stage',
] as const;

type CrmLeadWriteField = (typeof CRM_LEAD_WRITE_FIELDS)[number];

const CRM_LEAD_COLUMNS: Record<CrmLeadWriteField, string> = {
  name: 'name',
  company: 'company',
  email: 'email',
  phone: 'phone',
  source: 'source',
  stage: 'stage',
};

// The six values of one lead, always complete. The patch route fills the gaps
// from the stored row, so both routes decide the table's invariants over one
// shape rather than over a half-supplied one.
type CrmLeadValues = {
  name: string;
  company: string | null;
  email: string | null;
  phone: string | null;
  source: string | null;
  stage: CrmLeadStage;
};

type CrmLeadWriteParse = {
  // Field names the caller actually sent, so the audit can record which
  // fields were written without recording any of their values.
  present: CrmLeadWriteField[];
  // Trimmed values. A blank or null optional field is null; an absent field is
  // undefined, which the patch route reads as "unchanged".
  values: Partial<CrmLeadValues>;
};

// One parser for both writes: create requires a name and may only name an open
// stage; patch takes any non-empty subset of the six and validates the merged
// record afterwards. 'converted' is a valid patch value at this layer and is
// refused by the route with its own answer, because conversion writes more
// than the lead row.
function parseCrmLeadWrite(
  body: Record<string, unknown>,
  mode: 'create' | 'patch',
): CrmLeadWriteParse {
  for (const key of Object.keys(body)) {
    if (!(CRM_LEAD_WRITE_FIELDS as readonly string[]).includes(key)) {
      throw new ApiError(400, 'INVALID_BODY');
    }
  }

  const present: CrmLeadWriteField[] = [];
  const values: Partial<CrmLeadValues> = {};

  for (const field of CRM_LEAD_WRITE_FIELDS) {
    if (!Object.hasOwn(body, field)) {
      continue;
    }
    const raw = body[field];
    present.push(field);

    if (field === 'name') {
      if (typeof raw !== 'string' || raw.trim() === '') {
        throw new ApiError(400, 'INVALID_BODY');
      }
      values.name = raw.trim();
      continue;
    }

    if (field === 'stage') {
      const allowed: readonly string[] =
        mode === 'create' ? CRM_LEAD_OPEN_STAGES : CRM_LEAD_STAGES;
      if (typeof raw !== 'string' || !allowed.includes(raw)) {
        throw new ApiError(400, 'INVALID_BODY');
      }
      values.stage = raw as CrmLeadStage;
      continue;
    }

    // company, email, phone and source: a blank or null clears them.
    if (raw !== null && typeof raw !== 'string') {
      throw new ApiError(400, 'INVALID_BODY');
    }
    const trimmed = typeof raw === 'string' ? raw.trim() : '';
    values[field] = trimmed === '' ? null : trimmed;
  }

  if (mode === 'create' && values.name === undefined) {
    throw new ApiError(400, 'INVALID_BODY');
  }
  if (present.length === 0) {
    throw new ApiError(400, 'INVALID_BODY');
  }
  return { present, values };
}

// The merged record, always complete. The two values that may not stand empty
// are checked again over the merged shape, so a patch cannot build a record
// the create path would have refused.
function checkCrmLeadValues(values: CrmLeadValues): void {
  if (values.name.trim() === '') {
    throw new ApiError(400, 'INVALID_BODY');
  }
  if (!(CRM_LEAD_STAGES as readonly string[]).includes(values.stage)) {
    throw new ApiError(400, 'INVALID_BODY');
  }
}

// The stage filter is an exact match on one stored stage. Anything else - a
// partial name, a case variant, a repeated parameter - is a client error
// rather than a filter that quietly matches nothing.
function crmLeadStageFilter(query: Record<string, unknown>): CrmLeadStage | null {
  const raw = queryStringParam(query, 'stage');
  if (raw === null) {
    return null;
  }
  if (!(CRM_LEAD_STAGES as readonly string[]).includes(raw)) {
    throw new ApiError(400, 'INVALID_QUERY');
  }
  return raw as CrmLeadStage;
}

// One answer for every way a lead id can fail to name a lead in this tenant:
// malformed, unknown, or another tenant's.
//
// A write path asks for the row lock. Two transactions that both read a lead
// before either writes it would each believe the stage they read, so a stage
// move could land on a lead a conversion had just made final. With the lock,
// the second transaction reads the committed row after the first commits and
// answers from it.
async function requireCrmLead(
  client: PoolClient,
  leadId: unknown,
  forUpdate = false,
): Promise<CrmLeadRow> {
  if (typeof leadId !== 'string' || !UUID_TEXT_PATTERN.test(leadId)) {
    throw new ApiError(404, 'LEAD_NOT_FOUND');
  }
  const lead = await client.query<CrmLeadRow>(
    `${CRM_LEAD_SELECT}
      ${CRM_LEAD_FROM}
      where l.id = $1${forUpdate ? ' for update' : ''}`,
    [leadId],
  );
  const row = lead.rows[0];
  if (!row) {
    throw new ApiError(404, 'LEAD_NOT_FOUND');
  }
  return row;
}

// The conversion body: a currency the caller must state and an account name
// the caller may state. The currency is the same three-letter code the account
// route takes, because the account this writes stores it; nothing here converts
// one currency into another. An absent or blank name means "take the lead's
// company, then the lead's name", so the route decides the name from the row it
// locked rather than from a value the caller invented.
function parseCrmLeadConversion(body: Record<string, unknown>): {
  currency: string;
  accountName: string | null;
} {
  for (const key of Object.keys(body)) {
    if (key !== 'currency' && key !== 'accountName') {
      throw new ApiError(400, 'INVALID_BODY');
    }
  }

  const currency = crmAccountCurrency(body.currency);

  const raw = body.accountName;
  if (raw !== undefined && raw !== null && typeof raw !== 'string') {
    throw new ApiError(400, 'INVALID_BODY');
  }
  const trimmed = typeof raw === 'string' ? raw.trim() : '';

  return { currency, accountName: trimmed === '' ? null : trimmed };
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

  // Auth, context, directory and module responses carry credentials, session,
  // authorization or tenant data and must never be cached by a browser, proxy
  // or shared cache, including error responses. Every People path is covered by
  // prefix, so a write, a 4xx and a 5xx are all no-store too, and the module
  // surfaces are covered the same way.
  app.addHook('onSend', async (request, reply) => {
    if (
      request.url.startsWith('/v1/auth/') ||
      request.url.startsWith('/v1/context') ||
      request.url.startsWith('/v1/people') ||
      request.url.startsWith('/v1/crm') ||
      request.url.startsWith('/v1/work') ||
      request.url.startsWith('/v1/money') ||
      request.url.startsWith('/v1/content')
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

    requireCsrfToken(session, request);

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
    const searchTerm = listSearchTerm(query, PEOPLE_SEARCH_MAX_LENGTH);
    const page = listIntegerParam(query, 'page', 1, LIST_MAX_PAGE);
    const pageSize = listIntegerParam(
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
          const clauses = ['p.deleted_at is null'];
          const filterValues: string[] = [];
          if (searchTerm !== '') {
            filterValues.push(searchTerm);
            const needle = `$${filterValues.length}`;
            // strpos over the lowered columns is a literal match, so a search
            // for "%" or "_" cannot behave like a LIKE wildcard.
            clauses.push(
              `(strpos(lower(p.display_name), lower(${needle})) > 0
                 or strpos(lower(coalesce(p.employee_code, '')), lower(${needle})) > 0
                 or strpos(lower(coalesce(p.work_email::text, '')), lower(${needle})) > 0)`,
            );
          }
          const where = clauses.join(' and ');
          const limitIndex = filterValues.length + 1;

          const matching = await client.query<{ total: string }>(
            `select count(*) as total from person p where ${where}`,
            filterValues,
          );
          const pageRows = await client.query<PeopleListRow>(
            `${DIRECTORY_SELECT}
              ${DIRECTORY_FROM}
              where ${where}
              order by lower(p.display_name), p.id
              limit $${limitIndex} offset $${limitIndex + 1}`,
            [...filterValues, pageSize, (page - 1) * pageSize],
          );

          const items: PeopleListItem[] = pageRows.rows.map(peopleItemFromRow);

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

  app.post('/v1/people', async (request, reply) => {
    const session = await currentSession(request);
    if (!session) {
      return unauthenticated(reply);
    }
    requireCsrfToken(session, request);

    try {
      const item = await withMemberTransaction(
        pool,
        {
          tenantId: session.tenantId,
          userId: session.userId,
          gate: { module: 'people', operation: 'write' },
        },
        async (client) => {
          // Inside the gated transaction on purpose: a role that may not write
          // is refused before the body is read at all.
          const parsed = parsePeopleWrite(peopleWriteObject(request.body), 'create');
          const firstName = parsed.values.firstName as string;
          const lastName = parsed.values.lastName ?? null;
          checkCombinedName(firstName, lastName);
          const displayName =
            parsed.values.displayName ?? deriveDisplayName(firstName, lastName);

          // An unplaced person is only creatable by a tenant-wide member: a
          // scoped member could neither see nor maintain it afterwards. The
          // helper answers first so the client gets a typed 403, and
          // scope_insert is the database half of the same rule.
          const placement = await client.query<{ allowed: boolean }>(
            'select app.person_placement_in_scope(null, null) as allowed',
          );
          if (!placement.rows[0]?.allowed) {
            throw new ApiError(403, 'SCOPE_DENIED');
          }

          // The id is generated here and named in the insert instead of taken
          // from RETURNING: the restrictive scope_read policy calls
          // app.person_visible(id), which cannot observe a row created by the
          // same command, so every person INSERT ... RETURNING is refused.
          // ADR 0008 records the reproduction.
          const id = randomUUID();
          try {
            await client.query(
              `insert into person
                 (id, tenant_id, employee_code, first_name, last_name, display_name, work_email, phone)
               values
                 ($1, app.current_tenant_id(), $2, $3, $4, $5, $6, $7)`,
              [
                id,
                parsed.values.employeeCode ?? null,
                firstName,
                lastName,
                displayName,
                parsed.values.workEmail ?? null,
                parsed.values.phone ?? null,
              ],
            );
          } catch (error) {
            const violation = error as { code?: string; constraint?: string };
            if (violation.code !== '23505') {
              throw error;
            }
            // The message never repeats the code or email that collided.
            if (violation.constraint === 'person_tenant_id_employee_code_key') {
              throw new ApiError(409, 'PERSON_CODE_TAKEN');
            }
            if (violation.constraint === 'person_tenant_id_work_email_key') {
              throw new ApiError(409, 'PERSON_EMAIL_TAKEN');
            }
            throw new ApiError(409, 'PERSON_CONFLICT');
          }

          const created = await client.query<PeopleListRow>(
            `${DIRECTORY_SELECT}
              ${DIRECTORY_FROM}
              where p.id = $1 and p.deleted_at is null`,
            [id],
          );
          const row = created.rows[0];
          if (!row) {
            // A row this transaction just wrote is not readable inside it.
            // That is an invariant break, so it fails closed as a 500 and the
            // insert rolls back with the audit row.
            throw new ApiError(500, 'INTERNAL_ERROR');
          }

          await appendAuditEvent(client, {
            action: 'person.created',
            entityType: 'person',
            entityId: id,
            actorType: 'user',
            actorUserId: session.userId,
            // Field names only: the values stay in the directory, not the audit.
            metadata: { module: 'people', fields: [...parsed.present].sort() },
            ip: request.ip,
            userAgent: request.headers['user-agent'] ?? null,
          });

          return peopleItemFromRow(row);
        },
      );

      reply.code(201);
      return item;
    } catch (error) {
      return await accessError(pool, error, request, reply, session);
    }
  });

  app.patch('/v1/people/:id', async (request, reply) => {
    const session = await currentSession(request);
    if (!session) {
      return unauthenticated(reply);
    }
    requireCsrfToken(session, request);

    const personId = (request.params as { id?: unknown }).id;

    try {
      return await withMemberTransaction(
        pool,
        {
          tenantId: session.tenantId,
          userId: session.userId,
          gate: { module: 'people', operation: 'write' },
        },
        async (client) => {
          // Checked here, after entitlement and role have settled and before any
          // SQL: a denied caller is denied the same way whatever the id looks
          // like, and no malformed UUID reaches the database.
          if (typeof personId !== 'string' || !UUID_TEXT_PATTERN.test(personId)) {
            // A malformed id addresses no person, exactly like an id from another
            // tenant or one that was soft-deleted.
            throw new ApiError(404, 'PERSON_NOT_FOUND');
          }

          const parsed = parsePeopleWrite(peopleWriteObject(request.body), 'update');

          const current = await client.query<PeopleListRow>(
            `${DIRECTORY_SELECT}
              ${DIRECTORY_FROM}
              where p.id = $1 and p.deleted_at is null`,
            [personId],
          );
          const row = current.rows[0];
          if (!row) {
            throw new ApiError(404, 'PERSON_NOT_FOUND');
          }
          const currentItem = peopleItemFromRow(row);

          const firstName = parsed.values.firstName ?? currentItem.firstName;
          const lastName = pickPeopleField(parsed, 'lastName', currentItem.lastName);
          checkCombinedName(firstName, lastName);
          const displayName = Object.hasOwn(parsed.values, 'displayName')
            ? (parsed.values.displayName ?? deriveDisplayName(firstName, lastName))
            : currentItem.displayName;

          const values: Record<PeopleWriteField, string | null> = {
            firstName,
            lastName,
            displayName,
            employeeCode: pickPeopleField(parsed, 'employeeCode', currentItem.employeeCode),
            workEmail: pickPeopleField(parsed, 'workEmail', currentItem.workEmail),
            phone: pickPeopleField(parsed, 'phone', currentItem.phone),
          };

          const changed = PEOPLE_WRITE_FIELDS.filter((field) => {
            const next = values[field];
            const previous = currentItem[field];
            // work_email is citext, so two spellings of one address are one value.
            if (
              field === 'workEmail' &&
              next !== null &&
              previous !== null
            ) {
              return next.toLowerCase() !== previous.toLowerCase();
            }
            return next !== previous;
          }).sort();

          if (changed.length === 0) {
            // Nothing moved: no UPDATE, no audit row, and the stored row answers.
            return currentItem;
          }

          const setValues: unknown[] = [];
          const assignments = changed.map((field) => {
            setValues.push(values[field]);
            return `${PEOPLE_WRITE_COLUMNS[field]} = $${setValues.length}`;
          });

          let updated;
          try {
            updated = await client.query(
              `update person
                  set ${assignments.join(', ')}
                where id = $${setValues.length + 1} and deleted_at is null`,
              [...setValues, personId],
            );
          } catch (error) {
            const violation = error as { code?: string; constraint?: string };
            if (violation.code !== '23505') {
              throw error;
            }
            // Renaming onto an existing code or email is the same collision the
            // create route reports, and for the same reason the value is not
            // repeated back to the caller.
            if (violation.constraint === 'person_tenant_id_employee_code_key') {
              throw new ApiError(409, 'PERSON_CODE_TAKEN');
            }
            if (violation.constraint === 'person_tenant_id_work_email_key') {
              throw new ApiError(409, 'PERSON_EMAIL_TAKEN');
            }
            throw new ApiError(409, 'PERSON_CONFLICT');
          }
          // One row or none: anything else is an invariant break and the whole
          // transaction rolls back with the audit row.
          if (updated.rowCount !== 1) {
            throw new ApiError(500, 'INTERNAL_ERROR');
          }

          // UPDATE ... RETURNING cannot carry the joined placement names, so the
          // response is read back with the same select the list uses.
          const written = await client.query<PeopleListRow>(
            `${DIRECTORY_SELECT}
              ${DIRECTORY_FROM}
              where p.id = $1 and p.deleted_at is null`,
            [personId],
          );
          const updatedRow = written.rows[0];
          if (!updatedRow) {
            throw new ApiError(500, 'INTERNAL_ERROR');
          }

          await appendAuditEvent(client, {
            action: 'person.updated',
            entityType: 'person',
            entityId: personId,
            actorType: 'user',
            actorUserId: session.userId,
            metadata: { module: 'people', changedFields: changed },
            ip: request.ip,
            userAgent: request.headers['user-agent'] ?? null,
          });

          return peopleItemFromRow(updatedRow);
        },
      );
    } catch (error) {
      return await accessError(pool, error, request, reply, session);
    }
  });

  app.get('/v1/people/placement-options', async (request, reply) => {
    const session = await currentSession(request);
    if (!session) {
      return unauthenticated(reply);
    }

    try {
      // Only a member who may write a placement has any reason to ask for these
      // lists, so a read-only manager is refused exactly as on the write routes.
      return await withMemberTransaction(
        pool,
        {
          tenantId: session.tenantId,
          userId: session.userId,
          gate: { module: 'people', operation: 'write' },
        },
        async (client) => {
          // Every row is decided by app.person_placement_in_scope - the same
          // security-definer helper the write policies call. No scope rule is
          // restated in TypeScript, and no tenant_id predicate appears: the
          // transaction sets app.tenant_id, so each reference table's
          // tenant_isolation policy is the tenant boundary.
          const unplace = await client.query<{ allowed: boolean }>(
            'select app.person_placement_in_scope(null, null) as allowed',
          );

          // An entity is offered when the member may place directly on it, or
          // when it owns at least one offerable org unit. That second branch is
          // what lets an org-unit-scoped member group their units under an
          // entity they cannot place on; placeable tells the UI so.
          const entities = await client.query<{
            id: string;
            name: string;
            code: string;
            placeable: boolean;
          }>(
            `select le.id,
                    le.name,
                    le.code,
                    app.person_placement_in_scope(le.id, null) as placeable
               from legal_entity le
              where le.deleted_at is null
                and (
                     app.person_placement_in_scope(le.id, null)
                     or exists (
                        select 1
                          from org_unit ou
                         where ou.legal_entity_id = le.id
                           and ou.deleted_at is null
                           and app.person_placement_in_scope(ou.legal_entity_id, ou.id)
                     )
                   )
              order by le.name, le.id`,
          );

          // The inner join is what drops a unit with no legal entity and a unit
          // whose entity is retired. A unit here is always placeable: the
          // helper said so, and the pair it checks is the one the write stores.
          const units = await client.query<{
            id: string;
            name: string;
            legal_entity_id: string;
          }>(
            `select ou.id,
                    ou.name,
                    ou.legal_entity_id
               from org_unit ou
               join legal_entity le on le.id = ou.legal_entity_id
                                   and le.deleted_at is null
              where ou.deleted_at is null
                and app.person_placement_in_scope(ou.legal_entity_id, ou.id)
              order by ou.name, ou.id`,
          );

          const body: PeoplePlacementOptions = {
            canUnplace: unplace.rows[0]?.allowed === true,
            legalEntities: entities.rows.map((row) => ({
              id: row.id,
              name: row.name,
              code: row.code,
              placeable: row.placeable,
            })),
            orgUnits: units.rows.map((row) => ({
              id: row.id,
              name: row.name,
              legalEntityId: row.legal_entity_id,
              placeable: true,
            })),
          };
          return body;
        },
      );
    } catch (error) {
      return await accessError(pool, error, request, reply, session);
    }
  });

  app.patch('/v1/people/:id/placement', async (request, reply) => {
    const session = await currentSession(request);
    if (!session) {
      return unauthenticated(reply);
    }
    requireCsrfToken(session, request);

    const personId = (request.params as { id?: unknown }).id;

    try {
      return await withMemberTransaction(
        pool,
        {
          tenantId: session.tenantId,
          userId: session.userId,
          gate: { module: 'people', operation: 'write' },
        },
        async (client) => {
          // Entitlement and role settle before any of this runs, so a denied
          // caller is denied the same way whatever the id looks like and no
          // malformed UUID reaches the database.
          if (typeof personId !== 'string' || !UUID_TEXT_PATTERN.test(personId)) {
            throw new ApiError(404, 'PERSON_NOT_FOUND');
          }

          const placement = parsePeoplePlacement(request.body);

          // The read is the scope test: RLS leaves a person this member may not
          // see - unknown, another tenant, soft-deleted or out of scope -
          // invisible, and all four answer as one 404.
          const personRows = await client.query<PeopleListRow>(
            `${DIRECTORY_SELECT}
              ${DIRECTORY_FROM}
              where p.id = $1 and p.deleted_at is null`,
            [personId],
          );
          const personRow = personRows.rows[0];
          if (!personRow) {
            throw new ApiError(404, 'PERSON_NOT_FOUND');
          }
          const currentItem = peopleItemFromRow(personRow);

          if (placement.legalEntityId !== null) {
            const entity = await client.query<{ id: string }>(
              `select le.id
                 from legal_entity le
                where le.id = $1 and le.deleted_at is null`,
              [placement.legalEntityId],
            );
            if (!entity.rows[0]) {
              throw new ApiError(404, 'PLACEMENT_NOT_FOUND');
            }
          }

          if (placement.orgUnitId !== null) {
            const unit = await client.query<{ legal_entity_id: string }>(
              `select ou.legal_entity_id
                 from org_unit ou
                where ou.id = $1 and ou.deleted_at is null`,
              [placement.orgUnitId],
            );
            // A unit that belongs to another legal entity is not the pair this
            // caller named, and there is no database check for it, so the route
            // enforces it.
            if (unit.rows[0]?.legal_entity_id?.toLowerCase() !== placement.legalEntityId) {
              throw new ApiError(404, 'PLACEMENT_NOT_FOUND');
            }
          }

          // A target that is out of this member's scope answers as a miss, not
          // as a refusal, so a scoped member cannot use these calls to find out
          // whether an org unit exists. Only the both-null unplace has no id to
          // hide, so that one case is the typed scope denial.
          const allowed = await client.query<{ allowed: boolean }>(
            'select app.person_placement_in_scope($1, $2) as allowed',
            [placement.legalEntityId, placement.orgUnitId],
          );
          if (!allowed.rows[0]?.allowed) {
            if (placement.legalEntityId === null && placement.orgUnitId === null) {
              throw new ApiError(403, 'SCOPE_DENIED');
            }
            throw new ApiError(404, 'PLACEMENT_NOT_FOUND');
          }

          if (
            currentItem.legalEntityId === placement.legalEntityId &&
            currentItem.orgUnitId === placement.orgUnitId
          ) {
            // Already placed exactly here: no UPDATE, no audit row, stored row
            // answers.
            return currentItem;
          }

          const written = await client.query(
            `update person
                set legal_entity_id = $1, org_unit_id = $2
              where id = $3 and deleted_at is null`,
            [placement.legalEntityId, placement.orgUnitId, personId],
          );
          if (written.rowCount !== 1) {
            throw new ApiError(500, 'INTERNAL_ERROR');
          }

          // Ids only: no names, no emails, nothing else from the row.
          await appendAuditEvent(client, {
            action: 'person.placement.changed',
            entityType: 'person',
            entityId: personId,
            actorType: 'user',
            actorUserId: session.userId,
            metadata: {
              module: 'people',
              legalEntityId: placement.legalEntityId,
              orgUnitId: placement.orgUnitId,
              previousLegalEntityId: currentItem.legalEntityId,
              previousOrgUnitId: currentItem.orgUnitId,
            },
            ip: request.ip,
            userAgent: request.headers['user-agent'] ?? null,
          });

          const readBack = await client.query<PeopleListRow>(
            `${DIRECTORY_SELECT}
              ${DIRECTORY_FROM}
              where p.id = $1 and p.deleted_at is null`,
            [personId],
          );
          const row = readBack.rows[0];
          if (!row) {
            throw new ApiError(500, 'INTERNAL_ERROR');
          }
          return peopleItemFromRow(row);
        },
      );
    } catch (error) {
      return await accessError(pool, error, request, reply, session);
    }
  });

  app.get('/v1/people/:id/employments', async (request, reply) => {
    const session = await currentSession(request);
    if (!session) {
      return unauthenticated(reply);
    }

    const personId = (request.params as { id?: unknown }).id;

    try {
      // A read, so every member who may read People may open a history - not only
      // a writer. The member transaction sets app.tenant_id and app.user_id, and
      // employment's own tenant_isolation plus scope_read policies narrow the
      // rows; no scope predicate is restated here.
      return await withMemberTransaction(
        pool,
        {
          tenantId: session.tenantId,
          userId: session.userId,
          gate: { module: 'people', operation: 'read' },
        },
        async (client) => {
          // Inside the gated transaction, after entitlement and role, so a denied
          // caller is denied the same way whatever the id looks like.
          if (typeof personId !== 'string' || !UUID_TEXT_PATTERN.test(personId)) {
            throw new ApiError(404, 'PERSON_NOT_FOUND');
          }

          // The person read is the scope test, and it answers with the directory's
          // own miss: unknown, malformed, soft-deleted, another tenant or out of
          // scope are one PERSON_NOT_FOUND, so a history route cannot be used to
          // enumerate people a member may not list.
          const personRows = await client.query<PeopleListRow>(
            `${DIRECTORY_SELECT}
              ${DIRECTORY_FROM}
              where p.id = $1 and p.deleted_at is null`,
            [personId],
          );
          if (!personRows.rows[0]) {
            throw new ApiError(404, 'PERSON_NOT_FOUND');
          }

          const rows = await client.query<EmploymentRow>(
            `${EMPLOYMENT_SELECT}
              ${EMPLOYMENT_FROM}
              where e.person_id = $1
              ${EMPLOYMENT_ORDER}`,
            [personId],
          );
          const items = rows.rows.map(employmentItemFromRow);
          const body: EmploymentListResponse = { items, total: items.length };
          return body;
        },
      );
    } catch (error) {
      return await accessError(pool, error, request, reply, session);
    }
  });

  app.post('/v1/people/:id/employments', async (request, reply) => {
    const session = await currentSession(request);
    if (!session) {
      return unauthenticated(reply);
    }
    requireCsrfToken(session, request);

    const personId = (request.params as { id?: unknown }).id;

    try {
      const item = await withMemberTransaction(
        pool,
        {
          tenantId: session.tenantId,
          userId: session.userId,
          gate: { module: 'people', operation: 'write' },
        },
        async (client) => {
          if (typeof personId !== 'string' || !UUID_TEXT_PATTERN.test(personId)) {
            throw new ApiError(404, 'PERSON_NOT_FOUND');
          }

          const parsed = parseEmploymentWrite(peopleWriteObject(request.body), 'create');
          const values: EmploymentValues = {
            employmentType: parsed.values.employmentType as EmploymentType,
            startDate: parsed.values.startDate as string,
            endDate: parsed.values.endDate ?? null,
            probationEndDate: parsed.values.probationEndDate ?? null,
            noticeDays: parsed.values.noticeDays ?? null,
          };
          // A new row is active, so the only status rule that can be broken on this
          // path is the date order.
          checkEmploymentValues(values, 'active');

          const personRows = await client.query<PeopleListRow>(
            `${DIRECTORY_SELECT}
              ${DIRECTORY_FROM}
              where p.id = $1 and p.deleted_at is null`,
            [personId],
          );
          const personRow = personRows.rows[0];
          if (!personRow) {
            throw new ApiError(404, 'PERSON_NOT_FOUND');
          }

          // The helper answers with app.person_in_scope, while the directory read
          // above answers with app.person_visible, and the two are not the same: a
          // scoped member may see the person row linked to their own user account
          // but may not maintain it. The helper answers first so the client gets a
          // typed 403, and scope_insert is the database half of the same rule.
          const writable = await client.query<{ allowed: boolean }>(
            'select app.person_in_scope($1) as allowed',
            [personId],
          );
          if (!writable.rows[0]?.allowed) {
            throw new ApiError(403, 'SCOPE_DENIED');
          }

          // The legal entity is never supplied by the caller: it is the person's own
          // placement at this moment. That makes the employment's reach exactly the
          // member's reach over the person, and it keeps a later placement move from
          // rewriting history already recorded under the old entity.
          const storedEntityId = personRow.legal_entity_id;
          if (storedEntityId === null) {
            throw new ApiError(409, 'EMPLOYMENT_ENTITY_REQUIRED');
          }

          const entity = await client.query<{ id: string }>(
            `select le.id
               from legal_entity le
              where le.id = $1 and le.deleted_at is null`,
            [storedEntityId],
          );
          if (!entity.rows[0]) {
            // A retired entity is no place to start a record either, and the answer
            // is the same as for no placement at all because the fix is the same.
            throw new ApiError(409, 'EMPLOYMENT_ENTITY_REQUIRED');
          }

          // The id is generated here for the reason ADR 0008 gives for person: the
          // row is read back inside this transaction, its response carries a joined
          // column, and the audit entry needs the id before the answer is sent.
          const id = randomUUID();
          await client.query(
            `insert into employment
               (id, tenant_id, person_id, legal_entity_id, employment_type,
                start_date, end_date, probation_end_date, notice_days)
             values
               ($1, app.current_tenant_id(), $2, $3, $4, $5, $6, $7, $8)`,
            [
              id,
              personId,
              storedEntityId,
              values.employmentType,
              values.startDate,
              values.endDate,
              values.probationEndDate,
              values.noticeDays,
            ],
          );

          // status is absent from the column list, so the database default is the
          // only source of it and nothing the client sent can choose it.
          const created = await client.query<EmploymentRow>(
            `${EMPLOYMENT_SELECT}
              ${EMPLOYMENT_FROM}
              where e.id = $1`,
            [id],
          );
          const row = created.rows[0];
          if (!row) {
            throw new ApiError(500, 'INTERNAL_ERROR');
          }

          await appendAuditEvent(client, {
            action: 'employment.created',
            entityType: 'employment',
            entityId: id,
            actorType: 'user',
            actorUserId: session.userId,
            // Field names only: no date, notice period or status is copied into
            // the audit trail, because they are all still readable on the row.
            metadata: { module: 'people', fields: [...parsed.present].sort() },
            ip: request.ip,
            userAgent: request.headers['user-agent'] ?? null,
          });

          return employmentItemFromRow(row);
        },
      );

      reply.code(201);
      return item;
    } catch (error) {
      return await accessError(pool, error, request, reply, session);
    }
  });

  app.patch('/v1/people/:id/employments/:employmentId', async (request, reply) => {
    const session = await currentSession(request);
    if (!session) {
      return unauthenticated(reply);
    }
    requireCsrfToken(session, request);

    const personId = (request.params as { id?: unknown }).id;
    const employmentId = (request.params as { employmentId?: unknown }).employmentId;

    try {
      return await withMemberTransaction(
        pool,
        {
          tenantId: session.tenantId,
          userId: session.userId,
          gate: { module: 'people', operation: 'write' },
        },
        async (client) => {
          if (typeof personId !== 'string' || !UUID_TEXT_PATTERN.test(personId)) {
            throw new ApiError(404, 'PERSON_NOT_FOUND');
          }
          if (
            typeof employmentId !== 'string' ||
            !UUID_TEXT_PATTERN.test(employmentId)
          ) {
            throw new ApiError(404, 'EMPLOYMENT_NOT_FOUND');
          }

          const parsed = parseEmploymentWrite(peopleWriteObject(request.body), 'patch');

          // The person first, so a member who may not reach this colleague gets the
          // directory's own miss rather than a verdict about a history row.
          const personRows = await client.query<PeopleListRow>(
            `${DIRECTORY_SELECT}
              ${DIRECTORY_FROM}
              where p.id = $1 and p.deleted_at is null`,
            [personId],
          );
          if (!personRows.rows[0]) {
            throw new ApiError(404, 'PERSON_NOT_FOUND');
          }

          // Addressed by its id and its person, so a row belonging to someone else
          // is the same answer as a row that does not exist, and no id in another
          // part of the tenant can be probed through this path.
          const current = await client.query<EmploymentRow>(
            `${EMPLOYMENT_SELECT}
              ${EMPLOYMENT_FROM}
              where e.id = $1 and e.person_id = $2`,
            [employmentId, personId],
          );
          const currentRow = current.rows[0];
          if (!currentRow) {
            throw new ApiError(404, 'EMPLOYMENT_NOT_FOUND');
          }
          const currentItem = employmentItemFromRow(currentRow);

          // The row is readable but this member may not maintain the person it
          // belongs to: app.person_visible (the read predicate the directory and
          // this route's reads use) and app.person_in_scope (the write predicate
          // employment's scope_update policy uses) are not the same. The helper
          // answers first so the client gets a typed 403 instead of an UPDATE that
          // matches nothing, and scope_update stays the database half of the rule.
          const writable = await client.query<{ allowed: boolean }>(
            'select app.person_in_scope($1) as allowed',
            [personId],
          );
          if (!writable.rows[0]?.allowed) {
            throw new ApiError(403, 'SCOPE_DENIED');
          }

          // An absent key keeps the stored value; a present one states it, and for
          // the two optional dates and the notice days a null states "cleared".
          // employmentType and startDate cannot be null, so the parser already
          // refused that.
          const values: EmploymentValues = {
            employmentType: parsed.values.employmentType ?? currentItem.employmentType,
            startDate: parsed.values.startDate ?? currentItem.startDate,
            endDate: Object.hasOwn(parsed.values, 'endDate')
              ? parsed.values.endDate ?? null
              : currentItem.endDate,
            probationEndDate: Object.hasOwn(parsed.values, 'probationEndDate')
              ? parsed.values.probationEndDate ?? null
              : currentItem.probationEndDate,
            noticeDays: Object.hasOwn(parsed.values, 'noticeDays')
              ? parsed.values.noticeDays ?? null
              : currentItem.noticeDays,
          };
          const nextStatus = parsed.status ?? currentItem.status;

          checkEmploymentTransition(currentItem.status, nextStatus);
          checkEmploymentValues(values, nextStatus);

          const changed = EMPLOYMENT_PATCH_FIELDS.filter((field) =>
            field === 'status'
              ? nextStatus !== currentItem.status
              : values[field] !== currentItem[field],
          ).sort();

          if (changed.length === 0) {
            // Nothing moved: no UPDATE, no audit row, and the stored row answers.
            return currentItem;
          }

          const setValues: unknown[] = [];
          const assignments = changed.map((field) => {
            setValues.push(field === 'status' ? nextStatus : values[field]);
            return `${EMPLOYMENT_COLUMNS[field]} = $${setValues.length}`;
          });

          const updated = await client.query(
            `update employment
                set ${assignments.join(', ')}
              where id = $${setValues.length + 1}
                and person_id = $${setValues.length + 2}`,
            [...setValues, employmentId, personId],
          );
          // One row or none: a statement that succeeded but matched nothing would
          // mean the policy moved under the transaction, so the write and its audit
          // row both roll back to a sanitized 500.
          if (updated.rowCount !== 1) {
            throw new ApiError(500, 'INTERNAL_ERROR');
          }

          const written = await client.query<EmploymentRow>(
            `${EMPLOYMENT_SELECT}
              ${EMPLOYMENT_FROM}
              where e.id = $1 and e.person_id = $2`,
            [employmentId, personId],
          );
          const row = written.rows[0];
          if (!row) {
            throw new ApiError(500, 'INTERNAL_ERROR');
          }

          await appendAuditEvent(client, {
            action: 'employment.updated',
            entityType: 'employment',
            entityId: employmentId,
            actorType: 'user',
            actorUserId: session.userId,
            metadata: { module: 'people', changedFields: changed },
            ip: request.ip,
            userAgent: request.headers['user-agent'] ?? null,
          });

          return employmentItemFromRow(row);
        },
      );
    } catch (error) {
      return await accessError(pool, error, request, reply, session);
    }
  });

  app.get('/v1/people/:id/compensations', async (request, reply) => {
    const session = await currentSession(request);
    if (!session) {
      return unauthenticated(reply);
    }

    const personId = (request.params as { id?: unknown }).id;

    try {
      // Compensation is salary history, so it has a permission of its own rather
      // than riding on people.read: the gate names people.compensation.read and
      // the assertion below it runs inside that gate. Entitlement is still
      // checked before the role, so an unentitled tenant answers
      // MODULE_NOT_ENTITLED for this path exactly as it does for every other.
      // No scope predicate is restated here; compensation's tenant_isolation and
      // the restrictive scope_read policy in 0013_compensation_read.sql narrow
      // the rows, and the member transaction is what sets the app.user_id that
      // policy keys on.
      return await withMemberTransaction(
        pool,
        {
          tenantId: session.tenantId,
          userId: session.userId,
          gate: {
            module: 'people',
            operation: 'read',
            permission: 'people.compensation.read',
          },
        },
        async (client) => {
          // Inside the gated transaction, after entitlement and role, so a denied
          // caller is denied the same way whatever the id looks like.
          if (typeof personId !== 'string' || !UUID_TEXT_PATTERN.test(personId)) {
            throw new ApiError(404, 'PERSON_NOT_FOUND');
          }

          // The person read is the visibility test, answered with the directory's
          // own miss: unknown, malformed, soft-deleted, another tenant or out of
          // scope are one PERSON_NOT_FOUND. A compensation route therefore cannot
          // be used to probe for people a member may not list.
          const personRows = await client.query<PeopleListRow>(
            `${DIRECTORY_SELECT}
              ${DIRECTORY_FROM}
              where p.id = $1 and p.deleted_at is null`,
            [personId],
          );
          if (!personRows.rows[0]) {
            throw new ApiError(404, 'PERSON_NOT_FOUND');
          }

          const rows = await client.query<CompensationRow>(
            `${COMPENSATION_SELECT}
              ${COMPENSATION_FROM}
              where c.person_id = $1
              ${COMPENSATION_ORDER}`,
            [personId],
          );
          const items = rows.rows.map(compensationItemFromRow);
          const body: CompensationListResponse = { items, total: items.length };
          return body;
        },
      );
    } catch (error) {
      return await accessError(pool, error, request, reply, session);
    }
  });

  app.post('/v1/people/:id/compensations', async (request, reply) => {
    const session = await currentSession(request);
    if (!session) {
      return unauthenticated(reply);
    }
    requireCsrfToken(session, request);

    const personId = (request.params as { id?: unknown }).id;

    try {
      const item = await withMemberTransaction(
        pool,
        {
          tenantId: session.tenantId,
          userId: session.userId,
          gate: {
            module: 'people',
            operation: 'write',
            permission: 'people.compensation.write',
          },
        },
        async (client) => {
          if (typeof personId !== 'string' || !UUID_TEXT_PATTERN.test(personId)) {
            throw new ApiError(404, 'PERSON_NOT_FOUND');
          }

          const personRows = await client.query<PeopleListRow>(
            `${DIRECTORY_SELECT}
              ${DIRECTORY_FROM}
              where p.id = $1 and p.deleted_at is null`,
            [personId],
          );
          if (!personRows.rows[0]) {
            throw new ApiError(404, 'PERSON_NOT_FOUND');
          }

          // The write oracle, not the read oracle: a member may see their own
          // directory row through app.person_visible and still never write
          // against it. The helper answers so the caller gets a typed 403 rather
          // than an INSERT that the scope_insert policy in
          // 0014_compensation_write.sql refuses in silence, and that policy
          // stays the database half of the rule.
          const writable = await client.query<{ allowed: boolean }>(
            'select app.person_in_scope($1) as allowed',
            [personId],
          );
          if (!writable.rows[0]?.allowed) {
            throw new ApiError(403, 'SCOPE_DENIED');
          }

          // Only now is the body read. A caller who may not touch this person
          // learns nothing about what a valid salary row looks like from the
          // order of the refusals, and one who may gets a 400 they can act on.
          const parsed = parseCompensationWrite(peopleWriteObject(request.body), 'create');
          const values: CompensationValues = {
            effectiveFrom: parsed.values.effectiveFrom as string,
            effectiveTo: parsed.values.effectiveTo ?? null,
            ctcMinor: parsed.values.ctcMinor as number,
            currency: parsed.values.currency as string,
            payFrequency: parsed.values.payFrequency as CompensationPayFrequency,
          };
          checkCompensationValues(values);

          // The id is generated here, as for person and employment, so the audit
          // entry names the row before the answer is sent. There is no RETURNING
          // because the response is the read-back: the row comes from the same
          // COMPENSATION_SELECT fragment the list uses, which formats the dates and
          // casts the bigint, so a write answer and a list answer cannot diverge.
          // (On person, RETURNING is not merely avoided - the restrictive scope_read
          // policy there reads the new row's own id and refuses it, ADR 0008. Here
          // the policy reads person_id, which names an already-existing person.)
          const id = randomUUID();
          try {
            await client.query(
              `insert into compensation
                 (id, tenant_id, person_id, effective_from, effective_to,
                  ctc_minor, currency, pay_frequency)
               values
                 ($1, app.current_tenant_id(), $2, $3, $4, $5, $6, $7)`,
              [
                id,
                personId,
                values.effectiveFrom,
                values.effectiveTo,
                values.ctcMinor,
                values.currency,
                values.payFrequency,
              ],
            );
          } catch (error) {
            const violation = error as { code?: string; constraint?: string };
            if (violation.code !== '23505') {
              throw error;
            }
            // unique (tenant_id, person_id, effective_from) is the only key this
            // path can collide with, and it names a period, not a value, so the
            // answer says which day is already taken without repeating the amount.
            throw new ApiError(409, 'COMPENSATION_PERIOD_EXISTS');
          }

          const created = await client.query<CompensationRow>(
            `${COMPENSATION_SELECT}
              ${COMPENSATION_FROM}
              where c.id = $1`,
            [id],
          );
          const row = created.rows[0];
          if (!row) {
            throw new ApiError(500, 'INTERNAL_ERROR');
          }

          await appendAuditEvent(client, {
            action: 'compensation.created',
            entityType: 'compensation',
            entityId: id,
            actorType: 'user',
            actorUserId: session.userId,
            // Field names and nothing else: the amount, the currency, the dates
            // and the frequency all stay on the row, and an audit trail that
            // copied salaries into metadata would be a second place to leak them.
            metadata: { fields: [...parsed.present].sort() },
            ip: request.ip,
            userAgent: request.headers['user-agent'] ?? null,
          });

          return compensationItemFromRow(row);
        },
      );

      reply.code(201);
      return item;
    } catch (error) {
      return await accessError(pool, error, request, reply, session);
    }
  });

  app.patch('/v1/people/:id/compensations/:compensationId', async (request, reply) => {
    const session = await currentSession(request);
    if (!session) {
      return unauthenticated(reply);
    }
    requireCsrfToken(session, request);

    const personId = (request.params as { id?: unknown }).id;
    const compensationId = (request.params as { compensationId?: unknown })
      .compensationId;

    try {
      return await withMemberTransaction(
        pool,
        {
          tenantId: session.tenantId,
          userId: session.userId,
          gate: {
            module: 'people',
            operation: 'write',
            permission: 'people.compensation.write',
          },
        },
        async (client) => {
          if (typeof personId !== 'string' || !UUID_TEXT_PATTERN.test(personId)) {
            throw new ApiError(404, 'PERSON_NOT_FOUND');
          }
          if (
            typeof compensationId !== 'string' ||
            !UUID_TEXT_PATTERN.test(compensationId)
          ) {
            throw new ApiError(404, 'COMPENSATION_NOT_FOUND');
          }

          // The person first, so a member who may not reach this colleague gets
          // the directory's own miss rather than a verdict about a pay row.
          const personRows = await client.query<PeopleListRow>(
            `${DIRECTORY_SELECT}
              ${DIRECTORY_FROM}
              where p.id = $1 and p.deleted_at is null`,
            [personId],
          );
          if (!personRows.rows[0]) {
            throw new ApiError(404, 'PERSON_NOT_FOUND');
          }

          // Addressed by its id and its person, so another person's row, a row in
          // another tenant and a row that does not exist are all one answer, and
          // no id can be probed through this path.
          const current = await client.query<CompensationRow>(
            `${COMPENSATION_SELECT}
              ${COMPENSATION_FROM}
              where c.id = $1 and c.person_id = $2`,
            [compensationId, personId],
          );
          const currentRow = current.rows[0];
          if (!currentRow) {
            throw new ApiError(404, 'COMPENSATION_NOT_FOUND');
          }
          const currentItem = compensationItemFromRow(currentRow);

          const writable = await client.query<{ allowed: boolean }>(
            'select app.person_in_scope($1) as allowed',
            [personId],
          );
          if (!writable.rows[0]?.allowed) {
            throw new ApiError(403, 'SCOPE_DENIED');
          }

          const parsed = parseCompensationWrite(peopleWriteObject(request.body), 'patch');

          // An absent key keeps the stored value; a present one states it, and
          // only effective_to may be stated as null, because that is the one
          // column of the five the table lets stand empty.
          const values: CompensationValues = {
            effectiveFrom: parsed.values.effectiveFrom ?? currentItem.effectiveFrom,
            effectiveTo: Object.hasOwn(parsed.values, 'effectiveTo')
              ? parsed.values.effectiveTo ?? null
              : currentItem.effectiveTo,
            ctcMinor: parsed.values.ctcMinor ?? currentItem.ctcMinor,
            currency: parsed.values.currency ?? currentItem.currency,
            payFrequency: parsed.values.payFrequency ?? currentItem.payFrequency,
          };
          checkCompensationValues(values);

          const changed = COMPENSATION_WRITE_FIELDS.filter(
            (field) => values[field] !== currentItem[field],
          ).sort();

          if (changed.length === 0) {
            // Nothing moved: no UPDATE, no audit row, and the stored row answers.
            return currentItem;
          }

          const setValues: unknown[] = [];
          const assignments = changed.map((field) => {
            setValues.push(values[field]);
            return `${COMPENSATION_COLUMNS[field]} = $${setValues.length}`;
          });

          try {
            const updated = await client.query(
              `update compensation
                  set ${assignments.join(', ')}
                where id = $${setValues.length + 1}
                  and person_id = $${setValues.length + 2}`,
              [...setValues, compensationId, personId],
            );
            // One row or none: a statement that succeeded but matched nothing
            // would mean a policy moved under the transaction, so the write and
            // its audit row both roll back to a sanitized 500.
            if (updated.rowCount !== 1) {
              throw new ApiError(500, 'INTERNAL_ERROR');
            }
          } catch (error) {
            const violation = error as { code?: string };
            if (violation.code !== '23505') {
              throw error;
            }
            // Moving a row onto a day this person already has is the same
            // collision a create can make, and it gets the same answer.
            throw new ApiError(409, 'COMPENSATION_PERIOD_EXISTS');
          }

          const written = await client.query<CompensationRow>(
            `${COMPENSATION_SELECT}
              ${COMPENSATION_FROM}
              where c.id = $1 and c.person_id = $2`,
            [compensationId, personId],
          );
          const row = written.rows[0];
          if (!row) {
            throw new ApiError(500, 'INTERNAL_ERROR');
          }

          await appendAuditEvent(client, {
            action: 'compensation.updated',
            entityType: 'compensation',
            entityId: compensationId,
            actorType: 'user',
            actorUserId: session.userId,
            // The changed field names only, in the same reviewed key set a create
            // writes. No before or after value of any amount is recorded here.
            metadata: { fields: changed },
            ip: request.ip,
            userAgent: request.headers['user-agent'] ?? null,
          });

          return compensationItemFromRow(row);
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

  // The Work read surface. One gate, one predicate, one body.
  app.get('/v1/work/projects', async (request, reply) => {
    const session = await currentSession(request);
    if (!session) {
      return unauthenticated(reply);
    }

    const query = request.query as Record<string, unknown>;
    const searchTerm = listSearchTerm(query, WORK_SEARCH_MAX_LENGTH);
    const page = listIntegerParam(query, 'page', 1, LIST_MAX_PAGE);
    const pageSize = listIntegerParam(
      query,
      'pageSize',
      WORK_LIST_DEFAULT_PAGE_SIZE,
      WORK_LIST_MAX_PAGE_SIZE,
    );

    try {
      // The gate is checked inside the transaction, so entitlement is answered
      // before the role is and both before a row is read. The restrictive
      // module_work_read policy narrows what this read can see; no scope
      // predicate is restated here.
      return await withMemberTransaction(
        pool,
        {
          tenantId: session.tenantId,
          userId: session.userId,
          gate: { module: 'work', operation: 'read' },
        },
        async (client) => {
          const clauses = ['p.deleted_at is null'];
          const filterValues: string[] = [];
          if (searchTerm !== '') {
            filterValues.push(searchTerm);
            const needle = `$${filterValues.length}`;
            // strpos over the lowered columns is a literal match, so a search
            // for "%" or "_" cannot behave like a LIKE wildcard.
            clauses.push(
              `(strpos(lower(p.name), lower(${needle})) > 0
                 or strpos(lower(coalesce(p.code, '')), lower(${needle})) > 0
                 or strpos(lower(coalesce(c.name, '')), lower(${needle})) > 0)`,
            );
          }
          const where = clauses.join(' and ');
          const limitIndex = filterValues.length + 1;

          const matching = await client.query<{ total: string }>(
            `select count(*) as total ${PROJECT_FROM} where ${where}`,
            filterValues,
          );
          const pageRows = await client.query<ProjectRow>(
            `${PROJECT_SELECT}
              ${PROJECT_FROM}
              where ${where}
              order by lower(p.name), p.id
              limit $${limitIndex} offset $${limitIndex + 1}`,
            [...filterValues, pageSize, (page - 1) * pageSize],
          );

          const items: ProjectListItem[] = pageRows.rows.map(projectItemFromRow);

          const body: ProjectListResponse = {
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

  // The Money read surface. The same shape, and the same refusal of an amount
  // a JavaScript number cannot hold exactly.
  app.get('/v1/money/invoices', async (request, reply) => {
    const session = await currentSession(request);
    if (!session) {
      return unauthenticated(reply);
    }

    const query = request.query as Record<string, unknown>;
    const searchTerm = listSearchTerm(query, MONEY_SEARCH_MAX_LENGTH);
    const page = listIntegerParam(query, 'page', 1, LIST_MAX_PAGE);
    const pageSize = listIntegerParam(
      query,
      'pageSize',
      MONEY_LIST_DEFAULT_PAGE_SIZE,
      MONEY_LIST_MAX_PAGE_SIZE,
    );

    try {
      return await withMemberTransaction(
        pool,
        {
          tenantId: session.tenantId,
          userId: session.userId,
          gate: { module: 'money', operation: 'read' },
        },
        async (client) => {
          const clauses: string[] = [];
          const filterValues: string[] = [];
          if (searchTerm !== '') {
            filterValues.push(searchTerm);
            const needle = `$${filterValues.length}`;
            clauses.push(
              `(strpos(lower(i.number), lower(${needle})) > 0
                 or strpos(lower(coalesce(c.name, '')), lower(${needle})) > 0)`,
            );
          }
          const where = clauses.length === 0 ? 'true' : clauses.join(' and ');
          const limitIndex = filterValues.length + 1;

          const matching = await client.query<{ total: string }>(
            `select count(*) as total ${INVOICE_FROM} where ${where}`,
            filterValues,
          );
          const pageRows = await client.query<InvoiceRow>(
            `${INVOICE_SELECT}
              ${INVOICE_FROM}
              where ${where}
              order by lower(i.number), i.id
              limit $${limitIndex} offset $${limitIndex + 1}`,
            [...filterValues, pageSize, (page - 1) * pageSize],
          );

          const items: InvoiceListItem[] = pageRows.rows.map(invoiceItemFromRow);

          const body: InvoiceListResponse = {
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

  // The Content read surface. A content item has no client, so this query joins
  // nothing and the client grant does not reach it.
  app.get('/v1/content/items', async (request, reply) => {
    const session = await currentSession(request);
    if (!session) {
      return unauthenticated(reply);
    }

    const query = request.query as Record<string, unknown>;
    const searchTerm = listSearchTerm(query, CONTENT_SEARCH_MAX_LENGTH);
    const page = listIntegerParam(query, 'page', 1, LIST_MAX_PAGE);
    const pageSize = listIntegerParam(
      query,
      'pageSize',
      CONTENT_LIST_DEFAULT_PAGE_SIZE,
      CONTENT_LIST_MAX_PAGE_SIZE,
    );

    try {
      return await withMemberTransaction(
        pool,
        {
          tenantId: session.tenantId,
          userId: session.userId,
          gate: { module: 'content', operation: 'read' },
        },
        async (client) => {
          const clauses = ['ct.deleted_at is null'];
          const filterValues: string[] = [];
          if (searchTerm !== '') {
            filterValues.push(searchTerm);
            const needle = `$${filterValues.length}`;
            clauses.push(
              `(strpos(lower(ct.title), lower(${needle})) > 0
                 or strpos(lower(ct.slug), lower(${needle})) > 0
                 or strpos(lower(ct.kind), lower(${needle})) > 0)`,
            );
          }
          const where = clauses.join(' and ');
          const limitIndex = filterValues.length + 1;

          const matching = await client.query<{ total: string }>(
            `select count(*) as total ${CONTENT_FROM} where ${where}`,
            filterValues,
          );
          const pageRows = await client.query<ContentRow>(
            `${CONTENT_SELECT}
              ${CONTENT_FROM}
              where ${where}
              order by lower(ct.title), ct.id
              limit $${limitIndex} offset $${limitIndex + 1}`,
            [...filterValues, pageSize, (page - 1) * pageSize],
          );

          const items: ContentListItem[] = pageRows.rows.map(contentItemFromRow);

          const body: ContentListResponse = {
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

  // The CRM account read surface. A shared client record, read through the
  // module gate rather than a module policy on the table.
  app.get('/v1/crm/accounts', async (request, reply) => {
    const session = await currentSession(request);
    if (!session) {
      return unauthenticated(reply);
    }

    const query = request.query as Record<string, unknown>;
    const searchTerm = listSearchTerm(query, CRM_SEARCH_MAX_LENGTH);
    const page = listIntegerParam(query, 'page', 1, LIST_MAX_PAGE);
    const pageSize = listIntegerParam(
      query,
      'pageSize',
      CRM_LIST_DEFAULT_PAGE_SIZE,
      CRM_LIST_MAX_PAGE_SIZE,
    );

    try {
      return await withMemberTransaction(
        pool,
        {
          tenantId: session.tenantId,
          userId: session.userId,
          gate: { module: 'crm', operation: 'read' },
        },
        async (client) => {
          // A soft-deleted client is not an account: the row stays for the
          // invoices and projects that name it, and it is dropped here.
          const clauses = ['c.deleted_at is null'];
          const filterValues: string[] = [];
          if (searchTerm !== '') {
            filterValues.push(searchTerm);
            const needle = `$${filterValues.length}`;
            // strpos over the lowered columns is a literal match, so a search
            // for "%" or "_" cannot behave like a LIKE wildcard.
            clauses.push(
              `(strpos(lower(c.name), lower(${needle})) > 0
                 or strpos(lower(coalesce(c.code, '')), lower(${needle})) > 0
                 or strpos(lower(coalesce(c.billing_email::text, '')), lower(${needle})) > 0)`,
            );
          }
          const where = clauses.join(' and ');
          const limitIndex = filterValues.length + 1;

          const matching = await client.query<{ total: string }>(
            `select count(*) as total ${CRM_ACCOUNT_FROM} where ${where}`,
            filterValues,
          );
          const pageRows = await client.query<CrmAccountRow>(
            `${CRM_ACCOUNT_SELECT}
              ${CRM_ACCOUNT_FROM}
              where ${where}
              order by lower(c.name), c.id
              limit $${limitIndex} offset $${limitIndex + 1}`,
            [...filterValues, pageSize, (page - 1) * pageSize],
          );

          const items: CrmAccountListItem[] = pageRows.rows.map(
            crmAccountItemFromRow,
          );

          const body: CrmAccountListResponse = {
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

  // The CRM account create. One gate, one explicit column list, one read-back.
  app.post('/v1/crm/accounts', async (request, reply) => {
    const session = await currentSession(request);
    if (!session) {
      return unauthenticated(reply);
    }
    requireCsrfToken(session, request);

    try {
      const item = await withMemberTransaction(
        pool,
        {
          tenantId: session.tenantId,
          userId: session.userId,
          gate: { module: 'crm', operation: 'write' },
        },
        async (client) => {
          // Only now is the body read. A caller who may not write learns
          // nothing about what a valid account looks like from the order of
          // the refusals, and one who may gets a 400 they can act on.
          const parsed = parseCrmAccountWrite(peopleWriteObject(request.body), 'create');

          const name = parsed.values.name as string;
          const currency = parsed.values.currency as string;

          // The column list is the reviewed one; the body chooses only whether
          // the two defaulted columns are named at all. status and
          // payment_terms_days take the database's own defaults when the
          // caller leaves them out, and every other column of the table -
          // owner_user_id, the provenance columns, the timestamps and
          // deleted_at - is never named here.
          const columns = [
            'id',
            'tenant_id',
            'name',
            'code',
            'billing_email',
            'phone',
            'currency',
          ];
          const expressions = ['$1', 'app.current_tenant_id()', '$2', '$3', '$4', '$5', '$6'];
          const bound: unknown[] = [
            randomUUID(),
            name,
            parsed.values.code ?? null,
            parsed.values.billingEmail ?? null,
            parsed.values.phone ?? null,
            currency,
          ];

          if (parsed.values.status !== undefined) {
            columns.push('status');
            expressions.push(`$${bound.length + 1}`);
            bound.push(parsed.values.status);
          }
          if (parsed.values.paymentTermsDays !== undefined) {
            columns.push('payment_terms_days');
            expressions.push(`$${bound.length + 1}`);
            bound.push(parsed.values.paymentTermsDays);
          }

          const id = bound[0] as string;

          try {
            await client.query(
              `insert into client (${columns.join(', ')})
               values (${expressions.join(', ')})`,
              bound,
            );
          } catch (error) {
            const violation = error as { code?: string };
            if (violation.code !== '23505') {
              throw error;
            }
            // unique (tenant_id, code) is the only key this path can collide
            // with, and the answer names the conflict without repeating the
            // value that was sent.
            throw new ApiError(409, 'ACCOUNT_CODE_TAKEN');
          }

          // The answer is the read-back, from the same select fragment the
          // list uses, so a write answer and a list answer cannot diverge.
          const created = await client.query<CrmAccountRow>(
            `${CRM_ACCOUNT_SELECT}
              ${CRM_ACCOUNT_FROM}
              where c.id = $1`,
            [id],
          );
          const row = created.rows[0];
          if (!row) {
            throw new ApiError(500, 'INTERNAL_ERROR');
          }

          await appendAuditEvent(client, {
            action: 'crm.account.created',
            entityType: 'crm_account',
            entityId: id,
            actorType: 'user',
            actorUserId: session.userId,
            // Field names and nothing else: the name, the code, the email, the
            // phone, the currency and the terms stay on the row, and an audit
            // trail that copied them into metadata would be a second place to
            // read them from.
            metadata: { fields: [...parsed.present].sort() },
            ip: request.ip,
            userAgent: request.headers['user-agent'] ?? null,
          });

          return crmAccountItemFromRow(row);
        },
      );

      reply.code(201);
      return item;
    } catch (error) {
      return await accessError(pool, error, request, reply, session);
    }
  });

  // The CRM account update. One gate, one explicit column list, one read-back.
  app.patch('/v1/crm/accounts/:id', async (request, reply) => {
    const session = await currentSession(request);
    if (!session) {
      return unauthenticated(reply);
    }
    requireCsrfToken(session, request);

    const accountId = (request.params as { id?: unknown }).id;

    try {
      return await withMemberTransaction(
        pool,
        {
          tenantId: session.tenantId,
          userId: session.userId,
          gate: { module: 'crm', operation: 'write' },
        },
        async (client) => {
          if (typeof accountId !== 'string' || !UUID_TEXT_PATTERN.test(accountId)) {
            throw new ApiError(404, 'ACCOUNT_NOT_FOUND');
          }

          // One answer for every way the id can fail to name a live account in
          // this tenant: unknown, malformed, another tenant's, or withdrawn.
          const current = await client.query<CrmAccountRow>(
            `${CRM_ACCOUNT_SELECT}
              ${CRM_ACCOUNT_FROM}
              where c.id = $1 and c.deleted_at is null`,
            [accountId],
          );
          const currentRow = current.rows[0];
          if (!currentRow) {
            throw new ApiError(404, 'ACCOUNT_NOT_FOUND');
          }
          const currentItem = crmAccountItemFromRow(currentRow);

          const parsed = parseCrmAccountWrite(peopleWriteObject(request.body), 'patch');

          // An absent key keeps the stored value; a present one states it.
          const values: CrmAccountValues = {
            name: parsed.values.name ?? currentItem.name,
            code: Object.hasOwn(parsed.values, 'code')
              ? parsed.values.code ?? null
              : currentItem.code,
            status: parsed.values.status ?? currentItem.status,
            billingEmail: Object.hasOwn(parsed.values, 'billingEmail')
              ? parsed.values.billingEmail ?? null
              : currentItem.billingEmail,
            phone: Object.hasOwn(parsed.values, 'phone')
              ? parsed.values.phone ?? null
              : currentItem.phone,
            currency: parsed.values.currency ?? currentItem.currency,
            paymentTermsDays:
              parsed.values.paymentTermsDays ?? currentItem.paymentTermsDays,
          };
          checkCrmAccountValues(values);

          const changed = CRM_ACCOUNT_WRITE_FIELDS.filter(
            (field) => values[field] !== currentItem[field],
          ).sort();

          if (changed.length === 0) {
            // Nothing moved: no UPDATE, no audit row, and the stored row
            // answers.
            return currentItem;
          }

          const setValues: unknown[] = [];
          const assignments = changed.map((field) => {
            setValues.push(values[field]);
            return `${CRM_ACCOUNT_COLUMNS[field]} = $${setValues.length}`;
          });

          try {
            const updated = await client.query(
              `update client
                  set ${assignments.join(', ')}
                where id = $${setValues.length + 1}
                  and deleted_at is null`,
              [...setValues, accountId],
            );
            // One row or none: a statement that succeeded but matched nothing
            // would mean a policy moved under the transaction, so the write and
            // its audit row both roll back to a sanitized 500.
            if (updated.rowCount !== 1) {
              throw new ApiError(500, 'INTERNAL_ERROR');
            }
          } catch (error) {
            const violation = error as { code?: string };
            if (violation.code !== '23505') {
              throw error;
            }
            // Moving an account onto a code this tenant already holds is the
            // same collision a create can make, and it gets the same answer.
            throw new ApiError(409, 'ACCOUNT_CODE_TAKEN');
          }

          const written = await client.query<CrmAccountRow>(
            `${CRM_ACCOUNT_SELECT}
              ${CRM_ACCOUNT_FROM}
              where c.id = $1`,
            [accountId],
          );
          const row = written.rows[0];
          if (!row) {
            throw new ApiError(500, 'INTERNAL_ERROR');
          }

          await appendAuditEvent(client, {
            action: 'crm.account.updated',
            entityType: 'crm_account',
            entityId: accountId,
            actorType: 'user',
            actorUserId: session.userId,
            // The changed field names only, in the same reviewed key set a
            // create writes. No before or after value of any field is
            // recorded here.
            metadata: { fields: changed },
            ip: request.ip,
            userAgent: request.headers['user-agent'] ?? null,
          });

          return crmAccountItemFromRow(row);
        },
      );
    } catch (error) {
      return await accessError(pool, error, request, reply, session);
    }
  });

  // The CRM contact read surface. The account in the path is checked first, so
  // a caller who cannot see the account learns nothing about the contacts
  // that hang off it.
  app.get('/v1/crm/accounts/:accountId/contacts', async (request, reply) => {
    const session = await currentSession(request);
    if (!session) {
      return unauthenticated(reply);
    }

    const accountId = (request.params as { accountId?: unknown }).accountId;

    try {
      return await withMemberTransaction(
        pool,
        {
          tenantId: session.tenantId,
          userId: session.userId,
          gate: { module: 'crm', operation: 'read' },
        },
        async (client) => {
          const account = await requireCrmAccount(client, accountId);

          const rows = await client.query<CrmContactRow>(
            `${CRM_CONTACT_SELECT}
              ${CRM_CONTACT_FROM}
              where ct.client_id = $1
              order by ct.is_primary desc, lower(ct.name), ct.id`,
            [account],
          );
          const counted = await client.query<{ total: string }>(
            `select count(*) as total
               from client_contact
              where client_id = $1`,
            [account],
          );

          const body: CrmContactListResponse = {
            items: rows.rows.map(crmContactItemFromRow),
            total: Number(counted.rows[0]?.total ?? '0'),
          };
          return body;
        },
      );
    } catch (error) {
      return await accessError(pool, error, request, reply, session);
    }
  });

  // The CRM contact create. The body is closed, the id is the server's, and
  // the account in the path is the only thing that can say which account the
  // contact belongs to.
  app.post('/v1/crm/accounts/:accountId/contacts', async (request, reply) => {
    const session = await currentSession(request);
    if (!session) {
      return unauthenticated(reply);
    }
    requireCsrfToken(session, request);

    const accountId = (request.params as { accountId?: unknown }).accountId;

    try {
      const contact = await withMemberTransaction(
        pool,
        {
          tenantId: session.tenantId,
          userId: session.userId,
          gate: { module: 'crm', operation: 'write' },
        },
        async (client) => {
          const account = await requireCrmAccount(client, accountId);

          const parsed = parseCrmContactWrite(peopleWriteObject(request.body), 'create');

          const name = parsed.values.name as string;
          const isPrimary = parsed.values.isPrimary ?? false;

          // An account holds at most one primary contact. The old primary is
          // demoted before the new one is written, in the same transaction, so
          // the partial unique index holds at every point another session can
          // see the rows.
          const demoted = isPrimary
            ? await demoteOtherPrimaries(client, account, null)
            : [];

          const id = randomUUID();
          try {
            await client.query(
              `insert into client_contact
                 (id, tenant_id, client_id, name, email, phone, role, is_primary)
               values ($1, app.current_tenant_id(), $2, $3, $4, $5, $6, $7)`,
              [
                id,
                account,
                name,
                parsed.values.email ?? null,
                parsed.values.phone ?? null,
                parsed.values.role ?? null,
                isPrimary,
              ],
            );
          } catch (error) {
            const violation = error as { code?: string };
            if (violation.code !== '23505') {
              throw error;
            }
            // The only key this path can collide with is the partial unique
            // index that keeps one primary contact per account, and the
            // answer names the conflict without repeating a value.
            throw new ApiError(409, 'CONTACT_PRIMARY_TAKEN');
          }

          const created = await client.query<CrmContactRow>(
            `${CRM_CONTACT_SELECT}
              ${CRM_CONTACT_FROM}
              where ct.id = $1`,
            [id],
          );
          const row = created.rows[0];
          if (!row) {
            throw new ApiError(500, 'INTERNAL_ERROR');
          }

          await appendAuditEvent(client, {
            action: 'crm.contact.created',
            entityType: 'crm_contact',
            entityId: id,
            actorType: 'user',
            actorUserId: session.userId,
            // Field names and nothing else: the name, the email, the phone and
            // the role stay on the row.
            metadata: { fields: [...parsed.present].sort() },
            ip: request.ip,
            userAgent: request.headers['user-agent'] ?? null,
          });

          // A demoted contact is a row that moved without the caller naming
          // it, so it is audited in its own right.
          for (const demotedId of demoted) {
            await appendAuditEvent(client, {
              action: 'crm.contact.updated',
              entityType: 'crm_contact',
              entityId: demotedId,
              actorType: 'user',
              actorUserId: session.userId,
              metadata: { fields: ['isPrimary'] },
              ip: request.ip,
              userAgent: request.headers['user-agent'] ?? null,
            });
          }

          return crmContactItemFromRow(row);
        },
      );

      reply.code(201);
      return contact;
    } catch (error) {
      return await accessError(pool, error, request, reply, session);
    }
  });

  // The CRM contact update. A contact belongs to the account in the path, and
  // one that does not is not found.
  app.patch('/v1/crm/accounts/:accountId/contacts/:contactId', async (request, reply) => {
    const session = await currentSession(request);
    if (!session) {
      return unauthenticated(reply);
    }
    requireCsrfToken(session, request);

    const params = request.params as { accountId?: unknown; contactId?: unknown };

    try {
      return await withMemberTransaction(
        pool,
        {
          tenantId: session.tenantId,
          userId: session.userId,
          gate: { module: 'crm', operation: 'write' },
        },
        async (client) => {
          const account = await requireCrmAccount(client, params.accountId);

          const contactId = params.contactId;
          if (typeof contactId !== 'string' || !UUID_TEXT_PATTERN.test(contactId)) {
            throw new ApiError(404, 'CONTACT_NOT_FOUND');
          }

          // One answer for a contact this account does not hold: a contact of
          // another account and a contact of another tenant are the same
          // not-found, so the reply says nothing about either.
          const current = await client.query<CrmContactRow>(
            `${CRM_CONTACT_SELECT}
              ${CRM_CONTACT_FROM}
              where ct.id = $1 and ct.client_id = $2`,
            [contactId, account],
          );
          const currentRow = current.rows[0];
          if (!currentRow) {
            throw new ApiError(404, 'CONTACT_NOT_FOUND');
          }
          const currentItem = crmContactItemFromRow(currentRow);

          const parsed = parseCrmContactWrite(peopleWriteObject(request.body), 'patch');

          // An absent key keeps the stored value; a present one states it.
          const values: CrmContactValues = {
            name: parsed.values.name ?? currentItem.name,
            email: Object.hasOwn(parsed.values, 'email')
              ? parsed.values.email ?? null
              : currentItem.email,
            phone: Object.hasOwn(parsed.values, 'phone')
              ? parsed.values.phone ?? null
              : currentItem.phone,
            role: Object.hasOwn(parsed.values, 'role')
              ? parsed.values.role ?? null
              : currentItem.role,
            isPrimary: parsed.values.isPrimary ?? currentItem.isPrimary,
          };
          checkCrmContactValues(values);

          const changed = CRM_CONTACT_WRITE_FIELDS.filter(
            (field) => values[field] !== currentItem[field],
          ).sort();

          if (changed.length === 0) {
            // Nothing moved: no UPDATE, no audit row, and the stored row
            // answers.
            return currentItem;
          }

          // A contact that becomes the primary demotes the account's other
          // primary, in the same transaction.
          const demoted =
            values.isPrimary && !currentItem.isPrimary
              ? await demoteOtherPrimaries(client, account, contactId)
              : [];

          const setValues: unknown[] = [];
          const assignments = changed.map((field) => {
            setValues.push(values[field]);
            return `${CRM_CONTACT_COLUMNS[field]} = $${setValues.length}`;
          });

          try {
            const updated = await client.query(
              `update client_contact
                  set ${assignments.join(', ')}
                where id = $${setValues.length + 1}
                  and client_id = $${setValues.length + 2}`,
              [...setValues, contactId, account],
            );
            // One row or none: a statement that succeeded but matched nothing
            // would mean a policy moved under the transaction, so the write and
            // its audit rows both roll back to a sanitized 500.
            if (updated.rowCount !== 1) {
              throw new ApiError(500, 'INTERNAL_ERROR');
            }
          } catch (error) {
            const violation = error as { code?: string };
            if (violation.code !== '23505') {
              throw error;
            }
            // Making a contact primary can collide with the account's other
            // primary, and it gets the same typed answer a create gets.
            throw new ApiError(409, 'CONTACT_PRIMARY_TAKEN');
          }

          const written = await client.query<CrmContactRow>(
            `${CRM_CONTACT_SELECT}
              ${CRM_CONTACT_FROM}
              where ct.id = $1`,
            [contactId],
          );
          const row = written.rows[0];
          if (!row) {
            throw new ApiError(500, 'INTERNAL_ERROR');
          }

          await appendAuditEvent(client, {
            action: 'crm.contact.updated',
            entityType: 'crm_contact',
            entityId: contactId,
            actorType: 'user',
            actorUserId: session.userId,
            // The changed field names only. No before or after value of any
            // field is recorded here.
            metadata: { fields: changed },
            ip: request.ip,
            userAgent: request.headers['user-agent'] ?? null,
          });

          for (const demotedId of demoted) {
            await appendAuditEvent(client, {
              action: 'crm.contact.updated',
              entityType: 'crm_contact',
              entityId: demotedId,
              actorType: 'user',
              actorUserId: session.userId,
              metadata: { fields: ['isPrimary'] },
              ip: request.ip,
              userAgent: request.headers['user-agent'] ?? null,
            });
          }

          return crmContactItemFromRow(row);
        },
      );
    } catch (error) {
      return await accessError(pool, error, request, reply, session);
    }
  });

  // The CRM lead read surface. A CRM-private row: the route gate and the
  // restrictive crm_read policy both have to allow it.
  app.get('/v1/crm/leads', async (request, reply) => {
    const session = await currentSession(request);
    if (!session) {
      return unauthenticated(reply);
    }

    const query = request.query as Record<string, unknown>;
    const searchTerm = listSearchTerm(query, CRM_SEARCH_MAX_LENGTH);
    const stage = crmLeadStageFilter(query);
    const page = listIntegerParam(query, 'page', 1, LIST_MAX_PAGE);
    const pageSize = listIntegerParam(
      query,
      'pageSize',
      CRM_LIST_DEFAULT_PAGE_SIZE,
      CRM_LIST_MAX_PAGE_SIZE,
    );

    try {
      return await withMemberTransaction(
        pool,
        {
          tenantId: session.tenantId,
          userId: session.userId,
          gate: { module: 'crm', operation: 'read' },
        },
        async (client) => {
          const clauses: string[] = [];
          const filterValues: string[] = [];
          if (searchTerm !== '') {
            filterValues.push(searchTerm);
            const needle = `$${filterValues.length}`;
            // strpos over the lowered columns is a literal match, so a search
            // for "%" or "_" cannot behave like a LIKE wildcard.
            clauses.push(
              `(strpos(lower(l.name), lower(${needle})) > 0
                 or strpos(lower(coalesce(l.company, '')), lower(${needle})) > 0
                 or strpos(lower(coalesce(l.email::text, '')), lower(${needle})) > 0)`,
            );
          }
          if (stage !== null) {
            filterValues.push(stage);
            clauses.push(`l.stage = $${filterValues.length}`);
          }
          const where = clauses.length === 0 ? 'true' : clauses.join(' and ');
          const limitIndex = filterValues.length + 1;

          const matching = await client.query<{ total: string }>(
            `select count(*) as total ${CRM_LEAD_FROM} where ${where}`,
            filterValues,
          );
          const pageRows = await client.query<CrmLeadRow>(
            `${CRM_LEAD_SELECT}
              ${CRM_LEAD_FROM}
              where ${where}
              order by l.stage, lower(l.name), l.id
              limit $${limitIndex} offset $${limitIndex + 1}`,
            [...filterValues, pageSize, (page - 1) * pageSize],
          );

          const body: CrmLeadListResponse = {
            items: pageRows.rows.map(crmLeadItemFromRow),
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

  // The CRM lead intake. One gate, one explicit column list, one read-back.
  app.post('/v1/crm/leads', async (request, reply) => {
    const session = await currentSession(request);
    if (!session) {
      return unauthenticated(reply);
    }
    requireCsrfToken(session, request);

    try {
      const item = await withMemberTransaction(
        pool,
        {
          tenantId: session.tenantId,
          userId: session.userId,
          gate: { module: 'crm', operation: 'write' },
        },
        async (client) => {
          // Only now is the body read. A caller who may not write learns
          // nothing about what a valid lead looks like from the order of the
          // refusals.
          const parsed = parseCrmLeadWrite(peopleWriteObject(request.body), 'create');

          // The column list is the reviewed one; the body chooses only whether
          // stage is named at all, and an absent stage takes the database's
          // own 'new' default. The conversion columns are never named here: a
          // lead is born unconverted.
          const columns = [
            'id',
            'tenant_id',
            'name',
            'company',
            'email',
            'phone',
            'source',
          ];
          const expressions = [
            '$1',
            'app.current_tenant_id()',
            '$2',
            '$3',
            '$4::citext',
            '$5',
            '$6',
          ];
          const bound: unknown[] = [
            randomUUID(),
            parsed.values.name as string,
            parsed.values.company ?? null,
            parsed.values.email ?? null,
            parsed.values.phone ?? null,
            parsed.values.source ?? null,
          ];

          if (parsed.values.stage !== undefined) {
            columns.push('stage');
            expressions.push(`$${bound.length + 1}`);
            bound.push(parsed.values.stage);
          }

          const id = bound[0] as string;

          await client.query(
            `insert into crm_lead (${columns.join(', ')})
             values (${expressions.join(', ')})`,
            bound,
          );

          // The answer is the read-back, from the same select fragment the
          // list uses, so a write answer and a list answer cannot diverge.
          const created = await client.query<CrmLeadRow>(
            `${CRM_LEAD_SELECT}
              ${CRM_LEAD_FROM}
              where l.id = $1`,
            [id],
          );
          const row = created.rows[0];
          if (!row) {
            throw new ApiError(500, 'INTERNAL_ERROR');
          }

          await appendAuditEvent(client, {
            action: 'crm.lead.created',
            entityType: 'crm_lead',
            entityId: id,
            actorType: 'user',
            actorUserId: session.userId,
            // Field names and nothing else: the name, the company, the email,
            // the phone and the source stay on the row, and an audit trail
            // that copied them into metadata would be a second place to read
            // them from.
            metadata: { fields: [...parsed.present].sort() },
            ip: request.ip,
            userAgent: request.headers['user-agent'] ?? null,
          });

          return crmLeadItemFromRow(row);
        },
      );

      reply.code(201);
      return item;
    } catch (error) {
      return await accessError(pool, error, request, reply, session);
    }
  });

  // The CRM lead stage movement. The table's policies and terminality check
  // still apply; this route is where the two application rules live. An open
  // lead may move among the open stages or be disqualified. A converted lead is
  // reached only through the conversion route, and a lead that has reached
  // either terminal stage can no longer change.
  app.patch('/v1/crm/leads/:id', async (request, reply) => {
    const session = await currentSession(request);
    if (!session) {
      return unauthenticated(reply);
    }
    requireCsrfToken(session, request);

    const leadId = (request.params as { id?: unknown }).id;

    try {
      return await withMemberTransaction(
        pool,
        {
          tenantId: session.tenantId,
          userId: session.userId,
          gate: { module: 'crm', operation: 'write' },
        },
        async (client) => {
          const currentRow = await requireCrmLead(client, leadId, true);
          const currentItem = crmLeadItemFromRow(currentRow);

          const parsed = parseCrmLeadWrite(peopleWriteObject(request.body), 'patch');

          // An absent key keeps the stored value; a present one states it.
          const values: CrmLeadValues = {
            name: parsed.values.name ?? currentItem.name,
            company: Object.hasOwn(parsed.values, 'company')
              ? parsed.values.company ?? null
              : currentItem.company,
            email: Object.hasOwn(parsed.values, 'email')
              ? parsed.values.email ?? null
              : currentItem.email,
            phone: Object.hasOwn(parsed.values, 'phone')
              ? parsed.values.phone ?? null
              : currentItem.phone,
            source: Object.hasOwn(parsed.values, 'source')
              ? parsed.values.source ?? null
              : currentItem.source,
            stage: parsed.values.stage ?? currentItem.stage,
          };
          checkCrmLeadValues(values);

          const changed = CRM_LEAD_WRITE_FIELDS.filter(
            (field) => values[field] !== currentItem[field],
          ).sort();

          if (changed.length === 0) {
            // Nothing moved: no UPDATE, no audit row, and the stored row
            // answers. A terminal lead can be re-read this way; it cannot be
            // changed.
            return currentItem;
          }

          if (
            currentItem.stage === 'converted' ||
            currentItem.stage === 'disqualified'
          ) {
            throw new ApiError(409, 'LEAD_TERMINAL');
          }

          // 'converted' is not a stage this route writes. Conversion writes an
          // account and a contact as well, and that is one transaction of its
          // own, reached through the convert route.
          if (values.stage === 'converted') {
            throw new ApiError(409, 'LEAD_CONVERSION_REQUIRED');
          }

          const setValues: unknown[] = [];
          const assignments = changed.map((field) => {
            setValues.push(values[field]);
            return `${CRM_LEAD_COLUMNS[field]} = $${setValues.length}`;
          });

          const updated = await client.query(
            `update crm_lead
                set ${assignments.join(', ')}
              where id = $${setValues.length + 1}`,
            [...setValues, currentItem.id],
          );
          // One row or none: a statement that succeeded but matched nothing
          // would mean a policy moved under the transaction, so the write and
          // its audit row both roll back to a sanitized 500.
          if (updated.rowCount !== 1) {
            throw new ApiError(500, 'INTERNAL_ERROR');
          }

          const written = await client.query<CrmLeadRow>(
            `${CRM_LEAD_SELECT}
              ${CRM_LEAD_FROM}
              where l.id = $1`,
            [currentItem.id],
          );
          const row = written.rows[0];
          if (!row) {
            throw new ApiError(500, 'INTERNAL_ERROR');
          }

          await appendAuditEvent(client, {
            action: 'crm.lead.updated',
            entityType: 'crm_lead',
            entityId: currentItem.id,
            actorType: 'user',
            actorUserId: session.userId,
            // The changed field names only. No before or after value of any
            // field is recorded here.
            metadata: { fields: changed },
            ip: request.ip,
            userAgent: request.headers['user-agent'] ?? null,
          });

          return crmLeadItemFromRow(row);
        },
      );
    } catch (error) {
      return await accessError(pool, error, request, reply, session);
    }
  });

  // The CRM lead conversion. One transaction writes three rows: the account the
  // lead became, its primary contact and the lead's own terminal state. Either
  // all three exist or none does, so a failure between them cannot leave a lead
  // marked converted with no account, or an account with no lead that explains
  // it.
  //
  // The lead is read under its row lock before anything is inserted. Two
  // conversions of the same lead therefore serialize, and the second reads the
  // committed 'converted' row and is answered 409 with nothing written.
  app.post('/v1/crm/leads/:id/convert', async (request, reply) => {
    const session = await currentSession(request);
    if (!session) {
      return unauthenticated(reply);
    }
    requireCsrfToken(session, request);

    const leadId = (request.params as { id?: unknown }).id;

    try {
      const conversion = await withMemberTransaction(
        pool,
        {
          tenantId: session.tenantId,
          userId: session.userId,
          gate: { module: 'crm', operation: 'write' },
        },
        async (client): Promise<CrmLeadConversionResponse> => {
          const leadRow = await requireCrmLead(client, leadId, true);
          const lead = crmLeadItemFromRow(leadRow);

          // The body is read after the gate and after the lead is known, so a
          // caller who may not write learns nothing about a valid body, and a
          // caller who names no lead of this tenant gets the 404 rather than a
          // verdict on the body.
          const parsed = parseCrmLeadConversion(peopleWriteObject(request.body));

          if (lead.stage === 'converted') {
            throw new ApiError(409, 'LEAD_ALREADY_CONVERTED');
          }
          if (lead.stage === 'disqualified') {
            throw new ApiError(409, 'LEAD_TERMINAL');
          }

          // The account is a shared client record: no code is set, the status
          // and the payment terms take the database's defaults, and the
          // currency is the code the caller stated. The billing email and the
          // phone are the lead's own contact details, copied once at the moment
          // the lead becomes an account.
          const accountId = randomUUID();
          const accountName = parsed.accountName ?? lead.company ?? lead.name;
          await client.query(
            `insert into client
               (id, tenant_id, name, billing_email, phone, currency)
             values ($1, app.current_tenant_id(), $2, $3, $4, $5)`,
            [accountId, accountName, lead.email, lead.phone, parsed.currency],
          );

          // The contact is the person the lead named, and the account has no
          // other contact, so it is primary by construction.
          const contactId = randomUUID();
          await client.query(
            `insert into client_contact
               (id, tenant_id, client_id, name, email, phone, is_primary)
             values ($1, app.current_tenant_id(), $2, $3, $4, $5, true)`,
            [contactId, accountId, lead.name, lead.email, lead.phone],
          );

          // One statement states the whole terminal state, so the table's
          // terminality check sees the stage and both ids in the same row
          // version.
          const converted = await client.query(
            `update crm_lead
                set stage = 'converted',
                    converted_client_id = $1,
                    converted_contact_id = $2,
                    converted_at = now()
              where id = $3`,
            [accountId, contactId, lead.id],
          );
          if (converted.rowCount !== 1) {
            throw new ApiError(500, 'INTERNAL_ERROR');
          }

          // All three rows are read back through the fragments their own
          // surfaces use, so a conversion answer and a list answer cannot
          // diverge.
          const leadRead = await client.query<CrmLeadRow>(
            `${CRM_LEAD_SELECT}
              ${CRM_LEAD_FROM}
              where l.id = $1`,
            [lead.id],
          );
          const accountRead = await client.query<CrmAccountRow>(
            `${CRM_ACCOUNT_SELECT}
              ${CRM_ACCOUNT_FROM}
              where c.id = $1`,
            [accountId],
          );
          const contactRead = await client.query<CrmContactRow>(
            `${CRM_CONTACT_SELECT}
              ${CRM_CONTACT_FROM}
              where ct.id = $1`,
            [contactId],
          );
          const writtenLead = leadRead.rows[0];
          const writtenAccount = accountRead.rows[0];
          const writtenContact = contactRead.rows[0];
          if (!writtenLead || !writtenAccount || !writtenContact) {
            throw new ApiError(500, 'INTERNAL_ERROR');
          }

          await appendAuditEvent(client, {
            action: 'crm.lead.converted',
            entityType: 'crm_lead',
            entityId: lead.id,
            actorType: 'user',
            actorUserId: session.userId,
            // The field names the conversion set, and nothing else: no name,
            // email, phone, currency or id is copied into the trail.
            metadata: {
              fields: ['convertedAccountId', 'convertedContactId', 'stage'],
            },
            ip: request.ip,
            userAgent: request.headers['user-agent'] ?? null,
          });

          return {
            lead: crmLeadItemFromRow(writtenLead),
            account: crmAccountItemFromRow(writtenAccount),
            contact: crmContactItemFromRow(writtenContact),
          };
        },
      );

      return conversion;
    } catch (error) {
      return await accessError(pool, error, request, reply, session);
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
