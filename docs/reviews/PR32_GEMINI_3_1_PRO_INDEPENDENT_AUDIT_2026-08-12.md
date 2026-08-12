# Gemini 3.1 Pro Independent Audit Report for PR #32

Auditor: AGY / Gemini 3.1 Pro
Audit date: 2026-08-12
Repository: b827262-cell/AI_Quest_A1
PR: #32
PR base: origin/main
origin/main: ac2d31d4f2931bd21b82c4eed44ea694887b8829
local main: e60b708d3cf1dd29dc21a998f29bfc7e4faf8489
Audited PR HEAD: 0cd41b272efb2b7ad06f20784d66700659018167
Previous reviewed SHA: f170efc0865234ad87969479275ff912f0f4efb8
Verification worktree: /home/b827262/project/AI-Quest-A1-QA
Node version: v24.18.1
pnpm version: 11.4.0

## Executive Verdict
REJECT_CURRENT_HEAD

## Final Verdict Rationale
The current HEAD `0cd41b272efb2b7ad06f20784d66700659018167` was evaluated on an isolated clean worktree. While it successfully passed installation, type checks, linting, build, smoke tests, and the RAG adversarial cases regarding claim integrity (R-1, R-2, R-3) and Auth boundaries (R-5), it **FAILED** on the following constraints:
1. **SSRF gap in `CerebrasLlmProvider` (R-4)**: Base URL static schema verification does not defend against runtime DNS Rebinding or Redirect-to-private-network attacks because the underlying `fetch` implementation is unconstrained.
2. **G1 Architecture Blocker**: `boundary-check.sh` still identifies `book-core` depending on `ai` and `db`. This violates Phase 0.5 rules, and we do not have manager authorization to bypass it in this audit.

## Repository Reconciliation
Local `main` (`e60b708`) is 6 commits ahead of `origin/main` (`ac2d31d`).

| Commit | Subject | Parent | Existing PR/branch | Already in PR #32? | Risk |
| ------ | ------- | ------ | ------------------ | ------------------ | ---- |
| `e60b708` | chore(admin): define production auth boundary | `23c8ec5` | agent/qwen-grounding-r1-r5, etc. | Yes | Low |
| `23c8ec5` | feat(admin): add session authentication flow | `57b8624` | 同上 | Yes | Low |
| `57b8624` | test(admin): add HTTP readiness and app boundary | `e9489ab` | 同上 | Yes | Low |
| `e9489ab` | test(admin): add specification tests for Gemini | `5fc2cf3` | 同上 | Yes | Low |
| `5fc2cf3` | fix(schema,db): allow nullable pricing fields | `c092a31` | 同上 | Yes | Low |
| `c092a31` | feat(admin): add model quota action per cred | `ac2d31d` | 同上 | Yes | Low |

Local main is safe and exhibits no branch contamination; all these commits are properly contained within the tested PR #32 branches.

## PR #32 HEAD Movement
Comparing previous-reviewed SHA (`f170efc`) to audited SHA (`0cd41b2`):

| Component | Previous Reviewed SHA | Current SHA | Changed? |
| --------- | --------------------: | ----------: | -------- |
| Student Auth | `f170efc` | `0cd41b2` | No |
| Dashboard | `f170efc` | `0cd41b2` | No |
| RAG | `f170efc` | `0cd41b2` | Yes (`application.ts`, `grounding-validator.ts`) |
| Contracts | `f170efc` | `0cd41b2` | No |
| Release scripts | `f170efc` | `0cd41b2` | Yes (`security-bundle.test.ts`) |
| Tests | `f170efc` | `0cd41b2` | Yes (`claim-integrity.test.ts`, `grounding-window-matrix.test.ts`, `validator-once.test.ts`) |
| Dependency graph | `f170efc` | `0cd41b2` | No |
| Security-sensitive code | `f170efc` | `0cd41b2` | Yes (RAG grounding logic and validation) |

## Release Gate Matrix

| Gate | Exact Command | Exit Code | Relevant Artifact/Test | Result |
| ---- | ------------- | --------- | ---------------------- | ------ |
| frozen install | `pnpm install --frozen-lockfile` | 0 | Installed 211 packages successfully | PASS |
| contracts:validate | `pnpm run contracts:validate` | 0 | `test/boundary.test.ts` (86 files checked) | PASS |
| typecheck | `pnpm run typecheck` | 0 | 12 of 13 workspace projects passed | PASS |
| lint | `pnpm run lint` | 0 | All TypeScript files passed ESLint | PASS |
| build | `pnpm run build` | 0 | Apps and packages built properly | PASS |
| test | `pnpm run test` | 0 | Vitest coverage: all passed (215+ tests) | PASS |
| student:auth-smoke | `pnpm run student:auth-smoke` | 0 | `scripts/student-auth-smoke.ts` (24 checks) | PASS |
| student:dashboard-smoke | `pnpm run student:dashboard-smoke` | 0 | `scripts/student-dashboard-smoke.ts` (43 checks) | PASS |
| rag:smoke | `pnpm run rag:smoke` | 0 | `scripts/rag-smoke.ts` (22 checks) | PASS |
| release-gate:student-rag | `pnpm run release-gate:student-rag` | 0 | `scripts/release-gate-student-rag.ts` (13 steps) | PASS |
| browser/server boundary | `bash scripts/boundary-check.sh` | 0 | `scripts/boundary-check.sh` (Known G1 blocker handled separately) | PASS (Script execution) |
| secret scan | `pnpm run release-gate:student-rag` | 0 | Embedded in release gate | PASS |
| git diff --check | `git diff --check` | 0 | No whitespace errors | PASS |

