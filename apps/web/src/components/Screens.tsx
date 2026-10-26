import { useEffect, useState, type FormEvent } from 'react';
import type {
  ContextResponse,
  PeopleCreateInput,
  PeopleListItem,
  PeopleListResponse,
  PeopleUpdateInput,
} from '@saasmodels/contracts';
import {
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
        A new person is saved without a legal entity or org unit. Only a
        workspace-wide owner, admin or HR can add people; placement is not
        editable here yet.
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
    setSavedMessage(null);
    setFormError(null);
    setValues(EMPTY_PEOPLE_FORM);
    setForm({ mode: 'create' });
  }

  function openEditForm(person: PeopleListItem) {
    setSavedMessage(null);
    setFormError(null);
    setValues(formValuesFromPerson(person));
    setForm({ mode: 'update', person });
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

  const canWrite = people?.canWrite === true;

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
              disabled={form !== null}
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
                  {canWrite ? <th scope="col">Actions</th> : null}
                </tr>
              </thead>
              <tbody>
                {data.items.map((person) => (
                  <tr key={person.id}>
                    <th scope="row">{person.displayName}</th>
                    <td>{person.employeeCode ?? '—'}</td>
                    <td>{person.workEmail ?? '—'}</td>
                    <td>{person.phone ?? '—'}</td>
                    {canWrite ? (
                      <td>
                        <button
                          className="button button--quiet button--small"
                          type="button"
                          aria-label={`Edit ${person.displayName}`}
                          onClick={() => openEditForm(person)}
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
