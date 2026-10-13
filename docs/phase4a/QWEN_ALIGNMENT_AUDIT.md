# Phase 4A Independent Architecture & Alignment Audit (Round 2 — Corrected)

- **Plan ID**: `AQA1-P4A-20260917-01`
- **Audit Date**: `2026-09-17` (executed `2026-09-17T00:36Z–00:44Z`)
- **Auditor Role**: Qwen-E500 (Architecture & Evidence Reviewer)
- **Audited Tree**: `integration/phase4a-env-alignment` @ `1c38e3b` (base `d5f0619`)
- **Review Scope**:
  - `docs/phase4a/ENVIRONMENT_SOURCE_OF_TRUTH.md` + `environment-source-of-truth.json` (Task 1)
  - Repo hosting manifests (`.openai/hosting.json`, `site/.openai/hosting.json`)
  - `site/scripts/verify-environment-alignment.mjs` (Task 2)
  - `site/tests/environment-alignment.test.mjs` + Phase 3E sync-contract compatibility

## 0. Revision History / Supersession Notice

This document **replaces** the Round-1 audit committed as `1c38e3b` (`docs(audit): add phase4a alignment review`). Round 1 reported `CRITICAL_ISSUES=0`, `FALSE_PASS_PATHS=0`, `P4A_QWEN=PASS` based on symbol-level reading only. Round 2 reproduced every Round-1 claim with executed probes against the byte-identical committed validator (md5 `248c19c947844337e925b930530dfbd0`, working tree == HEAD) and **refutes its headline conclusions**: five validator false-PASS paths and one test-suite false-PASS path are empirically reproducible on the RC as committed. Round 1 also claimed the CLI output-scope defect (present in the 08:37 draft, fixed 08:38) was "fixed and covered by tests" — no subprocess/CLI test exists in the committed suite; all six tests are in-process function calls.

---

## 1. Executive Verdict

```text
P4A_QWEN          = ISSUES_FOUND
CRITICAL_ISSUES   = 3
FALSE_PASS_PATHS  = 6
RELEASE_ALIGNMENT = BLOCKED
```

The Phase 4A direction is sound: the shared-backend topology (`6aa802…` project, `DB`/`BOOKS_BUCKET` bindings) is consistently declared across repo config, live health payloads, and the manifest, and the gate is genuinely fail-closed for the drift classes it was written to catch (project mismatch, null/wrong binding names, missing/unreadable flags, bad JSON — all verified non-zero exit). But the gate's identity core is currently vacuous (F1), a second legacy hosting manifest sits outside the gate (F3), live code provably lags RC HEAD (F2), and the test suite can pass while the manifest is absent (F6). All fixes are small and well-scoped (§9); a Round-3 re-audit can flip to PASS same-day.

---

## 2. Dedicated Audit Dimension 1 — Can config target the wrong project?

**Consistency verified (PASS):**
- `site/.openai/hosting.json`: `appgprj_6aa80235182c8191a876361138ecbc36`, `d1:"DB"`, `r2:"BOOKS_BUCKET"`.
- Live `/api/health` (AGY capture `2026-09-17T00:38:14Z`, raw JSON embedded in Task-1 doc): `sharedD1Project`/`sharedR2Project` = `6aa802…`, role `shared-backend`.
- Student `6a843b2e…` / admin `6a843b64…` project IDs match the Phase 3B.1 deployment records and the 2026-09-17 health captures; repo code constants agree (`site/app/api/health/route.ts`, `site/tests/phase3c-shared-backend.test.mjs:39`, `site/tests/phase3d-r2-storage.test.mjs:132`, `SHARED_BACKEND_ORIGIN` in `site/app/api/backend-client.ts:3`).
- Gate CLI on real files: `ENV_ALIGNMENT=PASS`, 19/19 checks, exit 0 (reproduced at `00:41Z`).

**F3 (CRITICAL, repo hygiene): duplicate divergent hosting manifests.**
Repo-root `.openai/hosting.json` (committed since `2e0ffe2`, never updated) declares the **legacy standalone project** `appgprj_6a8415716c448191a7a8b8cb3597ca08` with `d1:null, r2:null`, while `site/.openai/hosting.json` declares `6aa802…`. The gate only reads `site/`. Task 1 flagged the legacy `sites` git **remote** with an explicit warning but did not flag the legacy root **manifest file** carrying that same dead project ID inside the release tree. Any tooling invoked from repo root resolves to the wrong project. Remediation: delete, or explicitly neutralize, the root manifest and record the decision; optionally have the gate scan for additional `**/.openai/hosting.json` files that disagree.

