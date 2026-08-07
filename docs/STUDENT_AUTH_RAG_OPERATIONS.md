# Student Auth + RAG Operations Guide (Phase 6)

Scope: the student app (`apps/AI-Stu-R1`), its standalone server
(`server/stu-api.ts`), the Google OAuth student session, and the scoped
Cerebras RAG question endpoint. Phase 6 integration branch:
`agent/student-rag-release-gate`.

## 1. Google OAuth local setup

Student login is **Google OAuth only**. There is no name/password login; the
server-side session is the single source of truth for identity.

1. Create OAuth credentials in Google Cloud Console (Web application).
2. Add the authorized redirect URI:
   `http://127.0.0.1:<port>/api/student/auth/google/callback`
   (or the HTTPS origin in staging/production).
3. Export the environment for the student server:

   | Variable | Purpose |
   | --- | --- |
   | `STUDENT_GOOGLE_AUTH_ENABLED` | `true` to enable the OAuth routes |
   | `GOOGLE_CLIENT_ID` | OAuth client id |
   | `GOOGLE_CLIENT_SECRET` | OAuth client secret (server-only) |
   | `GOOGLE_REDIRECT_URI` | must match the registered redirect URI |
   | `GOOGLE_AUTHORIZATION_ENDPOINT` | defaults to Google; override for fixtures |
   | `GOOGLE_TOKEN_ENDPOINT` | defaults to Google; override for fixtures |
   | `GOOGLE_USERINFO_ENDPOINT` | defaults to Google; override for fixtures |

4. The login flow is `GET /api/student/auth/google/start?returnTo=<path>` →
   Google consent → `GET /api/student/auth/google/callback` → session cookie →
   redirect to profile completion or the requested page. PKCE is enforced
   (`code_challenge` on start, verifier kept server-side encrypted) and the
   OAuth `state` is one-time-use.

Deterministic smoke fixture: the smoke gates run a fake provider whose
`/authorize` immediately redirects back with a fixed code; see
`scripts/student-smoke-harness.ts`. Never point the fixture at production.

## 2. Student session configuration

| Variable | Purpose |
| --- | --- |
| `STUDENT_SESSION_SECRET` | ≥32-char secret used to sign/hash session tokens |
| `STUDENT_ALLOWED_ORIGINS` | comma-separated origins allowed for mutating calls |
| `STUDENT_SESSION_TTL_MS` | session lifetime in milliseconds |
| `STUDENT_AUTH_DB_PATH` | SQLite file holding `student_sessions`, OAuth states, profiles |

Session cookie: `ai_student_session`, `HttpOnly`, `Secure`, `SameSite=Strict`.
Browsers can never read or forge it; the UI derives identity exclusively from
`GET /api/student/auth/me`. Logout revokes the session row, so replaying an
old cookie fails. Expired sessions return `401` from every
`/api/student/*` endpoint and the SPA routes back to `/login`.

## 3. Profile completion flow

After the first successful OAuth login the session exists but the profile is
incomplete:

- `GET /api/student/auth/me` → `authenticated: true`, `profileCompleted: false`
- protected learning endpoints (`/api/student/books`, RAG ask, …) answer `403`
- the SPA routes to `/profile-completion` (display name, school, grade)
- `PATCH /api/student/auth/profile` completes the profile → `200`
- afterwards protected endpoints answer normally and the SPA enters `/dashboard`

## 4. Cerebras credential setup

| Variable | Purpose |
| --- | --- |
| `STUDENT_RAG_PROVIDER` | `fake` (deterministic, default in smoke) or `cerebras` |
| `CEREBRAS_API_KEY` | Cerebras API key (server-only, never shipped to browser) |
| `CEREBRAS_BASE_URL` | optional override; SSRF-guarded (see §6) |
| `CEREBRAS_MODEL` | model id used for generation |
| `STUDENT_RAG_FAKE_MODE` | `grounded` (default), or failure injection: `invalid_citation`, `weak_source`, `partial_unsupported`, `unsupported_number`, `evidence_quote_tamper` |

