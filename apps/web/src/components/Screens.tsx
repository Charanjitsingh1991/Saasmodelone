import { Fragment, useEffect, useState, type FormEvent } from 'react';
import type {
  CompensationCreateInput,
  CompensationItem,
  CompensationListResponse,
  CompensationPayFrequency,
  CompensationUpdateInput,
  ContextResponse,
  EmploymentCreateInput,
  EmploymentItem,
  EmploymentListResponse,
  EmploymentStatus,
  EmploymentType,
  EmploymentUpdateInput,
  PeopleCreateInput,
  PeopleListItem,
  PeopleListResponse,
  PeoplePlacementInput,
  PeoplePlacementOptions,
  PeopleUpdateInput,
} from '@saasmodels/contracts';
import {
  COMPENSATION_CTC_MINOR_MAX,
  COMPENSATION_PAY_FREQUENCIES,
  EMPLOYMENT_NOTICE_DAYS_MAX,
  EMPLOYMENT_STATUSES,
  EMPLOYMENT_TYPES,
  PEOPLE_LIST_DEFAULT_PAGE_SIZE,
  PEOPLE_SEARCH_MAX_LENGTH,
  PERSON_DISPLAY_NAME_MAX_LENGTH,
  PERSON_EMPLOYEE_CODE_MAX_LENGTH,
  PERSON_NAME_MAX_LENGTH,
  PERSON_PHONE_MAX_LENGTH,
  PERSON_WORK_EMAIL_MAX_LENGTH,
} from '@saasmodels/contracts';
import { api } from '../api';
import {
  accessLabel,
  availableModuleNames,
  canReadCompensation,
  canWriteCompensation,
  findModule,
  formatCompensationAmount,
  orderModules,
  roleLabel,
} from '../lib/model';

type LinkHandler = (path: string) => void;

type HomeScreenProps = {
  context: ContextResponse;
  onNavigate: LinkHandler;
};

