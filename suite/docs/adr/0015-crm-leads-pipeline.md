# ADR 0015 — CRM leads, stage movement and atomic conversion

Status: accepted · 28 October 2026 · Batch 3 of the five-module build

## Context

The owner decided on 27 October 2026 that all five modules are built now, reviewed in batches of three
slices, each carrying one ADR, one doc pass and one gate run. Batch 1 built the Work, Money and Content
read surfaces (ADR 0013). Batch 2 built CRM accounts and contacts on the shared `client` and
`client_contact` rows (ADR 0014) and shipped no migration at all. Batch 3 is the CRM lead surface, in
three slices reviewed together: the lead read and intake, the stage movement and the leads screen, and
the conversion that turns a lead into an account and its primary contact.

Four facts about the tree shaped the design:

1. **A lead is not a shared party record.** Accounts and contacts are platform-owned identity rows:
   Work and Money read the same `client` row, so those tables carry tenant isolation alone and the route
   gate is the only module boundary. A lead is a CRM-private record. Nothing outside CRM reads or writes
   it, and no other module would ever want to, so it can carry the module boundary in the database as
   well as on the route. This is the first table outside the People module to do that.
2. **The published permissions are nine, and this batch adds none.** `crm.read` and `crm.write` already
   exist. A lead is CRM work: reading one is reading CRM, changing or converting one is writing it. A
   third permission would be a finer distinction than the role map makes and would leave four roles to
   re-decide for no product question.
3. **The shared account row requires a currency, and a lead does not hold one.** `client.currency` is a
   `not null` three-letter code because Money is bigint minor units plus an explicit ISO code. A
   conversion writes a client row, so it must state a code. Nothing in the product can derive it from a
   lead, from an address or from a country, and the platform has no exchange rates. The conversion
   therefore asks the member for the code and records it verbatim.
4. **A conversion writes three rows and they must agree.** The lead's terminal state names the account
   and the contact it became; the account is a shared record with a primary contact. A half-written
   conversion would either leave a converted lead pointing at nothing or an account with no lead that
   explains it, and a retry would duplicate the account. The write is therefore one transaction under
   the lead's row lock.

## Decision

1. **One additive migration, `0015_crm_leads.sql`, and no change to 0001–0014.** It creates `crm_lead`
   with `id`, `tenant_id`, `name`, `company`, `email` (`citext`), `phone`, `source`, `stage`,
   `converted_client_id`, `converted_contact_id`, `converted_at`, `created_at` and `updated_at`.
   `stage` defaults to `new` and is checked against the five stored values. `unique (tenant_id, id)`
   is the key the composite references need; `converted_client_id` and `converted_contact_id` are
   composite foreign keys on `(tenant_id, id)` to `client` and `client_contact`, so a lead cannot point
   at an account or a contact of another workspace. Both are nullable, and MATCH SIMPLE leaves the
   reference unchecked while the column is null, which is what an unconverted lead holds.
2. **Terminality is a table invariant, not a runtime convention.** One check states the biconditional
   `(stage = 'converted') = (converted_client_id is not null and converted_contact_id is not null and
   converted_at is not null)`. A converted row with any of the three missing cannot exist, and neither
   can an unconverted row carrying all three. The route enforces the same rule with typed refusals; the
   table keeps it true whatever a future route does.
3. **The table carries its own module policies.** `app.enable_tenant_rls('crm_lead')` installs the
   permissive `tenant_isolation` policy, and three restrictive policies are declared beside the table:
   `crm_read` (`app.has_module_read('crm')`), `crm_write_insert` and `crm_write_update`
   (`app.has_module_write('crm')`). The names are literal, not `module_*`; `app.apply_module_policies()`
   only manages the `module_*` names, so the installer can never drop them. There is no delete policy
   and no `DELETE` privilege: a lead is retired by moving it to `disqualified`, not erased. A runtime
   insert in an unentitled workspace is refused at the policy, not only at the route, and the suite
   proves the refusal is `row-level security` rather than `permission denied for table crm_lead`.
4. **The runtime gets column-only grants and no table privilege.** `SELECT` names the nine columns the
   read answers with; `INSERT` names the eight intake columns and no conversion column; `UPDATE` names
   the six content fields, `stage` and the three conversion columns. `converted_at` is updatable and
   not selectable because the route writes it with `now()` and never reads it back. `id` and
   `tenant_id` are insertable and not updatable; `created_at` and `updated_at` are absent.
5. **Four routes, two gates.** There is no fifth permission and no second gate shape:

   | Route | Gate | Answers |
   | --- | --- | --- |
   | `GET /v1/crm/leads` | `{module:'crm', operation:'read'}` | `{items, total, page, pageSize}` |
   | `POST /v1/crm/leads` | `{module:'crm', operation:'write'}` | `201` + the nine-key lead |
   | `PATCH /v1/crm/leads/:id` | `{module:'crm', operation:'write'}` | `200` + the nine-key lead |
   | `POST /v1/crm/leads/:id/convert` | `{module:'crm', operation:'write'}` | `200` + `{lead, account, contact}` |

   The lead item has exactly nine keys — `id`, `name`, `company`, `email`, `phone`, `source`, `stage`,
   `convertedAccountId`, `convertedContactId` — and no tenant, no timestamp and no `converted_at`.
