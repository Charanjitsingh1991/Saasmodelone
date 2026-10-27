import { Fragment, useEffect, useState, type FormEvent } from 'react';
import type {
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
  findModule,
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
          ? 'Employment is separate from directory placement. The legal entity is taken from where this person is placed now, and it never changes on this record. Compensation and payroll are not built here.'
          : 'This record keeps the legal entity it was written against, even if the person has since been placed elsewhere. Compensation and payroll are not built here.'}
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
    setSavedMessage(null);
    setFormError(null);
    setValues(EMPTY_PEOPLE_FORM);
    setForm({ mode: 'create' });
  }

  function openEditForm(person: PeopleListItem) {
    closePlacement();
    closeEmployment();
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
    setSavedMessage(null);
    closeEmploymentForm();
    setEmploymentState({ phase: 'idle' });
    setEmploying(person);
  }

  function retryEmployments() {
    setEmploymentError(null);
    setEmploymentAttempt((current) => current + 1);
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
              disabled={form !== null || placing !== null || employing !== null}
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
                  Use Employment on this row for dates and status. Compensation
                  is not editable anywhere yet.
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
                  was made, and a later placement does not change it. Compensation
                  and payroll are not built here.
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
                            disabled={placing !== null || employing !== null}
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
                          employing?.id === person.id
                        }
                      >
                        Employment
                      </button>
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