export function HomeScreen({ context, onNavigate }: HomeScreenProps) {
  const modules = orderModules(context.modules);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="eyebrow">Workspace</p>
          <h1>Your workspace is ready.</h1>
          <p className="page-lede">
            Signed in as {roleLabel(context.role).toLowerCase()}. These are the
            modules enabled by your licence and your role.
          </p>
        </div>
      </header>

      <section className="roster" aria-labelledby="enabled-modules">
        <div className="section-head">
          <h2 id="enabled-modules">Enabled modules</h2>
          <span className="section-count">{modules.length}</span>
        </div>
        {modules.length === 0 ? (
          <p className="roster-empty">
            No modules are enabled for your role yet. Your workspace owner can
            change this.
          </p>
        ) : (
          <ul className="module-list">
            {modules.map((module) => (
              <li key={module.code}>
                <div>
                  <p className="module-name">{module.name}</p>
                  <p className="module-note">
                    {module.code === 'people'
                      ? 'The shared directory for this workspace.'
                      : 'Enabled for this workspace. Its interface arrives in a later milestone.'}
                  </p>
                </div>
                {module.code === 'people' ? (
                  <a
                    className="text-link"
                    href="/app/people"
                    onClick={(event) => {
                      event.preventDefault();
                      onNavigate('/app/people');
                    }}
                  >
                    Open People
                  </a>
                ) : (
                  <span className="section-count">{accessLabel(module)}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

type PeopleScreenProps = {
  context: ContextResponse;
};

type DirectoryState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; data: PeopleListResponse };

const DIRECTORY_ERROR_MESSAGE =
  'The directory could not be loaded. Try again.';

function directoryCount(total: number): string {
  return `${total} ${total === 1 ? 'person' : 'people'}`;
}

// The live region must not announce a load that already failed, so its copy
// follows the phase rather than the presence of data.
function directoryStatusCopy(state: DirectoryState): string {
  if (state.phase === 'error') {
    return 'Directory unavailable';
  }
  if (state.phase === 'ready') {
    return directoryCount(state.data.total);
  }
  return 'Loading the directory…';
}

type PeopleFormField =
  | 'firstName'
  | 'lastName'
  | 'displayName'
  | 'employeeCode'
  | 'workEmail'
  | 'phone';

type PeopleFormValues = Record<PeopleFormField, string>;

const EMPTY_PEOPLE_FORM: PeopleFormValues = {
  firstName: '',
  lastName: '',
  displayName: '',
  employeeCode: '',
  workEmail: '',
  phone: '',
};

const PEOPLE_FORM_FIELDS: ReadonlyArray<{
  key: PeopleFormField;
  label: string;
  maxLength: number;
  required?: boolean;
  email?: boolean;
  placeholder?: string;
}> = [
  { key: 'firstName', label: 'First name', maxLength: PERSON_NAME_MAX_LENGTH, required: true },
  { key: 'lastName', label: 'Last name', maxLength: PERSON_NAME_MAX_LENGTH },
  {
    key: 'displayName',
    label: 'Display name',
    maxLength: PERSON_DISPLAY_NAME_MAX_LENGTH,
    placeholder: 'Defaults to first and last name',
  },
  { key: 'employeeCode', label: 'Employee code', maxLength: PERSON_EMPLOYEE_CODE_MAX_LENGTH },
  { key: 'workEmail', label: 'Work email', maxLength: PERSON_WORK_EMAIL_MAX_LENGTH, email: true },
  { key: 'phone', label: 'Phone', maxLength: PERSON_PHONE_MAX_LENGTH },
];

// Every failure the write routes can return has honest copy here, so the screen
// never shows a raw server message and never shows a success it did not get.
const PEOPLE_WRITE_ERROR_COPY: Record<string, string> = {
  PERSON_CODE_TAKEN: 'That employee code already belongs to someone in this workspace.',
  PERSON_EMAIL_TAKEN: 'That work email already belongs to someone in this workspace.',
  SCOPE_DENIED:
    'A new person starts unplaced, which only a workspace-wide role can record. Ask an owner or admin to add them.',
  INVALID_BODY:
    'The details were not accepted. A first name is required and each value has a length limit.',
  CSRF_INVALID:
    'This browser no longer matches your session. Sign out, sign in again and retry.',
  NETWORK: 'The workspace could not be reached. Check your connection and try again.',
};

const PEOPLE_WRITE_ERROR_FALLBACK = 'The person could not be saved. Try again.';

function peopleWriteErrorCopy(code: string | null): string {
  if (code === null) {
    return PEOPLE_WRITE_ERROR_FALLBACK;
  }
  return PEOPLE_WRITE_ERROR_COPY[code] ?? PEOPLE_WRITE_ERROR_FALLBACK;
}

// The placement route has its own failures, and PLACEMENT_NOT_FOUND is the
// shaped answer for a legal entity or org unit this member cannot reach.
const PEOPLE_PLACEMENT_ERROR_COPY: Record<string, string> = {
  PLACEMENT_NOT_FOUND: 'That legal entity or org unit is not available to you.',
  SCOPE_DENIED: 'Only a workspace-wide role can remove a placement.',
  INVALID_BODY:
    'Choose one legal entity, or one org unit inside the legal entity you chose.',
  CSRF_INVALID:
    'This browser no longer matches your session. Sign out, sign in again and retry.',
  NETWORK: 'The workspace could not be reached. Check your connection and try again.',
};

const PEOPLE_PLACEMENT_ERROR_FALLBACK =
  'The placement could not be saved. Try again.';

const PLACEMENT_OPTIONS_ERROR = 'The placement choices could not be loaded.';

function peoplePlacementErrorCopy(code: string | null): string {
  if (code === null) {
    return PEOPLE_PLACEMENT_ERROR_FALLBACK;
  }
  return PEOPLE_PLACEMENT_ERROR_COPY[code] ?? PEOPLE_PLACEMENT_ERROR_FALLBACK;
}

type PlacementOptionsState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'error' }
  | { phase: 'ready'; data: PeoplePlacementOptions };

// One select value per choice: an org unit carries its own id and the route
// sends the pair, an entity is entity-only, and 'unplaced' is the both-null
// write. A person placed somewhere this member was not offered keeps an empty
// selection, so the panel cannot submit a change it never displayed.
function placementSelection(
  person: PeopleListItem,
  options: PeoplePlacementOptions,
): string {
  if (
    person.orgUnitId !== null &&
    options.orgUnits.some((unit) => unit.id === person.orgUnitId)
  ) {
    return `ou:${person.orgUnitId}`;
  }
  if (
    person.legalEntityId !== null &&
    person.orgUnitId === null &&
    options.legalEntities.some(
      (entity) => entity.placeable && entity.id === person.legalEntityId,
    )
  ) {
    return `le:${person.legalEntityId}`;
  }
  if (
    person.legalEntityId === null &&
    person.orgUnitId === null &&
    options.canUnplace
  ) {
    return 'unplaced';
  }
  return '';
}

function placementInputFromSelection(
  selection: string,
  options: PeoplePlacementOptions,
): PeoplePlacementInput | null {
  if (selection === 'unplaced') {
    return { legalEntityId: null, orgUnitId: null };
  }
  if (selection.startsWith('le:')) {
    const id = selection.slice(3);
    const entity = options.legalEntities.find(
      (candidate) => candidate.id === id && candidate.placeable,
    );
    return entity ? { legalEntityId: entity.id, orgUnitId: null } : null;
  }
  if (selection.startsWith('ou:')) {
    const unit = options.orgUnits.find((candidate) => candidate.id === selection.slice(3));
    return unit ? { legalEntityId: unit.legalEntityId, orgUnitId: unit.id } : null;
  }
  return null;
}

function placementCopy(person: PeopleListItem): string {
  return [person.legalEntityName, person.orgUnitName]
    .filter((name): name is string => name !== null)
    .join(' · ');
}

function formValuesFromPerson(person: PeopleListItem): PeopleFormValues {
  return {
    firstName: person.firstName,
    lastName: person.lastName ?? '',
    displayName: person.displayName,
    employeeCode: person.employeeCode ?? '',
    workEmail: person.workEmail ?? '',
    phone: person.phone ?? '',
  };
}

// A blank optional on create means "not recorded", so the key is left out and
// the audit lists only the fields someone actually filled in.
function peopleCreateInput(values: PeopleFormValues): PeopleCreateInput {
  const input: PeopleCreateInput = { firstName: values.firstName.trim() };
  const optional: Exclude<PeopleFormField, 'firstName'>[] = [
    'lastName',
    'displayName',
    'employeeCode',
    'workEmail',
    'phone',
  ];
  for (const field of optional) {
    const value = values[field].trim();
    if (value !== '') {
      input[field] = value;
    }
  }
  return input;
}

// A blank optional on edit means "clear it", which an update states as null;
// leaving a key out would mean "unchanged".
function peopleUpdateInput(values: PeopleFormValues): PeopleUpdateInput {
  const trimmed = (field: PeopleFormField): string | null => {
    const value = values[field].trim();
    return value === '' ? null : value;
  };
  return {
    // The contract cannot null the first name, so an empty one is sent as an
    // empty value and the API answers with the validation error.
    firstName: values.firstName.trim(),
    lastName: trimmed('lastName'),
    displayName: trimmed('displayName'),
    employeeCode: trimmed('employeeCode'),
    workEmail: trimmed('workEmail'),
    phone: trimmed('phone'),
  };
}

type EmploymentFormValues = {
  employmentType: EmploymentType;
  startDate: string;
  endDate: string;
  probationEndDate: string;
  noticeDays: string;
  status: EmploymentStatus;
};

const EMPTY_EMPLOYMENT_FORM: EmploymentFormValues = {
  employmentType: 'full_time',
  startDate: '',
  endDate: '',
  probationEndDate: '',
  noticeDays: '',
  status: 'active',
};

// The two enums are the only words on this panel a member cannot type, so they
// are labelled from the contract values rather than stored as free text.
const EMPLOYMENT_TYPE_LABELS: Record<EmploymentType, string> = {
  full_time: 'Full time',
  part_time: 'Part time',
  contract: 'Contract',
  intern: 'Intern',
  consultant: 'Consultant',
};

const EMPLOYMENT_STATUS_LABELS: Record<EmploymentStatus, string> = {
  active: 'Active',
  ended: 'Ended',
  cancelled: 'Cancelled',
};

// The offer follows the rule the route enforces: an active record can be closed
// or cancelled, and a record that has left active stays where it is. A member
// is never shown a transition the server would refuse.
function offerableEmploymentStatuses(
  current: EmploymentStatus,
): EmploymentStatus[] {
  return current === 'active' ? [...EMPLOYMENT_STATUSES] : [current];
}

function formValuesFromEmployment(employment: EmploymentItem): EmploymentFormValues {
  return {
    employmentType: employment.employmentType,
    startDate: employment.startDate,
    endDate: employment.endDate ?? '',
    probationEndDate: employment.probationEndDate ?? '',
    noticeDays: employment.noticeDays === null ? '' : String(employment.noticeDays),
    status: employment.status,
  };
}

// A blank optional on create means "not recorded", so the key is left out and the
// audit lists only the fields someone actually filled in.
function employmentCreateInput(values: EmploymentFormValues): EmploymentCreateInput {
  const input: EmploymentCreateInput = {
    employmentType: values.employmentType,
    startDate: values.startDate,
  };
  if (values.endDate !== '') {
    input.endDate = values.endDate;
  }
  if (values.probationEndDate !== '') {
    input.probationEndDate = values.probationEndDate;
  }
  if (values.noticeDays !== '') {
    input.noticeDays = Number(values.noticeDays);
  }
  return input;
}

// A whole statement of the row, so a blank optional field clears it the way the
// identity form does. Status is always sent because the edit form always shows
// it; on an unchanged row that is the same value, which the route reads as no
// transition.
function employmentUpdateInput(values: EmploymentFormValues): EmploymentUpdateInput {
  return {
    employmentType: values.employmentType,
    startDate: values.startDate,
    endDate: values.endDate === '' ? null : values.endDate,
    probationEndDate: values.probationEndDate === '' ? null : values.probationEndDate,
    noticeDays: values.noticeDays === '' ? null : Number(values.noticeDays),
    status: values.status,
  };
}

function employmentFormMatches(
  values: EmploymentFormValues,
  employment: EmploymentItem,
): boolean {
  return (
    values.employmentType === employment.employmentType &&
    values.startDate === employment.startDate &&
    values.endDate === (employment.endDate ?? '') &&
    values.probationEndDate === (employment.probationEndDate ?? '') &&
    values.noticeDays ===
      (employment.noticeDays === null ? '' : String(employment.noticeDays)) &&
    values.status === employment.status
  );
}

function employmentPeriod(employment: EmploymentItem): string {
  return `${employment.startDate} – ${employment.endDate ?? 'open'}`;
}

// Every failure these routes can return has honest copy here, so the screen
// never shows a raw server message and never shows a success it did not get.
const EMPLOYMENT_WRITE_ERROR_COPY: Record<string, string> = {
  EMPLOYMENT_ENTITY_REQUIRED:
    'Place this person on a current legal entity first. Employment always records the entity the person sits on.',
  EMPLOYMENT_STATUS_TRANSITION_INVALID:
    'Employment status only moves forward: an active record can be ended or cancelled, and one that has ended or been cancelled stays that way.',
  PERSON_NOT_FOUND: 'That person is no longer in the directory you can see.',
  // The server can answer this for a colleague whose own record you are: the
  // directory shows them to you, but maintaining their employment belongs to a
  // role whose scope reaches that placement.
  SCOPE_DENIED:
    'You can see this person, but your scope does not cover where they are placed, so their employment is not yours to change.',
  EMPLOYMENT_NOT_FOUND:
    'That employment record is no longer available to you.',
  INVALID_BODY:
    'The details were not accepted. A type and a start date are required, an end date and a probation end date cannot precede the start, and notice days must be a whole number from 0 to 3650.',
  CSRF_INVALID:
    'This browser no longer matches your session. Sign out, sign in again and retry.',
  NETWORK: 'The workspace could not be reached. Check your connection and try again.',
};

const EMPLOYMENT_WRITE_ERROR_FALLBACK =
  'The employment record could not be saved. Try again.';

function employmentWriteErrorCopy(code: string | null): string {
  if (code === null) {
    return EMPLOYMENT_WRITE_ERROR_FALLBACK;
  }
  return EMPLOYMENT_WRITE_ERROR_COPY[code] ?? EMPLOYMENT_WRITE_ERROR_FALLBACK;
}

const EMPLOYMENT_LIST_ERROR =
  'The employment history could not be loaded. Try again.';

type EmploymentPanelState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'error' }
  | { phase: 'ready'; data: EmploymentListResponse };

// The pay frequency is one of four stored words a member cannot type, so it is
// labelled from the contract's own vocabulary rather than a string made up here.
// The amount and currency are shown exactly as stored: this panel does not say
// whether a figure is a period's pay or a year's, because nothing in this build
// decides that and the table records no rule for it.
const COMPENSATION_PAY_FREQUENCY_LABELS: Record<
  CompensationPayFrequency,
  string
> = {
  monthly: 'Monthly',
  semi_monthly: 'Semi-monthly',
  biweekly: 'Biweekly',
  weekly: 'Weekly',
};

// Every failure this read can return has copy of its own, so the panel never
// shows a raw server message and never shows a history it did not get. There is
// no 401 line: the global listener takes the whole app back to sign-in.
const COMPENSATION_ERROR_COPY: Record<string, string> = {
  PERSON_NOT_FOUND: 'That person is no longer available to you.',
  ROLE_DENIED:
    'Your role can open the directory but not salary history. Reading pay needs the compensation read permission.',
  MODULE_NOT_ENTITLED:
    'People is not enabled for this workspace, so its records cannot be opened.',
  MEMBERSHIP_DENIED: 'You no longer hold a seat in this workspace.',
  PLATFORM_ACCESS_DENIED:
    'This workspace is no longer open to your account.',
  NETWORK:
    'The workspace could not be reached. Check your connection and try again.',
};

const COMPENSATION_ERROR_FALLBACK =
  'The compensation history could not be loaded. Try again.';

function compensationErrorCopy(code: string | null): string {
  if (code === null) {
    return COMPENSATION_ERROR_FALLBACK;
  }
  return COMPENSATION_ERROR_COPY[code] ?? COMPENSATION_ERROR_FALLBACK;
}

// Every failure these two writes can return has copy of its own, so the panel
// never shows a raw server message and never shows a save it did not get. The
// amount, the currency and the dates are named in the copy but never repeated by
// it: an error message that echoes a salary would put the figure in the browser
// history and the accessibility tree, where the stored row already is not.
const COMPENSATION_WRITE_ERROR_COPY: Record<string, string> = {
  PERSON_NOT_FOUND: 'That person is no longer in the directory you can see.',
  // The same refusal the employment form explains: the directory shows the person
  // to you, and maintaining what they cost belongs to a scope that reaches them.
  SCOPE_DENIED:
    'You can see this person, but your scope does not cover where they are placed, so their pay is not yours to change.',
  COMPENSATION_NOT_FOUND:
    'That salary record is no longer available to you.',
  COMPENSATION_PERIOD_EXISTS:
    'This person already has a record opening on that date. A change of pay is recorded on a new day, so use a start date no other record of theirs uses.',
  INVALID_BODY:
    'The details were not accepted. An effective-from date, a whole-number amount in minor units and a three-letter upper-case currency are required, an effective-to date cannot precede the effective-from date, and the pay frequency must be one of the four offered.',
  CSRF_INVALID:
    'This browser no longer matches your session. Sign out, sign in again and retry.',
  NETWORK: 'The workspace could not be reached. Check your connection and try again.',
};

const COMPENSATION_WRITE_ERROR_FALLBACK =
  'The salary record could not be saved. Try again.';

function compensationWriteErrorCopy(code: string | null): string {
  if (code === null) {
    return COMPENSATION_WRITE_ERROR_FALLBACK;
  }
  return COMPENSATION_WRITE_ERROR_COPY[code] ?? COMPENSATION_WRITE_ERROR_FALLBACK;
}

type CompensationPanelState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; data: CompensationListResponse };

// Every value is a string here because every field is an input, and a number
// field that has been cleared reads back as ''. The converters below decide what
// the server is told: a blank effective_to on an edit clears the period, and a
// blank one on a create leaves the key out entirely.
type CompensationFormValues = {
  effectiveFrom: string;
  effectiveTo: string;
  ctcMinor: string;
  currency: string;
  payFrequency: CompensationPayFrequency;
};

const EMPTY_COMPENSATION_FORM: CompensationFormValues = {
  effectiveFrom: '',
  effectiveTo: '',
  ctcMinor: '',
  currency: '',
  payFrequency: 'monthly',
};

// currency is typed, not chosen, so nothing here can restrict it to a code list:
// the input caps the value at three characters and leaves the case alone, and the
// server's upper-case-only rule is the one that refuses a lower-case code rather
// than silently converting it. The field hint says so before the first submit.
const COMPENSATION_CURRENCY_MAX_LENGTH = 3;

function formValuesFromCompensation(
  compensation: CompensationItem,
): CompensationFormValues {
  return {
    effectiveFrom: compensation.effectiveFrom,
    effectiveTo: compensation.effectiveTo ?? '',
    ctcMinor: String(compensation.ctcMinor),
    currency: compensation.currency,
    payFrequency: compensation.payFrequency,
  };
}

function compensationCreateInput(
  values: CompensationFormValues,
): CompensationCreateInput {
  const input: CompensationCreateInput = {
    effectiveFrom: values.effectiveFrom,
    ctcMinor: Number(values.ctcMinor),
    currency: values.currency.trim(),
    payFrequency: values.payFrequency,
  };
  // A blank optional on create means "not recorded", so the key is left out and
  // the audit lists only the fields someone actually filled in.
  if (values.effectiveTo !== '') {
    input.effectiveTo = values.effectiveTo;
  }
  return input;
}

// A whole statement of the row, the way the employment edit works: a blank
// effective_to on an edit clears the end of the period rather than leaving the
// stored date alone.
function compensationUpdateInput(
  values: CompensationFormValues,
): CompensationUpdateInput {
  return {
    effectiveFrom: values.effectiveFrom,
    effectiveTo: values.effectiveTo === '' ? null : values.effectiveTo,
    ctcMinor: Number(values.ctcMinor),
    currency: values.currency.trim(),
    payFrequency: values.payFrequency,
  };
}

function compensationFormMatches(
  values: CompensationFormValues,
  compensation: CompensationItem,
): boolean {
  return (
    values.effectiveFrom === compensation.effectiveFrom &&
    values.effectiveTo === (compensation.effectiveTo ?? '') &&
    values.ctcMinor === String(compensation.ctcMinor) &&
    values.currency.trim() === compensation.currency &&
    values.payFrequency === compensation.payFrequency
  );
}

type CompensationFormProps = {
  mode: 'create' | 'update';
  values: CompensationFormValues;
  submitting: boolean;
  // The parent decides this, because only the parent holds the stored row an
  // unchanged edit is compared against.
  unchanged: boolean;
  error: string | null;
  onField: (field: keyof CompensationFormValues, value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
};

function CompensationWriteForm({
  mode,
  values,
  submitting,
  unchanged,
  error,
  onField,
  onSubmit,
  onCancel,
}: CompensationFormProps) {
  const titleId = `compensation-${mode}-title`;
  const amountTooLarge =
    values.ctcMinor !== '' && Number(values.ctcMinor) > COMPENSATION_CTC_MINOR_MAX;

  return (
    <form
      className="people-form employment-form"
      aria-labelledby={titleId}
      onSubmit={onSubmit}
    >
      <h3 id={titleId} className="people-form-title">
        {mode === 'create' ? 'Add compensation' : 'Edit this compensation'}
      </h3>

      <div className="people-form-grid">
        <div className="field">
          <label htmlFor="compensation-form-effectiveFrom">
            Effective from
            <span className="required-mark"> (required)</span>
          </label>
          <input
            id="compensation-form-effectiveFrom"
            name="effectiveFrom"
            type="date"
            value={values.effectiveFrom}
            disabled={submitting}
            onChange={(event) => onField('effectiveFrom', event.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="compensation-form-effectiveTo">
            Effective to (blank means open)
          </label>
          <input
            id="compensation-form-effectiveTo"
            name="effectiveTo"
            type="date"
            value={values.effectiveTo}
            disabled={submitting}
            onChange={(event) => onField('effectiveTo', event.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="compensation-form-ctcMinor">
            Amount in minor units
            <span className="required-mark"> (required)</span>
          </label>
          <input
            id="compensation-form-ctcMinor"
            name="ctcMinor"
            type="number"
            min={0}
            max={COMPENSATION_CTC_MINOR_MAX}
            step={1}
            value={values.ctcMinor}
            disabled={submitting}
            onChange={(event) => onField('ctcMinor', event.target.value)}
          />
          <p className="field-hint">
            The stored count of minor units, with no exponent table behind it. One
            hundred is shown as 1.00 for two-decimal currencies. Nothing here
            converts the figure to a month or a year.
          </p>
        </div>

        <div className="field">
          <label htmlFor="compensation-form-currency">
            Currency
            <span className="required-mark"> (required)</span>
          </label>
          <input
            id="compensation-form-currency"
            name="currency"
            type="text"
            value={values.currency}
            maxLength={COMPENSATION_CURRENCY_MAX_LENGTH}
            placeholder="INR"
            autoComplete="off"
            spellCheck={false}
            disabled={submitting}
            onChange={(event) => onField('currency', event.target.value)}
          />
          <p className="field-hint">
            Three upper-case letters, exactly as stored. A lower-case code is
            refused rather than corrected.
          </p>
        </div>

        <div className="field">
          <label htmlFor="compensation-form-payFrequency">
            Pay frequency
            <span className="required-mark"> (required)</span>
          </label>
          <select
            id="compensation-form-payFrequency"
            name="payFrequency"
            value={values.payFrequency}
            disabled={submitting}
            onChange={(event) => onField('payFrequency', event.target.value)}
          >
            {COMPENSATION_PAY_FREQUENCIES.map((frequency) => (
              <option value={frequency} key={frequency}>
                {COMPENSATION_PAY_FREQUENCY_LABELS[frequency]}
              </option>
            ))}
          </select>
        </div>
      </div>

      {error ? (
        <p className="form-alert" role="alert">
          {error}
        </p>
      ) : null}

      <div className="people-form-actions">
        <button
          className="button button--primary"
          type="submit"
          disabled={
            submitting ||
            values.effectiveFrom === '' ||
            values.ctcMinor === '' ||
            values.currency.trim() === '' ||
            amountTooLarge ||
            (mode === 'update' && unchanged)
          }
        >
          {mode === 'create' ? 'Save compensation' : 'Save changes'}
        </button>
        <button
          className="button button--quiet"
          type="button"
          onClick={onCancel}
          disabled={submitting}
        >
          Cancel
        </button>
      </div>

      <p className="fine-print people-form-note">
        {mode === 'create'
          ? 'A new record opens on its own date; the amount of an existing record is not restated here. Nothing is annualised or prorated, and payroll, payslips and statutory deductions are not built.'
          : 'This amends the stored row in place. A record that has already been superseded is normally corrected by adding a new one on a later date rather than by changing this one. Nothing is annualised or prorated, and payroll is not built.'}
      </p>
    </form>
  );
}

type EmploymentFormProps = {
  mode: 'create' | 'update';
  currentStatus: EmploymentStatus;
  values: EmploymentFormValues;
  submitting: boolean;
  // The parent decides this, because only the parent holds the stored row an
  // unchanged edit is compared against.
  unchanged: boolean;
  error: string | null;
  onField: (field: keyof EmploymentFormValues, value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
};

function EmploymentWriteForm({
  mode,
  currentStatus,
  values,
  submitting,
  unchanged,
  error,
  onField,
  onSubmit,
  onCancel,
}: EmploymentFormProps) {
  const titleId = `employment-${mode}-title`;

  return (
    <form
      className="people-form employment-form"
      aria-labelledby={titleId}
      onSubmit={onSubmit}
    >
      <h3 id={titleId} className="people-form-title">
        {mode === 'create' ? 'Add employment' : 'Edit this employment'}
      </h3>

      <div className="people-form-grid">
        <div className="field">
          <label htmlFor="employment-form-type">Employment type</label>
          <select
            id="employment-form-type"
            name="employmentType"
            value={values.employmentType}
            disabled={submitting}
            onChange={(event) =>
              onField('employmentType', event.target.value)
            }
          >
            {EMPLOYMENT_TYPES.map((type) => (
              <option value={type} key={type}>
                {EMPLOYMENT_TYPE_LABELS[type]}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="employment-form-noticeDays">
            Notice days
          </label>
          <input
            id="employment-form-noticeDays"
            name="noticeDays"
            type="number"
            min={0}
            max={EMPLOYMENT_NOTICE_DAYS_MAX}
            step={1}
            value={values.noticeDays}
            disabled={submitting}
            onChange={(event) => onField('noticeDays', event.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="employment-form-startDate">
            Start date
            <span className="required-mark"> (required)</span>
          </label>
          <input
            id="employment-form-startDate"
            name="startDate"
            type="date"
            value={values.startDate}
            disabled={submitting}
            onChange={(event) => onField('startDate', event.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="employment-form-endDate">End date</label>
          <input
            id="employment-form-endDate"
            name="endDate"
            type="date"
            value={values.endDate}
            disabled={submitting}
            onChange={(event) => onField('endDate', event.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="employment-form-probationEndDate">
            Probation end date
          </label>
          <input
            id="employment-form-probationEndDate"
            name="probationEndDate"
            type="date"
            value={values.probationEndDate}
            disabled={submitting}
            onChange={(event) => onField('probationEndDate', event.target.value)}
          />
        </div>

        {mode === 'update' ? (
          <div className="field">
            <label htmlFor="employment-form-status">Status</label>
            <select
              id="employment-form-status"
              name="status"
              value={values.status}
              disabled={submitting}
              onChange={(event) => onField('status', event.target.value)}
            >
              {offerableEmploymentStatuses(currentStatus).map((status) => (
                <option value={status} key={status}>
                  {EMPLOYMENT_STATUS_LABELS[status]}
                </option>
              ))}
            </select>
            {currentStatus === 'active' ? null : (
              <p className="field-hint">
                This record is already {EMPLOYMENT_STATUS_LABELS[currentStatus].toLowerCase()},
                so it stays that way.
              </p>
            )}
          </div>
        ) : null}
      </div>

      {error ? (
        <p className="form-alert" role="alert">
          {error}
        </p>
      ) : null}

      <div className="people-form-actions">
        <button
          className="button button--primary"
          type="submit"
          disabled={
            submitting ||
            values.startDate === '' ||
            (mode === 'update' && unchanged)
          }
        >
          {mode === 'create' ? 'Save employment' : 'Save changes'}
        </button>
        <button
          className="button button--quiet"
          type="button"
          onClick={onCancel}
          disabled={submitting}
        >
          Cancel
        </button>
      </div>

      <p className="fine-print people-form-note">
        {mode === 'create'
          ? 'Employment is separate from directory placement. The legal entity is taken from where this person is placed now, and it never changes on this record. Payroll is not built here.'
          : 'This record keeps the legal entity it was written against, even if the person has since been placed elsewhere. Payroll is not built here.'}
      </p>
    </form>
  );
}

type PeopleFormProps = {
  mode: 'create' | 'update';
  values: PeopleFormValues;
  submitting: boolean;
  error: string | null;
  onField: (field: PeopleFormField, value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
};

function PeopleWriteForm({
  mode,
  values,
  submitting,
  error,
  onField,
  onSubmit,
  onCancel,
}: PeopleFormProps) {
  const titleId = `people-${mode}-title`;

  return (
    <form
      className="people-form"
      aria-labelledby={titleId}
      onSubmit={onSubmit}
    >
      <h3 id={titleId} className="people-form-title">
        {mode === 'create' ? 'Add a person' : 'Edit this person'}
      </h3>

      <div className="people-form-grid">
        {PEOPLE_FORM_FIELDS.map((field) => (
          <div className="field" key={field.key}>
            <label htmlFor={`people-form-${field.key}`}>
              {field.label}
              {field.required ? <span className="required-mark"> (required)</span> : null}
            </label>
            <input
              id={`people-form-${field.key}`}
              name={field.key}
              type={field.email ? 'email' : 'text'}
              value={values[field.key]}
              maxLength={field.maxLength}
              placeholder={field.placeholder}
              autoComplete="off"
              disabled={submitting}
              onChange={(event) => onField(field.key, event.target.value)}
            />
          </div>
        ))}
      </div>

      {error ? (
        <p className="form-alert" role="alert">
          {error}
        </p>
      ) : null}

      <div className="people-form-actions">
        <button className="button button--primary" type="submit" disabled={submitting}>
          {mode === 'create' ? 'Save person' : 'Save changes'}
        </button>
        <button className="button button--quiet" type="button" onClick={onCancel} disabled={submitting}>
          Cancel
        </button>
      </div>

      <p className="fine-print people-form-note">
        {mode === 'create'
          ? 'A new person is added unplaced. Only a workspace-wide owner, admin or HR can add people; use Place afterwards.'
          : 'These are the identity fields only. Use Place to change the legal entity or org unit.'}
      </p>
    </form>
  );
}

export function PeopleScreen({ context }: PeopleScreenProps) {
  const people = findModule(context, 'people');
  const [draft, setDraft] = useState('');
  const [term, setTerm] = useState('');
  const [page, setPage] = useState(1);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<DirectoryState>({ phase: 'loading' });
  const [form, setForm] = useState<
    { mode: 'create' } | { mode: 'update'; person: PeopleListItem } | null
  >(null);
  const [values, setValues] = useState<PeopleFormValues>(EMPTY_PEOPLE_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const [placing, setPlacing] = useState<PeopleListItem | null>(null);
  const [placementOptions, setPlacementOptions] =
    useState<PlacementOptionsState>({ phase: 'idle' });
  const [placementValue, setPlacementValue] = useState('');
  const [placementAttempt, setPlacementAttempt] = useState(0);
  const [placementSubmitting, setPlacementSubmitting] = useState(false);
  const [placementError, setPlacementError] = useState<string | null>(null);
  const [employing, setEmploying] = useState<PeopleListItem | null>(null);
  const [employmentState, setEmploymentState] =
    useState<EmploymentPanelState>({ phase: 'idle' });
  const [employmentAttempt, setEmploymentAttempt] = useState(0);
  const [employmentForm, setEmploymentForm] = useState<
    { mode: 'create' } | { mode: 'update'; employment: EmploymentItem } | null
  >(null);
  const [employmentValues, setEmploymentValues] =
    useState<EmploymentFormValues>(EMPTY_EMPLOYMENT_FORM);
  const [employmentSubmitting, setEmploymentSubmitting] = useState(false);
  const [employmentError, setEmploymentError] = useState<string | null>(null);
  const [compensating, setCompensating] = useState<PeopleListItem | null>(null);
  const [compensationState, setCompensationState] =
    useState<CompensationPanelState>({ phase: 'idle' });
  const [compensationAttempt, setCompensationAttempt] = useState(0);
  const [compensationForm, setCompensationForm] = useState<
    { mode: 'create' } | { mode: 'update'; compensation: CompensationItem } | null
  >(null);
  const [compensationValues, setCompensationValues] =
    useState<CompensationFormValues>(EMPTY_COMPENSATION_FORM);
  const [compensationSubmitting, setCompensationSubmitting] = useState(false);
  const [compensationError, setCompensationError] = useState<string | null>(null);

  useEffect(() => {
    // A response is dropped once the search or page has moved on, so a slow
    // first request cannot overwrite the results of a newer one.
    let stale = false;

    async function load() {
      setState({ phase: 'loading' });
      const result = await api.people({
        q: term,
        page,
        pageSize: PEOPLE_LIST_DEFAULT_PAGE_SIZE,
      });
      if (stale) {
        return;
      }
      if (!result.ok) {
        // A 401 is handled by the global listener, which returns the app to
        // sign-in without leaving any directory state behind.
        if (result.status !== 401) {
          setState({ phase: 'error', message: DIRECTORY_ERROR_MESSAGE });
        }
        return;
      }
      setState({ phase: 'ready', data: result.data });
    }

    void load();
    return () => {
      stale = true;
    };
  }, [term, page, attempt]);

  useEffect(() => {
    // The choices are fetched when the panel opens, not with the directory: the
    // list is the server's own scope answer for this member, and a response
    // that arrives after the panel moved on is dropped.
    if (placing === null) {
      return;
    }
    let stale = false;
    const person = placing;

    async function loadOptions() {
      setPlacementOptions({ phase: 'loading' });
      const result = await api.placementOptions();
      if (stale) {
        return;
      }
      if (!result.ok) {
        // A 401 is handled by the global listener that returns the app to
        // sign-in, so the panel simply goes with it.
        if (result.status !== 401) {
          setPlacementOptions({ phase: 'error' });
        } else {
          setPlacing(null);
        }
        return;
      }
      setPlacementOptions({ phase: 'ready', data: result.data });
      setPlacementValue(placementSelection(person, result.data));
    }

    void loadOptions();
    return () => {
      stale = true;
    };
  }, [placing, placementAttempt]);

  useEffect(() => {
    // The history is fetched when the panel opens, not with the directory: it is
    // the server's own scope answer for this person, and a response that arrives
    // after the panel moved on is dropped rather than shown against a different
    // colleague.
    if (employing === null) {
      return;
    }
    let stale = false;
    const person = employing;

    async function loadHistory() {
      setEmploymentState({ phase: 'loading' });
      const result = await api.employments(person.id);
      if (stale) {
        return;
      }
      if (!result.ok) {
        // A 401 is handled by the global listener that returns the app to
        // sign-in, so the panel simply goes with it.
        if (result.status !== 401) {
          setEmploymentState({ phase: 'error' });
        } else {
          setEmploying(null);
        }
        return;
      }
      setEmploymentState({ phase: 'ready', data: result.data });
    }

    void loadHistory();
    return () => {
      stale = true;
    };
  }, [employing, employmentAttempt]);

  useEffect(() => {
    // The same rule as the employment history: fetched when this panel opens, not
    // with the directory, because the response is this member's own scope answer
    // for this person and one that arrives after the panel moved on is dropped
    // rather than shown against a different colleague.
    if (compensating === null) {
      return;
    }
    let stale = false;
    const person = compensating;

    async function loadHistory() {
      setCompensationState({ phase: 'loading' });
      const result = await api.compensations(person.id);
      if (stale) {
        return;
      }
      if (!result.ok) {
        // A 401 is handled by the global listener that returns the app to
        // sign-in, so the panel simply goes with it.
        if (result.status !== 401) {
          setCompensationState({
            phase: 'error',
            message: compensationErrorCopy(result.code),
          });
        } else {
          setCompensating(null);
        }
        return;
      }
      setCompensationState({ phase: 'ready', data: result.data });
    }

    void loadHistory();
    return () => {
      stale = true;
    };
  }, [compensating, compensationAttempt]);

  const data = state.phase === 'ready' ? state.data : null;
  const totalPages =
    data === null ? 1 : Math.max(1, Math.ceil(data.total / data.pageSize));

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTerm(draft.trim());
    setPage(1);
  }

  function closeForm() {
    setForm(null);
    setValues(EMPTY_PEOPLE_FORM);
    setFormError(null);
  }

  function openCreateForm() {
    closePlacement();
    closeEmployment();
    closeCompensation();
    setSavedMessage(null);
    setFormError(null);
    setValues(EMPTY_PEOPLE_FORM);
    setForm({ mode: 'create' });
  }

  function openEditForm(person: PeopleListItem) {
    closePlacement();
    closeEmployment();
    closeCompensation();
    setSavedMessage(null);
    setFormError(null);
    setValues(formValuesFromPerson(person));
    setForm({ mode: 'update', person });
  }

  // One panel at a time: opening Place closes any open identity form and starts
  // with no error and no selection, so a stale choice cannot be submitted for a
  // different person.
  function openPlacement(person: PeopleListItem) {
    closeForm();
    closeEmployment();
    closeCompensation();
    setSavedMessage(null);
    setPlacementError(null);
    setPlacementValue('');
    setPlacementOptions({ phase: 'idle' });
    setPlacing(person);
  }

  function closePlacement() {
    setPlacing(null);
    setPlacementOptions({ phase: 'idle' });
    setPlacementValue('');
    setPlacementError(null);
  }

  function retryPlacementOptions() {
    setPlacementError(null);
    setPlacementAttempt((current) => current + 1);
  }

  function closeEmploymentForm() {
    setEmploymentForm(null);
    setEmploymentValues(EMPTY_EMPLOYMENT_FORM);
    setEmploymentError(null);
  }

  function closeEmployment() {
    closeEmploymentForm();
    setEmploying(null);
    setEmploymentState({ phase: 'idle' });
  }

  // Reading a history is not a write, so this opens for anyone who can see the
  // directory; the add and edit controls inside it appear only for a writer.
  function openEmployment(person: PeopleListItem) {
    closeForm();
    closePlacement();
    closeCompensation();
    setSavedMessage(null);
    closeEmploymentForm();
    setEmploymentState({ phase: 'idle' });
    setEmploying(person);
  }

  function retryEmployments() {
    setEmploymentError(null);
    setEmploymentAttempt((current) => current + 1);
  }

  function closeCompensationForm() {
    setCompensationForm(null);
    setCompensationValues(EMPTY_COMPENSATION_FORM);
    setCompensationError(null);
  }

  function closeCompensation() {
    closeCompensationForm();
    setCompensating(null);
    setCompensationState({ phase: 'idle' });
  }

  // Opening this one needs no write of any kind, and it promises none on its own:
  // the panel shows the stored rows, and the add and edit controls inside it
  // appear only for a member whose role holds people.compensation.write.
  function openCompensation(person: PeopleListItem) {
    closeForm();
    closePlacement();
    closeEmployment();
    setSavedMessage(null);
    closeCompensationForm();
    setCompensationState({ phase: 'idle' });
    setCompensating(person);
  }

  function retryCompensations() {
    closeCompensationForm();
    setCompensationAttempt((current) => current + 1);
  }

  function openCompensationCreate() {
    setSavedMessage(null);
    setCompensationError(null);
    setCompensationValues(EMPTY_COMPENSATION_FORM);
    setCompensationForm({ mode: 'create' });
  }

  function openCompensationEdit(compensation: CompensationItem) {
    setSavedMessage(null);
    setCompensationError(null);
    setCompensationValues(formValuesFromCompensation(compensation));
    setCompensationForm({ mode: 'update', compensation });
  }

  async function submitCompensationForm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (compensationForm === null || compensationSubmitting || compensating === null) {
      return;
    }
    const mode = compensationForm.mode;
    setCompensationSubmitting(true);
    setCompensationError(null);
    const result =
      mode === 'create'
        ? await api.createCompensation(
            compensating.id,
            compensationCreateInput(compensationValues),
          )
        : await api.updateCompensation(
            compensating.id,
            compensationForm.compensation.id,
            compensationUpdateInput(compensationValues),
          );
    setCompensationSubmitting(false);

    if (!result.ok) {
      if (result.status === 401) {
        // The global listener is taking the app back to sign-in.
        closeCompensation();
        return;
      }
      setCompensationError(compensationWriteErrorCopy(result.code));
      return;
    }

    closeCompensationForm();
    setSavedMessage(mode === 'create' ? 'Compensation added.' : 'Compensation updated.');
    // Reload the same person's history the panel is already showing.
    setCompensationAttempt((current) => current + 1);
  }

  function openEmploymentCreate() {
    setSavedMessage(null);
    setEmploymentError(null);
    setEmploymentValues(EMPTY_EMPLOYMENT_FORM);
    setEmploymentForm({ mode: 'create' });
  }

  function openEmploymentEdit(employment: EmploymentItem) {
    setSavedMessage(null);
    setEmploymentError(null);
    setEmploymentValues(formValuesFromEmployment(employment));
    setEmploymentForm({ mode: 'update', employment });
  }

  async function submitEmploymentForm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (employing === null || employmentForm === null || employmentSubmitting) {
      return;
    }
    const mode = employmentForm.mode;
    setEmploymentSubmitting(true);
    setEmploymentError(null);
    const result =
      mode === 'create'
        ? await api.createEmployment(
            employing.id,
            employmentCreateInput(employmentValues),
          )
        : await api.updateEmployment(
            employing.id,
            employmentForm.employment.id,
            employmentUpdateInput(employmentValues),
          );
    setEmploymentSubmitting(false);

    if (!result.ok) {
      if (result.status === 401) {
        // The global listener is taking the app back to sign-in.
        closeEmployment();
        return;
      }
      setEmploymentError(employmentWriteErrorCopy(result.code));
      return;
    }

    closeEmploymentForm();
    setSavedMessage(mode === 'create' ? 'Employment added.' : 'Employment updated.');
    // Reload the same person's history the panel is already showing.
    setEmploymentAttempt((current) => current + 1);
  }

  async function submitForm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (form === null || submitting) {
      return;
    }
    const mode = form.mode;
    setSubmitting(true);
    setFormError(null);
    const result =
      mode === 'create'
        ? await api.createPerson(peopleCreateInput(values))
        : await api.updatePerson(form.person.id, peopleUpdateInput(values));
    setSubmitting(false);

    if (!result.ok) {
      if (result.status === 401) {
        // The global listener is taking the app back to sign-in.
        closeForm();
        return;
      }
      setFormError(peopleWriteErrorCopy(result.code));
      return;
    }

    closeForm();
    setSavedMessage(mode === 'create' ? 'Person created.' : 'Person updated.');
    setAttempt((current) => current + 1);
  }

  async function submitPlacement(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (placing === null || placementOptions.phase !== 'ready' || placementSubmitting) {
      return;
    }
    const input = placementInputFromSelection(placementValue, placementOptions.data);
    if (input === null) {
      // A selection the server would not accept cannot be submitted at all.
      setPlacementError(peoplePlacementErrorCopy('INVALID_BODY'));
      return;
    }

    setPlacementSubmitting(true);
    setPlacementError(null);
    const result = await api.updatePlacement(placing.id, input);
    setPlacementSubmitting(false);

    if (!result.ok) {
      if (result.status === 401) {
        closePlacement();
        return;
      }
      setPlacementError(peoplePlacementErrorCopy(result.code));
      return;
    }

    closePlacement();
    setSavedMessage('Placement updated.');
    // Reload the same search and page the directory is already showing.
    setAttempt((current) => current + 1);
  }

  const canWrite = people?.canWrite === true;
  // Save stays put while the choice still matches what is stored, so the screen
  // never claims an update that would change nothing.
  const chosenPlacement =
    placing !== null && placementOptions.phase === 'ready'
      ? placementInputFromSelection(placementValue, placementOptions.data)
      : null;
  const placementIsUnchanged =
    chosenPlacement !== null &&
    placing !== null &&
    chosenPlacement.legalEntityId === placing.legalEntityId &&
    chosenPlacement.orgUnitId === placing.orgUnitId;
  // The same rule for an employment edit: every key is stated, so an unchanged
  // form would be refused no work by the server and would need an audit row.
  const employmentIsUnchanged =
    employmentForm !== null &&
    employmentForm.mode === 'update' &&
    employmentFormMatches(employmentValues, employmentForm.employment);
  // The same rule for a salary edit: every key is stated, so an unchanged form
  // would be refused no work by the server and would need an audit row.
  const canWriteSalary = canWriteCompensation(context);
  const compensationIsUnchanged =
    compensationForm !== null &&
    compensationForm.mode === 'update' &&
    compensationFormMatches(compensationValues, compensationForm.compensation);

  return (
    <article className="page page--people">
      <header className="page-head page-head--split">
        <div>
          <p className="eyebrow">Directory</p>
          <h1 id="people-title">People</h1>
          <p className="page-lede">
            The shared directory for this workspace.
          </p>
        </div>
        {people ? (
          <span className="badge badge--accent">{accessLabel(people)}</span>
        ) : null}
      </header>

      <section className="directory" aria-labelledby="people-title">
        <div className="directory-toolbar">
          <form className="search-form" role="search" onSubmit={submitSearch}>
            <label htmlFor="people-search">Search people</label>
            <input
              id="people-search"
              className="searchbox"
              type="search"
              placeholder="Name, code or work email"
              value={draft}
              maxLength={PEOPLE_SEARCH_MAX_LENGTH}
              onChange={(event) => setDraft(event.target.value)}
            />
            <button className="button button--quiet" type="submit">
              Search
            </button>
          </form>
          <p className="directory-count" role="status" aria-live="polite">
            {directoryStatusCopy(state)}
          </p>
          {canWrite ? (
            <button
              className="button button--primary button--small"
              type="button"
              onClick={openCreateForm}
              disabled={
                form !== null ||
                placing !== null ||
                employing !== null ||
                compensating !== null
              }
            >
              Add person
            </button>
          ) : null}
        </div>

        {savedMessage ? (
          <p className="people-saved" role="status" aria-live="polite">
            {savedMessage}
          </p>
        ) : null}

        {form ? (
          <PeopleWriteForm
            mode={form.mode}
            values={values}
            submitting={submitting}
            error={formError}
            onField={(field, value) =>
              setValues((current) => ({ ...current, [field]: value }))
            }
            onSubmit={(event) => void submitForm(event)}
            onCancel={closeForm}
          />
        ) : null}

        {placing ? (
          <div className="placement-panel" aria-labelledby="placement-title">
            <h3 id="placement-title" className="people-form-title">
              Place {placing.displayName}
            </h3>

            {placementOptions.phase === 'loading' ? (
              <p className="placement-state">Loading the placement choices…</p>
            ) : null}

            {placementOptions.phase === 'error' ? (
              <div className="placement-state">
                <p className="form-alert" role="alert">
                  {PLACEMENT_OPTIONS_ERROR}
                </p>
                <button
                  className="button button--quiet button--small"
                  type="button"
                  onClick={retryPlacementOptions}
                >
                  Try again
                </button>
              </div>
            ) : null}

            {placementOptions.phase === 'ready' ? (
              <form className="placement-form" onSubmit={(event) => void submitPlacement(event)}>
                <div className="field">
                  <label htmlFor="people-placement">Legal entity or org unit</label>
                  <select
                    id="people-placement"
                    name="placement"
                    value={placementValue}
                    disabled={placementSubmitting}
                    onChange={(event) => setPlacementValue(event.target.value)}
                  >
                    {placementOptions.data.canUnplace ? (
                      <option value="unplaced">Unplaced</option>
                    ) : null}
                    {placementOptions.data.legalEntities.map((entity) => {
                      const units = placementOptions.data.orgUnits.filter(
                        (unit) => unit.legalEntityId === entity.id,
                      );
                      return (
                        <Fragment key={entity.id}>
                          {entity.placeable ? (
                            <option value={`le:${entity.id}`}>{entity.name}</option>
                          ) : null}
                          {units.length > 0 ? (
                            <optgroup label={entity.name}>
                              {units.map((unit) => (
                                <option value={`ou:${unit.id}`} key={unit.id}>
                                  {unit.name}
                                </option>
                              ))}
                            </optgroup>
                          ) : null}
                        </Fragment>
                      );
                    })}
                  </select>
                  {placementOptions.data.legalEntities.length === 0 ? (
                    <p className="fine-print placement-empty">
                      No legal entity or org unit is available yet. They are
                      created outside this screen today.
                    </p>
                  ) : null}
                </div>

                {placementError ? (
                  <p className="form-alert" role="alert">
                    {placementError}
                  </p>
                ) : null}

                <div className="people-form-actions">
                  <button
                    className="button button--primary"
                    type="submit"
                    disabled={
                      placementSubmitting ||
                      placementValue === '' ||
                      placementIsUnchanged
                    }
                  >
                    Save placement
                  </button>
                  <button
                    className="button button--quiet"
                    type="button"
                    onClick={closePlacement}
                    disabled={placementSubmitting}
                  >
                    Close
                  </button>
                </div>

                <p className="fine-print">
                  Placement is a directory attribute, not an employment record.
                  Use Employment on this row for dates and status, and Compensation
                  for the stored pay records.
                </p>
              </form>
            ) : null}
          </div>
        ) : null}

        {employing ? (
          <div
            className="placement-panel employment-panel"
            aria-labelledby="employment-panel-title"
          >
            <div className="employment-panel-head">
              <h3 id="employment-panel-title" className="people-form-title">
                Employment for {employing.displayName}
              </h3>
              <button
                className="button button--quiet button--small"
                type="button"
                onClick={closeEmployment}
                disabled={employmentSubmitting}
              >
                Close
              </button>
            </div>

            {employmentState.phase === 'loading' ? (
              <p className="placement-state">Loading the employment history…</p>
            ) : null}

            {employmentState.phase === 'error' ? (
              <div className="placement-state">
                <p className="form-alert" role="alert">
                  {EMPLOYMENT_LIST_ERROR}
                </p>
                <button
                  className="button button--quiet button--small"
                  type="button"
                  onClick={retryEmployments}
                >
                  Try again
                </button>
              </div>
            ) : null}

            {employmentState.phase === 'ready' ? (
              <div className="employment-body">
                {employmentState.data.items.length === 0 ? (
                  <p className="fine-print placement-empty">
                    No employment is recorded for this person yet.
                  </p>
                ) : (
                  <div className="directory-scroll">
                    <table
                      className="directory-table employment-table"
                      aria-label={`Employment history for ${employing.displayName}`}
                    >
                      <thead>
                        <tr>
                          <th scope="col">Legal entity</th>
                          <th scope="col">Type</th>
                          <th scope="col">Period</th>
                          <th scope="col">Probation end</th>
                          <th scope="col">Notice days</th>
                          <th scope="col">Status</th>
                          {canWrite ? <th scope="col">Actions</th> : null}
                        </tr>
                      </thead>
                      <tbody>
                        {employmentState.data.items.map((employment) => (
                          <tr key={employment.id}>
                            <th scope="row">{employment.legalEntityName ?? '—'}</th>
                            <td>
                              {EMPLOYMENT_TYPE_LABELS[employment.employmentType]}
                            </td>
                            <td>{employmentPeriod(employment)}</td>
                            <td>{employment.probationEndDate ?? '—'}</td>
                            <td>{employment.noticeDays ?? '—'}</td>
                            <td>
                              <span
                                className={`badge employment-status employment-status--${employment.status}`}
                              >
                                {EMPLOYMENT_STATUS_LABELS[employment.status]}
                              </span>
                            </td>
                            {canWrite ? (
                              <td className="directory-actions">
                                <button
                                  className="button button--quiet button--small"
                                  type="button"
                                  aria-label={`Edit employment from ${employment.startDate}`}
                                  onClick={() => openEmploymentEdit(employment)}
                                  disabled={
                                    employmentForm !== null || employmentSubmitting
                                  }
                                >
                                  Edit
                                </button>
                              </td>
                            ) : null}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {employmentForm ? (
                  <EmploymentWriteForm
                    mode={employmentForm.mode}
                    currentStatus={
                      employmentForm.mode === 'update'
                        ? employmentForm.employment.status
                        : 'active'
                    }
                    values={employmentValues}
                    submitting={employmentSubmitting}
                    unchanged={employmentIsUnchanged}
                    error={employmentError}
                    onField={(field, value) =>
                      setEmploymentValues((current) => ({
                        ...current,
                        [field]: value,
                      }))
                    }
                    onSubmit={(event) => void submitEmploymentForm(event)}
                    onCancel={closeEmploymentForm}
                  />
                ) : canWrite ? (
                  <div className="people-form-actions">
                    <button
                      className="button button--primary button--small"
                      type="button"
                      onClick={openEmploymentCreate}
                    >
                      Add employment
                    </button>
                  </div>
                ) : null}

                <p className="fine-print employment-note">
                  Employment is separate from directory placement. Each record
                  keeps the legal entity this person was placed on when the record
                  was made, and a later placement does not change it. Payroll is
                  not built here.
                </p>
              </div>
            ) : null}
          </div>
        ) : null}

        {compensating ? (
          <div
            className="placement-panel"
            aria-labelledby="compensation-panel-title"
          >
            <div className="employment-panel-head">
              <h3 id="compensation-panel-title" className="people-form-title">
                Compensation for {compensating.displayName}
              </h3>
              <button
                className="button button--quiet button--small"
                type="button"
                onClick={closeCompensation}
                disabled={compensationSubmitting}
              >
                Close
              </button>
            </div>

            {compensationState.phase === 'loading' ? (
              <p className="placement-state">Loading the compensation history…</p>
            ) : null}

            {compensationState.phase === 'error' ? (
              <div className="placement-state">
                {/* The message is this screen's own copy for the code the API
                    returned, never the server's text, and it is announced in a
                    polite live region: a failed read is news, not an alarm. */}
                <p className="form-alert" role="status" aria-live="polite">
                  {compensationState.message}
                </p>
                <button
                  className="button button--quiet button--small"
                  type="button"
                  onClick={retryCompensations}
                >
                  Try again
                </button>
              </div>
            ) : null}

            {compensationState.phase === 'ready' ? (
              <div className="employment-body">
                {compensationState.data.items.length === 0 ? (
                  <p className="fine-print placement-empty">
                    No compensation is recorded for this person yet.
                  </p>
                ) : (
                  <div className="directory-scroll">
                    <table
                      className="directory-table"
                      aria-label={`Compensation history for ${compensating.displayName}`}
                    >
                      <thead>
                        <tr>
                          <th scope="col">Effective from</th>
                          <th scope="col">Effective to</th>
                          <th scope="col">Amount</th>
                          <th scope="col">Pay frequency</th>
                          {canWriteSalary ? <th scope="col">Actions</th> : null}
                        </tr>
                      </thead>
                      <tbody>
                        {compensationState.data.items.map((compensation) => (
                          <tr key={compensation.id}>
                            <th scope="row">{compensation.effectiveFrom}</th>
                            <td>{compensation.effectiveTo ?? '—'}</td>
                            <td>
                              {formatCompensationAmount(
                                compensation.ctcMinor,
                                compensation.currency,
                              )}
                            </td>
                            <td>
                              {COMPENSATION_PAY_FREQUENCY_LABELS[
                                compensation.payFrequency
                              ]}
                            </td>
                            {canWriteSalary ? (
                              <td className="directory-actions">
                                <button
                                  className="button button--quiet button--small"
                                  type="button"
                                  aria-label={`Edit compensation from ${compensation.effectiveFrom}`}
                                  onClick={() => openCompensationEdit(compensation)}
                                  disabled={
                                    compensationForm !== null || compensationSubmitting
                                  }
                                >
                                  Edit
                                </button>
                              </td>
                            ) : null}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {compensationForm ? (
                  <CompensationWriteForm
                    mode={compensationForm.mode}
                    values={compensationValues}
                    submitting={compensationSubmitting}
                    unchanged={compensationIsUnchanged}
                    error={compensationError}
                    onField={(field, value) =>
                      setCompensationValues((current) => ({
                        ...current,
                        [field]: value,
                      }))
                    }
                    onSubmit={(event) => void submitCompensationForm(event)}
                    onCancel={closeCompensationForm}
                  />
                ) : canWriteSalary ? (
                  <div className="people-form-actions">
                    <button
                      className="button button--primary button--small"
                      type="button"
                      onClick={openCompensationCreate}
                      disabled={compensationSubmitting}
                    >
                      Add compensation
                    </button>
                  </div>
                ) : null}

                {/* The two audiences have to be told different truths, so the note
                    branches on the same permission the controls branch on: a member
                    who holds the read but not the write is still looking at a panel
                    with nothing in it that changes a row, and saying otherwise would
                    promise an action this screen will not offer. */}
                <p className="fine-print compensation-note">
                  {canWriteSalary ? (
                    <>
                      A record can be added here for a person in this member&apos;s
                      scope, and one of that person&apos;s records amended. No record
                      can be deleted: a correction is made by adding a row that opens
                      later, and the row it corrects stays. Payroll, payslips and
                      statutory deductions are not built, so each row is a stored
                      amount in its own currency with the pay frequency stored beside
                      it - not a monthly or annual salary worked out from it, and
                      nothing here annualises or prorates it.
                    </>
                  ) : (
                    <>
                      Compensation is read-only in this build for you. A member whose
                      role also holds the pay write can add a record and amend one
                      inside their own scope; you can read these figures and change
                      none of them, and no record can be deleted by anyone: a
                      correction is made by adding a row that opens later. Payroll,
                      payslips and statutory deductions are not built, so each row is
                      a stored amount in its own currency with the pay frequency
                      stored beside it - not a monthly or annual salary worked out
                      from it.
                    </>
                  )}
                </p>
              </div>
            ) : null}
          </div>
        ) : null}

        {state.phase === 'error' ? (
          <div className="directory-state">
            <p className="directory-error" role="alert">
              {state.message}
            </p>
            <button
              className="button button--quiet"
              type="button"
              onClick={() => setAttempt((current) => current + 1)}
            >
              Try again
            </button>
          </div>
        ) : data !== null && data.items.length > 0 ? (
          <div className="directory-scroll">
            <table className="directory-table" aria-label="People directory">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Employee code</th>
                  <th scope="col">Work email</th>
                  <th scope="col">Phone</th>
                  <th scope="col">Placement</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((person) => (
                  <tr key={person.id}>
                    <th scope="row">{person.displayName}</th>
                    <td>{person.employeeCode ?? '—'}</td>
                    <td>{person.workEmail ?? '—'}</td>
                    <td>{person.phone ?? '—'}</td>
                    <td>{placementCopy(person) === '' ? '—' : placementCopy(person)}</td>
                    <td className="directory-actions">
                      {canWrite ? (
                        <>
                          <button
                            className="button button--quiet button--small"
                            type="button"
                            aria-label={`Edit ${person.displayName}`}
                            onClick={() => openEditForm(person)}
                            disabled={
                              placing !== null ||
                              employing !== null ||
                              compensating !== null
                            }
                          >
                            Edit
                          </button>
                          <button
                            className="button button--quiet button--small"
                            type="button"
                            aria-label={`Place ${person.displayName}`}
                            onClick={() => openPlacement(person)}
                            disabled={
                              form !== null ||
                              employing !== null ||
                              compensating !== null ||
                              placing?.id === person.id
                            }
                          >
                            Place
                          </button>
                        </>
                      ) : null}
                      {/* Reading a history is a read, so this row action belongs
                          to every member who sees the row, not only to a writer. */}
                      <button
                        className="button button--quiet button--small"
                        type="button"
                        aria-label={`Employment ${person.displayName}`}
                        onClick={() => openEmployment(person)}
                        disabled={
                          form !== null ||
                          placing !== null ||
                          compensating !== null ||
                          employing?.id === person.id
                        }
                      >
                        Employment
                      </button>
                      {/* Salary history is a stricter read than the directory, so
                          the action is absent rather than disabled when this
                          member's role has no people.compensation.read. */}
                      {canReadCompensation(context) ? (
                        <button
                          className="button button--quiet button--small"
                          type="button"
                          aria-label={`Compensation ${person.displayName}`}
                          onClick={() => openCompensation(person)}
                          disabled={
                            form !== null ||
                            placing !== null ||
                            employing !== null ||
                            compensating?.id === person.id
                          }
                        >
                          Compensation
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : data !== null ? (
          <p className="directory-empty">
            {term === ''
              ? 'No people are visible in this view.'
              : `No people match “${term}” in this view.`}
          </p>
        ) : null}

        {data !== null && data.total > 0 ? (
          <nav className="pager" aria-label="Directory pages">
            <button
              className="button button--quiet button--small"
              type="button"
              disabled={page <= 1}
              onClick={() => setPage((current) => Math.max(1, current - 1))}
            >
              Previous
            </button>
            <span className="pager-status">
              Page {page} of {totalPages}
            </span>
            <button
              className="button button--quiet button--small"
              type="button"
              disabled={page >= totalPages}
              onClick={() =>
                setPage((current) => Math.min(totalPages, current + 1))
              }
            >
              Next
            </button>
          </nav>
        ) : null}

        <p className="fine-print directory-note">
          This view lists only the people your role and scope cover, so it can
          show fewer records than the workspace holds.
        </p>
      </section>
    </article>
  );
}

type PeopleAccessStateProps = {
  context: ContextResponse;
  onNavigate: LinkHandler;
};

export function PeopleAccessState({
  context,
  onNavigate,
}: PeopleAccessStateProps) {
  const modules = availableModuleNames(context);

  return (
    <article className="panel-state" aria-labelledby="people-access-title">
      <p className="eyebrow">People</p>
      <h1 id="people-access-title">People is not available to you</h1>
      <p className="page-lede">
        Your role does not include the People module in this workspace. These
        are the modules enabled for you:
      </p>
      {modules.length > 0 ? (
        <ul className="module-chips">
          {modules.map((name) => (
            <li key={name}>{name}</li>
          ))}
        </ul>
      ) : (
        <p className="roster-empty">No modules are enabled for your role yet.</p>
      )}
      <a
        className="text-link"
        href="/app"
        onClick={(event) => {
          event.preventDefault();
          onNavigate('/app');
        }}
      >
        Back to the workspace
      </a>
    </article>
  );
}

type NotFoundScreenProps = {
  onNavigate: LinkHandler;
};

export function NotFoundScreen({ onNavigate }: NotFoundScreenProps) {
  return (
    <article className="panel-state" aria-labelledby="not-found-title">
      <p className="eyebrow">Not found</p>
      <h1 id="not-found-title">That page is not part of this workspace.</h1>
      <p className="page-lede">
        The address may be out of date, or the screen may not exist in this
        milestone.
      </p>
      <a
        className="text-link"
        href="/app"
        onClick={(event) => {
          event.preventDefault();
          onNavigate('/app');
        }}
      >
        Back to the workspace
      </a>
    </article>
  );
}
