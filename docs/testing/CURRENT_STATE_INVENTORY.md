# AI_Quest_A1 Current State Inventory & Evidence Mapping (Phase 1 / Issue #17)

- **Owner**: Codex
- **Task**: Issue #17-1 (Prep 17-1)
- **Status**: Completed
- **Date**: 2026-08-05
- **Scope**: Read-only inventory of `apps/AI-adm-D1`, `apps/AI-Stu-R1`, `packages/*`, and `scripts/*`.
- **Constraint**: No product behavior modification, no production middleware additions, no security logic fixes in this pass.

---

## 1. Inventory Summary & Systems Overview

| System / Area | Primary Location | Key Capabilities & Artifacts | Active Evidence / Verification |
| :--- | :--- | :--- | :--- |
| **Admin API & Web** | `apps/AI-adm-D1` | Express backend on port 3002; admin token auth middleware (`admin-auth.ts`); Vite React SPA on frontend | `pnpm admin:build`, `scripts/admin-navigation-smoke.mjs` |
| **Student API & Web** | `apps/AI-Stu-R1` | Vite React SPA on frontend (port 3000 default); server API routes for book notes, chat, progress | `pnpm student:build` |
| **QM Adapter & Orchestration** | `packages/ai-orchestration` | `LocalQmAdapter` implementation of QM ports; `FeedbackWorkflowService` managing draft/review/publish workflow | `packages/db/test/feedback-workflow.test.ts` |
| **AI Gateway & Providers** | `packages/ai` | Multi-provider dispatch (OpenAI, Gemini, Kimi, Qwen, Zai); AES credential decryption; token pool management | `packages/ai/src/server/ai/*.test.ts` (30 test files, 319 tests) |
| **Database & Schema** | `packages/db`, `packages/schema`, `data/` | Drizzle ORM + SQLite (`ai-smartbook-r1.db`); seeds & migration scripts | `scripts/phase2-db-preflight.ts`, `packages/db/src/` |
| **Upload Processing** | `apps/AI-adm-D1/src/server/index.ts` | `multer` upload handling for PDFs, book content, appearance images, and JSON indices | `sanitizeUploadFileName` helper in `apps/AI-adm-D1` |
| **Testing & Release Harness** | `scripts/` | HTTP smoke test scripts (`phase2-http-smoke.ts`, `phase3a-staging-smoke.ts`), boundary check (`boundary-check.sh`), release gates | `pnpm test`, `pnpm lint`, `pnpm typecheck` |

---

## 2. Seven Core Technical Dimensions

### 2.1 Admin & Student API Routes, Middleware & Data Scoping
- **Admin Authentication & Origin**:
  - `apps/AI-adm-D1/src/server/middleware/admin-auth.ts`: Validates `x-admin-token` or `Authorization: Bearer` against `ADMIN_API_TOKEN` / `ADMIN_DEV_PASSWORD`. Enforces canonical error responses with `X-Admin-Auth-State: invalid` and `{"code": "ADMIN_AUTH_REQUIRED"}`.
  - `apps/AI-adm-D1/src/server/middleware/admin-origin.ts`: Validates `Origin` / `Referer` to guard against CSRF on admin endpoints.
- **Student Data Scope**:
  - Student endpoints (`/api/student/books/:bookId/...`) accept client-supplied `learnerId` and `sessionId`.
  - **Evidence Gap**: No centralized session token verification middleware was found on student routes; scope verification relies on route parameters.

### 2.2 QM Adapter, Workspace & Feedback Flow
- **Port Interface**: `packages/ai-orchestration/src/ports.ts` defines `ensureWorkspace`, `submitAndGenerate`, `review`, and `publish`.
- **Adapter Implementation**: `LocalQmAdapter` (`packages/ai-orchestration/src/local-qm-adapter.ts`) mimics QM execution without requiring external `qm up` background services.
- **Workflow State**: Managed via `FeedbackWorkflowService` (`packages/db/src/feedback-workflow.ts`), transitioning feedback through `draft` -> `reviewed` -> `published`.

### 2.3 AI Gateway, Orchestration & Credential Loading
- **Credential Storage**: Encrypted in DB using AES via `AI_CREDENTIAL_ENCRYPTION_KEY` (`packages/ai/src/server/ai/credential-crypto.ts`).
- **Isolation**: Transient per-run secrets injected via `buildIsolatedRunSecretEnv` closure. Keys are never appended to global `process.env`.
- **Fail-Closed Runtime Resolution**: `resolveQmRuntimeConfig` handles 9 distinct fail-closed error codes when provider credentials or configs are missing or invalid.

