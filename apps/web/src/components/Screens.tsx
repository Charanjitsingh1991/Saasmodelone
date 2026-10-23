import { useEffect, useState, type FormEvent } from 'react';
import type { ContextResponse, PeopleListResponse } from '@saasmodels/contracts';
import {
  PEOPLE_LIST_DEFAULT_PAGE_SIZE,
  PEOPLE_SEARCH_MAX_LENGTH,
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

export function PeopleScreen({ context }: PeopleScreenProps) {
  const people = findModule(context, 'people');
  const [draft, setDraft] = useState('');
  const [term, setTerm] = useState('');
  const [page, setPage] = useState(1);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<DirectoryState>({ phase: 'loading' });

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
        </div>

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
                </tr>
              </thead>
              <tbody>
                {data.items.map((person) => (
                  <tr key={person.id}>
                    <th scope="row">{person.displayName}</th>
                    <td>{person.employeeCode ?? '—'}</td>
                    <td>{person.workEmail ?? '—'}</td>
                    <td>{person.phone ?? '—'}</td>
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
