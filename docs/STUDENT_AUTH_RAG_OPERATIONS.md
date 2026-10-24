# Student Auth + RAG Operations Guide (Phase 6)

Scope: the student app (`apps/AI-Stu-R1`), its standalone server
(`server/stu-api.ts`), Cloudflare Access student sessions, and the scoped
Cerebras RAG question endpoint.

## 1. Cloudflare Access setup

The student login button opens `GET /api/student/auth/access/login?returnTo=<path>`.
Cloudflare Access must protect this path with **email one-time PIN only** and
forward `Cf-Access-Jwt-Assertion` to the Student API. Set these server-only
values from the Access application:

| Variable | Purpose |
| --- | --- |
| `STUDENT_ACCESS_TEAM_DOMAIN` | Access team subdomain (or full `*.cloudflareaccess.com` hostname) |
| `STUDENT_ACCESS_AUD` | Access application audience tag |

The API verifies the RS256 signature using Cloudflare's certs, exact `kid`,
issuer, audience, and time claims. Certs are cached for five minutes. Missing
or invalid assertions return 401; missing configuration or unavailable certs
return 503. `Cf-Access-Authenticated-User-Email`, `CF_Authorization`, and
`oai-*` are never identity sources. The old Google start and callback routes
return 404. Existing Google users are linked by a case-insensitive,
trimmed verified email only when exactly one row matches. Duplicate matches
return 403 `ACCESS_EMAIL_CONFLICT`; an event containing only an email digest
and match count is logged for manual resolution. No accounts are merged.

Local tests and smoke use generated RSA keys and a loopback JWKS fixture.
`STUDENT_ACCESS_CERTS_URL` is accepted only outside production for this
fixture; production always fetches the team's Cloudflare certs endpoint.

## 2. Student session configuration

| Variable | Purpose |
| --- | --- |
| `STUDENT_SESSION_SECRET` | ≥32-char server secret retained for session configuration |
| `STUDENT_ALLOWED_ORIGINS` | comma-separated origins allowed for mutating calls |
| `STUDENT_SESSION_TTL_MS` | session lifetime in milliseconds |
| `STUDENT_AUTH_DB_PATH` | SQLite file holding `student_sessions` and profiles |

Session cookie: `ai_student_session`, `HttpOnly`, `Secure`, `SameSite=Strict`.
Browsers can never read or forge it; the UI derives identity exclusively from
`GET /api/student/auth/me`. Logout revokes the session row, so replaying an
old cookie fails. Expired sessions return `401` from every
`/api/student/*` endpoint and the SPA routes back to `/login`.

## 3. Profile completion flow

After the first successful Access login the session exists but the profile is
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
  Response invariant: `grounding === "verified"` IFF
  `unsupportedClaimCount === 0`. All response fields derive from the single
  authoritative `GroundingValidator.validate()` result, which runs exactly
  once per request (safe for future LLM-backed/probabilistic validators).
- Grounding scoring (R-1): general claims are scored with localized,
  claim-length-derived token windows inside each cited chunk, so a faithful
  claim inside a hundreds-to-thousands-of-words chunk can still reach
  `verified`; chunk length no longer inflates the similarity denominator.
  Contradicting (negated) windows never count as support, and high-risk
  number/date/formula claims still require verbatim literals.
- Evidence integrity (R-2/R-4): each citation/claim may carry `evidenceQuote`
  and a `contentHash` (sha256, domain-separated). For claim evidence the
  canonical integrity model is quote-derived and client-verifiable:
  `start` = the server-located offset of the quote in the chunk,
  `end = start + quote.length`, `contentHash = hashEvidenceSpan(quote)`, so
  clients can check `hashEvidenceSpan(evidence.quote) === evidence.contentHash`
  and `chunk.content.slice(start, end) === evidence.quote`. Model-supplied
  offsets must match the server-authoritative location exactly (never
  clamped); model-supplied hashes must match the quote-derived hash. Any
  violation — quote not a chunk substring, modified quote, wrong hash,
  out-of-range/inverted/disagreeing spans, unknown or uncited evidence chunk,
  claim text missing from the answer — is treated as tampering and fails
  closed (502 `RAG_CITATION_INVALID` with a deterministic reason code such as
  `CLAIM_EVIDENCE_QUOTE_MISMATCH`, `CLAIM_EVIDENCE_HASH_MISMATCH`,
  `CLAIM_EVIDENCE_SPAN_MISMATCH`) — never downgraded to a soft partial,
  never silently dropped.
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

Clean-checkout verification order (pinned by `release-gate:student-rag`):

```bash
pnpm install --frozen-lockfile
pnpm run contracts:validate
pnpm run typecheck
pnpm run lint
pnpm run build        # MUST run before test: security-bundle tests assert built output
pnpm run test
pnpm run student:auth-smoke
pnpm run student:dashboard-smoke
pnpm run rag:smoke
```

On a clean checkout without `dist/`, the admin security-bundle test fails with
an explicit "run `pnpm build` before `pnpm test`" error instead of an opaque
assertion. Never validate against a stale local `dist/`.

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
| Access login returns `ACCESS_ASSERTION_INVALID` | Access assertion is missing, expired, or does not match issuer/audience; check the Access application and proxy header forwarding |
| Access login returns `ACCESS_UNAVAILABLE` | team domain/audience is missing or certs cannot be fetched |
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
| Student Access assertion login and server session | VERIFIED (unit + auth smoke) |
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
| R-1 localized-window grounding: faithful claims verified in 300+/1000+/2000+ word chunks (head/middle/tail) | VERIFIED (`grounding-window-matrix.test.ts`) |
| R-1 calibration: verbatim/close paraphrase supported; partial/adjacent/contradiction/single-noun unsupported | VERIFIED (`grounding-window-matrix.test.ts`) |
| R-2 claim-evidence tamper matrix fails closed (quote/hash/start/end/OOB/span/chunk/scope/format) | VERIFIED (`claim-integrity.test.ts`, HTTP 502 boundary) |
| R-3 `GroundingValidator.validate()` exactly once per request; `verified` IFF `unsupportedClaimCount === 0` | VERIFIED (`validator-once.test.ts`, alternating fake validator) |
| R-4 quote-derived `contentHash`, server-located offsets, client-verifiable invariants | VERIFIED (`claim-integrity.test.ts` property tests) |
| R-5 high-risk literals (number/percent/date/formula/equation) need verbatim evidence | VERIFIED (`grounding-window-matrix.test.ts`) |
| Clean-checkout build→test order (security-bundle error message) | VERIFIED (release gate order + explicit guard) |
| Prompt injection block | VERIFIED (rag smoke) |
| Cerebras baseUrl SSRF guard | VERIFIED (adapter unit tests) |
| Desktop/Tablet/Mobile browser smoke, no overflow/console errors | VERIFIED (dashboard smoke, 3 viewports) |
| Live Cloudflare Access email one-time PIN | NOT ATTEMPTED (Access configuration was out of scope) |
| Live Cerebras generation | NOT ATTEMPTED (no approved credentials) |