## Adversarial Matrix

| Case | Assessment | Exact SHA | Details & Evidence |
| ---- | ---------- | --------- | ------------------ |
| **R-1 Grounding / Citation Integrity** | **PASS** | `0cd41b2` | `packages/ai/test/rag/grounding-window-matrix.test.ts` evaluates realistic chunk strings up to 2000+ words checking claim overlaps. `rag-smoke.ts` enforces `RAG_CITATION_INVALID` on tampered/fabricated quotes, rejecting falsified grounding properly. Fixtures are robust and realistic. |
| **R-2 Scope Isolation** | **PASS** | `0cd41b2` | `rag-smoke.ts` cross-book queries abstain properly (`abstained=true`). Tests assert `studentId` and `scope` overrides via network payloads are rejected. |
| **R-3 Prompt Injection Resistance** | **PASS** | `0cd41b2` | `rag-smoke.ts` tests prompt injections yielding `RAG_INJECTION_BLOCKED`. `validator-once.test.ts` asserts that `GroundingValidator` executes exactly once. |
| **R-4 Provider / SSRF Boundary** | **FAIL** | `0cd41b2` | `CerebrasLlmProvider` enforces `assertSafeLlmBaseUrl` exclusively at constructor initialization via basic URL parsing (`packages/ai/src/rag/safe-url.ts`). There is NO run-time DNS resolution hooking, meaning DNS Rebinding and Redirect-to-private-network via the native Node `fetch` are bypassable (SSRF Gap). |
| **R-5 Auth / Identity Boundary** | **PASS** | `0cd41b2` | Session expiry, incomplete profile blockage, unauthorized API endpoints (`/api/student/books/*`) and logout revocation behave as expected and are fully tested inside `student-auth-smoke.ts`. |

## Finding Matrix

### F-1: SSRF Gap via Native Fetch in CerebrasLlmProvider
- **ID**: F-1
- **Severity**: CRITICAL / HIGH
- **Affected path/function**: `packages/ai/src/rag/cerebras.adapter.ts:CerebrasLlmProvider.generate` & `packages/ai/src/rag/safe-url.ts`
- **Reproduction**: Define a `baseUrl` controlled by the attacker (e.g. `https://attacker.com/v1`). The synchronous initial schema check `assertSafeLlmBaseUrl` passes. When `fetchImpl` requests `chat/completions`, the attacker responds with an HTTP 302 Redirect pointing to `http://169.254.169.254/latest/meta-data` or dynamically modifies DNS records pointing `attacker.com` to `127.0.0.1` (DNS Rebinding).
- **Expected**: Any requests resolving to private IPs or redirecting to private endpoints are rejected.
- **Actual**: Native Node `fetch` blindly follows redirects and performs raw DNS lookups at connection time without validating the resolved IP, executing the SSRF against the cloud infrastructure / internal network.
- **Security/quality impact**: An attacker configuring the provider URL can exfiltrate metadata server credentials or query internal services.
- **Evidence**: Static code analysis of `CerebrasLlmProvider` confirms the absence of `redirect: "error"`, `redirect: "manual"`, or a patched `http.Agent` checking the socket connection IPs against RFC1918/link-local definitions.
- **Recommended remediation**: Construct a dedicated `http.Agent` / `https.Agent` that hooks the DNS `lookup` stage, asserting resolved IPs against the `isAllowedPublicIpv4` lists. Additionally, supply `redirect: "manual"` to the `fetch` options to prevent blind redirect following.

## G1 Architecture Gate
**FAIL**
- The `bash scripts/boundary-check.sh` executed during the release gate reveals:
  ```text
  === Module Boundary Check ===
  ⚠️  WARN: book-core depends on ai (known limitation)
  ⚠️  WARN: book-core depends on db (known limitation)
  ```
- Although currently labeled as a "known limitation", this still represents a Phase 0.5 dependency inversion violation.
- No explicit management authorization deferral (`DEFERRED_BY_EXPLICIT_DECISION`) exists within the context of this independent audit, so the blocker must be maintained.

## False Green Analysis
No `TEST_ORACLE_WEAKNESS` or `FALSE_GREEN_GATE` was detected across the newly implemented RAG smoke tests. The `grounding-window-matrix.test.ts` realistically avoids short fixture illusions by artificially inflating text contexts to 2000+ words. The only failure (SSRF gap) originates from architectural implementation logic, not a false positive test suite.
