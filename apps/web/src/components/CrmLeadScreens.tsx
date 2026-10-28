import { useEffect, useState, type FormEvent } from 'react';
import type {
  ContextResponse,
  CrmLeadConversionInput,
  CrmLeadCreateInput,
  CrmLeadItem,
  CrmLeadOpenStage,
  CrmLeadStage,
  CrmLeadUpdateInput,
} from '@saasmodels/contracts';
import {
  CRM_LEAD_OPEN_STAGES,
  CRM_LEAD_STAGES,
  CRM_LIST_DEFAULT_PAGE_SIZE,
  CRM_SEARCH_MAX_LENGTH,
} from '@saasmodels/contracts';
import { api } from '../api';
import { accessLabel, findModule } from '../lib/model';

type LeadListResponse = {
  items: CrmLeadItem[];
  total: number;
  page: number;
  pageSize: number;
};

type LeadListState =
  | { phase: 'loading' }
  | { phase: 'error' }
  | { phase: 'ready'; data: LeadListResponse };

// The five stored stages, labelled for display only. A stage the column holds
// is exactly one of these values.
const STAGE_LABELS: Record<CrmLeadStage, string> = {
  new: 'New',
  contacted: 'Contacted',
  qualified: 'Qualified',
  converted: 'Converted',
  disqualified: 'Disqualified',
};

// A converted or disqualified lead is final. The row keeps its place in the
// list so its history stays readable; no control on it writes.
function isTerminal(stage: CrmLeadStage): boolean {
  return stage === 'converted' || stage === 'disqualified';
}

const LEADS_ERROR_MESSAGE = 'The leads could not be loaded. Try again.';

// Every failure the lead routes can return has honest copy here, so the screen
// never shows a raw server message and never shows a success it did not get.
const LEAD_ERROR_COPY: Record<string, string> = {
  LEAD_NOT_FOUND: 'That lead is no longer available to you.',
  LEAD_TERMINAL:
    'That lead has already been converted or disqualified, so it can no longer change.',
  LEAD_CONVERSION_REQUIRED:
    'A lead becomes converted through the conversion form, which writes the account and the contact as well.',
  LEAD_ALREADY_CONVERTED: 'That lead has already been converted.',
  INVALID_BODY:
    'The details were not accepted. A name is required, and every other value may be left empty.',
  CSRF_INVALID:
    'This browser no longer matches your session. Sign out, sign in again and retry.',
  NETWORK: 'The workspace could not be reached. Check your connection and try again.',
};

const LEAD_ERROR_FALLBACK = 'The lead could not be saved. Try again.';

function leadErrorCopy(code: string | null): string {
  if (code === null) {
    return LEAD_ERROR_FALLBACK;
  }
  return LEAD_ERROR_COPY[code] ?? LEAD_ERROR_FALLBACK;
}

type LeadFormValues = {
  name: string;
  company: string;
  email: string;
  phone: string;
  source: string;
  stage: CrmLeadOpenStage;
};

const EMPTY_LEAD_FORM: LeadFormValues = {
  name: '',
  company: '',
  email: '',
  phone: '',
  source: '',
  stage: 'new',
};

function openStage(value: string): CrmLeadOpenStage {
  return (CRM_LEAD_OPEN_STAGES as readonly string[]).includes(value)
    ? (value as CrmLeadOpenStage)
    : 'new';
}

function formValuesFromLead(lead: CrmLeadItem): LeadFormValues {
  return {
    name: lead.name,
    company: lead.company ?? '',
    email: lead.email ?? '',
    phone: lead.phone ?? '',
    source: lead.source ?? '',
    stage: openStage(lead.stage),
  };
}

// A blank optional on create means "not recorded", so the key is left out. The
// stage is always stated, and it is one of the three open stages the create
// route accepts.
function leadCreateInput(values: LeadFormValues): CrmLeadCreateInput {
  const input: CrmLeadCreateInput = {
    name: values.name.trim(),
    stage: values.stage,
  };
  const optional: Array<'company' | 'email' | 'phone' | 'source'> = [
    'company',
    'email',
    'phone',
    'source',
  ];
  for (const field of optional) {
    const value = values[field].trim();
    if (value !== '') {
      input[field] = value;
    }
  }
  return input;
}

