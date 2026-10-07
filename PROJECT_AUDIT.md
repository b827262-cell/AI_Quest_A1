# Project Audit & Baseline Inventory (Phase 1B)

**Date**: 2026-10-06
**Status**: COMPLETE (Phase 1B Documentation Gate)
**Maintainer / Phase 1B authoritative writer**: CodeBuddy
**Independent reviewers / evidence sources**: Codex, Qoder, AGY-Hermes (reviewers and evidence providers only — NOT writers)
**Target Branch**: `cleanup/project-health`
**Base Commit SHA**: `054206670ed5db9c1501a5cce3fa0c6f9635e06c` (`origin/agent/a01-agy-a1-a3`)
**Scope**: Read-only repository audit & health analysis (Side-effect free)
**Snapshot Basis**: All SHAs, counts, and version figures below are the **2026-10-06 Phase 1B evidence snapshot**. Where the live repository has since advanced, `current: …` is annotated inline.

---

## 1. Executive Summary & Provenance Baseline

### 1.1 Phase 1A Closeout & Phase 1B Authorization
Phase 1A comprehensive codebase inspection conducted by Codex, Qoder, and AGY-Hermes concluded with `Phase 1A = COMPLETE & FROZEN`. Audit activities respected the `NO_WRITE=YES` restriction with zero mutations performed against formatters, package dependencies, builds, or test suites.

Following Owner Gate Adjudication, Phase 1B documentation is unlocked under strict **Single-Writer** authority assigned exclusively to **CodeBuddy**. All peer agents (Codex, Qoder, AGY-Hermes) remain in read-only hold status; they contribute independent review and evidence only and are **not** writers of these documents.

### 1.2 Triad Commit Topology & Clean Source Provenance
The repository exhibits a diverged three-point git state:

| Reference | Commit SHA | Role & Status | Clean Source Assessment |
|---|---|---|---|
| `origin/main` | `d5f0619b90d33b9b96256823144b9c937ad7f1ab` | Upstream Trunk | **Lags active development**. NO MERGE / NO REBASE permitted during cleanup. |
| `origin/agent/a01-agy-a1-a3` | `054206670ed5db9c1501a5cce3fa0c6f9635e06c` (2026-10-06 snapshot; current: `bcb31f3d`) | Canonical Active Remote Baseline | **CANONICAL CLEAN SOURCE**. Verified via remote lookup; base for `cleanup/project-health`. |
| Root Checkout (`wip/a01-site-wip-quarantine-20261004`) | `067937d98c76e7abada0193a5b9a50c489473a42` | Dirty Root WIP Snapshot | **不可當乾淨來源 (DO NOT USE AS CLEAN SOURCE)**. 87 dirty entries (2026-10-06 snapshot; current: 88); strictly isolated. |
| Frozen A-01 Worktree (`.worktrees/a01-agy-a1-a3`) | `054206670ed5db9c1501a5cce3fa0c6f9635e06c` (2026-10-06 snapshot; current: `bcb31f3d`) | Frozen Agent Snapshot | 12 dirty entries at snapshot (current observation: 2); **FROZEN**. Protected against direct edits. |

> [!WARNING]
> **Dirty Root Quarantine Warning**: The repository root checkout is attached to `wip/a01-site-wip-quarantine-20261004` at `067937d` with **87** modified/untracked/deleted entries (2026-10-06 snapshot; current: 88). Under no circumstances should root files be blanket-staged (`git add .` / `git add -A`) or treated as clean baseline code.

### 1.3 Infrastructure State
- **Cline Connector**: Remains in `INFRA_DEFERRED_NONPRODUCT` status due to connector authorization requirements. This is an external tooling interface issue and does not block repository health or product integrity.
- **Remote Target Branch**: `cleanup/project-health` has been verified as not yet published to remote origin (`git ls-remote origin refs/heads/cleanup/project-health` returned empty).

### 1.4 Root WIP Quarantine Decomposition (2026-10-06 snapshot; current count: 88)
`git status --porcelain` on the dirty root checkout (`wip/a01-site-wip-quarantine-20261004` @ `067937d`) returned **87 entries** in the 2026-10-06 snapshot (the live count has since drifted to **88**; not re-decomposed in this correction), decomposed as:

