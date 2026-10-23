# ADR 0006 — A server-authorized React shell behind a same-origin proxy

Status: accepted · October 2026

## Context

M0 needs a signed-in workspace shell and an honest empty People screen so the
sign-in, session, entitlement and role path is proven in a real browser, not
only through API tests. The web client must not become a second authorization
system, must not hold session tokens where scripts can read them, and must stay
deployable as a static bundle behind the same origin as the API.

The product is a pre-launch internal workspace, not a public content site. Search
engine rendering, per-request HTML and a component design system are not needed
to prove the M0 exit criterion.

## Decision

1. **React and Vite single-page application.** `apps/web` is a React 19 app built
   by Vite with TypeScript, exact-pinned dependencies and a system font stack.
   It imports only `@saasmodels/contracts` from the workspace; lint enforces the
   boundary. There is no component library, CSS framework, CDN, external font,
   analytics or runtime third-party script.
2. **Same-origin in development and production.** During development Vite serves
   the app on port 3000 and proxies `/v1` and `/health` to the API on
   `127.0.0.1:3001`; the target can be overridden with
   `VITE_API_PROXY_TARGET`. Production serves the built assets from the same
   origin as the API behind an edge or reverse proxy that forwards `/v1` and
   `/health`. The edge must serve `index.html` for unknown application paths so
   `/app` and `/app/people` survive a reload. The SPA owns no server routing.
3. **Session credentials stay in an HttpOnly cookie.** The API sets the
   `saas_session` cookie; browser JavaScript never receives or stores the
   session token. The only value kept in memory is the CSRF token returned by
   the session response, used for sign-out. Credentials and the CSRF token are
   never written to local storage, session storage, the URL or logs. The theme
   is the only persisted preference.
4. **Client routing is presentation, never authorization.** A small History API
   router resolves `/login`, `/app` and `/app/people`; it has no open-redirect
   parameter. Hiding a module, or showing an access state, is a convenience.
   Every API request is still checked server-side in the order entitlement,
   role, scope. A user who types a route for an unentitled module sees an
   access state; the API would refuse the data regardless of what the client
   renders.
5. **The server is the source of the shell's navigation.** The app loads the
   session and then `GET /v1/context`. The context response carries each
   effective module's code, name, sort order and read/write flags, computed from
   entitlement and role. The shell renders only those modules, ordered by the
   server, and shows non-People modules as not yet shipped. The response is
   marked `Cache-Control: no-store`.
6. **The browser journey is part of the definition of done.** One Playwright
   test runs against the built web output, a disposable PostgreSQL database and
   the API in-process on localhost. Synthetic accounts exercise sign-in, the
   People screen's data (empty state in M0, the directory rows and their search
   from M1), module filtering, theme persistence and sign-out. It does
   not mock the API, session or database.

## Consequences

- The M0 People screen is deliberately an empty state. It has no data entry,
  import, export, invitation or CRUD, and it makes no directory request.
- M1 note: that empty state has since been replaced — `/app/people` now renders
  the read-only `GET /v1/people` directory with search, a live result count and
  paging, still with no write path and no scope label, and every decision above
  still holds.
- The client bundle is small enough to reason about but not split by route yet;
  code splitting can be introduced when module screens exist.
- Same-origin deployment means cookies use `SameSite=Strict` without CORS
  credentials work. A future native or third-party client would need a different
  API authentication decision.
- Server-side rendering, a strict Content-Security-Policy and production
  security headers are deferred until there is a production deployment to
  verify them against. This ADR makes no claim that they exist.
- The visual language currently lives in one stylesheet. Extracting a shared
  design system is deferred until a second surface needs it.
- The hand-rolled router covers three routes. A routing library is not justified
  yet, and avoiding one removes an open-redirect surface to review.
