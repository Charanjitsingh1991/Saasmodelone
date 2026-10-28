import { useEffect, useState, type FormEvent } from 'react';
import type {
  ContextResponse,
  CrmAccountCreateInput,
  CrmAccountListItem,
  CrmAccountStatus,
  CrmAccountUpdateInput,
  CrmContactCreateInput,
  CrmContactItem,
  CrmContactUpdateInput,
} from '@saasmodels/contracts';
import {
  CRM_ACCOUNT_STATUSES,
  CRM_LIST_DEFAULT_PAGE_SIZE,
  CRM_SEARCH_MAX_LENGTH,
} from '@saasmodels/contracts';
import { api, type ApiResult } from '../api';
import { findModule } from '../lib/model';
import { CrmLeadsScreen } from './CrmLeadScreens';
import { ModuleListScreen, type Column } from './ModuleScreens';

type CrmListResponse<T> = {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
};

const ACCOUNT_COLUMNS: Column<CrmAccountListItem>[] = [
  { header: 'Name', render: (item) => item.name },
  { header: 'Code', render: (item) => item.code ?? '—' },
  { header: 'Status', render: (item) => item.status },
  { header: 'Billing email', render: (item) => item.billingEmail ?? '—' },
  { header: 'Phone', render: (item) => item.phone ?? '—' },
  { header: 'Currency', render: (item) => item.currency },
  { header: 'Payment terms', render: (item) => `${item.paymentTermsDays} days` },
];

// The four stored statuses, labelled for the picker. The column keeps the raw
// value; the label is only ever presentation.
const STATUS_LABELS: Record<CrmAccountStatus, string> = {
  prospect: 'Prospect',
  active: 'Active',
  dormant: 'Dormant',
  archived: 'Archived',
};

type AccountFormField = keyof AccountFormValues;

type AccountFormValues = {
  name: string;
  code: string;
  status: CrmAccountStatus;
  billingEmail: string;
  phone: string;
  currency: string;
  paymentTermsDays: string;
};

const EMPTY_ACCOUNT_FORM: AccountFormValues = {
  name: '',
  code: '',
  status: 'active',
  billingEmail: '',
  phone: '',
  currency: '',
  paymentTermsDays: '',
};

// The stored status is one of the four the column allows, so a value the
// picker does not know cannot reach the form.
function accountStatus(value: string): CrmAccountStatus {
  return (CRM_ACCOUNT_STATUSES as readonly string[]).includes(value)
    ? (value as CrmAccountStatus)
    : 'active';
}

function formValuesFromAccount(account: CrmAccountListItem): AccountFormValues {
  return {
    name: account.name,
    code: account.code ?? '',
    status: accountStatus(account.status),
    billingEmail: account.billingEmail ?? '',
    phone: account.phone ?? '',
    currency: account.currency,
    paymentTermsDays: String(account.paymentTermsDays),
  };
}

// A blank optional on create means "not recorded", so the key is left out and
// the database default applies.
function accountCreateInput(values: AccountFormValues): CrmAccountCreateInput {
  const input: CrmAccountCreateInput = {
    name: values.name.trim(),
    status: values.status,
    currency: values.currency.trim(),
  };
  const optional: Array<'code' | 'billingEmail' | 'phone'> = [
    'code',
    'billingEmail',
    'phone',
  ];
  for (const field of optional) {
    const value = values[field].trim();
    if (value !== '') {
      input[field] = value;
    }
  }
  const terms = values.paymentTermsDays.trim();
  if (terms !== '') {
    input.paymentTermsDays = Number(terms);
  }
  return input;
}