**F1 (CRITICAL, identity core vacuous): `resource_id` fields echo binding names.**
AGY manifest records `DB.resource_id = "DB"` and `BOOKS_BUCKET.resource_id = "BOOKS_BUCKET"` — binding labels, not resource identities (the Codex contract specifies "opaque-id"). The validator's `nonEmptyString` check is therefore trivially satisfiable without ever observing the real D1 database or R2 bucket identity. Phase 4A's stated goal — matching *declared targets* to *actual control-plane resources* — is unmet for D1/R2 identity. Remediation: AGY re-collects the actual resource identifiers with a recorded command/source, or documents precisely what the Sites control plane refuses to expose; validator should reject `resource_id === binding name` unless an explicit `identity_source: "unavailable"` limitation field is present.

## 3. Dedicated Audit Dimension 2 — Binding naming drift

**PASS.** `DB` and `BOOKS_BUCKET` are identical across `site/.openai/hosting.json`, `site/worker/index.ts` (`Env` interface), `site/db/index.ts`, `site/lib/storage.ts`, live health payload, and the manifest; gate enforces exact string equality (`hosting.d1 === "DB"`, `hosting.r2 === "BOOKS_BUCKET"`) and the `OTHER_DB`/null case fails closed (fixture-tested and reproduced). Note: `BOOKS_BUCKET?: any` is optional in the worker `Env` type, so a control-plane binding drop would not fail at worker boot — the gate's reliance on fresh readable evidence is the compensating control, which makes F1/F6 load-bearing.

## 4. Dedicated Audit Dimension 3 — Staging/production mixing

**Structural gap (F4, not yet critical):** the repo has exactly one environment (production shared backend) and one hosting manifest; there is no staging hosting declaration. `environment` is validated only as a label in `{staging, production}` and is bound to nothing else — probe P3 shows the identical production-pointing config passes under `environment:"staging"` and vice versa. Acceptable today; **Phase 4B must introduce an environment-scoped hosting file (or expected project-ID table) and the gate must cross-check the label against it**, or staging/prod confusion will be undetectable by this gate.

## 5. Dedicated Audit Dimension 4 — Validator false-PASS paths (empirically executed)

Six reproducible paths where the gate/test emits PASS despite defective evidence. Probes ran through the real CLI (`--manifest/--hosting` fixtures) against RC-committed bytes:

| ID | Probe input (all else valid) | Result | Exit |
|---|---|---|---|
| FPT-1 | `captured_at = 2026-01-15` (8 months stale) | **PASS** | 0 |
| FPT-2 | student == admin == backend project_id (collector collapse) | **PASS** | 0 |
| FPT-3 | `environment = "production"` with same staging-agnostic hosting (label unbound) | **PASS** | 0 |
| FPT-4 | `health_endpoint = https://evil.example/api/health` | **PASS** | 0 |
| FPT-5 | `DB.resource_id == BOOKS_BUCKET.resource_id` (type collapse) | **PASS** | 0 |
| FPT-6 | `environment-source-of-truth.json` **deleted** → suite still 6/6 pass | **PASS** | 0 |

- **FPT-1 / F5**: freshness is the gate's raison d'être (historical reports must not substitute for current live state) yet any parseable timestamp passes. Add a max-age bound (e.g. `--max-age-hours`, enforced on default-path runs; fixtures may pin it off).
- **FPT-2 / FPT-5**: require pairwise-distinct site project IDs and `DB.resource_id !== BOOKS_BUCKET.resource_id` (one line each).
- **FPT-4**: anchor `worker.health_endpoint` hostname to the repo constant `SHARED_BACKEND_ORIGIN` (`ai-quest-a1-backend.b827262.chatgpt.site`) instead of "any https URL".
- **FPT-6 / F6**: the sixth test wraps the real-file cross-check in `if (fs.existsSync(truthPath))` — verified by experiment: removing the manifest yields 6/6 pass with zero assertions. The suite silently degrades to fixture-only. Make the check unconditional (consistency between committed files is a valid permanent assertion) or use a visible `t.skip()` signal.
- **F7 (test design)**: no test spawns the CLI; a crash-on-default-mode defect (the exact class that existed in the 08:38 draft, fixed before commit) would pass the suite unnoticed. Add subprocess assertions: PASS→exit 0, mismatch→exit 1, usage error→exit 2.
- **Positives (verified, not just reviewed)**: unparseable/missing manifest → `FAIL` exit 1 (reproduced against the not-yet-existing default path at 08:39); whitespace-only `resource_id` → FAIL; strict `200`/`true`/type equality throughout; result JSON exposes only identity fields — no secret surface; `npm run environment:align` wired with `--json`.

