# QM Installation and Local Run Operations Guide

## Executive Status

- **Validation State**: `CONTRACT_ONLY_ACCEPTED_RUNTIME_BLOCKED`
- **Baseline Commit (Round 3's remote head at start)**: `36e0cfb498608757f5c131ffc218fc3f45770a20`
- **Branch**: `agent/qm-feedback-platform`
- **QM CLI Baseline Version**: `@yc-software/qm@0.1.4`

All static contracts, typechecks, lint rules, boundary constraints, application smoke tests, and secret scans have **PASSED**. Container runtime startup (`qm up`) remains blocked pending external credential provision and explicit execution authorization.

Round 2 (test stabilization + lint gate fixes) resolved the 25 `explicit any` lint errors in `apps/AI-adm-D1` and the `qm-runner.test.ts` global-lock pollution under Vitest's default 5s timeout — see §7. Round 3 (independent security/contract review of the `/admin/ai-providers` QM Runtime Settings integration) found and fixed a real SSRF gap on `baseUrlOverride`, an unreachable `upstream_error` classification branch, a missing browser-side response schema validation, and a silently-skipped `packages/contracts` test suite — see §8. Round 4 fixed a real user-reported bug where admin sidebar navigation repeatedly bounced to `/admin/login` (a duplicated, out-of-sync server auth check plus an over-eager browser session-invalidation rule) — see §9. Phase 5 turned that fix's manual Chrome verification into a repeatable `pnpm admin:navigation-smoke` regression gate and performed a final cross-layer audit of the auth contract and the QM/API-key boundary — see §10.

---

## 1. Environment & Preflight Inventory

The preflight check verified environment parity prior to executing validation tasks:

| Item | Expected / Observed | Status |
| :--- | :--- | :--- |
| **Git Branch** | `agent/qm-feedback-platform` | PASS |
| **Git Baseline** | `453e3f5be8350862a038a819cc2069d0773c8375` | PASS |
| **Git Working Tree** | Clean (0 uncommitted changes) | PASS |
| **Node.js** | `v22.22.2` | PASS |
| **npm** | `10.9.7` | PASS |
| **pnpm** | `11.4.0` | PASS |

---

## 2. Latest QM CLI Scaffolding Compatibility Check

An isolated scaffolding check was performed in a unique temporary directory (`/tmp/ai-quest-a1-qm-latest.E0HcNa`) using `@yc-software/qm@latest`:

1. **CLI Version**: `0.1.4`
2. **Help Documentation Log**: Captured to `/tmp/qm-latest-help.log`. Confirmed presence of standard operator commands:
   - `init`, `setup`, `up` (`--dry-run`), `plan`, `check`, `doctor`, `conformance`, `status`, `logs`, `down`, `rollback`, `sandbox build`, `sandbox publish`.
3. **Scaffold Execution**: `qm init . --org ai-quest-a1 --target docker` exited with `0`.
4. **Scaffold Inventory**:
   - `package.json` (declares `@yc-software/qm@0.1.4`, Node engines `>=24.0.0`)
   - `qm.config.jsonc` (contract v1, `target: docker`, `modelProvider: anthropic`)
   - `.env.example`, `.env`, `.gitignore`
   - `AGENTS.md`, `deployment.md`
   - `.codex/skills/deploy-qm/`
   - `slack-app-manifest.yml`
   - `sandbox/skills/greet/` & `sandbox/tools/example-tool/`

---

## 3. Pinned Baseline (0.1.4) Contract & Doctor Validation

The project's pinned baseline in `deploy/qm` was verified against version `0.1.4`:

```bash
cd deploy/qm
npm ci
npm ls @yc-software/qm --depth=0
# Output: @yc-software/qm@0.1.4
```

Verification of dependency locks (`git diff --exit-code -- deploy/qm/package.json deploy/qm/package-lock.json`) confirmed `0` changes.

### Validation Gate Output (`pnpm run qm:validate`)

```text
Validating QM deployment with @yc-software/qm@0.1.4
Contract PASS
Doctor ENVIRONMENT BLOCKED
Overall exit 1
Deployment attempted No
Real credentials used No
```

- **Contract Status**: `PASS` (Schema, layout, and configuration syntax conform to Specification v1).
- **Doctor Status**: `ENVIRONMENT BLOCKED` (Expected result due to missing production/provider credentials in non-runtime environment).
- **Exit Code**: `1` (Recorded as expected).

---

## 4. Application Gate Verification Results

All local repository gate scripts were executed:

```bash
pnpm install --frozen-lockfile
pnpm run typecheck                    # PASS (13 workspace projects)
pnpm run typecheck:release-scripts    # PASS
pnpm run lint                         # PASS (13 workspace projects, 0 errors, 0 warnings)
pnpm run lint:release-scripts         # PASS (8 scripts checked, 0 errors, 0 warnings)
pnpm run build                        # PASS
pnpm run test                         # PASS (82 test files, 1132 unit/integration tests) — see §8, §9
pnpm run admin:navigation-smoke       # PASS (real headless Chrome, 11 routes x 3 rounds) — see §10
pnpm run qm:smoke                     # PASS (submission -> draft -> review -> publish)
node scripts/qm-browser-boundary.mjs                       # PASS (root, server-free browser boundary)
(cd apps/AI-Stu-R1 && node ../../scripts/qm-browser-boundary.mjs)  # PASS (apps/AI-Stu-R1, server-free browser boundary)
git diff --check                      # PASS (no whitespace or formatting errors)
```

`apps/AI-adm-D1` breakdown within the totals above: 25 test files, 252 tests passed (0 failed). See §7 for the fixes that took this from `pnpm run lint` FAIL (25 `explicit any` errors) and `pnpm run test` 248 passed / 2 failed to the fully green state recorded here.

---

## 5. Security & Secret Scan

A filename-only scan was conducted to ensure no secrets or API keys are exposed or tracked:

```bash
find deploy/qm -type f -not -path '*/node_modules/*' -not -path '*/runtime/*' \
  -exec grep -IlE 'sk-(ant|proj|or)-[A-Za-z0-9_-]{20,}|Bearer[[:space:]]+[A-Za-z0-9._-]{20,}' {} +
```

- **Exposed Secret Files**: `0` (clean scan).
- **Tracked `.env` Check**: Confirmed `deploy/qm/.env` is ignored by `.gitignore` and not tracked by Git (`git ls-files deploy/qm/.env` returned empty).

---

## 6. Distinguishing Operational System Layers

To ensure clear operational boundaries, the system components are separated into distinct layers:

```
+-------------------------------------------------------------------------+
| Layer 1: Latest CLI Compatibility Check                                 |
| Isolated mktemp directory; tests CLI scaffolding & command availability |
+-------------------------------------------------------------------------+
                                    |
                                    v
+-------------------------------------------------------------------------+
| Layer 2: Pinned 0.1.4 Contract / Doctor Validation                      |
| Validates qm.config.jsonc schema & environmental credential readiness   |
+-------------------------------------------------------------------------+
                                    |
                                    v
+-------------------------------------------------------------------------+
| Layer 3: AI_Quest_A1 Application Smoke & Unit Tests                     |
| Verifies state transitions (draft -> review -> publish) & browser boundary|
+-------------------------------------------------------------------------+
                                    |
                                    v [DECISION GATE: STOPPED HERE]
+-------------------------------------------------------------------------+
| Layer 4: QM Deployment Runtime (qm up)                                  |
| Docker container instantiation (Core, Web UI, Sandbox)                  |
+-------------------------------------------------------------------------+
                                    |
                                    v
+-------------------------------------------------------------------------+
| Layer 5: Live Model Inference                                           |
| External API calls to Anthropic / OpenAI providers                      |
+-------------------------------------------------------------------------+
                                    |
                                    v
+-------------------------------------------------------------------------+
| Layer 6: Admin QM Status API                                            |
| Live health probing and status endpoints                                |
+-------------------------------------------------------------------------+
```

1. **Latest CLI Compatibility Check**: Evaluates `@yc-software/qm@latest` scaffolding capabilities in an isolated scratch directory without affecting the repository.
2. **Pinned 0.1.4 Contract/Doctor Validation**: Verifies local deployment manifests against contract v1 constraints.
3. **AI_Quest_A1 Application Smoke**: Evaluates application code, mock flows, and unit tests independently of external containers.
4. **QM Deployment Runtime**: Manages Docker/Fly/AWS container instances (`qm up`). Requires external credentials and explicit operator approval before execution.
5. **Live Model Inference**: Facilitates live model interactions via provider API keys.
6. **Admin QM Status API**: Exposes runtime status and telemetry endpoints once containers are active.

---

## 7. Round 2 — Test Stabilization & Lint Gate Fixes

Starting state for this round (remote head `453e3f5`):

- `pnpm run lint` FAIL: ~25 `explicit any` errors in `apps/AI-adm-D1`, concentrated in `qm-status-api.test.ts` and `qm-runner.test.ts`.
- `pnpm run test` FAIL: 248 passed / 2 failed. `qm-runner.test.ts`'s concurrent-lock tests called the real `runValidate()`/`runSmoke()` against the installed `deploy/qm/node_modules/.bin/qm` binary; the runner's own 30s subprocess timeout outlasted Vitest's 5s default test timeout, leaving the module-level operation lock held and causing the next test to fail with `QmOperationBusyError`.

### Runner dependency-injection design

`apps/AI-adm-D1/src/server/ai/qm-runner.ts` now exposes `createQmRunner(overrides?: Partial<QmRunnerDependencies>): QmRunner`, where:

```ts
type QmRunnerDependencies = {
  spawnCapture: typeof spawnCapture; // real child_process spawn + capture
  existsQmBin: () => boolean;        // QM binary presence check
  readQmCliVersion: () => string;    // pinned CLI version from deploy/qm/package.json
  now: () => string;                 // ISO timestamp for checkedAt
};
```

- Each `createQmRunner()` call owns its own `cachedStatus`/`runningOperation` closure state — the lock is no longer a module-level global, so tests cannot pollute each other even without the DI boundary.
- The exported `runValidate`, `runSmoke`, `getCachedQmStatus` are bound to a single production singleton (`createQmRunner()` with no overrides), which still uses the real `spawnCapture`, `existsSync(QM_BIN)`, `readFileSync`-based version read, and `Date.now()`-based clock — no behavior change for the app.
- Unit tests call `createQmRunner({ spawnCapture: <stub> })`, where the stub hands back a `Deferred<SpawnCaptureResult>` per invocation. Tests resolve/reject those deferred promises explicitly and use a microtask-flush helper (`while (calls.length <= index) await Promise.resolve()`) to wait for the runner's second `spawnCapture` call (the `doctor` step) to be issued — no real timers, no `sleep`, no increased Vitest timeout.
- Coverage added: (1) duplicate `runValidate()` rejects synchronously with `QmOperationBusyError` before any spawn settles; (2) `runValidate`/`runSmoke` share one lock; (3) lock releases after a resolved operation; (4) lock releases after a rejected/thrown operation; (5) lock releases after a simulated subprocess timeout/process failure; (6) `existsQmBin() === false` short-circuits without calling `spawnCapture` at all.

### explicit any cleanup

- `qm-runner.test.ts`: `(clause as any).names` → `Object.prototype.hasOwnProperty.call(clause as unknown as Record<string, unknown>, "names")`.
- `qm-status-api.test.ts`: rewritten with a typed harness — `RequestHandler | undefined` route lookups guarded by an `assertDefined` type-narrowing helper before invocation, a `Request`/`Response` fake built with a single `as unknown as Express/Request/Response` cast (not `any`), and response bodies read as `unknown` then narrowed with a `hasStringField` type guard. No file-wide or block lint-disable was added. The pre-existing unauthenticated-request test was removed as a full duplicate of `admin-auth.test.ts` (unit-level) and `qm-status-http.test.ts` (real HTTP 401/403 round trip); the GET/validate-success/smoke-409 cases were kept since they exercise `registerQmStatusRoutes` directly and are not otherwise covered.

### Targeted verification

```bash
pnpm --filter AI-adm-D1 run lint
# lint: 83 TypeScript source files checked; 0 error(s), 0 warning(s)

pnpm --filter AI-adm-D1 exec vitest run \
  src/server/ai/qm-runner.test.ts \
  src/server/ai/qm-status-api.test.ts
# Test Files  2 passed (2) — Tests  31 passed (31)
```

10x repeat of `qm-runner.test.ts` alone (flakiness / stray-subprocess check): **10/10 passed**, 28 tests each run, ~0.4s per run (down from a run that could hang to Vitest's 5s timeout per lock test).


---

## 8. Round 3 — Independent Security/Contract Review of QM Runtime Settings

Starting state for this round (remote head `36e0cfb`): the `/admin/ai-providers` → QM Runtime Settings integration (contracts, fail-closed service, admin routes, browser card, per-run secret isolation scaffolding, 42 new tests) was already merged to the branch. This round performed an independent review per the task's checklist (API key handling, fail-closed re-validation, SSRF surface, error-code/HTTP/contract consistency, test-endpoint timeout/abort/redaction, HTTP/UI acceptance) and fixed everything it found — it was not a text-only review.

### Findings and fixes

1. **SSRF via `baseUrlOverride` (real gap, fixed).** The field was validated with `z.string().url()` plus an `http(s)://` prefix check only — `http://127.0.0.1/`, `http://169.254.169.254/latest/meta-data/` (cloud metadata), RFC1918 private ranges, CGNAT, and `localhost` all passed. Added `isSafeQmBaseUrl` (`packages/contracts/src/qm-runtime-config.ts`) — a dependency-free scheme/host parser (no `URL` global, so the package stays ambient-lib-free and browser-bundlable) that blocks loopback, RFC1918/CGNAT private ranges, link-local (including the 169.254.169.254 metadata endpoint), IPv4-mapped-IPv6 equivalents, and well-known metadata hostnames. Wired into both the Zod schema (`qmRuntimeConfigSchema`, rejects at PUT time) and `resolveQmRuntimeConfig` (defense in depth for any already-persisted value). 6 new contract-level tests + 1 new service-level test + a live reproduction: submitted the payload through a real logged-in Chrome session against the running dev server — the UI showed `Invalid QM runtime config` and a follow-up `GET` confirmed `baseUrlOverride` was still `null` in the database.
2. **`upstream_error` was unreachable (real bug, fixed).** In `runQmRuntimeConfigTest`, the internal `upstreamRequestSent` flag was only assigned after a successful probe resolve, so any post-dispatch failure was always misreported as `local_validation_failed`. Added an `isUpstreamRequestSent` side-channel option so the route's dispatch-tracking carrier (set the instant the adapter fires its request) is consulted on the catch path too. New test exercises the previously-dead branch and asserts the thrown error's message/stack/body never leaks into the safe result.
3. **Runtime-config responses were not Zod-validated in the browser (real gap, fixed).** `adminApi.getQmRuntimeConfig` / `saveQmRuntimeConfig` / `testQmRuntimeConfig` trusted the HTTP body via a bare `body as T` cast — unlike the QM status endpoints, which already validate with `qmStatusResponseSchema`. Added `qmRuntimeConfigViewResponseSchema` / `qmRuntimeConfigSaveResponseSchema` to contracts and wired all three calls through the existing `schema.safeParse` path in `api.ts`'s `http()` helper. Removed `AiProvidersPage.tsx`'s redundant local `QmRuntimeConfigView` type and `as QmRuntimeConfigView` cast in favor of the real, now-validated contract type.
4. **`packages/contracts` tests were never run by the gate (real gap, fixed).** The package has 3 test files (`qm-status.test.ts`, `qm-runtime-config.test.ts`, `feedback.test.ts`) but no `"test"` script, so `pnpm run test` (`pnpm -r --if-present test`) silently skipped all of them — including the new SSRF coverage above. Added `"test": "vitest run"` to `packages/contracts/package.json`. This is also why the workspace test total moves from 1037/1038 (previous rounds, contracts excluded) to 1118 (contracts now included, plus this round's new cases).
5. **PUT input sanitization — verified, not a gap.** Added an explicit test confirming `apiKey`/`command`/`args`/`cwd` fields submitted in a PUT body are stripped by the non-strict Zod object schema before `save()` is ever called (`qm-runtime-config-http.test.ts`).
6. **Per-run secret isolation (A2) and fail-closed re-validation (A3) — reviewed, already correct.** `buildQmRunEnv`/`buildIsolatedRunSecretEnv` never read or mutate the shared `process.env` and are covered by existing isolation tests; GET/PUT/test all call `resolve()` fresh against live provider/credential state on every request (no caching), confirmed by reading the route code and the existing post-save-disable/cooldown/cross-provider/model-invalid test coverage.

### HTTP/UI acceptance (real, not just helpers)

- Started the actual `apps/AI-adm-D1` server (`tsx src/server/index.ts`, port 4300) and Vite dev server (port 5174) locally.
- `curl` against the live server confirmed: 401 with no token, 403 with a disallowed origin, 200 with the dev password, and 400 (`QM_RUNTIME_CONFIG_INVALID`) for the SSRF payload — matching the HTTP-level test suite.
- Logged into `/admin/ai-providers` in a real Chrome session (via the dev admin password), confirmed the QM Runtime Settings card renders live provider/credential data, the masked key (`AIz****3ySE`) displays with no plaintext-key input anywhere, Provider→Credential→Model selects cascade correctly, and submitting the SSRF payload through the actual form is rejected end-to-end (`Invalid QM runtime config`) with no persistence.

### Targeted verification

```bash
pnpm --filter @ai-smartbook/contracts exec vitest run src/qm-runtime-config.test.ts   # 9 passed
pnpm --filter AI-adm-D1 exec vitest run src/server/ai/qm-runtime-config.test.ts \
  src/server/ai/qm-runtime-config-http.test.ts                                        # 36 passed
pnpm --filter AI-adm-D1 run lint                                                      # 91 files, 0 errors
pnpm --filter AI-adm-D1 exec tsc --noEmit                                             # clean
```

Full gate re-run after all fixes: typecheck / typecheck:release-scripts / lint / lint:release-scripts / build / qm:smoke / `node scripts/qm-browser-boundary.mjs` (root + `apps/AI-Stu-R1`) / `npm exec @yc-software/qm@0.1.4 -- qm --help` / `git diff --check` all **PASS**; `pnpm run test` **PASS 1118/1118** across 82 files; `pnpm run qm:validate` returns Contract PASS / Doctor ENVIRONMENT BLOCKED / exit 1 (expected, no real credentials, no deployment attempted); filename-only secret scan found 0 exposed files and `deploy/qm/.env` remains untracked.

`qm up` was **not** executed. No cloud resources were created. No credentials, real or placeholder, were added. Final verdict remains `CONTRACT_ONLY_ACCEPTED_RUNTIME_BLOCKED`.

---

## 9. Round 4 — Admin Navigation Login-Bounce Fix

Starting state for this round (remote head `69b02b2`): a real user report that switching between `/admin/*` sidebar sections repeatedly bounced back to `/admin/login`, forcing repeated re-login, even with a valid dev-password session. Chrome Network evidence showed `ai-evaluation-alerts`, `retention`, `governance`, `settings`, `live-readiness`, and `production-readiness` returning 401 while `ai-providers`/`runtime-config`/`credentials` succeeded in the same window.

### Root cause

Two independent, additive defects:

1. **Server — duplicated auth policy.** `apps/AI-adm-D1/src/server/index.ts`'s route-local `requireAdminAccess()` guard (called by every evaluation/governance/pilot/analytics route) re-implemented its own token comparison against only the production `ADMIN_API_TOKEN`, ignoring the non-production dev-password fallback that the canonical `/api/admin` middleware (`createAdminAuthMiddleware`) already accepted. A valid dev-password login therefore passed the global boundary but was rejected by this second, stricter, out-of-sync guard on every route that called it — reproduced live via `git stash` (pre-fix: 401 on the affected routes; post-fix: 200 on all of them).
2. **Browser — over-eager session invalidation.** `apps/AI-adm-D1/src/adminAuth.tsx`'s fetch interceptor treated *any* same-origin `/api/admin/*` 401 as "session expired" and cleared the token immediately, so the first false-positive 401 from defect 1 logged the user out everywhere, even on tabs/routes that never made the failing call.

### Fixes

- `apps/AI-adm-D1/src/server/ai/admin-auth.ts`: extracted the single canonical accepted-secret check (`isAcceptedAdminToken`), a shared candidate-token reader (`candidateAdminToken`), and the exact safe-failure response (`sendAdminAuthRequired`, which sets `code: "ADMIN_AUTH_REQUIRED"` and the `X-Admin-Auth-State: invalid` header) as the one source of truth both the global middleware and `requireAdminAccess` now call.
- `apps/AI-adm-D1/src/server/index.ts`: `requireAdminAccess` rewritten to delegate entirely to the shared policy — no more hand-rolled comparison.
- `apps/AI-adm-D1/src/adminAuth.tsx`: the interceptor now clears the session only when **all four** hold: a token was actually dispatched with the request, the response is 401, the response carries the `ADMIN_AUTH_REQUIRED` marker (header or body code — business 401s never carry it), and `getAdminToken()` still equals the dispatched token at the moment of the check (checked before and after the async marker read). This same token-snapshot check makes concurrent marked-401s single-flight without an extra dedupe flag, and rejects a late/stale response for a token that a fresh login has already superseded.

### Real HTTP/Chrome acceptance

`curl` against the live (pre-fix vs. post-fix, via `git stash`/`git stash pop`) server reproduced and then resolved the exact 8-endpoint symptom set; a wrong dev password returns `401` with `X-Admin-Auth-State: invalid` and `code: ADMIN_AUTH_REQUIRED`. In real Chrome: logged in, then performed 3 full rounds of navigation across all 10 sidebar sections with **zero 401s** observed on any `/api/admin/*` call; manually corrupted the stored token via `sessionStorage.setItem` and confirmed exactly one logout/redirect to `/admin/login`.

### Targeted verification

`adminAuth.test.ts` (browser) gained 15 tests covering: marked-401-via-header/-via-body-code clears the session; unmarked business 401 and parameterized 403/409/422/500 responses do not; a no-token marked-401 does not clear an unrelated session; a stale token's late 401 does not clear a freshly-logged-in token; 10 concurrent marked 401s produce exactly one clear and one event; a wrong-password login probe does not clear a different, still-valid session; `Request` object vs. string-URL calls preserve method/body/signal. `admin-auth.test.ts` (server) gained 2 tests for the `ADMIN_AUTH_REQUIRED` code/header pairing and its absence on the unconfigured-production 503. Full gate: **PASS 1132/1132** across 82 files (up from 1118 — 15 browser + 2 server new tests, minus none removed).

`qm up` was **not** executed in this round either. Final verdict remained `CONTRACT_ONLY_ACCEPTED_RUNTIME_BLOCKED`.

---

## 10. Phase 5 — Admin Navigation Regression Automation & Final Cross-Layer Audit

Starting state for this round (remote head `e065741`): Round 4's fix was verified only by a one-off manual real-Chrome session. This round turns that manual evidence into a repeatable, unattended regression gate, and performs a final cross-layer audit of everything landed today (QM Runtime Settings, API-key boundary, and the Round 4 auth-contract fix) before handoff.

### A. `pnpm admin:navigation-smoke`

`scripts/admin-navigation-smoke.mjs` (registered as `pnpm admin:navigation-smoke`) is a self-contained, dependency-free (Chrome DevTools Protocol over the platform `WebSocket` global — no Playwright/Puppeteer added) regression smoke that:

1. Spawns an isolated Admin API instance (`tsx src/server/index.ts`) on a dedicated port against a fresh temporary SQLite file (`SQLITE_PATH`), and an isolated Vite dev server on a dedicated port — both distinct from the conventional dev ports so the smoke never collides with (or reads/writes) a real local dev session or its database. Readiness is polled over HTTP (`/api/appearance-settings`, `/`), never a fixed sleep.
2. Sets `ADMIN_ALLOWED_ORIGINS` to its own isolated web origin so the admin API's CORS/origin boundary (`admin-origin.ts`, otherwise hardcoded to the conventional port 5174) accepts it, and unsets `ADMIN_API_TOKEN` for the child process only (never touching the invoking shell's `process.env`) so the isolated server runs the same dev-password path exercised throughout this branch's testing.
3. Launches headless Chrome via raw CDP and logs in through the real `/admin/login` form using the local dev password (never printed, logged, or written to the JSON artifact — only pass/fail booleans and status codes are recorded).
4. Drives the same browser tab through all 11 current `AdminSidebar` routes, 3 full rounds, clicking the real sidebar `<a>` elements (not URL-bar navigation) so it exercises the same client-side route-switch path as the original bug report.
5. Every navigation waits for the page to be free of a loading indicator **and** for the fetch interceptor's install marker to be present on the current document — the latter closes a real race discovered while stabilizing this script: Vite's dev client can trigger its own `location.reload()` (e.g. right after first-run dependency pre-bundling) independently of any reload the script initiates, and checking only `document.readyState` can observe the outgoing document mid-teardown.
6. Asserts, from captured `Network.responseReceived` events, zero `ADMIN_AUTH_REQUIRED`-marked and zero unexpected 401 responses across all `/api/admin/*` traffic during the valid-session phase, and that the session token is still present after the full sweep.
7. Reloads 2 representative pages (`/admin/ai-providers`, `/admin/qm-status`) and confirms the session survives a hard refresh.
8. Fires a real POST to a non-existent alert's acknowledge endpoint (a genuine, unmarked business `404` from live server code, not a mock) and confirms it does **not** clear the session — the full `401/403/409/422/500`-non-invalidation matrix is exhaustively parameterized at the unit level in `adminAuth.test.ts` (§9); this live check adds one real end-to-end confirmation on top, since deterministically producing each of 403/409/422/500 from the real server requires seeded fixture rows a fresh smoke database does not have.
9. Corrupts the stored token, fires 5 concurrent requests to distinct real admin endpoints, and asserts all 5 return a marked 401, exactly **one** `ai-quest:admin-auth-expired` event fires (no event storm), and the SPA auto-redirects to `/admin/login` exactly once.
10. Cleans up unconditionally in a `finally` block — closes the CDP socket, terminates the Chrome, Admin API, and Vite child processes (SIGTERM then SIGKILL fallback), and removes the temporary directory (SQLite file + Chrome profile) — even on failure or a thrown assertion.
11. Writes a redacted JSON artifact via the existing `writeSanitizedArtifact` helper (same secret-scanning/redaction path used by `admin-provider-ui-e2e.mjs`) and prints only route/status/pass-fail counts to stdout; never a token, password, cookie, or `Authorization`/`X-Admin-Token` header value.

If no headless Chrome binary is available, the script exits `2` (`BLOCKED`) with a redacted diagnostic rather than silently passing — it never substitutes a `happy-dom` stub for this check. In this environment Chrome is present and the smoke runs against a real browser and real server.

**Verified locally**: 10 consecutive runs, 10/10 pass, 0 leaked ports/processes after each run (`ss -ltnp` clean, temp dirs removed).

### B. Auth contract final audit

- Confirmed exactly one code path in the entire server emits a `401` (`sendAdminAuthRequired` in `admin-auth.ts`) — there is no other hand-rolled `401` anywhere in `apps/AI-adm-D1/src/server`, so "business 401 never carries the marker" holds by construction, not by convention.
- Confirmed `registerQmAdminBoundary` mounts `createAdminOriginMiddleware` then `createAdminAuthMiddleware` on `/api/admin` before any admin route is registered (`index.ts:371`, first admin route at `:1779`), so every `/api/admin/*` request passes the canonical policy at least once regardless of whether the specific route also calls the route-local `requireAdminAccess` defense-in-depth guard.
- Found and fixed one remaining minor inconsistency: `adminActorId()` (used only to derive a non-secret, one-way-hashed audit-log actor id — never an authentication decision) read `x-admin-token`/`authorization` directly instead of the shared `candidateAdminToken()` reader, so an `Authorization: Bearer ...` caller's audit hash included the literal `"Bearer "` prefix while `x-admin-token` callers did not. Switched it to `candidateAdminToken(req)` for a single consistent source. Not a security gap (nothing was bypassable), just a latent inconsistency.
- Re-ran `apps/AI-adm-D1`'s full suite after the change: 319/319 tests pass, no regression.

### C. QM / API-key boundary final audit

Re-confirmed, by reading the current code and re-running its dedicated tests (not by re-trusting the Round 3 writeup):

- `qmRuntimeConfigPublicViewSchema` (the only shape the browser ever receives) exposes `maskedApiKey: z.string().nullable()` and no plaintext key field.
- `QM_RUNTIME_CONFIG_ERROR_CODES` still lists exactly the 9 fail-closed codes end to end.
- `isSafeQmBaseUrl` SSRF guard is still wired into both the Zod schema (reject at PUT) and `resolveQmRuntimeConfig` (defense in depth at read/test time).
- `packages/contracts` and `apps/AI-adm-D1`'s QM runtime-config test suites (48 tests across `qm-runtime-config.test.ts`, `qm-runtime-config-http.test.ts`, `qm-status-api.test.ts`, and the contracts package's own suite) all pass unchanged.

No gaps were found in this pass; nothing in Round 4's auth fix touched the QM secret/SSRF boundary, so this section is a confirmation, not a remediation.

### D. Verified / Blocked / Not-attempted matrix

| Layer | State | Evidence |
| :--- | :--- | :--- |
| Contract (`qm.config.jsonc` schema) | **Verified** | `qm:validate` → Contract PASS |
| Doctor (7 runtime secrets) | **Blocked** | `qm:validate` → Doctor ENVIRONMENT BLOCKED, exit 1 (expected — no real credentials provisioned) |
| Admin UI — QM Runtime Settings card, provider/credential/key masking | **Verified** | Round 3 real Chrome session + this round's contract re-check |
| Admin UI — sidebar navigation session stability | **Verified** | `pnpm admin:navigation-smoke`, 10/10 real-Chrome runs, plus the one-off manual session in §9 |
| Admin auth contract (`ADMIN_AUTH_REQUIRED` marker, single-clear, no event storm) | **Verified** | `adminAuth.test.ts`/`admin-auth.test.ts` unit suites + live concurrent-401 assertion in the navigation smoke |
| QM Core API, Web UI, Session, Sandbox, Memory, Files | **Not attempted** | `qm up` never executed; these layers do not exist without a running container |
| Real model inference (Anthropic/OpenAI/etc.) | **Not attempted** | No live credentials configured; `mock`/`local-feedback-fixture` providers only |

### Full gate re-run

`pnpm typecheck`, `typecheck:release-scripts`, `lint`, `lint:release-scripts`, `build`, `test` (1132/1132, unchanged from §9 — no test count regression from this round's server audit fix or the new smoke script, which is intentionally outside the `vitest` suites), `admin:navigation-smoke` (PASS), `qm:smoke` (PASS), `qm:validate` (Contract PASS / Doctor ENVIRONMENT BLOCKED / exit 1, expected), the browser-boundary check, `qm --help`, and `git diff --check` all passed. Filename-only secret scan: 0 exposed files. `qm up` was **not** executed. No real or placeholder QM secrets were added. Final verdict remains `CONTRACT_ONLY_ACCEPTED_RUNTIME_BLOCKED`.

---

## 11. Next Steps & Approval Gate

Local runtime deployment (`qm up`) was **NOT** executed. Approval to run `qm up` requires:
- Target configured as `docker`.
- No cloud infrastructure or external provider credentials instantiated.
- Valid credential-free mock/fixture harness verification.
- Explicit user confirmation.

---

## 12. Doctor blocker remediation

QM `0.1.4` computes these names from `qm.config.jsonc`. The Admin page reports
only the names, category, and safe next step; it never returns values or raw CLI
output. For this repository, `modelProvider: anthropic` and `HARNESS: pi` make
the following seven settings required:

| Name | QM source and purpose | Category | Local generation | Required external input |
| :--- | :--- | :--- | :--- | :--- |
| `ANTHROPIC_API_KEY` | Official QM provider credential used and billed when `modelProvider` is `anthropic` | Credential | No | Yes, from Anthropic |
| `CAPABILITY_SECRET` | First-party signing key for scoped capabilities and egress grants | Local Secret | Yes, official QM `MINT_LOCALLY` rule | No |
| `CONNECTOR_SECRET_KEY` | First-party encryption key for durable connector credentials | Local Secret | Yes, official QM `MINT_LOCALLY` rule | No |
| `CORE_SIGNING_SECRET` | HMAC key shared by QM Core and surface plugins | Local Secret | Yes, official QM `MINT_LOCALLY` rule | No |
| `PORTAL_IDENTITY_SECRET` | Signing key for portal-bound user identity | Local Secret | Yes, official QM `MINT_LOCALLY` rule | No |
| `PUBLIC_API_URL` | Public QM Core self-API URL reachable from `pi` agent sandboxes | URL / configuration | Not a Secret; derive from the actual runtime network | A real reachable QM Core URL |
| `SKILL_SIGNING_SECRET` | Stable signing key for reviewed skills | Local Secret | Yes, official QM `MINT_LOCALLY` rule | No |

`PUBLIC_API_URL` is not `/api/admin/qm/*` and must never point at the Admin
Dashboard merely to clear Doctor. The Admin endpoints observe and trigger checks;
they are not the QM Core API used by sandboxes.

### Private local setup

QM documents `openssl rand -hex 32` for each of the five first-party local
Secret names above. Generate a fresh independent value per name and insert it
directly into the ignored `deploy/qm/.env` without echoing it to logs, chat,
snapshots, or PR comments. Do not reuse one value for multiple names. Provider
keys must come from the provider; never generate a dummy key to force PASS.

Before editing, verify the file remains private and ignored:

```bash
cd deploy/qm
install -m 600 /dev/null .env # only when .env does not already exist
git check-ignore --quiet .env
```

The Admin runner invokes the pinned CLI from `deploy/qm`, uses QM's documented
default `deploy/qm/.env` location, and passes that same path explicitly once the
file exists. It provides only a small OS/runtime environment
allowlist (`PATH`, home/temp, locale/timezone, and CI metadata). Browser requests
cannot supply command, arguments, cwd, or environment. The response schema
contains no raw stdout/stderr, absolute path, stack trace, process environment,
or Secret value.

After authorized configuration changes, restart Admin API and Web using the
normal development commands, then run `pnpm run qm:validate` and use
**重新驗證** on `/admin/qm-status`. A nonzero validate exit remains correct when
Doctor is honestly blocked.

### State meanings

- **Contract PASS**: committed QM config and computed contract are structurally valid.
- **Doctor BLOCKED**: one or more honest prerequisites are absent; this is not runtime readiness.
- **Runtime READY**: the real QM runtime and its external dependencies have been exercised successfully. This task does not claim it.

Do not run `qm up`, `qm secrets push`, Fly/AWS/Slack deployment, cloud mutation,
or any production secret mutation as part of local remediation without explicit
approval. After local investigation, remove scratch profiles/logs and any
generated runtime state that is no longer needed. Avoid putting Secret-bearing
commands into shell history; do not delete or rewrite shared history without the
operator's approval.