// A blank optional on edit means "clear it", which an update states as null;
// leaving a key out would mean "unchanged".
function accountUpdateInput(values: AccountFormValues): CrmAccountUpdateInput {
  const trimmed = (value: string): string | null => {
    const text = value.trim();
    return text === '' ? null : text;
  };
  return {
    name: values.name.trim(),
    code: trimmed(values.code),
    status: values.status,
    billingEmail: trimmed(values.billingEmail),
    phone: trimmed(values.phone),
    currency: values.currency.trim(),
    paymentTermsDays: Number(values.paymentTermsDays.trim()),
  };
}

// Every failure these routes can return has honest copy here, so the screen
// never shows a raw server message and never shows a success it did not get.
const CRM_WRITE_ERROR_COPY: Record<string, string> = {
  ACCOUNT_CODE_TAKEN:
    'That account code already belongs to an account in this workspace.',
  ACCOUNT_NOT_FOUND: 'That account is no longer available to you.',
  INVALID_BODY:
    'The details were not accepted. A name and a three-letter currency code in capitals are required, the status must be one of the four the account list shows, and the payment terms must be a whole number of days.',
  CSRF_INVALID:
    'This browser no longer matches your session. Sign out, sign in again and retry.',
  NETWORK: 'The workspace could not be reached. Check your connection and try again.',
};

const CRM_WRITE_ERROR_FALLBACK = 'The account could not be saved. Try again.';

function crmWriteErrorCopy(code: string | null): string {
  if (code === null) {
    return CRM_WRITE_ERROR_FALLBACK;
  }
  return CRM_WRITE_ERROR_COPY[code] ?? CRM_WRITE_ERROR_FALLBACK;
}

// Every failure the contact routes can return has honest copy here, so the
// screen never shows a raw server message and never shows a success it did
// not get.
const CRM_CONTACT_ERROR_COPY: Record<string, string> = {
  ACCOUNT_NOT_FOUND: 'That account is no longer available to you.',
  CONTACT_NOT_FOUND: 'That contact is no longer available to you.',
  CONTACT_PRIMARY_TAKEN:
    'That account already has a primary contact, and the change was not applied.',
  INVALID_BODY:
    'The details were not accepted. A name is required and every other value may be left empty.',
  CSRF_INVALID:
    'This browser no longer matches your session. Sign out, sign in again and retry.',
  NETWORK: 'The workspace could not be reached. Check your connection and try again.',
};

const CRM_CONTACT_ERROR_FALLBACK = 'The contact could not be saved. Try again.';

function crmContactErrorCopy(code: string | null): string {
  if (code === null) {
    return CRM_CONTACT_ERROR_FALLBACK;
  }
  return CRM_CONTACT_ERROR_COPY[code] ?? CRM_CONTACT_ERROR_FALLBACK;
}

const CONTACTS_ERROR_MESSAGE = 'The contacts could not be loaded. Try again.';

type ContactFormValues = {
  name: string;
  email: string;
  phone: string;
  role: string;
  isPrimary: boolean;
};

const EMPTY_CONTACT_FORM: ContactFormValues = {
  name: '',
  email: '',
  phone: '',
  role: '',
  isPrimary: false,
};

function formValuesFromContact(contact: CrmContactItem): ContactFormValues {
  return {
    name: contact.name,
    email: contact.email ?? '',
    phone: contact.phone ?? '',
    role: contact.role ?? '',
    isPrimary: contact.isPrimary,
  };
}

// A blank optional on create means "not recorded", so the key is left out.
function contactCreateInput(values: ContactFormValues): CrmContactCreateInput {
  const input: CrmContactCreateInput = { name: values.name.trim() };
  const optional: Array<'email' | 'phone' | 'role'> = ['email', 'phone', 'role'];
  for (const field of optional) {
    const value = values[field].trim();
    if (value !== '') {
      input[field] = value;
    }
  }
  if (values.isPrimary) {
    input.isPrimary = true;
  }
  return input;
}

