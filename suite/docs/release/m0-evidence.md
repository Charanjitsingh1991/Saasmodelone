# M0 evidence

Date: 22 October 2026
Status: **interim evidence pack — M0 has not exited**

This document records what the current tree proves, what it merely checks structurally, and what remains unproven. It is not a release approval and not a claim that the product is ready for customer data. The design-partner gate in [`../security.md`](../security.md) is still unticked, and the draft threat model in [`../security/m0-threat-model.md`](../security/m0-threat-model.md) has not been reviewed by a named human security owner.

## 1. Source and environment

| Item | Value |
| --- | --- |
| Last committed source | `ef3b9a65633d1bbbd613e88db78744dddb8c6bed` (T9, People CSV export) |
| Current source | T10 working tree, uncommitted; HEAD remains `ef3b9a6` |
| Operating system | Windows 10.0.26300, x64 |
| Node.js | 22.18.0 |
| pnpm | 10.18.3 |
| Local PostgreSQL | 17.9, x86_64-windows |
| CI matrix authored | PostgreSQL 16 and 17 on `ubuntu-latest`, Node 22, pnpm 10.18.3 |
| CI executed on GitHub | **No.** There is no Git remote and the workflow has never run. |

All database tests use disposable local databases created by `@saasmodels/testkit`. Fixtures are synthetic. No real customer, payroll, bank, statutory-identifier or design-partner data is present.

## 2. Commands run on this tree

| Command | Result |
| --- | --- |
| `pnpm secret-scan` | Exit 0, no findings. The scanner lists tracked and untracked non-ignored paths, so this rerun includes the T10 additions; ignored files such as `.env` remain unscanned. |
| `pnpm audit --prod --audit-level high` | Exit 0, `No known vulnerabilities found`. |
| `pnpm typecheck` | Exit 0 for the tools project and all six workspace packages. |
| `pnpm lint` | Exit 0. |
| `pnpm lint:boundaries` | Exit 0. |
| `pnpm test` | 16 test files passed, 203 tests passed, 27.93 s. |
| `pnpm db:migrate` | Exit 0; all ten baseline migrations skipped; `runtime-grants.sql` and `auth-grants.sql` reapplied. |

`pnpm test` includes 14 new T10 tests over the 189 tests recorded for T9: 3 CI workflow contract tests, 6 secret-scan tests and 5 schema-inventory tests.

Final migration output:

```json
{"event":"migration.skipped","version":"0001_core.sql"}
...
{"event":"migration.skipped","version":"0010_identity.sql"}
{"event":"grants.applied","file":"runtime-grants.sql"}
{"event":"grants.applied","file":"auth-grants.sql"}
{"event":"migrate.complete","applied":[],"skipped":["0001_core.sql","0002_people.sql","0003_work.sql","0004_content.sql","0005_money.sql","0006_migration.sql","0007_modules.sql","0008_platform_access.sql","0009_member_access.sql","0010_identity.sql"]}
```

## 3. M0 exit criteria

