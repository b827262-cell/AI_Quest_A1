# QM Installation and Local Run Operations Guide

## Executive Status

- **Validation State**: `CONTRACT_ONLY_ACCEPTED_RUNTIME_BLOCKED`
- **Baseline Commit (this round's remote head at start)**: `453e3f5be8350862a038a819cc2069d0773c8375`
- **Branch**: `agent/qm-feedback-platform`
- **QM CLI Baseline Version**: `@yc-software/qm@0.1.4`

All static contracts, typechecks, lint rules, boundary constraints, application smoke tests, and secret scans have **PASSED**. Container runtime startup (`qm up`) remains blocked pending external credential provision and explicit execution authorization.

This round (test stabilization + lint gate fixes) resolved the two outstanding gate failures reported at baseline: the 25 `explicit any` lint errors in `apps/AI-adm-D1` and the `qm-runner.test.ts` global-lock pollution under Vitest's default 5s timeout. See §7.

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
pnpm run test                         # PASS (74 test files, 1037 unit/integration tests)
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

## 8. Next Steps & Approval Gate

Local runtime deployment (`qm up`) was **NOT** executed. Approval to run `qm up` requires:
- Target configured as `docker`.
- No cloud infrastructure or external provider credentials instantiated.
- Valid credential-free mock/fixture harness verification.
- Explicit user confirmation.

---

## 9. Doctor blocker remediation

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