// A blank optional on edit means "clear it", which an update states as null.
function contactUpdateInput(values: ContactFormValues): CrmContactUpdateInput {
  const trimmed = (value: string): string | null => {
    const text = value.trim();
    return text === '' ? null : text;
  };
  return {
    name: values.name.trim(),
    email: trimmed(values.email),
    phone: trimmed(values.phone),
    role: trimmed(values.role),
    isPrimary: values.isPrimary,
  };
}

type CrmAccountFormProps = {
  mode: 'create' | 'update';
  values: AccountFormValues;
  submitting: boolean;
  error: string | null;
  onField: (field: AccountFormField, value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
};

function CrmAccountForm({
  mode,
  values,
  submitting,
  error,
  onField,
  onSubmit,
  onCancel,
}: CrmAccountFormProps) {
  const titleId = `crm-account-${mode}-title`;

  return (
    <form
      className="write-form"
      aria-labelledby={titleId}
      onSubmit={onSubmit}
    >
      <h3 id={titleId} className="write-form-title">
        {mode === 'create' ? 'Add an account' : 'Edit this account'}
      </h3>

      <div className="write-form-grid">
        <div className="field">
          <label htmlFor="crm-account-name">
            Name<span className="required-mark"> (required)</span>
          </label>
          <input
            id="crm-account-name"
            name="name"
            type="text"
            value={values.name}
            autoComplete="off"
            disabled={submitting}
            onChange={(event) => onField('name', event.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="crm-account-code">Code</label>
          <input
            id="crm-account-code"
            name="code"
            type="text"
            value={values.code}
            autoComplete="off"
            disabled={submitting}
            onChange={(event) => onField('code', event.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="crm-account-status">Status</label>
          <select
            id="crm-account-status"
            name="status"
            value={values.status}
            disabled={submitting}
            onChange={(event) =>
              onField('status', accountStatus(event.target.value))
            }
          >
            {CRM_ACCOUNT_STATUSES.map((status) => (
              <option value={status} key={status}>
                {STATUS_LABELS[status]}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="crm-account-billingEmail">Billing email</label>
          <input
            id="crm-account-billingEmail"
            name="billingEmail"
            type="email"
            value={values.billingEmail}
            autoComplete="off"
            disabled={submitting}
            onChange={(event) => onField('billingEmail', event.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="crm-account-phone">Phone</label>
          <input
            id="crm-account-phone"
            name="phone"
            type="tel"
            value={values.phone}
            autoComplete="off"
            disabled={submitting}
            onChange={(event) => onField('phone', event.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="crm-account-currency">
            Currency<span className="required-mark"> (required)</span>
          </label>
          <input
            id="crm-account-currency"
            name="currency"
            type="text"
            value={values.currency}
            maxLength={3}
            placeholder="USD"
            autoComplete="off"
            disabled={submitting}
            onChange={(event) => onField('currency', event.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="crm-account-paymentTermsDays">Payment terms (days)</label>
          <input
            id="crm-account-paymentTermsDays"
            name="paymentTermsDays"
            type="number"
            min={0}
            step={1}
            value={values.paymentTermsDays}
            placeholder={mode === 'create' ? 'Defaults to 30 days' : '0'}
            disabled={submitting}
            onChange={(event) =>
              onField('paymentTermsDays', event.target.value)
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
          {mode === 'create' ? 'Save account' : 'Save changes'}
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
        An account is a shared client record, so Work and Money name the same
        row. The currency is a stored code: nothing on this form converts money
        or sets a tax rate.
      </p>
    </form>
  );
}

function loadAccounts(input: {
  q: string;
  page: number;
  pageSize: number;
}): Promise<ApiResult<CrmListResponse<CrmAccountListItem>>> {
  return api.crmAccounts(input);
}

type CrmContactFormProps = {
  mode: 'create' | 'update';
  values: ContactFormValues;
  submitting: boolean;
  error: string | null;
  onField: (field: keyof ContactFormValues, value: string | boolean) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
};

function CrmContactForm({
  mode,
  values,
  submitting,
  error,
  onField,
  onSubmit,
  onCancel,
}: CrmContactFormProps) {
  const titleId = `crm-contact-${mode}-title`;

  return (
    <form
      className="write-form"
      aria-labelledby={titleId}
      onSubmit={onSubmit}
    >
      <h3 id={titleId} className="write-form-title">
        {mode === 'create' ? 'Add a contact' : 'Edit this contact'}
      </h3>

      <div className="write-form-grid">
        <div className="field">
          <label htmlFor="crm-contact-name">
            Name<span className="required-mark"> (required)</span>
          </label>
          <input
            id="crm-contact-name"
            name="name"
            type="text"
            value={values.name}
            autoComplete="off"
            disabled={submitting}
            onChange={(event) => onField('name', event.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="crm-contact-email">Email</label>
          <input
            id="crm-contact-email"
            name="email"
            type="email"
            value={values.email}
            autoComplete="off"
            disabled={submitting}
            onChange={(event) => onField('email', event.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="crm-contact-phone">Phone</label>
          <input
            id="crm-contact-phone"
            name="phone"
            type="tel"
            value={values.phone}
            autoComplete="off"
            disabled={submitting}
            onChange={(event) => onField('phone', event.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="crm-contact-role">Role</label>
          <input
            id="crm-contact-role"
            name="role"
            type="text"
            value={values.role}
            autoComplete="off"
            disabled={submitting}
            onChange={(event) => onField('role', event.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="crm-contact-isPrimary">Primary contact</label>
          <input
            id="crm-contact-isPrimary"
            name="isPrimary"
            type="checkbox"
            checked={values.isPrimary}
            disabled={submitting}
            onChange={(event) => onField('isPrimary', event.target.checked)}
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
          {mode === 'create' ? 'Save contact' : 'Save changes'}
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
        An account holds at most one primary contact. Making a contact primary
        demotes the account’s other primary, and the change is recorded.
      </p>
    </form>
  );
}

type ContactsState =
  | { phase: 'loading' }
  | { phase: 'error' }
  | { phase: 'ready'; items: CrmContactItem[]; total: number };

type CrmContactsPanelProps = {
  account: { id: string; name: string };
  state: ContactsState;
  canWrite: boolean;
  form: { mode: 'create' } | { mode: 'update'; contact: CrmContactItem } | null;
  values: ContactFormValues;
  submitting: boolean;
  error: string | null;
  onRetry: () => void;
  onAdd: () => void;
  onEdit: (contact: CrmContactItem) => void;
  onField: (field: keyof ContactFormValues, value: string | boolean) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
};

function CrmContactsPanel({
  account,
  state,
  canWrite,
  form,
  values,
  submitting,
  error,
  onRetry,
  onAdd,
  onEdit,
  onField,
  onSubmit,
  onCancel,
}: CrmContactsPanelProps) {
  return (
    <section className="write-panel" aria-labelledby="crm-contacts-title">
      <div className="write-panel-head">
        <h3 id="crm-contacts-title" className="write-form-title">
          Contacts of {account.name}
        </h3>
        {canWrite ? (
          <button
            className="button button--quiet button--small"
            type="button"
            onClick={onAdd}
            disabled={form !== null || submitting}
          >
            Add contact
          </button>
        ) : null}
      </div>

      {state.phase === 'loading' ? (
        <p className="write-state">Loading the contacts…</p>
      ) : null}

      {state.phase === 'error' ? (
        <div className="write-state">
          <p className="form-alert" role="alert">
            {CONTACTS_ERROR_MESSAGE}
          </p>
          <button
            className="button button--quiet button--small"
            type="button"
            onClick={onRetry}
          >
            Try again
          </button>
        </div>
      ) : null}

      {state.phase === 'ready' ? (
        state.items.length === 0 ? (
          <p className="write-empty">
            This account has no contacts in this view.
          </p>
        ) : (
          <div className="directory-scroll">
            <table className="directory-table" aria-label={`Contacts of ${account.name}`}>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Email</th>
                  <th scope="col">Phone</th>
                  <th scope="col">Role</th>
                  <th scope="col">Primary</th>
                  {canWrite ? <th scope="col">Actions</th> : null}
                </tr>
              </thead>
              <tbody>
                {state.items.map((contact) => (
                  <tr key={contact.id}>
                    <th scope="row">{contact.name}</th>
                    <td>{contact.email ?? '—'}</td>
                    <td>{contact.phone ?? '—'}</td>
                    <td>{contact.role ?? '—'}</td>
                    <td>{contact.isPrimary ? 'Yes' : 'No'}</td>
                    {canWrite ? (
                      <td className="directory-actions">
                        <button
                          className="button button--quiet button--small"
                          type="button"
                          onClick={() => onEdit(contact)}
                          disabled={form !== null || submitting}
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
        )
      ) : null}

      {form ? (
        <CrmContactForm
          mode={form.mode}
          values={values}
          submitting={submitting}
          error={error}
          onField={onField}
          onSubmit={onSubmit}
          onCancel={onCancel}
        />
      ) : null}

      <p className="fine-print write-form-note">
        A contact belongs to one account and cannot be moved to another. The
        shared record has no delete route, so a contact is corrected in place
        rather than removed.
      </p>
    </section>
  );
}

// The CRM account surface. An account is a shared client record: the platform
// owns client identity and this is the module that reads and writes it. The
// screen says so in its note, because a member who also holds Work or Money
// will see the same account named in two places.
//
// The tabs above this screen own which view is mounted, so switching to Leads
// unmounts it. The account search and any message a conversion left behind are
// handed back in, which is what lets a conversion land on the account it wrote.
type CrmAccountsScreenProps = {
  context: ContextResponse;
  initialSearch?: string;
  initialMessage?: string | null;
  onSearchCommit?: (term: string) => void;
};

function CrmAccountsScreen({
  context,
  initialSearch,
  initialMessage = null,
  onSearchCommit,
}: CrmAccountsScreenProps) {
  const module = findModule(context, 'crm');
  // The write controls appear only for a member whose own context says they
  // may write. The server checks the same permission on every request, so a
  // hidden control is presentation and never authorization.
  const canWrite = module?.canWrite === true;
  const [form, setForm] = useState<
    { mode: 'create' } | { mode: 'update'; account: CrmAccountListItem } | null
  >(null);
  const [values, setValues] = useState<AccountFormValues>(EMPTY_ACCOUNT_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  // One success slot for the whole screen: an account write and a contact write
  // never stack two confirmations above each other.
  const [savedMessage, setSavedMessage] = useState<string | null>(initialMessage);
  const [revision, setRevision] = useState(0);

  // The account whose contacts are open. One at a time: the panel below the
  // table belongs to a single account, and the reader opens it from the row.
  const [openAccount, setOpenAccount] = useState<CrmAccountListItem | null>(null);
  const [contactsState, setContactsState] = useState<ContactsState>({
    phase: 'loading',
  });
  const [contactAttempt, setContactAttempt] = useState(0);
  const [contactRevision, setContactRevision] = useState(0);
  const [contactForm, setContactForm] = useState<
    { mode: 'create' } | { mode: 'update'; contact: CrmContactItem } | null
  >(null);
  const [contactValues, setContactValues] = useState<ContactFormValues>(
    EMPTY_CONTACT_FORM,
  );
  const [contactSubmitting, setContactSubmitting] = useState(false);
  const [contactError, setContactError] = useState<string | null>(null);

  // The contacts are read on their own route, so the panel carries its own
  // loading, error and empty states instead of the account list's.
  useEffect(() => {
    if (openAccount === null) {
      return;
    }
    let active = true;
    setContactsState({ phase: 'loading' });
    void api.crmContacts(openAccount.id).then((result) => {
      if (!active) {
        return;
      }
      if (!result.ok) {
        setContactsState({ phase: 'error' });
        return;
      }
      setContactsState({
        phase: 'ready',
        items: result.data.items,
        total: result.data.total,
      });
    });
    return () => {
      active = false;
    };
  }, [openAccount, contactAttempt, contactRevision]);

  function openCreateForm() {
    setSavedMessage(null);
    setFormError(null);
    setValues(EMPTY_ACCOUNT_FORM);
    setForm({ mode: 'create' });
  }

  function openEditForm(account: CrmAccountListItem) {
    setSavedMessage(null);
    setFormError(null);
    setValues(formValuesFromAccount(account));
    setForm({ mode: 'update', account });
  }

  function closeForm() {
    setForm(null);
    setFormError(null);
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
        ? await api.createCrmAccount(accountCreateInput(values))
        : await api.updateCrmAccount(
            form.account.id,
            accountUpdateInput(values),
          );
    setSubmitting(false);

    if (!result.ok) {
      if (result.status === 401) {
        // The global listener is taking the app back to sign-in.
        closeForm();
        return;
      }
      // The form stays open with the refusal in it, so nothing typed is lost.
      setFormError(crmWriteErrorCopy(result.code));
      return;
    }

    closeForm();
    setSavedMessage(mode === 'create' ? 'Account added.' : 'Account updated.');
    setRevision((current) => current + 1);
  }

  function openContacts(account: CrmAccountListItem) {
    setSavedMessage(null);
    setContactError(null);
    setContactForm(null);
    setOpenAccount(account);
  }

  function retryContacts() {
    setContactAttempt((current) => current + 1);
  }

  function openContactCreate() {
    setSavedMessage(null);
    setContactError(null);
    setContactValues(EMPTY_CONTACT_FORM);
    setContactForm({ mode: 'create' });
  }

  function openContactEdit(contact: CrmContactItem) {
    setSavedMessage(null);
    setContactError(null);
    setContactValues(formValuesFromContact(contact));
    setContactForm({ mode: 'update', contact });
  }

  function closeContactForm() {
    setContactForm(null);
    setContactError(null);
  }

  async function submitContactForm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (contactForm === null || contactSubmitting || openAccount === null) {
      return;
    }
    const mode = contactForm.mode;
    setContactSubmitting(true);
    setContactError(null);
    const result =
      mode === 'create'
        ? await api.createCrmContact(
            openAccount.id,
            contactCreateInput(contactValues),
          )
        : await api.updateCrmContact(
            openAccount.id,
            contactForm.contact.id,
            contactUpdateInput(contactValues),
          );
    setContactSubmitting(false);

    if (!result.ok) {
      if (result.status === 401) {
        // The global listener is taking the app back to sign-in.
        closeContactForm();
        return;
      }
      // The form stays open with the refusal in it, so nothing typed is lost.
      setContactError(crmContactErrorCopy(result.code));
      return;
    }

    closeContactForm();
    setSavedMessage(
      mode === 'create' ? 'Contact added.' : 'Contact updated.',
    );
    setContactRevision((current) => current + 1);
  }

  const panel =
    form !== null || savedMessage !== null || openAccount !== null ? (
      <>
        {savedMessage ? (
          <p className="write-saved" role="status" aria-live="polite">
            {savedMessage}
          </p>
        ) : null}
        {form ? (
          <CrmAccountForm
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
        {openAccount ? (
          <CrmContactsPanel
            account={openAccount}
            state={contactsState}
            canWrite={canWrite}
            form={contactForm}
            values={contactValues}
            submitting={contactSubmitting}
            error={contactError}
            onRetry={retryContacts}
            onAdd={openContactCreate}
            onEdit={openContactEdit}
            onField={(field, value) =>
              setContactValues((current) => ({ ...current, [field]: value }))
            }
            onSubmit={(event) => void submitContactForm(event)}
            onCancel={closeContactForm}
          />
        ) : null}
      </>
    ) : undefined;

  return (
    <ModuleListScreen
      context={context}
      moduleCode="crm"
      eyebrow="CRM"
      title="Accounts"
      lede="The client accounts this workspace can read."
      singular="account"
      plural="accounts"
      searchLabel="Search accounts"
      searchPlaceholder="Name, code or billing email"
      searchMaxLength={CRM_SEARCH_MAX_LENGTH}
      pageSize={CRM_LIST_DEFAULT_PAGE_SIZE}
      tableLabel="Accounts"
      errorMessage="The accounts could not be loaded. Try again."
      unavailableLabel="Accounts unavailable"
      loadingMessage="Loading the accounts…"
      emptyMessage="No accounts are visible in this view."
      note="This view lists only the accounts your licence and role cover, so it can show fewer records than the workspace holds. An account is a shared client record, so Work and Money name the same row."
      columns={ACCOUNT_COLUMNS}
      load={loadAccounts}
      headerActions={
        canWrite ? (
          <button
            className="button button--primary button--small"
            type="button"
            onClick={openCreateForm}
            disabled={form !== null || submitting}
          >
            Add account
          </button>
        ) : undefined
      }
      rowActions={(account) => (
        <>
          <button
            className="button button--quiet button--small"
            type="button"
            onClick={() => openContacts(account)}
          >
            Contacts
          </button>
          {canWrite ? (
            <button
              className="button button--quiet button--small"
              type="button"
              onClick={() => openEditForm(account)}
              disabled={form !== null || submitting}
            >
              Edit
            </button>
          ) : null}
        </>
      )}
      panel={panel}
      refreshKey={revision}
      initialSearch={initialSearch}
      onSearchCommit={onSearchCommit}
    />
  );
}

// The CRM module holds two views of one entitlement: the accounts the workspace
// trades with, and the leads that become them. The route stays /app/crm and the
// tabs switch the view inside it, so a link to the module never depends on
// which view a member was last reading.
export function CrmScreen({ context }: { context: ContextResponse }) {
  const [view, setView] = useState<'accounts' | 'leads'>('accounts');
  // The account search the tabs hand back and forth, so returning to Accounts
  // restores the search the reader left rather than starting blank.
  const [accountSearch, setAccountSearch] = useState('');
  const [accountMessage, setAccountMessage] = useState<string | null>(null);

  function openAccounts() {
    setAccountMessage(null);
    setView('accounts');
  }

  function openLeads() {
    setView('leads');
  }

  return (
    <div className="crm-view">
      <div className="crm-tabs" role="tablist" aria-label="CRM views">
        <button
          id="crm-tab-accounts"
          className="crm-tab"
          type="button"
          role="tab"
          aria-selected={view === 'accounts'}
          aria-controls="crm-panel"
          onClick={openAccounts}
        >
          Accounts
        </button>
        <button
          id="crm-tab-leads"
          className="crm-tab"
          type="button"
          role="tab"
          aria-selected={view === 'leads'}
          aria-controls="crm-panel"
          onClick={openLeads}
        >
          Leads
        </button>
      </div>

      <div
        id="crm-panel"
        role="tabpanel"
        aria-labelledby={`crm-tab-${view}`}
      >
        {view === 'accounts' ? (
          <CrmAccountsScreen
            context={context}
            initialSearch={accountSearch}
            initialMessage={accountMessage}
            onSearchCommit={setAccountSearch}
          />
        ) : (
          <CrmLeadsScreen
            context={context}
            onConverted={(accountName) => {
              // The conversion is a write the member asked for, so the result
              // is shown where the account now lives: the account list, with
              // the new account already in the search.
              setAccountSearch(accountName);
              setAccountMessage('Lead converted to account.');
              setView('accounts');
            }}
          />
        )}
      </div>
    </div>
  );
}