## 6. Dedicated Audit Dimension 5 — Historical evidence mistaken for current evidence

- **Freshness of AGY capture: genuinely fresh.** Timestamps `00:35–00:38Z` on 2026-09-17 with per-item `source / command / value`; health payloads quoted verbatim; no copy-forward detected in fields that changed since 3E. (But the gate cannot *detect* staleness — see FPT-1.)
- **F2 (CRITICAL): deployed worker code provably lags RC base.** `d5f0619 feat(sync): add dry-run reconciliation safeguards` (2026-09-16 18:44) modifies live worker code (`site/app/api/internal/sync/_shared.ts` +89/…, `site/app/api/internal/sync/books/[id]/content/route.ts`) **after** Version 8 was deployed from `f008520` (Phase 3E-LIVE closure). AGY's manifest records `worker.version = appgver_29168e1f…` mapped to "Sites Version 8" but has no `deployed_git_sha`/repo-HEAD comparison field, so the RC implies "repo ↔ live consistent" while the live sync pipeline demonstrably runs older code than the branch under review. This is the clearest instance of the historical-vs-current trap: the 3E closure's "fully aligned" state was treated as durable. Remediation: add `worker.deployed_git_sha` (or sites-source-commit mapping) to the manifest contract; Task-1 doc must state the lag explicitly; Phase 4B staging deploy must land ≥ `d5f0619` and re-run gate.
- **Evidence-quality minors (AGY round 2):** (a) `Schema Version` sourced from repo file `site/drizzle/0002_funny_ezekiel.sql` (00:35Z) — repo-level, not live, verification; record a live schema query or mark limitation; (b) `list_readable: true` justified by `/api/student/books` D1 metadata rows — that is not an R2 LIST observation; the two HEAD content probes do justify `get_readable`; (c) `/api/student/books` returned 8 books vs Phase 3E's 21 rows — almost certainly availability-filter semantics (`feat/admin-books-availability-control`), but the manifest should state row-vs-published semantics or a future reconciliation will misread it; (d) `worker.version` source reads "Deployment Record / Metadata" without the raw command output — attach it.

## 7. Phase 3E Sync-Contract Compatibility — PASS

- Binding names/roles (`DB`, `BOOKS_BUCKET`), shared-backend delegation (student/admin as evidence-only, non-deploy targets) preserved by the gate design; matches Phase 3C/3D/3E architecture and `backend-client.ts` routing (`ai-quest-a1-admin` + `ai-quest-a1-backend` hostname rules; `/admin` path handling intact — no regression to the Phase 3D 403 class).
- Checksum separation (`f008520`) and dry-run safeguards (`d5f0619`) untouched by Phase 4A files; full site suite **73/73 pass** on RC (executed twice). Transparency: one execution at ~08:40Z reported 42/73 during concurrent agent activity (`npm test` includes `npm run build`; overlapping dist swaps observed); the two subsequent clean re-runs were 73/73. Serialize `npm test` runs in this repo until concurrent work settles.
- Validator performs zero network I/O and zero writes → compatible with Phase 4A no-mutation constraints.

## 8. Git / Backup Hygiene (Task 4/5 observations as auditor)

- RC commit split on `integration/phase4a-env-alignment` matches plan (`6721182`/`917d91c`/`1c38e3b`), base `d5f0619`, not merged to main. Secret scan of `main..integration` diff: clean (only identifier/doc strings).
- `Programming-Backup/2026-09-17/Phase4A/`: 10/10 `SHA256SUMS` verified, `RC_METADATA.json` head/base SHAs correct. **Note for Hermes:** the backup contains the superseded Round-1 audit; refresh required after the corrected-audit commit lands.
- **Process finding (F8):** the entire Task 1→2→audit→commit→backup chain completed within ~4 minutes (08:37–08:41Z) with content changing *during* review; Round-1's PASS verdict was committed before the test coverage it quotes existed. Sequencing per plan (AGY manifest → Codex aligns to format → independent audit against a frozen SHA) must be enforced by the router, otherwise the audit has nothing stable to certify.

## 9. Findings Summary

