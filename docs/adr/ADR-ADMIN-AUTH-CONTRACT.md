# ADR: Admin auth failure contract and browser session-invalidation rule

- Status: Accepted
- Date: 2026-08-04
- Related: PR #6, `docs/ops/qm-installation-and-local-run.md` §9–§10

## Context

`/admin/*` used two independent authentication checks: a global Express
middleware (`createAdminAuthMiddleware`, mounted on `/api/admin`) and a
route-local guard (`requireAdminAccess`) called by many individual routes as
defense in depth. They drifted apart — the route-local guard only accepted
the production `ADMIN_API_TOKEN` and silently rejected a valid non-production
dev-password session — so a subset of routes 401'd even for a logged-in
admin. The browser's fetch interceptor made this worse: it treated *any*
same-origin `/api/admin/*` 401 as "session expired" and cleared the token
immediately, so the first spurious 401 logged the admin out of every section,
not just the one route that misbehaved.

## Decision

**One accepted-secret policy, called from both layers.**
`apps/AI-adm-D1/src/server/ai/admin-auth.ts` owns the single comparison
(`isAcceptedAdminToken`), the single candidate-token reader
(`candidateAdminToken`), and the single failure response
(`sendAdminAuthRequired`). Both the global middleware and any route-local
guard must call these — never re-implement a comparison locally.

**A 401 is only a "session invalid" signal when explicitly marked.**
A genuine authentication failure — and only a genuine authentication
failure — sets:

- HTTP status `401`
- Header `X-Admin-Auth-State: invalid`
- JSON body `{ "code": "ADMIN_AUTH_REQUIRED" }`

Business-logic 401s (if any route ever needs one) must never set this
marker. As of this ADR, no route in the codebase emits a 401 through any
path other than `sendAdminAuthRequired`, so the invariant holds by
construction, not by convention — grep for `status(401)` in
`apps/AI-adm-D1/src/server` to re-verify after any change.

**The browser clears the session only when all four hold** (see
`maybeInvalidateAdminSession` in `apps/AI-adm-D1/src/adminAuth.tsx`):

1. The request actually dispatched a token (`dispatchedToken` is non-null).
   An unauthenticated request's 401 says nothing about an existing session —
   this is also what protects a wrong-password login probe from clearing a
   different, currently-valid session.
2. The response status is `401`.
3. The response carries the `ADMIN_AUTH_REQUIRED` marker (header first, then
   a cloned-body JSON fallback).
4. `getAdminToken()` still equals `dispatchedToken` at the moment of the
   check — read once before the async marker check and once after. This
   rejects a late/stale response for a token a fresh re-login has already
   superseded, and makes concurrent marked-401s single-flight: once the
   first clears the token, every other pending check's final comparison
   fails and becomes a no-op. No separate dedupe flag or lock is needed
   because the check-then-clear runs synchronously once condition 3
   resolves.

**Token storage stays `sessionStorage`, not `localStorage`.** The token is
scoped to one browser tab by design (see the login page's own copy: "密碼只
保存在目前瀏覽器分頁的 sessionStorage"). A cross-tab single-session
experience would require a separate HttpOnly/Secure/SameSite cookie design —
out of scope here; do not switch to `localStorage` as a shortcut, since that
silently changes the security/sharing model.

**Both literal-constant pairs must stay in sync by hand.** The server
(`ADMIN_AUTH_REQUIRED_CODE`, `ADMIN_AUTH_STATE_HEADER` in `admin-auth.ts`)
and the browser (matching constants in `adminAuth.tsx`) each define their own
copy of the header name and code string — there is no shared package between
them for this. If either changes, change both, and re-run
`pnpm admin:navigation-smoke` plus `adminAuth.test.ts`/`admin-auth.test.ts`.

## Consequences

- Any new admin route only needs to sit behind the global
  `/api/admin` middleware to be correctly authenticated; a route-local guard
  is optional defense in depth, not a second source of policy.
- Any new route-local guard must call `isAcceptedAdminToken`/
  `candidateAdminToken`/`sendAdminAuthRequired` rather than compare a header
  by hand — the lint/test suite does not currently block a reintroduced
  duplicate check, so this is a code-review invariant, not an automated one.
- `pnpm admin:navigation-smoke` (see the ops guide §10) exercises this
  contract against a real server and real browser on every run: full sidebar
  navigation with zero unexpected 401s, refresh persistence, a real
  invalid-token single-logout, 5 concurrent marked-401s producing exactly one
  clear/event, and one live unmarked-business-404 non-invalidation check.
