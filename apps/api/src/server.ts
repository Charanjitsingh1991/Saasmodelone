import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import cookie from '@fastify/cookie';
import {
  hasPermission,
  permissionFor,
  permissionsForRole,
  COMPENSATION_CTC_MINOR_MAX,
  COMPENSATION_PAY_FREQUENCIES,
  EMPLOYMENT_NOTICE_DAYS_MAX,
  EMPLOYMENT_STATUSES,
  EMPLOYMENT_TYPES,
  PEOPLE_LIST_DEFAULT_PAGE_SIZE,
  PEOPLE_LIST_MAX_PAGE_SIZE,
  PEOPLE_SEARCH_MAX_LENGTH,
  PERSON_DISPLAY_NAME_MAX_LENGTH,
  PERSON_EMPLOYEE_CODE_MAX_LENGTH,
  PERSON_NAME_MAX_LENGTH,
  PERSON_PHONE_MAX_LENGTH,
  PERSON_WORK_EMAIL_MAX_LENGTH,
  type ContextModule,
  type ContextResponse,
  type CompensationItem,
  type CompensationListResponse,
  type CompensationPayFrequency,
  type EmploymentItem,
  type EmploymentListResponse,
  type EmploymentStatus,
  type EmploymentType,
  type PeopleListItem,
  type PeopleListResponse,
  type PeoplePlacementInput,
  type PeoplePlacementOptions,
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
  // or shared cache, including error responses. Every People path is covered by
  // prefix, so a write, a 4xx and a 5xx are all no-store too.
  app.addHook('onSend', async (request, reply) => {
    if (
      request.url.startsWith('/v1/auth/') ||
      request.url.startsWith('/v1/context') ||
      request.url.startsWith('/v1/people')
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