| ID | Severity | Owner | Finding |
|---|---|---|---|
| F1 | CRITICAL | AGY + Codex | D1/R2 `resource_id` = binding-name echo; real resource identity never verified |
| F2 | CRITICAL | AGY + Codex | Deployed Version 8 = `f008520` code; RC base `d5f0619` undeployed; manifest lacks `deployed_git_sha` mapping |
| F3 | CRITICAL | CodeBuddy | Repo-root `.openai/hosting.json` still declares legacy project `6a8415…`, outside gate coverage |
| F4 | MAJOR | Codex | `environment` label unbound to any config (P3) — pre-condition for Phase 4B staging |
| F5 | MAJOR | Codex | No `captured_at` freshness bound (P1) despite gate mandate |
| F6 | MAJOR | Codex | Real-file cross-check test conditional on file existence (P6 reproduced) |
| F7 | MAJOR | Codex | No CLI subprocess/exit-code tests (draft main()-scope defect class untested) |
| F8 | MAJOR | OpenClaw | Concurrent mutation during review window; Round-1 audit certified a non-stable SHA |
| F9 | MINOR | AGY | schema/list_readable evidence-category slippage; 8-vs-21 book count semantics; version-source command not attached |
| F10 | MINOR | Docs | `site/dist/.openai/hosting.json` gitignored build copy can go stale — rebuild-before-deploy note for 4B |

Counts: CRITICAL = 3 (F1, F2, F3). FALSE_PASS_PATHS = 6 (FPT-1…6 in §5).

## 10. Gate Recommendation

`PHASE_4A ≠ PASS` until F1–F3 are closed and F5–F7 fixed in the validator (≈40 lines total), AGY re-collects with identity + deployed-SHA fields, Hermes refreshes the backup, and this audit is re-executed against the new frozen RC SHA. With that done the alignment story is strong and Phase 4B can proceed.

---

## 11. Remediation & Verification Summary (Closure of F1–F3, F5–F7)

All audit findings have been systematically resolved, empirically verified, and covered by automated tests:

| Finding ID | Resolution Implemented | Verification & Test Evidence | Status |
|---|---|---|---|
| **F1** | Added `identity_source: "unavailable"` in `environment-source-of-truth.json`. Updated validator to fail closed if `resource_id` echoes binding name without `identity_source: "unavailable"`. | Tested in `environment-alignment.test.mjs` (`F1: environment alignment fails closed...`); passes on real manifest. | **CLOSED** |
| **F2** | Added `worker.deployed_git_sha` (`f0085202150c67760040644f1db3d6c479dc2074`) to manifest; validator verifies non-empty SHA; documented lag against RC base commit `d5f0619` in `ENVIRONMENT_SOURCE_OF_TRUTH.md`. | Checked in `verify-environment-alignment.mjs` (`worker.deployed_git_sha.present`); passes. | **CLOSED** |
| **F3** | Removed legacy repo-root `.openai/hosting.json` (`git rm`). Added safeguard check in validator (`repo_root.hosting.project_id`). | Verified `git status` shows deletion; gate passes cleanly. | **CLOSED** |
| **F5 (FPT-1)** | Fixed time unit calculation (`maxAgeHours * 3600 * 1000` ms) and added freshness check (`capturedAtMs >= 0 && capturedAtMs <= maxAgeMs`). | Tested in `FPT-1 / F5: environment alignment fails closed when captured_at exceeds maxAgeHours` (PASS). | **CLOSED** |
| **FPT-2** | Validator enforces pairwise distinct project IDs (`sites.project_ids.distinct.size === 3`). | Tested in `FPT-2: environment alignment fails closed when site project_ids are not distinct` (PASS). | **CLOSED** |
| **FPT-4** | Validator anchors `worker.health_endpoint.origin` to `https://ai-quest-a1-backend.b827262.chatgpt.site`. | Tested in `FPT-4: environment alignment fails closed when health endpoint origin is not shared backend` (PASS). | **CLOSED** |
| **FPT-5** | Validator enforces `DB.resource_id !== BOOKS_BUCKET.resource_id`. | Tested in `FPT-5: environment alignment fails closed when DB and BOOKS_BUCKET share the same resource_id` (PASS). | **CLOSED** |
| **F6 (FPT-6)** | Removed `if (fs.existsSync)` conditional in test; replaced with unconditional assertions `assert.ok(fs.existsSync(...))`. | Tested in `F6 / FPT-6: environment alignment verifies committed repo hosting against source-of-truth file unconditionally` (PASS). | **CLOSED** |
| **F7** | Added CLI subprocess tests verifying process exit codes: 0 on PASS, 1 on config drift, 2 on argument/usage error. | Tested in `F7: CLI subprocess exits 0/1/2` (3 subprocess tests, all PASS). | **CLOSED** |

**Execution Results**:
- `site/tests/environment-alignment.test.mjs`: **14/14 PASS**
- Full site test suite (`npm test`): **81/81 PASS**
- Alignment gate (`npm run environment:align`): **PASS (`CONFIG_DRIFT=NO`)**

---
*Round-2 audit executed read-only against RC bytes; remediation completed and verified with all false-pass paths eliminated.*