// A blank optional on edit means "clear it", which an update states as null.
// The stage is not in this body: a row moves stage through its own control.
function leadUpdateInput(values: LeadFormValues): CrmLeadUpdateInput {
  const trimmed = (value: string): string | null => {
    const text = value.trim();
    return text === '' ? null : text;
  };
  return {
    name: values.name.trim(),
    company: trimmed(values.company),
    email: trimmed(values.email),
    phone: trimmed(values.phone),
    source: trimmed(values.source),
  };
}

type LeadFormProps = {
  mode: 'create' | 'update';
  values: LeadFormValues;
  submitting: boolean;
  error: string | null;
  onField: (field: keyof LeadFormValues, value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
};

function CrmLeadForm({
  mode,
  values,
  submitting,
  error,
  onField,
  onSubmit,
  onCancel,
}: LeadFormProps) {
  const titleId = `crm-lead-${mode}-title`;

  return (
    <form className="write-form" aria-labelledby={titleId} onSubmit={onSubmit}>
      <h3 id={titleId} className="write-form-title">
        {mode === 'create' ? 'Add a lead' : 'Edit this lead'}
      </h3>

      <div className="write-form-grid">
        <div className="field">
          <label htmlFor="crm-lead-name">
            Name<span className="required-mark"> (required)</span>
          </label>
          <input
            id="crm-lead-name"
            name="name"
            type="text"
            value={values.name}
            autoComplete="off"
            disabled={submitting}
            onChange={(event) => onField('name', event.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="crm-lead-company">Company</label>
          <input
            id="crm-lead-company"
            name="company"
            type="text"
            value={values.company}
            autoComplete="off"
            disabled={submitting}
            onChange={(event) => onField('company', event.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="crm-lead-email">Email</label>
          <input
            id="crm-lead-email"
            name="email"
            type="email"
            value={values.email}
            autoComplete="off"
            disabled={submitting}
            onChange={(event) => onField('email', event.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="crm-lead-phone">Phone</label>
          <input
            id="crm-lead-phone"
            name="phone"
            type="tel"
            value={values.phone}
            autoComplete="off"
            disabled={submitting}
            onChange={(event) => onField('phone', event.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="crm-lead-source">Source</label>
          <input
            id="crm-lead-source"
            name="source"
            type="text"
            value={values.source}
            autoComplete="off"
            disabled={submitting}
            onChange={(event) => onField('source', event.target.value)}
          />
        </div>

        {mode === 'create' ? (
          <div className="field">
            <label htmlFor="crm-lead-stage">Stage</label>
            <select
              id="crm-lead-stage"
              name="stage"
              value={values.stage}
              disabled={submitting}
              onChange={(event) =>
                onField('stage', openStage(event.target.value))
              }
            >
              {CRM_LEAD_OPEN_STAGES.map((stage) => (
                <option value={stage} key={stage}>
                  {STAGE_LABELS[stage]}
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </div>

      {error ? (
        <p className="form-alert" role="alert">
          {error}
        </p>
      ) : null}

      <div className="write-form-actions">
        <button
          className="button button--primary"
          type="submit"
          disabled={submitting}
        >
          {mode === 'create' ? 'Save lead' : 'Save changes'}
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

      <p className="fine-print write-form-note">
        A lead is a CRM row of its own: nothing outside this module reads or
        writes it. A new lead starts in an open stage, and conversion is a
        separate step that also writes an account.
      </p>
    </form>
  );
}

type DisqualifyPanelProps = {
  lead: CrmLeadItem;
  submitting: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
};

function CrmLeadDisqualify({
  lead,
  submitting,
  error,
  onConfirm,
  onCancel,
}: DisqualifyPanelProps) {
  return (
    <section className="write-form" aria-labelledby="crm-lead-disqualify-title">
      <h3 id="crm-lead-disqualify-title" className="write-form-title">
        Disqualify {lead.name}?
      </h3>
      <p className="write-form-note">
        A disqualified lead is final. It stays in the list so its history is
        readable, but it can no longer be edited, converted or returned to an
        open stage.
      </p>

      {error ? (
        <p className="form-alert" role="alert">
          {error}
        </p>
      ) : null}

      <div className="write-form-actions">
        <button
          className="button button--primary"
          type="button"
          onClick={onConfirm}
          disabled={submitting}
        >
          Disqualify lead
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
    </section>
  );
}

type ConvertFormProps = {
  lead: CrmLeadItem;
  values: { currency: string; accountName: string };
  submitting: boolean;
  error: string | null;
  onField: (field: 'currency' | 'accountName', value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
};

function CrmLeadConvertForm({
  lead,
  values,
  submitting,
  error,
  onField,
  onSubmit,
  onCancel,
}: ConvertFormProps) {
  return (
    <form
      className="write-form"
      aria-labelledby="crm-lead-convert-title"
      onSubmit={onSubmit}
    >
      <h3 id="crm-lead-convert-title" className="write-form-title">
        Convert {lead.name} to an account
      </h3>

      <div className="write-form-grid">
        <div className="field">
          <label htmlFor="crm-lead-accountName">Account name</label>
          <input
            id="crm-lead-accountName"
            name="accountName"
            type="text"
            value={values.accountName}
            placeholder={lead.company ?? lead.name}
            autoComplete="off"
            disabled={submitting}
            onChange={(event) => onField('accountName', event.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="crm-lead-currency">
            Currency<span className="required-mark"> (required)</span>
          </label>
          <input
            id="crm-lead-currency"
            name="currency"
            type="text"
            value={values.currency}
            maxLength={3}
            placeholder="USD"
            autoComplete="off"
            disabled={submitting}
            onChange={(event) =>
              onField('currency', event.target.value.toUpperCase())
            }
          />
        </div>
      </div>

      {error ? (
        <p className="form-alert" role="alert">
          {error}
        </p>
      ) : null}

      <div className="write-form-actions">
        <button
          className="button button--primary"
          type="submit"
          disabled={submitting}
        >
          Convert lead
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

      <p className="fine-print write-form-note">
        Conversion writes the account, its primary contact and this lead in one
        transaction, so all three exist or none does. The currency is a stored
        three-letter code: nothing here converts money or sets a tax rate. A
        converted lead is final.
      </p>
    </form>
  );
}

type LeadPanel =
  | { kind: 'create' }
  | { kind: 'edit'; lead: CrmLeadItem }
  | { kind: 'disqualify'; lead: CrmLeadItem }
  | { kind: 'convert'; lead: CrmLeadItem };

type CrmLeadsScreenProps = {
  context: ContextResponse;
  // A conversion lands on the Accounts view with the new account named, so the
  // screen that owns the tabs gets the account name and the success copy.
  onConverted: (accountName: string) => void;
};

// The CRM lead surface. Leads are the one CRM-private record, so this screen
// reads and writes through the same gate as the accounts and contacts beside
// it. The stage filter is an exact match on one stored stage.
export function CrmLeadsScreen({ context, onConverted }: CrmLeadsScreenProps) {
  const module = findModule(context, 'crm');
  // The write controls appear only for a member whose own context says they
  // may write. The server checks the same permission on every request, so a
  // hidden control is presentation and never authorization.
  const canWrite = module?.canWrite === true;

  const [draft, setDraft] = useState('');
  const [term, setTerm] = useState('');
  const [stageFilter, setStageFilter] = useState<'' | CrmLeadStage>('');
  const [page, setPage] = useState(1);
  const [attempt, setAttempt] = useState(0);
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<LeadListState>({ phase: 'loading' });

  const [panel, setPanel] = useState<LeadPanel | null>(null);
  const [values, setValues] = useState<LeadFormValues>(EMPTY_LEAD_FORM);
  const [convertValues, setConvertValues] = useState({
    currency: '',
    accountName: '',
  });
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyLead, setBusyLead] = useState<string | null>(null);

  useEffect(() => {
    // A response is dropped once the search, the stage or the page has moved
    // on, so a slow first request cannot overwrite a newer one.
    let stale = false;

    async function run() {
      setState({ phase: 'loading' });
      const result = await api.crmLeads({
        q: term,
        stage: stageFilter === '' ? undefined : stageFilter,
        page,
        pageSize: CRM_LIST_DEFAULT_PAGE_SIZE,
      });
      if (stale) {
        return;
      }
      if (!result.ok) {
        // A 401 is handled by the global listener, which returns the app to
        // sign-in without leaving any list state behind.
        if (result.status !== 401) {
          setState({ phase: 'error' });
        }
        return;
      }
      setState({ phase: 'ready', data: result.data });
    }

    void run();
    return () => {
      stale = true;
    };
  }, [term, stageFilter, page, attempt, revision]);

  const data = state.phase === 'ready' ? state.data : null;
  const totalPages =
    data === null ? 1 : Math.max(1, Math.ceil(data.total / data.pageSize));

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTerm(draft.trim());
    setPage(1);
  }

  function changeFilter(value: string) {
    setStageFilter(value === '' ? '' : (value as CrmLeadStage));
    setPage(1);
  }

  function closePanel() {
    setPanel(null);
    setFormError(null);
  }

  function openCreate() {
    setSavedMessage(null);
    setActionError(null);
    setFormError(null);
    setValues(EMPTY_LEAD_FORM);
    setPanel({ kind: 'create' });
  }

  function openEdit(lead: CrmLeadItem) {
    setSavedMessage(null);
    setActionError(null);
    setFormError(null);
    setValues(formValuesFromLead(lead));
    setPanel({ kind: 'edit', lead });
  }

  function openDisqualify(lead: CrmLeadItem) {
    setSavedMessage(null);
    setActionError(null);
    setFormError(null);
    setPanel({ kind: 'disqualify', lead });
  }

  function openConvert(lead: CrmLeadItem) {
    setSavedMessage(null);
    setActionError(null);
    setFormError(null);
    setConvertValues({ currency: '', accountName: '' });
    setPanel({ kind: 'convert', lead });
  }

  async function submitForm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (panel === null || submitting || panel.kind === 'disqualify' || panel.kind === 'convert') {
      return;
    }
    const mode = panel.kind;
    setSubmitting(true);
    setFormError(null);
    const result =
      mode === 'create'
        ? await api.createCrmLead(leadCreateInput(values))
        : await api.updateCrmLead(panel.lead.id, leadUpdateInput(values));
    setSubmitting(false);

    if (!result.ok) {
      if (result.status === 401) {
        // The global listener is taking the app back to sign-in.
        closePanel();
        return;
      }
      // The form stays open with the refusal in it, so nothing typed is lost.
      setFormError(leadErrorCopy(result.code));
      return;
    }

    closePanel();
    setSavedMessage(mode === 'create' ? 'Lead added.' : 'Lead updated.');
    setRevision((current) => current + 1);
  }

  async function confirmDisqualify() {
    if (panel === null || panel.kind !== 'disqualify' || submitting) {
      return;
    }
    setSubmitting(true);
    setFormError(null);
    const result = await api.updateCrmLead(panel.lead.id, {
      stage: 'disqualified',
    });
    setSubmitting(false);

    if (!result.ok) {
      if (result.status === 401) {
        closePanel();
        return;
      }
      setFormError(leadErrorCopy(result.code));
      return;
    }

    closePanel();
    setSavedMessage('Lead disqualified.');
    setRevision((current) => current + 1);
  }

  async function submitConvert(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (panel === null || panel.kind !== 'convert' || submitting) {
      return;
    }
    const currency = convertValues.currency.trim();
    if (currency === '') {
      setFormError('A three-letter currency code is required.');
      return;
    }
    // The server accepts only three ASCII capitals and answers a generic
    // INVALID_BODY, whose copy describes a required name and optional fields
    // and so is wrong for this dialog. Refuse the shape here, where the
    // message can name the field that failed.
    if (!/^[A-Z]{3}$/.test(currency)) {
      setFormError('Enter a three-letter currency code, such as USD.');
      return;
    }
    const input: CrmLeadConversionInput = { currency };
    const accountName = convertValues.accountName.trim();
    if (accountName !== '') {
      input.accountName = accountName;
    }

    setSubmitting(true);
    setFormError(null);
    const result = await api.convertCrmLead(panel.lead.id, input);
    setSubmitting(false);

    if (!result.ok) {
      if (result.status === 401) {
        closePanel();
        return;
      }
      setFormError(leadErrorCopy(result.code));
      return;
    }

    closePanel();
    onConverted(result.data.account.name);
  }

  // A row's stage control writes the movement the route accepts: another open
  // stage, or disqualification through the confirmation panel. It never offers
  // 'converted', which is the conversion form's job.
  async function changeStage(lead: CrmLeadItem, next: CrmLeadOpenStage) {
    if (next === lead.stage) {
      return;
    }
    setSavedMessage(null);
    setActionError(null);
    setBusyLead(lead.id);
    const result = await api.updateCrmLead(lead.id, { stage: next });
    setBusyLead(null);

    if (!result.ok) {
      if (result.status !== 401) {
        setActionError(leadErrorCopy(result.code));
      }
      return;
    }

    setSavedMessage('Stage updated.');
    setRevision((current) => current + 1);
  }

  const filtered = term !== '' || stageFilter !== '';
  const countCopy =
    state.phase === 'error'
      ? 'Leads unavailable'
      : state.phase === 'ready'
        ? `${state.data.total} ${state.data.total === 1 ? 'lead' : 'leads'}`
        : 'Loading the leads…';

  return (
    <article className="page">
      <header className="page-head page-head--split">
        <div>
          <p className="eyebrow">CRM</p>
          <h1 id="crm-leads-title">Leads</h1>
          <p className="page-lede">
            The leads this workspace holds, from first contact to the account
            they became.
          </p>
        </div>
        {module ? (
          <span className="badge badge--accent">{accessLabel(module)}</span>
        ) : null}
      </header>

      <section className="directory" aria-labelledby="crm-leads-title">
        <div className="directory-toolbar">
          <form className="search-form" role="search" onSubmit={submitSearch}>
            <label htmlFor="crm-lead-search">Search leads</label>
            <input
              id="crm-lead-search"
              className="searchbox"
              type="search"
              placeholder="Name, company or email"
              value={draft}
              maxLength={CRM_SEARCH_MAX_LENGTH}
              onChange={(event) => setDraft(event.target.value)}
            />
            <label htmlFor="crm-lead-filter">Stage</label>
            <select
              id="crm-lead-filter"
              className="searchbox crm-stage-filter"
              value={stageFilter}
              onChange={(event) => changeFilter(event.target.value)}
            >
              <option value="">All stages</option>
              {CRM_LEAD_STAGES.map((stage) => (
                <option value={stage} key={stage}>
                  {STAGE_LABELS[stage]}
                </option>
              ))}
            </select>
            <button className="button button--quiet" type="submit">
              Search
            </button>
          </form>
          {canWrite ? (
            <div className="directory-actions">
              <button
                className="button button--primary button--small"
                type="button"
                onClick={openCreate}
                disabled={panel !== null || submitting}
              >
                Add lead
              </button>
            </div>
          ) : null}
          <p className="directory-count" role="status" aria-live="polite">
            {countCopy}
          </p>
        </div>

        {savedMessage ? (
          <p className="write-saved" role="status" aria-live="polite">
            {savedMessage}
          </p>
        ) : null}

        {actionError ? (
          <p className="form-alert" role="alert">
            {actionError}
          </p>
        ) : null}

        {panel ? (
          panel.kind === 'create' || panel.kind === 'edit' ? (
            <CrmLeadForm
              mode={panel.kind === 'create' ? 'create' : 'update'}
              values={values}
              submitting={submitting}
              error={formError}
              onField={(field, value) =>
                setValues((current) => ({ ...current, [field]: value }))
              }
              onSubmit={(event) => void submitForm(event)}
              onCancel={closePanel}
            />
          ) : panel.kind === 'disqualify' ? (
            <CrmLeadDisqualify
              lead={panel.lead}
              submitting={submitting}
              error={formError}
              onConfirm={() => void confirmDisqualify()}
              onCancel={closePanel}
            />
          ) : (
            <CrmLeadConvertForm
              lead={panel.lead}
              values={convertValues}
              submitting={submitting}
              error={formError}
              onField={(field, value) =>
                setConvertValues((current) => ({ ...current, [field]: value }))
              }
              onSubmit={(event) => void submitConvert(event)}
              onCancel={closePanel}
            />
          )
        ) : null}

        {state.phase === 'error' ? (
          <div className="directory-state">
            <p className="directory-error" role="alert">
              {LEADS_ERROR_MESSAGE}
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
            <table className="directory-table" aria-label="Leads">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Company</th>
                  <th scope="col">Email</th>
                  <th scope="col">Source</th>
                  <th scope="col">Stage</th>
                  {canWrite ? <th scope="col">Actions</th> : null}
                </tr>
              </thead>
              <tbody>
                {data.items.map((lead) => (
                  <tr key={lead.id}>
                    <th scope="row">{lead.name}</th>
                    <td>{lead.company ?? '—'}</td>
                    <td>{lead.email ?? '—'}</td>
                    <td>{lead.source ?? '—'}</td>
                    <td>
                      {canWrite && !isTerminal(lead.stage) ? (
                        <select
                          className="stage-select"
                          aria-label={`Stage for ${lead.name}`}
                          value={lead.stage}
                          disabled={busyLead !== null || panel !== null}
                          onChange={(event) =>
                            void changeStage(
                              lead,
                              event.target.value as CrmLeadOpenStage,
                            )
                          }
                        >
                          {CRM_LEAD_OPEN_STAGES.map((stage) => (
                            <option value={stage} key={stage}>
                              {STAGE_LABELS[stage]}
                            </option>
                          ))}
                        </select>
                      ) : (
                        STAGE_LABELS[lead.stage]
                      )}
                    </td>
                    {canWrite ? (
                      <td className="directory-actions">
                        {isTerminal(lead.stage) ? (
                          '—'
                        ) : (
                          <>
                            <button
                              className="button button--quiet button--small"
                              type="button"
                              onClick={() => openEdit(lead)}
                              disabled={panel !== null || busyLead !== null}
                            >
                              Edit
                            </button>
                            <button
                              className="button button--quiet button--small"
                              type="button"
                              onClick={() => openConvert(lead)}
                              disabled={panel !== null || busyLead !== null}
                            >
                              Convert
                            </button>
                            <button
                              className="button button--quiet button--small"
                              type="button"
                              onClick={() => openDisqualify(lead)}
                              disabled={panel !== null || busyLead !== null}
                            >
                              Disqualify
                            </button>
                          </>
                        )}
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : data !== null ? (
          <p className="directory-empty">
            {filtered
              ? 'No leads match this view.'
              : 'No leads are visible in this view.'}
          </p>
        ) : null}

        {data !== null && data.total > 0 ? (
          <nav className="pager" aria-label="Leads pages">
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
              onClick={() => setPage((current) => current + 1)}
            >
              Next
            </button>
          </nav>
        ) : null}

        <p className="fine-print directory-note">
          This view lists only the leads your licence and role cover, so it can
          show fewer records than the workspace holds. A lead is a CRM row of
          its own; a converted lead names the account and the contact it became,
          and a disqualified lead is kept rather than removed.
        </p>
      </section>
    </article>
  );
}