- **30 staged modifications** (`git diff --cached --diff-filter=M`), of which **2 are `MM`** (staged + worktree modified): `site/app/chrome-built-in-ai.ts` and `site/tests/chrome-built-in-ai.test.mjs`.
- **44 staged deletions** (`git diff --cached --diff-filter=D`).
- **13 untracked entries** (collapsed `git status` view; expands to 111 untracked files via `git ls-files --others`).
- Staged total = 74 files (30 M + 44 D); root `HEAD` unchanged at `067937d`.

---

## 2. Git Topology & Working Trees Audit

Per the fresh audit and direct verification (2026-10-06), the repository exhibits git tree sprawl:

```
[Git Ref Breakdown — fresh measurement 2026-10-06]
├── Local Branches: 49 (including cleanup/project-health)
├── Remote-Tracking Branches: 66 (38 origin + 28 across sites/smartbook/source-local remotes)
├── Active Git Worktrees: 29 (including cleanup-project-health)
├── Stashes: 3 (on root checkout)
└── Dangling / Unreachable Commits: 0 (fresh `git fsck` / `git fsck --unreachable`)
```

### 2.1 Branch Inventory & Local-Only High-Risk Branches
The fresh audit finds **49 local branches**, of which **20 are local-only refs** (no same-named `origin` ref). The high-risk feature subset carrying unpushed work ahead of `origin/main` is:

| Branch Name | Commits Ahead of `origin/main` | Purpose / Context | Risk Status |
|---|---|---|---|
| `agent/a01-slot-d-real-wiring` | 30 | 高普考資料快照 real wiring onto B's exam modules | **HIGH / HOLD** — Contains unpushed feature work |
| `feature/a01-public-noauth-feedback` | 28 | A-01 Slot C: runtime diagnostics & degraded UX | **HIGH / HOLD** — Contains unpushed UX diagnostics |
| `agent/b3-ibrain-search-api` | 29 | Read-only B2 exam-course Search API | **HIGH / HOLD** — Contains unpushed Search API code |
| `agent/zh-hant-eval-fp-fix` | 13 | 20-question offline matrix results | **HIGH / HOLD** — Contains unpushed evaluation results |
| `feat/auto-qwen3-staging-test` | 11 | 72h boundary verification matrix | **HIGH / HOLD** — Contains unpushed test harness |
| `fix/ipad-local-fallback-diagnostics` | 10 | Homepage V5 frozen snapshot & iPad fixes | **HIGH / HOLD** — Contains unpushed styling/fixes |
| `agent/auto-fallback-pipeline-qwen25` | 9 | Worker version provenance & SHA gate (FS-1) | **HIGH / HOLD** — Contains unpushed worker provenance |
| `integration/qm-runtime-bringup` | 6 | Phase 5 runtime enablement docs | **HIGH / HOLD** — Contains unpushed QM bringup records |

> The complete **20-ref** local-only list (including agent/worktree bookkeeping refs, the WIP quarantine ref, and the docs branch) is maintained in `docs/maintenance/BRANCH_NOTES.md` §3. `rc/d09-freshness-freeze` is remote-tracked and is **not** local-only.

> [!CAUTION]
> **Owner Adjudication Mandate**: All branch deletion, pruning, dropping, or force-cleaning is strictly **FORBIDDEN** in Phase 1B. All local-only branches are placed on permanent **HOLD / APPROVAL REQUIRED** pending operator review.

