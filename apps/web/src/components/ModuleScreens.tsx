import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type {
  ContextResponse,
  ContentListItem,
  InvoiceListItem,
  ProjectListItem,
} from '@saasmodels/contracts';
import {
  CONTENT_LIST_DEFAULT_PAGE_SIZE,
  CONTENT_SEARCH_MAX_LENGTH,
  MONEY_LIST_DEFAULT_PAGE_SIZE,
  MONEY_SEARCH_MAX_LENGTH,
  WORK_LIST_DEFAULT_PAGE_SIZE,
  WORK_SEARCH_MAX_LENGTH,
} from '@saasmodels/contracts';
import { api, type ApiResult } from '../api';
import { formatMinorAmount } from '../lib/money';
import { accessLabel, availableModuleNames, findModule } from '../lib/model';

type ListResponse<T> = {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
};

type ListState<T> =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; data: ListResponse<T> };

type ModuleRow = { id: string };

export type Column<T> = {
  header: string;
  render: (item: T) => ReactNode;
};

type ModuleListScreenProps<T extends ModuleRow> = {
  context: ContextResponse;
  moduleCode: string;
  eyebrow: string;
  title: string;
  lede: string;
  singular: string;
  plural: string;
  searchLabel: string;
  searchPlaceholder: string;
  searchMaxLength: number;
  pageSize: number;
  tableLabel: string;
  errorMessage: string;
  unavailableLabel: string;
  loadingMessage: string;
  emptyMessage: string;
  note: string;
  columns: Column<T>[];
  load: (
    input: { q: string; page: number; pageSize: number },
  ) => Promise<ApiResult<ListResponse<T>>>;
  // What sits above the table, beside the search. A module with no writes
  // passes nothing and gets no controls.
  headerActions?: ReactNode;
  // What a row can carry. The screen adds an Actions column only when a
  // module asks for one, so a read-only module keeps a table of data alone.
  rowActions?: (item: T) => ReactNode;
  // A panel the module owns, shown under the toolbar: a write form, or the
  // details of the row a member opened.
  panel?: ReactNode;
  // The screen reloads when this changes, so a module that writes outside the
  // list can refresh the rows it just changed.
  refreshKey?: number;
  // Where the search starts, both in the box and in the committed term. A
  // module whose tabs unmount this screen uses it to bring the reader back to
  // the search they left, or to the row a write just created.
  initialSearch?: string;
  // The committed term, so a screen that unmounts can hand its search back to
  // whoever mounts it next.
  onSearchCommit?: (term: string) => void;
};

function listCount(total: number, singular: string, plural: string): string {
  return `${total} ${total === 1 ? singular : plural}`;
}

// The live region must not announce a load that already failed, so its copy
// follows the phase rather than the presence of data.
function statusCopy<T>(
  state: ListState<T>,
  singular: string,
  plural: string,
  unavailableLabel: string,
  loadingMessage: string,
): string {
  if (state.phase === 'error') {
    return unavailableLabel;
  }
  if (state.phase === 'ready') {
    return listCount(state.data.total, singular, plural);
  }
  return loadingMessage;
}