6. **The list is literal, exact and ordered.** The search is `strpos` over the lowered name, company
   and email, so `%` and `_` are data rather than `LIKE` wildcards. The stage filter is an exact match
   on one stored stage and refuses a value the column does not hold. The order is `stage, lower(name),
   id`, so the list is deterministic without a sort the client chooses. Paging uses the shared list
   helpers, and a malformed page or page size is `INVALID_QUERY` before any query runs.
7. **Only an open stage can be created, and the stage route cannot convert.** A create may state
   `new`, `contacted` or `qualified`; a new lead is never born terminal. A patch may move among those
   three or state `disqualified`, which is the confirmation the screen asks for. A patch that states
   `converted` is refused with `LEAD_CONVERSION_REQUIRED`: conversion writes more than one row and has
   its own route. A converted or disqualified lead is final — any changed-value patch is
   `LEAD_TERMINAL`. A patch that changes nothing is a true no-op: `200` with the stored row, no
   `UPDATE`, no `updated_at` movement and no audit row, so a terminal lead can be re-read that way but
   not changed.
8. **Conversion is one transaction under the lead's row lock.** The route opens the gate, reads the
   lead `for update`, then reads the closed body. A missing, foreign, malformed or soft-deleted lead is
   one `404 LEAD_NOT_FOUND`; a converted lead is `409 LEAD_ALREADY_CONVERTED`; a disqualified one is
   `409 LEAD_TERMINAL`; `currency` is required and is three uppercase ASCII letters; `accountName` is
   optional. The account is inserted with the stated name, falling back to the lead's company and then
   its name, with the lead's email and phone as billing email and phone, the stated currency, the
   database default status and terms, and **no code**. The contact is inserted with the lead's name,
   email and phone and `is_primary = true`. One `UPDATE` states the stage, both ids and `converted_at`
   together, so the table's terminality check sees a single consistent row version. All three rows are
   read back through the fragments their own surfaces use, and one `crm.lead.converted` audit row
   records the field names only. Two concurrent conversions serialize on the row lock: exactly one
   answers `200`, the other reads the committed state and answers `409 LEAD_ALREADY_CONVERTED` with
   nothing written.
9. **The currency is a code and nothing else.** The route validates the shape (three ASCII letters,
   uppercased) and stores it. It does not resolve the code against a registry, does not imply a
   jurisdiction or a tax rule, and does not convert any amount. There is no default, no country list
   and no remembered last choice on the dialog: a member states the code the account should carry. This
   is the same decision Money already makes for a stored amount and currency, applied to the one field a
   conversion has to supply.
10. **The lead screen is a second view inside `/app/crm`.** The route stays the module's URL; two tabs
    switch between Accounts and Leads, and the inactive view is unmounted, so a tenant without CRM read
    never mounts either and issues no `/v1/...` request. A lead row shows name, company, email, source
    and stage; a member whose context says `canWrite` gets a per-row stage select, Edit, Convert and
    Disqualify, and no one else gets any of them. Disqualification is a confirmation panel, not a
    silent select change. Conversion is a dialog with the account name (placeholder: the company or the
    lead name) and a required currency field with no default; success shows `Lead converted to account.`
    and switches to Accounts with the new account already in the search. The UI checks are presentation
    only: every request carries the same server gate.

## Consequences

**What this batch proves.** A CRM-only tenant with no People entitlement manages leads end to end: it
lists, creates, moves, disqualifies and converts them, while the table itself refuses an unentitled
workspace at the restrictive policy. A conversion is atomic against a revoked audit grant and against a
concurrent conversion, proven with a barrier rather than a sleep. The three browser journeys drive
create → advance → disqualify, create → convert → account and contact in the Accounts view, and the
unentitled tenant that sees no Leads tab and issues no lead request.

**What it deliberately does not build.** There is no lead delete, because `disqualified` is the
retirement and the runtime holds no `DELETE`; there is no lead owner, assignment, activity, note,
attachment, bulk import, forecast, pipeline analytics or export; there is no merge or dedupe when a
conversion creates an account that the workspace already holds; a conversion cannot be undone, because
both terminal stages are final; and there is no ISO 4217 registry behind the currency field, so any
three uppercase letters are a stored code. CRM is still **not complete** and the standalone sale is
still not ready: the export and the wider pipeline (forecast, activities, analytics) remain unbuilt.

**Residuals carried forward.** Every CRM reader sees every lead in the tenant: there is no CRM scope
analogue to the People scope layer, and no lead assignment to narrow it. A lead holds a person's name,
email and phone with no retention or masking rule of its own; it is covered only by tenant isolation,
the module gate and the audit trail. A successful lead read writes no audit row, which the suites pin
as an absence. There is no catalog or permission change, so the role map's two open CRM cells (auditor
without `crm.read`, and whether HR should read CRM) are unchanged. M0 has not exited, and no CI job has
ever executed a step: the account is billing-locked and every run has zero steps (§4 of
`docs/testing.md`).