### 2.2 Worktree Sprawl Inventory
A total of **29** worktrees are attached across multiple namespaces (fresh `git worktree list`, 2026-10-06):
1. Root main worktree: `AI-Quest-A1` (attached to `wip/a01-site-wip-quarantine-20261004`) — 1.
2. `AI-Quest-A1/.worktrees/`: 21 agent worktrees for parallel development (`a01-agy-a1-a3`, `a01-slot-d-real-wiring`, `d06-rc-integration`, `d09-freshness-freeze`, `rc-auto-37d89f2`, etc.).
3. `AI-Quest-A1/.claude/worktrees/`: 2 worktrees (`agent-a30972d373d0b7755`, `agent-ada2c5b68fec98477`).
4. `AI-Quest-A1/.qoder/worktrees/`: 1 worktree (`a01-slot-d-exam-snapshot`).
5. `/home/b827262/project/.worktrees/`: 2 worktrees (`a01-public-noauth-feedback`, `cleanup-project-health`).
6. External / Ephemeral paths: `/home/b827262/project/reviews/independent-review-0cd41b2` (detached HEAD, prunable) and `/tmp/d06-base-lint` (detached HEAD) — 2.

---

## 3. Untracked Artifacts, Hidden Excludes & Licensing

### 3.1 Local-Only Worker Replacement vs. Base Worker Chain
- **Base remote worker chain (tracked in `0542066`)**: The base commit `origin/agent/a01-agy-a1-a3@054206670ed5db9c1501a5cce3fa0c6f9635e06c` **tracks a dual-file local-inference worker chain**:
  - `site/app/local-inference-worker-client.ts` (tracked)
  - `site/app/local-inference.worker.ts` (tracked)
  - The tracked `site/app/chrome-built-in-ai.ts` imports this client+worker chain (verified: `await import("./local-inference-worker-client.ts")` → `createLocalInferenceWorker()`).
- **Dirty root quarantine tree**: additionally contains an **untracked** `site/app/local-inference-worker.ts` (hyphenated, local-only replacement) that does **not** exist in base `0542066`.
- **Dependency Analysis (corrected)**: base `0542066` **DOES depend on a local inference worker** — via the tracked `local-inference-worker-client.ts` + `local-inference.worker.ts` pair. The dirty tree's untracked `local-inference-worker.ts` is a *separate, local-only replacement*, not the base dependency. (Any earlier claim that "base does not depend on a local worker" is inaccurate and is removed.)
- **Adjudication**: The local-only hyphenated worker is classified as an unverified artifact of the dirty WIP quarantine snapshot. **HOLD / APPROVAL REQUIRED**. It must **NOT** be silently copied, added, or committed to `cleanup/project-health`.

### 3.2 Hidden Exclude Tracking in `.git/info/exclude`
The repository's local `.git/info/exclude` contains custom entries hiding project files from source control:
- `FOUNDATION_ROUND3_TASK.md`
- `docs/DUAL_MACHINE_QA_SPEC.md`
- `scripts/e500-qa-verify.sh`
- (plus local tooling/backup paths: `.claude/`, `.cleanup-backup-20260807/`, `.qoder/`, `.worktrees/`)
- Risk: Critical architectural specifications and verification scripts are shadowed locally and will not propagate to remote collaborators or CI.

### 3.3 License Inconsistency
- `README.md` features a prominent badge: `[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)`.
- However, no `LICENSE` or `LICENSE.md` file exists in the repository root (returns error on lookup).

### 3.4 `git add -A` Staged-Deletion Reversal Trap
In the dirty root quarantine snapshot, **8 files are staged as deletions (`D`) but still exist on disk and are not ignored**:
- `data/b1-ibrain-public/crawl-manifest.json`, `data/b1-ibrain-public/raw-snapshot.json` (2 files)
- `data/b2-ibrain-postgresql/001_exam_courses.sql`, `INDEX_REPORT.md`, `b2-contract.test.mjs`, `import-b1-snapshot.mjs`, `query-contract.sql`, `validate-snapshot.mjs` (6 files)

`git check-ignore` confirms none of these are ignored. Because the files remain on disk, a blanket `git add -A` / `git add .` would **re-add them to the index and silently reverse the quarantine snapshot's staged-deletion intent**. This is the concrete reason blanket staging is forbidden.

---

## 4. Security & Secret Risk Analysis

### 4.1 Secret Risk Assessment: `SECRET_RISK = POSSIBLE`
- Active scanning across tracked commits reveals **no evidence of committed active secrets**.
- However, unversioned local environment files are present in the root:
  - `.env` (1035 bytes)
  - `.env.test` (708 bytes)
  - `.env.example` (1398 bytes)