The browser never talks to Cerebras. All provider calls happen inside the
student server through the provider-neutral LLM port.

## 5. RAG indexing / rebuild

Retrieval in the standalone student server is served from the synced
`student.db` (`books`, `book_chapters`, `book_contents`, `book_files`).
Rebuild procedure:

1. Admin ingests/rebuilds a book (content extraction + chapter table).
2. Publish the book (`status = 'published'`); unpublished books are invisible
   to the student data source.
3. Sync the database to the student host (`deploy/scripts/sync-student-db.sh`)
   and restart/reload the student service.

No client-side index exists; there is nothing to rebuild on the student host.

## 6. RAG HTTP contract

Endpoint: `POST /api/student/books/:bookId/rag-ask`

- Guarded by the student session middleware: **401** without a valid session,
  **403** with an incomplete profile, **404** for unknown/unpublished books.
- Request body (contract `studentRagAskRequestV1`): `{ query, conversationId? }`.
  Any `studentId`/`scope` fields in the body are **rejected (400)** — the
  server derives `studentId` from the session and `bookId` from the route.
- Response (contract `studentRagAskResponseV1` from `@ai-smartbook/contracts`):
  grounded answers carry `grounding: "verified"` plus citations validated by
  the citation validator; without retrievable evidence the server answers
  `abstained: true` (fail-closed).