### 2.4 Upload / PDF / Textbook & External URL Processing
- **Multer Configuration**: `apps/AI-adm-D1/src/server/index.ts` configures size limits (2MB for appearance, 25MB for JSON) and filename sanitization.
- **PDF Extraction**: Uses pdf parsing logic in `packages/book-core`.
- **SSRF Defense**: `isSafeQmBaseUrl` in `packages/schema` blocks loopback (127.0.0.1), private IPv4 (10.x, 172.16-31.x, 192.168.x), CGNAT, link-local, IPv6-mapped, and cloud metadata IPs.

### 2.5 DB Schema, Migration, Seed & Audit Lifecycle
- **Schema Location**: `packages/schema/src/index.ts` and `packages/db/src/schema/`.
- **SQLite Database**: Default file at `data/ai-smartbook-r1.db` (and `apps/data/ai-smartbook-r1.db`).
- **Audit Logs**: `repos.aiProviders.audit(...)` logs provider configuration changes and evaluation executions to SQLite.

### 2.6 Unit, Integration, Contract & Smoke Test Harness
- **Unit & Integration Tests**: 30 Vitest suites across `packages/ai`, `packages/db`, `packages/schema`, and `apps/AI-adm-D1`.
- **HTTP Smoke Tests**:
  - `scripts/phase2-http-smoke.ts`: Tests basic health and endpoint availability.
  - `scripts/phase3a-staging-smoke.ts`: Tests staging deployment invariants.
  - `scripts/admin-navigation-smoke.mjs`: Tests 401 handling, concurrent auth invalidation, and session snapshot safety.

### 2.7 Ports, Environment Variables, Startup Order & Isolation
- **Port Allocation**:
  - Admin Web / API: `PORT=3002` (default)
  - Student Web / API: `PORT=3000` (default)
  - Production / Staging Systemd: `deploy/systemd/ai-stu-r1.service`
- **Environment Files**:
  - `.env` (root, gitignored)
  - `.env.example` (template)
  - `deploy/systemd/student.env.example`

---

## 3. Attack Case Cross-Reference Matrix (Claude AC-1 ~ AC-10)

| Attack Case | Title / Description | Current Test Coverage | Evidence File Location | Status / Gap |
| :--- | :--- | :--- | :--- | :--- |
| **AC-1** | Unauthorized / expired admin token | Automated | `apps/AI-adm-D1/src/server/middleware/admin-auth.test.ts`, `scripts/admin-navigation-smoke.mjs` | **PASS** — Returns 401 with `X-Admin-Auth-State: invalid`. |
| **AC-2** | Refresh replay / token substitution | Unit Covered | `apps/AI-adm-D1/src/client/services/adminAuth.test.ts` | **PASS** — Token snapshot check prevents stale 401 response invalidation. |
| **AC-3** | Concurrent 401 event storm | Automated | `scripts/admin-navigation-smoke.mjs` (5 concurrent), `adminAuth.test.ts` (10 concurrent) | **PASS** — Dispatches expiry event exactly once. |
| **AC-4** | IDOR (cross-learner / cross-class access) | Gap / Backlog | `docs/security/ATTACK_CASES.md` (AC-4) | **NEEDS FIXTURES** — Synthetic multi-learner fixture created in Prep 17-2. |
| **AC-5** | Role / privilege escalation | Unit Covered | `packages/db/test/feedback-workflow.test.ts` | **PARTIAL** — Role check covered; scope isolation needs synthetic multi-class fixtures. |
| **AC-6** | Business error misclassified as auth failure | Automated | `scripts/admin-navigation-smoke.mjs` (step 8), `adminAuth.test.ts` | **PASS** — Single-emitter auth failure marker verified. |
| **AC-7** | Direct & indirect prompt injection | Gap / Backlog | `tests/fixtures/security/prompt-injections.json` | **NEEDS FIXTURES** — Synthetic benign/malicious prompt injection samples created in Prep 17-2. |
| **AC-8** | Malicious PDF / textbook / upload content | Gap / Backlog | `tests/fixtures/security/upload-samples.json` | **NEEDS FIXTURES** — Synthetic upload & SSRF fixtures created in Prep 17-2. |
| **AC-9** | QM workspace / trace leakage | Unit Covered | `packages/ai-orchestration/src/local-qm-adapter.ts` | **PARTIAL** — LocalQmAdapter scoped; full QM Core pending live deployment. |
| **AC-10** | Secret exposure in bundle / logs / artifacts | Automated | `scripts/release-artifacts.mjs` (`scanArtifactText`) | **PASS** — Artifacts & console output sanitized. |

---

## 4. Identified Gaps & Evidence References

1. **Synthetic Security Fixture Corpus**: Lack of standardized multi-role, multi-learner, and prompt-injection synthetic fixtures for automated security test passes. *(Addressed in Prep 17-2)*.
2. **Environment Isolation & Cleanup**: Lack of dedicated standalone scripts to launch isolated test databases on non-standard ports and tear them down deterministically. *(Addressed in Prep 17-3)*.