- **Strict Prohibition**: Under NO circumstance may real tokens, API keys, passwords, or encryption seeds be added, documented, or committed.

### 4.2 Local Filesystem Permission Vulnerabilities
Local file permissions permit unauthorized local read access:
- `.env.test`: mode `644` (`-rw-r--r--`).
- Database files and snapshots:
  - `data/ai-smartbook-r1.db`: mode `644` (`-rw-r--r--`, 12.9 MB)
  - `data/ai-smartbook-r1.db.bak.20260629164923`: mode `644` (`-rw-r--r--`, 12.0 MB)
  - `data/ai-smartbook-r1.db.bak.20260728140000`: mode `644` (`-rw-r--r--`, 12.6 MB)
  - `apps/data/ai-smartbook-r1.db`: mode `644` (`-rw-r--r--`, 4.0 KB)
- **Action**: Recorded as a security observation for future review. Do NOT chmod or delete in Phase 1B.

### 4.3 Abnormal Directory Permissions & Hook State (record only — no modification)
- **World-writable directories (`777`)**: `docs/`, `legacy/`, `deploy/`, `scripts/` are all mode `777` (unexpected for source directories).
- **World-writable file (`666`)**: `lint.config.json` is mode `666`.
- **Git hooks**: `core.hooksPath` is set to `/home/b827262/project/AI-Quest-A1/.git/hooks`. The local `.git/hooks/post-checkout` and `.git/hooks/post-commit` are each **10-byte no-op shell stubs** (contents: `#!/bin/sh` only).
- **Action**: Recorded only. Do NOT chmod, rewrite hooks, or alter `.git/info/exclude` in Phase 1B.

---

## 5. Tooling, Dependencies & Runtime Audit

> [!NOTE]
> **Toolchain / runtime versions below (Node, pnpm, npm) are point-in-time observations from the Phase 1B execution context (E500 host, 2026-10-06).** They are **not** a single permanent "current" truth: different agents run in different execution contexts (e.g. Codex-E500 vs Agnes), and other hosts or containers may resolve different versions. Re-measure per execution context.

### 5.1 Dual Package Managers
- **Monorepo Root**: Managed via `pnpm` **v9.15.0** (uses `pnpm-workspace.yaml`, `pnpm-lock.yaml` with `lockfileVersion: '9.0'`).
- **Sub-application (`site/`)**: Managed via `npm` **v11.16.0** (contains standalone `site/package.json` and committed `site/package-lock.json` with `lockfileVersion: 3`, ~807 resolved packages). `site/` is **NOT** listed in `pnpm-workspace.yaml`, which only globs `apps/*` and `packages/*`.
- **Impact**: Inconsistent lockfile resolution, duplicate node_modules trees, inability to build monorepo packages and `site` in a unified pipeline.

### 5.2 48 Floating `"latest"` Dependencies
A total of 48 package dependencies are declared with `"latest"` across 12 package manifests:
- `apps/AI-adm-D1/package.json`: 11 dependencies
- `apps/AI-Stu-R1/package.json`: 8 dependencies
- `packages/db/package.json`: 6 dependencies
- `packages/contracts/package.json`: 4 dependencies
- `packages/student-runtime/package.json`: 4 dependencies
- `packages/auth/package.json`: 3 dependencies
- `packages/book-core/package.json`: 3 dependencies
- `packages/sync/package.json`: 3 dependencies
- `packages/ai/package.json`: 2 dependencies
- `packages/schema/package.json`: 2 dependencies
- `packages/quiz-core/package.json`: 1 dependency
- `packages/ui/package.json`: 1 dependency
- **Impact**: Non-deterministic installs, vulnerability to upstream breaking changes, build breakage across environments.

### 5.3 Node Engine Mismatch
- `site/package.json`: Defines `"engines": { "node": ">=22.13.0" }`.
- Root `README.md`: Documents **Node.js >= 20.0.0**.
- Monorepo root `package.json`: Lacks an `engines` declaration; there is no `.nvmrc`.
- **Host runtime (execution-context-specific)**: measured on the **E500 host on 2026-10-06** — nvm default **Node v24.18.1**; system `/usr/bin/node` v22.23.2. This is a *point-in-time, per-host* observation, **not** a universal "current" truth (see the §5 note above). The nvm default satisfies `site`'s `>=22.13.0`, while the README floor (`>=20`) is looser than `site`'s requirement.