// One list screen behind the three module surfaces. The modules differ in their
// columns and in their copy, not in their shape: a heading, a search, a live
// count, a table, a pager and the three states a read can be in.
//
// Every state says what this view holds, never what the workspace holds. A
// member sees only the rows their licence and role cover, so "no rows" is a
// statement about the view and never a statement about the workspace.
export function ModuleListScreen<T extends ModuleRow>({
  context,
  moduleCode,
  eyebrow,
  title,
  lede,
  singular,
  plural,
  searchLabel,
  searchPlaceholder,
  searchMaxLength,
  pageSize,
  tableLabel,
  errorMessage,
  unavailableLabel,
  loadingMessage,
  emptyMessage,
  note,
  columns,
  load,
  headerActions,
  rowActions,
  panel,
  refreshKey = 0,
  initialSearch = '',
  onSearchCommit,
}: ModuleListScreenProps<T>) {
  const module = findModule(context, moduleCode);
  const [draft, setDraft] = useState(initialSearch);
  const [term, setTerm] = useState(initialSearch);
  const [page, setPage] = useState(1);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<ListState<T>>({ phase: 'loading' });

  useEffect(() => {
    // A response is dropped once the search or the page has moved on, so a slow
    // first request cannot overwrite the results of a newer one.
    let stale = false;

    async function run() {
      setState({ phase: 'loading' });
      const result = await load({ q: term, page, pageSize });
      if (stale) {
        return;
      }
      if (!result.ok) {
        // A 401 is handled by the global listener, which returns the app to
        // sign-in without leaving any list state behind.
        if (result.status !== 401) {
          setState({ phase: 'error', message: errorMessage });
        }
        return;
      }
      setState({ phase: 'ready', data: result.data });
    }

    void run();
    return () => {
      stale = true;
    };
  }, [term, page, attempt, load, pageSize, errorMessage, refreshKey]);

  const data = state.phase === 'ready' ? state.data : null;
  const totalPages =
    data === null ? 1 : Math.max(1, Math.ceil(data.total / data.pageSize));

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next = draft.trim();
    setTerm(next);
    setPage(1);
    onSearchCommit?.(next);
  }

  return (
    <article className="page">
      <header className="page-head page-head--split">
        <div>
          <p className="eyebrow">{eyebrow}</p>
          <h1 id={`${moduleCode}-title`}>{title}</h1>
          <p className="page-lede">{lede}</p>
        </div>
        {module ? (
          <span className="badge badge--accent">{accessLabel(module)}</span>
        ) : null}
      </header>

      <section className="directory" aria-labelledby={`${moduleCode}-title`}>
        <div className="directory-toolbar">
          <form className="search-form" role="search" onSubmit={submitSearch}>
            <label htmlFor={`${moduleCode}-search`}>{searchLabel}</label>
            <input
              id={`${moduleCode}-search`}
              className="searchbox"
              type="search"
              placeholder={searchPlaceholder}
              value={draft}
              maxLength={searchMaxLength}
              onChange={(event) => setDraft(event.target.value)}
            />
            <button className="button button--quiet" type="submit">
              Search
            </button>
          </form>
          {headerActions ? <div className="directory-actions">{headerActions}</div> : null}
          <p className="directory-count" role="status" aria-live="polite">
            {statusCopy(state, singular, plural, unavailableLabel, loadingMessage)}
          </p>
        </div>

        {panel}

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
            <table className="directory-table" aria-label={tableLabel}>
              <thead>
                <tr>
                  {columns.map((column) => (
                    <th scope="col" key={column.header}>
                      {column.header}
                    </th>
                  ))}
                  {rowActions ? <th scope="col">Actions</th> : null}
                </tr>
              </thead>
              <tbody>
                {data.items.map((item) => (
                  <tr key={item.id}>
                    {columns.map((column, index) =>
                      index === 0 ? (
                        <th scope="row" key={column.header}>
                          {column.render(item)}
                        </th>
                      ) : (
                        <td key={column.header}>{column.render(item)}</td>
                      ),
                    )}
                    {rowActions ? (
                      <td className="directory-actions">{rowActions(item)}</td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : data !== null ? (
          <p className="directory-empty">
            {term === ''
              ? emptyMessage
              : `No ${plural} match “${term}” in this view.`}
          </p>
        ) : null}

        {data !== null && data.total > 0 ? (
          <nav className="pager" aria-label={`${title} pages`}>
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

        <p className="fine-print directory-note">{note}</p>
      </section>
    </article>
  );
}

const PROJECT_COLUMNS: Column<ProjectListItem>[] = [
  { header: 'Name', render: (item) => item.name },
  { header: 'Code', render: (item) => item.code ?? '—' },
  { header: 'Client', render: (item) => item.clientName ?? '—' },
  { header: 'Status', render: (item) => item.status },
  { header: 'Currency', render: (item) => item.currency },
  { header: 'Start', render: (item) => item.startDate ?? '—' },
  { header: 'End', render: (item) => item.endDate ?? '—' },
  {
    header: 'Budget',
    render: (item) =>
      item.budgetMinor === null
        ? '—'
        : formatMinorAmount(item.budgetMinor, item.currency),
  },
];

const INVOICE_COLUMNS: Column<InvoiceListItem>[] = [
  { header: 'Number', render: (item) => item.number },
  { header: 'Client', render: (item) => item.clientName ?? '—' },
  { header: 'Status', render: (item) => item.status },
  { header: 'Issued', render: (item) => item.issueDate },
  { header: 'Due', render: (item) => item.dueDate },
  {
    header: 'Subtotal',
    render: (item) => formatMinorAmount(item.subtotalMinor, item.currency),
  },
  {
    // The stored tax amount. It is not a rate, and it carries no jurisdiction:
    // the invoice stores an amount and the column is called Tax.
    header: 'Tax',
    render: (item) => formatMinorAmount(item.taxMinor, item.currency),
  },
  {
    header: 'Total',
    render: (item) => formatMinorAmount(item.totalMinor, item.currency),
  },
  {
    header: 'Paid',
    render: (item) => formatMinorAmount(item.amountPaidMinor, item.currency),
  },
];

const CONTENT_COLUMNS: Column<ContentListItem>[] = [
  { header: 'Title', render: (item) => item.title },
  { header: 'Kind', render: (item) => item.kind },
  { header: 'Slug', render: (item) => item.slug },
  { header: 'Locale', render: (item) => item.locale },
  { header: 'Status', render: (item) => item.status },
  { header: 'Updated', render: (item) => item.updatedAt },
];

function loadProjects(input: {
  q: string;
  page: number;
  pageSize: number;
}): Promise<ApiResult<ListResponse<ProjectListItem>>> {
  return api.workProjects(input);
}

function loadInvoices(input: {
  q: string;
  page: number;
  pageSize: number;
}): Promise<ApiResult<ListResponse<InvoiceListItem>>> {
  return api.moneyInvoices(input);
}

function loadContentItems(input: {
  q: string;
  page: number;
  pageSize: number;
}): Promise<ApiResult<ListResponse<ContentListItem>>> {
  return api.contentItems(input);
}

type ModuleScreenProps = {
  context: ContextResponse;
};

export function WorkScreen({ context }: ModuleScreenProps) {
  return (
    <ModuleListScreen
      context={context}
      moduleCode="work"
      eyebrow="Work"
      title="Projects"
      lede="The engagements this workspace can read."
      singular="project"
      plural="projects"
      searchLabel="Search projects"
      searchPlaceholder="Name, code or client"
      searchMaxLength={WORK_SEARCH_MAX_LENGTH}
      pageSize={WORK_LIST_DEFAULT_PAGE_SIZE}
      tableLabel="Projects"
      errorMessage="The projects could not be loaded. Try again."
      unavailableLabel="Projects unavailable"
      loadingMessage="Loading the projects…"
      emptyMessage="No projects are visible in this view."
      note="This view lists only the projects your licence and role cover, so it can show fewer records than the workspace holds."
      columns={PROJECT_COLUMNS}
      load={loadProjects}
    />
  );
}

export function MoneyScreen({ context }: ModuleScreenProps) {
  return (
    <ModuleListScreen
      context={context}
      moduleCode="money"
      eyebrow="Money"
      title="Invoices"
      lede="The invoices this workspace can read."
      singular="invoice"
      plural="invoices"
      searchLabel="Search invoices"
      searchPlaceholder="Invoice number or client"
      searchMaxLength={MONEY_SEARCH_MAX_LENGTH}
      pageSize={MONEY_LIST_DEFAULT_PAGE_SIZE}
      tableLabel="Invoices"
      errorMessage="The invoices could not be loaded. Try again."
      unavailableLabel="Invoices unavailable"
      loadingMessage="Loading the invoices…"
      emptyMessage="No invoices are visible in this view."
      note="This view lists only the invoices your licence and role cover, so it can show fewer records than the workspace holds. Every amount is the stored figure in its own currency."
      columns={INVOICE_COLUMNS}
      load={loadInvoices}
    />
  );
}

export function ContentScreen({ context }: ModuleScreenProps) {
  return (
    <ModuleListScreen
      context={context}
      moduleCode="content"
      eyebrow="Content"
      title="Content"
      lede="The content this workspace can read."
      singular="content item"
      plural="content items"
      searchLabel="Search content"
      searchPlaceholder="Title, slug or kind"
      searchMaxLength={CONTENT_SEARCH_MAX_LENGTH}
      pageSize={CONTENT_LIST_DEFAULT_PAGE_SIZE}
      tableLabel="Content items"
      errorMessage="The content could not be loaded. Try again."
      unavailableLabel="Content unavailable"
      loadingMessage="Loading the content…"
      emptyMessage="No content items are visible in this view."
      note="This view lists only the content your licence and role cover, so it can show fewer records than the workspace holds."
      columns={CONTENT_COLUMNS}
      load={loadContentItems}
    />
  );
}

type ModuleAccessStateProps = {
  context: ContextResponse;
  moduleName: string;
  onNavigate: (path: string) => void;
};

export function ModuleAccessState({
  context,
  moduleName,
  onNavigate,
}: ModuleAccessStateProps) {
  const modules = availableModuleNames(context);

  return (
    <article className="panel-state" aria-labelledby="module-access-title">
      <p className="eyebrow">{moduleName}</p>
      <h1 id="module-access-title">{moduleName} is not available to you</h1>
      <p className="page-lede">
        Your role does not include the {moduleName} module in this workspace.
        These are the modules enabled for you:
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