- Claim-level grounding (Grounding Hardening, Issue #12): responses carry an
  optional `claims` array (per-claim `supported|unsupported` verdicts with
  `answerStart`/`answerEnd` UTF-16 offsets into `answer`) and
  `unsupportedClaimCount`. `grounding` values:
  - `verified` — every claim is backed by cited, in-scope evidence;
  - `unverified` — at least one claim is unsupported (partial-source);
    `unsupportedClaimCount > 0` and the `claims` array locate the gaps;
  - `abstained` — no retrievable evidence (`NO_EVIDENCE`) or the validator
    could not establish support (`INSUFFICIENT_EVIDENCE`).
- Evidence integrity: each citation/claim may carry `evidenceQuote` and a
  `contentHash` (sha256, domain-separated). The server re-derives hashes from
  the actual retrieved chunk span and **never trusts model-supplied hashes**.
  A quote that is not a chunk substring, a mismatched hash, or a span/quote
  disagreement is treated as tampering and fails closed (502
  `RAG_CITATION_INVALID`) — it is not downgraded to a soft partial.
- Generator confidence (`high|medium|low`) is advisory only: the independent
  `GroundingValidator` port decides the verdict and the generator can never
  override it (disagreement resolves to the validator, fail-closed).
- Errors map to `RagApplicationError` codes, e.g. `RAG_INJECTION_BLOCKED`
  (400), `RAG_CITATION_INVALID` (502), provider unavailable (503/502).

Pipeline order: session → profile → book access → scope build → prompt
injection screening → retrieval → generation → citation validation →
independent claim-level grounding validation → contract response. The route
delegates to `RagApplicationService`; it never re-implements prompting,
retrieval, citation, or grounding logic.

## 7. Scope isolation

Every retrieval runs inside a structured scope
`{ studentId, bookId, institutionId? }` built from the server session and the
route parameter — never from the request body. Enforced properties:

- a student asking about book A cannot retrieve book B chunks (cross-book
  queries abstain);
- body-supplied `studentId`/scope overrides are rejected with 400;
- the retriever refuses to run without a scope;
- citations referencing chunks outside the scope fail validation and the
  request fails closed (502).

Covered by `packages/ai` scope tests and `scripts/rag-smoke.ts`.

## 8. Cerebras baseUrl SSRF protection

`CEREBRAS_BASE_URL` overrides are validated at the adapter boundary and fail
closed: HTTPS-only, no `localhost`/loopback/RFC1918/link-local/metadata
hosts, no userinfo URLs, restricted ports, and no DNS-rebinding-friendly
inputs. Even though no UI currently sets the base URL, the guard applies at
the adapter boundary so future configuration paths stay safe.

## 9. Prompt injection limitations

Injection screening blocks obvious takeover attempts and isolates book
context in the prompt, but it is a deterrent, not a proof. Limitations:

- novel/obfuscated jailbreaks may slip through screening;
- the screen judges the query, not multi-turn conversations; keep
  `conversationId` handling server-side and stateless per request;
- fail-closed only guarantees *no fabricated citations*, not semantic safety.
Treat provider output as untrusted content in the UI (citations render only
validator-approved entries).

## 10. Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| `401` on every `/api/student/*` call | session expired/revoked — re-login; check `STUDENT_SESSION_TTL_MS` |
| `403` after login | profile incomplete — finish `/profile-completion` |
| callback returns `OAUTH_STATE_INVALID` | state replayed or expired — start a fresh login; do not refresh the callback URL |
| `redirect_uri_mismatch` at Google | `GOOGLE_REDIRECT_URI` ≠ registered URI |
| RAG `503 provider-unavailable` | Cerebras key/base URL wrong or rate-limited; switch `STUDENT_RAG_PROVIDER=fake` to isolate |
| RAG abstains for a real question | book not published / content not synced / query outside book scope |
| browser console 404 `/api/appearance-settings` | student server older than Phase 6 — update `stu-api` |

## 11. Rollback

1. The integration branch is a Draft PR; **do not merge** until Claude's
   final re-acceptance passes. Rollback = keep `main` as-is.
2. If already deployed: redeploy the previous student bundle/server tag,
   restore the previous `student.db` backup, and restart the service.
3. Session data is additive (`student_sessions`); reverting the schema is
   unnecessary — old servers ignore the new tables.
4. Keep `CEREBRAS_API_KEY` out of any rollback artifact; rotate if it ever
   appeared in logs.

## 12. Known limitations

- Standalone student server serves outline from the chapter table only
  (manual TOCs / split-JSON indexes stay on the admin origin).
- Appearance settings on the standalone student server answer schema
  defaults; authored appearance is served by the admin origin.
- `book-core` still lists legacy `ai`/`db` dependencies (boundary check
  warns but does not fail); tracked for a later cleanup.
- RAG smoke uses a deterministic fake provider; live Cerebras verification
  requires approved credentials (see §13).

## 13. Verified / Blocked / Not Attempted

| Item | Status |
| --- | --- |
| Single real student login (OAuth + PKCE + one-time state) | VERIFIED (unit + auth smoke) |
| Dashboard/books/book-detail server session gating | VERIFIED (negative integration tests + browser smoke) |
| Forged `localStorage` identity rejected | VERIFIED (UI router integration test) |
| Session expiry / logout revocation replay fails | VERIFIED (auth smoke + browser smoke) |
| RAG route scope injection + body override rejection | VERIFIED (rag smoke) |
| Cross-book retrieval abstains | VERIFIED (rag smoke) |
| Unknown citation fail-closed | VERIFIED (fake provider injection mode) |
| Evidence quote/hash tamper fail-closed | VERIFIED (rag smoke `evidence_quote_tamper` + unit tests) |
| Claim-level `verified` (all claims supported) | VERIFIED (rag smoke grounded mode) |
| Weak-source claim downgraded to `unverified` (partial) | VERIFIED (rag smoke `weak_source`) |
| Unsupported numeric claim → partial + riskCategory=number | VERIFIED (rag smoke `unsupported_number`) |
| Generator/validator disagreement → validator verdict (fail-closed) | VERIFIED (application unit tests) |
| Validator failure/timeout → abstained, never verified | VERIFIED (application unit tests) |
| Server re-derives evidence hashes (model hashes ignored) | VERIFIED (application unit tests) |
| Prompt injection block | VERIFIED (rag smoke) |
| Cerebras baseUrl SSRF guard | VERIFIED (adapter unit tests) |
| Desktop/Tablet/Mobile browser smoke, no overflow/console errors | VERIFIED (dashboard smoke, 3 viewports) |
| Live Google OAuth with production credentials | NOT ATTEMPTED (no approved credentials) |
| Live Cerebras generation | NOT ATTEMPTED (no approved credentials) |