### 5.4 Hardcoded Execution Paths
Monorepo root `package.json` hardcodes app-local binary paths instead of workspace-resolved ones:
- `typecheck:release-scripts` (line 19): `./apps/AI-adm-D1/node_modules/.bin/tsc --noEmit ...`
- Numerous scripts (`db:preflight:phase2`, `smoke:phase2`, `smoke:phase3a`, `smoke:provider`, `verify:guest-ask-live`, `credential-key:rotate`, `credential-key:verify`, `student:auth-smoke`, `student:dashboard-smoke`, `rag:smoke`, `release-gate:student-rag`): `node --import ./apps/AI-adm-D1/node_modules/tsx/dist/loader.mjs ...`
- **Impact**: Fails immediately if `apps/AI-adm-D1` is not separately installed or if pnpm hoists binaries differently.

### 5.5 Zero Continuous Integration (CI)
- The repository contains no `.github/workflows/` directory.
- There are no automated pull request checks, type checks, lint runs, or regression test gates.

### 5.6 README Rebuildability Assessment: POOR
- The root `README.md` provides architectural descriptions but lacks deterministic setup steps for the dual pnpm/npm structure.
- Outdated badge links (e.g., non-existent `LICENSE`).
- Cloudflare Workers / D1 / Pages configuration steps are unverified.

### 5.7 Dependency Install State (Phase 1B must NOT claim reproducibility)
Dependency trees are currently **incomplete**:
- Root `node_modules/`: partial pnpm tree (`.pnpm` store present, but top-level links limited to `happy-dom`, `playwright-core`).
- `packages/ai/node_modules/`: only `@ai-smartbook`, `@types`, and a `typescript` symlink.
- `packages/db/node_modules/`: only `@ai-smartbook`, `@types`, and symlinks for `better-sqlite3`, `drizzle-orm`, `tsx`, `typescript`.
- `site/node_modules/`: present (424 top-level entries).
- **Consequence**: Because root/`packages/*` installs are incomplete, **Phase 1B must NOT claim that build/test is reproducible**. Any `pnpm install` is a DEFERRED step requiring explicit authorization.

---

## 6. Legacy Debt & Duplicate Directories Inventory

The repository contains numerous stale backups, snapshots, and legacy directories accumulated over multi-agent runs:

1. `testweb.bak-20260922_2105/` (~3.8 MB): Stale snapshot containing duplicate `dist/` folders.
2. `testweb/` (~3.8 MB): Contains `dist.old/` and `dist.prev-49b701d9/`.
3. `legacy/` (~5.6 MB, **266 tracked files**): Legacy UX reference code (`legacy/old-frontend-ux-reference/`).
4. `.cleanup-backup-20260807/` (~256 KB): Contains archived worktree diffs and student RAG artifacts.
5. `Programming-Backup/2026-09-17/`: Full historical code backup.
6. `release-artifacts/`: Redundant artifact archives (`student-rag/`, `phase3a/`).
7. Stale Agent State Folders: `.a01-phase-r`, `.a01-4mode`, `.a01-slot-d`.
8. Database Backups: Multiple multi-megabyte SQLite backups (`ai-smartbook-r1.db.bak.*`).
9. `ai-smartbook-site.tar.gz` (~335 KB / 334,944 bytes): redundant site archive.
10. Large agent/cache trees (locally ignored via `.git/info/exclude`): `.worktrees/` ~21 GB, `.claude/` ~1.4 GB, `.qoder/` ~13 MB.

---

## 7. Repository Governance & Cloud Safety Status

- **GitHub Branch Protection**: `origin/main` has `protected=false` and no required status checks. Marked for **REVIEW**; no remote settings are modified during Phase 1B.
- **Cloud Infrastructure Safety**: Strictly zero writes, migrations, or deployments to Cloudflare D1, R2, or Pages.