| # | Exit criterion (roadmap) | Status | Evidence | Gap |
| --- | --- | --- | --- | --- |
| 1 | Two tenants cannot read or write each other's rows through SQL and the API | **proven** | `tests/module-rls.test.ts`: "cross-tenant reads, updates and deletes on employment and project see zero rows", "tenant A cannot insert an employment row for tenant B", "without a tenant context the runtime sees no employment or project rows". `tests/api.test.ts`: "tenant A sees People only and only its own employment", "tenant B sees Work only and only its own project", "a session cannot select another tenant through a forged membership", "tenant override headers and query strings are ignored", "sequential tenants and users through one pool do not leak context or role". `tests/schema-inventory.test.ts` confirms 64 RLS tables and the two documented identity exceptions. | The matrix covers the two M0 tables with runtime grants (`employment`, `project`) and the People export. It does not exercise every tenant table through a route; most tables have no runtime grant or API path yet. |
| 2 | A tenant without an active module cannot reach its data, routes, exports or background jobs | **proven for M0 surfaces** | `tests/module-rls.test.ts`: "tenant A cannot read any project row", "tenant A insert into project is denied by row-level security, not table privilege", "a cancelled entitlement inside read_until is read-only at the table". `tests/worker.test.ts`: "an unentitled module fails before the callback runs". `tests/api.test.ts`: "an unentitled module is denied before the role is considered". `tests/people-export.test.ts`: "denies a Work-only tenant with MODULE_NOT_ENTITLED and no CSV". | Only the M0 proof routes, worker entry point and People export exist. Background queue/outbox polling does not exist. |
| 3 | Suspended, closed and deleted tenants are denied at both layers | **proven** | `tests/platform-access.test.ts`: "has_platform_access is false for suspended, closed and deleted tenants", "suspended, closed and deleted tenants are denied by every helper". `tests/module-rls.test.ts`: "suspended, closed and deleted tenants cannot read or insert employment". `tests/api.test.ts`: "suspended, closed and deleted tenants are denied on context and proof routes". `tests/authentication.test.ts`: "a suspended tenant may sign in but protected routes deny platform access". | There is no production tenant offboarding, retention or deletion workflow. |
| 4 | A synthetic public tenant gets People; an internal tenant gets planned CRM, without schema or data migration | **proven** | `tests/governance.test.ts`: "creates tenant, invited owner, membership, entitlement and audit in one transaction", "an internal tenant may receive a planned module with an internal source", "applies catalog rules and rolls back on an ineligible module". `tests/platform-access.test.ts`: "an internal tenant reaches a planned module with an internal-source entitlement", "a public tenant cannot reach a planned module through an entitlement". | Only the module-catalog configuration path is proven. The CRM module itself has no screens or routes. |
| 5 | Migrations and the module seed apply cleanly to an empty database and roll forward from the previous version | **partial** | `tests/harness.test.ts`: "fresh apply records every baseline migration and creates the schema", "a second migrate is a no-op", "a tampered applied migration is rejected by checksum", "seeding twice is idempotent and does not overwrite a reviewed catalog row". | Fresh apply of all ten files, no-op re-apply, checksum rejection and seed idempotency are proven. There is no test that starts from a populated previous-version schema and rolls forward in place; "roll forward" is inferred from ordered baseline application, not separately exercised. |
| 6 | A signed-in user can reach an empty People screen and sees only entitled modules | **not met** | No UI exists; `apps/web` has no server, route or People screen. `tests/authentication.test.ts` and `tests/api.test.ts` prove session and `/v1/context` behaviour at the API layer only. | The entire criterion is open. There is no browser test because there is no UI. |
| 7 | Role authorization runs after entitlement and does not disclose role policy for an unentitled module | **proven** | `tests/membership.test.ts`: "an entitled module still denies a role without its permission", "checks the entitlement before the role permission". `tests/api.test.ts`: "an entitled module is denied when the role lacks its permission", "an unentitled module is denied before the role is considered". `tests/authorization.test.ts`: exact seven-role policy and fail-closed mapping. | Role enforcement is application-layer only; grants and RLS do not know the membership role. Scope authorization is M1. |
| 8 | The People directory export returns only the session tenant's seven identity fields, denies unentitled/role-denied requests without CSV bytes, and audits before the first byte | **proven** | `tests/people-export.test.ts`: all ten tests, including exact streaming CSV, single audit row, role and module denials with no CSV, unauthenticated rejection, `read_until` retention, audit-failure 500 and eight-column grant. `tests/csv.test.ts` and `tests/csv-stream.test.ts` cover formula guarding, RFC 4180 and backpressure. `tests/schema-inventory.test.ts` confirms the exact person column grants. | The export is scoped to directory identity fields. There is no dedicated export permission, rate limit, filter, column selection, stored artifact or full portability export. |

## 4. T10 verification items

| Item | Status | Evidence | Limit |
| --- | --- | --- | --- |
| CI workflow definition | **partial** | `.github/workflows/ci.yml`; `tests/ci-workflow.test.ts` asserts push/pull-request triggers, read-only top-level permissions, no `pull_request_target`, no `continue-on-error`, concurrency/cancel, 20-minute timeout, PostgreSQL 16/17 matrix, localhost-only dummy database URLs, credential-free actions, `persist-credentials: false` and the exact ordered command list. | A contract test proves the file's shape, not that GitHub executed it. The workflow has never run; there is no remote. PostgreSQL 16 compatibility is therefore unproven. |
| Working-tree secret scan | **partial** | `scripts/secret-scan.ts`; `tests/secret-scan.test.ts` covers seven content rules, redacted output, benign placeholders, sensitive paths, `.env.example`, tracked and untracked non-ignored discovery, ignored-file exclusion, binary and symlink skipping, a temporary repository and a clean repository. `pnpm secret-scan` exits 0 and includes the T10 additions. | Regex-based; scans tracked and untracked non-ignored regular files. Git history, ignored files, packed objects and remote state are out of scope. Detection, not proof of absence. |
| Production dependency audit | **partial** | `pnpm audit --prod --audit-level high` reports no known vulnerabilities. CI runs the same command. | One advisory database at one point in time. No SBOM, provenance verification or scheduled audit. |
| Schema and privilege inventory | **proven for the current schema** | `tests/schema-inventory.test.ts`: 66 public tables with `tenant_id`; 64 with RLS and permissive `tenant_isolation`; exactly `auth_session` and `invitation` as exceptions with no policy; `tenant` has RLS and `tenant_self` but no `tenant_id`; no relation in `public` or `infra` has `relforcerowsecurity`; runtime has no grant on the two auth tables and the five auth helpers are security-definer; runtime table grants equal the exact 12-row allowlist; `person` has no table privilege and exactly eight column grants. | It proves the schema and grants at test time. It is not a continuous drift monitor. |
| Threat model | **partial** | [`../security/m0-threat-model.md`](../security/m0-threat-model.md) covers assets, actors, trust boundaries and 22 threats with controls, evidence and residual risk. | Draft only. No named security owner, no human review, no independent penetration test and no approval. |
| Restore drill | **not met** | No backup or restore exists in this environment. | Required before any real data. |
| Signed-in empty People screen | **not met** | No UI or browser suite. | Required by the M0 exit criteria. |
| PostgreSQL 16 | **not proven** | Local runs use PostgreSQL 17.9; CI declares a 16/17 matrix. | Proven only when the workflow actually runs on both versions. |

## 5. Not proven — do not claim

Do not claim any of the following on the strength of this tree:

- That M0 has exited, or that the product is production-ready.
- That PostgreSQL 16 works. The matrix is authored, not executed.
- That CI passes on GitHub. The workflow contract test is not a CI run.
- That the repository is secret-free. The scanner detects known shapes in tracked and untracked non-ignored regular files only.
- That the threat model is reviewed or approved. It is a draft without a named owner.
- That backups, restore, retention, legal hold, offboarding, full export or audit read exist.
- That tenant isolation is proven for every table or every future route. The tested runtime surface is `employment`, `project`, the People export and `/v1/context`.
- That the People directory CSV is a complete export or portability feature.
- That role scope, employee self-scope, MFA, session rotation, device lists, distributed rate limiting or authentication-event audit exist.
- That any jurisdiction pack, payroll calculation or statutory output exists.
- That real customer data would be safe in this build. It must not be loaded.

## 6. Related documents

- [`../roadmap.md`](../roadmap.md) — M0 scope and exit criteria.
- [`../security.md`](../security.md) — baseline controls and the design-partner gate.
- [`../testing.md`](../testing.md) — test layers, suites and CI gates.
- [`../security/m0-threat-model.md`](../security/m0-threat-model.md) — draft threat model.
- [`../../db/README.md`](../../db/README.md) — schema, roles and grant allowlists.
