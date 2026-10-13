# Repository Health & Remediation Cleanup Plan (Phase 1B)

**Date**: 2026-10-06
**Status**: DRAFT (Phase 1B Documentation Gate)
**Maintainer / Phase 1B authoritative writer**: CodeBuddy
**Independent reviewers / evidence sources**: Codex, Qoder, AGY-Hermes (reviewers only — not writers)
**Target Branch**: `cleanup/project-health`
**Base Commit SHA**: `054206670ed5db9c1501a5cce3fa0c6f9635e06c` (`origin/agent/a01-agy-a1-a3`; 2026-10-06 snapshot — the A-01 remote head has since advanced to `bcb31f3d`)
**Scope Classification**: SAFE / REVIEW / APPROVAL REQUIRED / FORBIDDEN

---

## 1. Classification & Safety Framework

All remediation tasks are strictly bucketed into four risk categories:

| Category | Description | Operational Gate |
|---|---|---|
| **SAFE** | Non-breaking documentation, baseline licenses, read-only analysis, and isolated non-invasive script fixes. | Single-writer autonomous execution permitted. |
| **REVIEW** | Configuration, dependency version pinning, CI workflows, and package manager alignment. | Operator or peer review required prior to merge. |
| **APPROVAL REQUIRED** | Worktree pruning, branch archival, filesystem permission changes, database modifications, and legacy directory retirement. | Explicit Operator authorization required before execution. |
| **FORBIDDEN** | Destructive git commands (`git clean -fdx`, `git reset --hard`), force-pushes, secret mutations, unreviewed trunk merges, and unauthorized cloud deployment. | Strictly barred under all circumstances. |

---

## 2. Remediations & Task Matrix

### Task 1: Project Documentation & Health Audit Baseline
- **Category**: `SAFE`
- **Problem**: Lack of authoritative single-source audit and governance documentation across fragmented multi-agent runs.
- **Cause**: Concurrent agent iterations without unified documentation gating.
- **Change**: Author `PROJECT_AUDIT.md`, `CLEANUP_PLAN.md`, `docs/maintenance/AGENT_MAINTENANCE_GUIDE.md`, and `docs/maintenance/BRANCH_NOTES.md` in isolated branch `cleanup/project-health`.
- **Scope**: Exactly 4 markdown documents; no code or dependency files modified.
- **Validation**: `git diff --check`, secret scanning, path verification.
- **Rollback**: Discard uncommitted documentation changes only. **NO prune, NO ref deletion.** On failure, **keep the isolated worktree and the `cleanup/project-health` branch intact and STOP** — do not delete the worktree, do not delete the branch, do not `git reset --hard` / `git clean`.

### Task 2: README Rebuildability & Setup Instructions Refresh
- **Category**: `REVIEW`
- **Problem**: Root `README.md` rebuildability is POOR; setup instructions do not reflect the current monorepo and `site/` architecture.
- **Cause**: Documentation lag during rapid multi-agent feature iterations.
- **Change**: Update `README.md` with explicit prerequisites (README floor Node >= 20; `site` requires Node >= 22.13.0; root `pnpm` 9.15.0), workspace layout description, and step-by-step installation instructions.
- **Scope**: `README.md`.
- **Validation**: Verify markdown formatting and relative link targets.
- **Rollback**: Non-destructive only — revert the single file (`git checkout -- README.md`). Do **not** delete files and do **not** restore from an external backup; if the revert fails, keep the file and STOP for operator review.

### Task 3: Root Script Hardcoded Path Normalization
- **Category**: `SAFE`
- **Problem**: `package.json` line 19 defines `typecheck:release-scripts` with hardcoded `./apps/AI-adm-D1/node_modules/.bin/tsc` and hardcoded types paths.
- **Cause**: Fragile local path referencing bypassing pnpm workspace hoisting.
- **Change**: Refactor the script to use workspace-standard `tsc` invocation or pnpm recursive filter `pnpm --filter AI-adm-D1 exec tsc`.
- **Scope**: `package.json` (`scripts.typecheck:release-scripts`).
- **Validation**: Dry-run script command evaluation.
- **Rollback**: Restore original script definition in `package.json`.

### Task 4: Missing LICENSE File Baseline Addition
- **Category**: `SAFE`
- **Problem**: `README.md` displays an MIT License badge referencing `LICENSE`, but the file is missing from the repository root.
- **Cause**: Repository initialized without standard license artifact.
- **Change**: Add standard MIT `LICENSE` matching the README declaration.
- **Scope**: `LICENSE` in repository root.
- **Validation**: Inspect file existence and text format.
- **Rollback**: Non-destructive only — revert the newly added `LICENSE` via git; do **not** hand-delete files, and any removal requires explicit operator approval. If unsure, keep the file and STOP.

---

### Task 5: Hidden Project Specs Un-exclusion (`.git/info/exclude`)
- **Category**: `REVIEW`
- **Problem**: Project specifications (`FOUNDATION_ROUND3_TASK.md`, `docs/DUAL_MACHINE_QA_SPEC.md`, `scripts/e500-qa-verify.sh`) are hidden in `.git/info/exclude`.
- **Cause**: Ephemeral testing exclusions left behind in local git config.
- **Change**: Evaluate hidden files for canonical value; remove entries from `.git/info/exclude` and track legitimate files or ignore via `.gitignore`.
- **Scope**: `.git/info/exclude`, `.gitignore`.
- **Validation**: `git status --ignored` inspection across clean worktrees.
- **Rollback**: Re-add excluded paths to `.git/info/exclude`.

### Task 6: Package Manager Harmonization (`site/` npm vs Monorepo pnpm)
- **Category**: `REVIEW`
- **Problem**: Dual package managers (`pnpm` at root vs `npm` in `site/` with committed `site/package-lock.json`) cause inconsistent dependencies and duplicate trees.
- **Cause**: `site/` sub-application was developed as an isolated project before monorepo inclusion.
- **Change**: Integrate `site/` into `pnpm-workspace.yaml`, migrate `site/package-lock.json` into the root pnpm lockfile, or clearly isolate the boundary.
- **Scope**: `pnpm-workspace.yaml`, `site/package.json`, `site/package-lock.json`.
- **Validation**: `pnpm install --frozen-lockfile` verification in a dedicated isolated test container.
- **Rollback**: Restore `site/package-lock.json` and keep separate package manager execution.

### Task 7: Pinning 48 Floating `"latest"` Dependencies
- **Category**: `REVIEW`
- **Problem**: 48 packages across `packages/*/package.json` and `apps/*/package.json` use `"latest"` versions, causing non-deterministic builds.
- **Cause**: Rapid prototyping without version locking.
- **Change**: Replace all `"latest"` declarations with concrete semver ranges based on current resolved lockfile versions.
- **Scope**: 12 `package.json` files in `packages/` and `apps/`.
- **Validation**: Run typecheck and unit tests across affected packages.
- **Rollback**: Revert modified `package.json` files to previous commit.

### Task 8: Node Engine Specification Alignment
- **Category**: `REVIEW`
- **Problem**: `site/package.json` specifies `"node": ">=22.13.0"`, while root `package.json` lacks an `engines` declaration.
- **Cause**: Independent manifest maintenance.
- **Change**: Define consistent `"engines"` in root `package.json` and add `.nvmrc`. **Repository-backed requirement**: `"node": ">=22.13.0"` (matches `site/package.json`). **Proposed / forward-looking policy (NOT repo-backed)**: the `"pnpm"` floor — the repo currently runs `pnpm` **9.15.0** (`pnpm-lock.yaml` `lockfileVersion: 9.0`), so a `">=11.0.0"` floor has **no in-repo evidence** and must be stated as a *proposed future policy*; otherwise use the repository-backed `">=9.15.0"`.
- **Scope**: `package.json`, `.nvmrc`.
- **Validation**: `node -v` compatibility check against declared constraints.
- **Rollback**: Revert `package.json` and remove `.nvmrc`.

### Task 9: Baseline CI Workflow Definition (`.github/workflows/ci.yml`)
- **Category**: `REVIEW`
- **Problem**: Zero CI automation exists; pull requests cannot be automatically validated.
- **Cause**: CI workflow infrastructure was never initialized.
- **Change**: Author minimal CI workflow (`.github/workflows/ci.yml`) executing lint, typecheck, and unit test suites on pull requests.
- **Scope**: `.github/workflows/ci.yml`.
- **Validation**: GitHub Actions syntax validation using schema parser.
- **Rollback**: Remove `.github/workflows/ci.yml`.

### Task 10: GitHub Branch Protection Policy for `main`
- **Category**: `REVIEW`
- **Problem**: `main` branch protection is disabled (`protected=false`), risking accidental direct pushes or destructive mutations.
- **Cause**: Initial repository settings left at default.
- **Change**: Formulate GitHub Ruleset recommendation: require PR reviews, require CI pass, dismiss stale reviews, forbid force pushes. (No remote API change performed by agent).
- **Scope**: Repository governance policy documentation.
- **Validation**: Review policy text with repository owner.
- **Rollback**: N/A (Documentation/recommendation only).

---

### Task 11: Untracked `site/app/local-inference-worker.ts` Adjudication
- **Category**: `APPROVAL REQUIRED`
- **Problem**: Untracked worker script exists in dirty root snapshot but is missing from clean canonical remote base `0542066`.
- **Cause**: Leftover experimental code from dirty A-01/quarantine work.
- **Change**: Present diff analysis to operator; obtain explicit operator decision whether to adopt into `site/app/` or discard.
- **Scope**: `site/app/local-inference-worker.ts`.
- **Validation**: Functional verification of local inference fallback if adopted.
- **Rollback**: Non-destructive only — retain the artifact in the quarantine tree (do **not** delete). No worktree or branch deletion.

### Task 12: Pruning Ephemeral / Stale Worktrees
- **Category**: `APPROVAL REQUIRED`
- **Problem**: 28 worktrees consume filesystem space, retain file locks, and cause cognitive overhead.
- **Cause**: Multi-agent sessions created individual worktrees without decommissioning gates.
- **Change**: Prune detached/prunable worktrees (`reviews/independent-review-0cd41b2`, `/tmp/d06-base-lint`) and archive unneeded agent worktrees after preserving uncommitted work.
- **Scope**: Git worktree metadata and directories.
- **Validation**: `git worktree list`.
- **Rollback**: Recreate worktree from tracked branch.

### Task 13: Local-Only Branch Consolidation & Archival
- **Category**: `APPROVAL REQUIRED`
- **Problem**: An earlier figure ("8 local-only branches ≈ 25 unpushed commits") conflated three distinct metrics. The fresh Phase 1B audit (2026-10-06) finds **20 local-only refs** (no same-named `origin` ref), and the commit-distance / truly-unpushed status is reported per branch — see `BRANCH_NOTES.md` §1 and §3 for the separated metrics. Do **not** read "local-only" as synonymous with "unpushed".
- **Cause**: Local agent branches were never pushed or merged upstream.
- **Change**: Create archive tags (e.g. `archive/<branch-name>-202610`) to preserve all commits. Any actual branch removal requires explicit operator authorization; this task is **APPROVAL REQUIRED** and must not be marked SAFE.
- **Scope**: Git branch and tag references.
- **Validation**: `git tag -l "archive/*"`, verify commit reachability.
- **Rollback**: Non-destructive only — recreate local branch pointers from the preserved archive tags; **never** delete refs. On failure, keep all branches and tags intact and STOP.

### Task 14: Sensitive File Permissions Hardening
- **Category**: `APPROVAL REQUIRED`
- **Problem**: `.env.test` and SQLite databases (`data/*.db*`) possess `644` permissions, exposing sensitive test tokens and data locally.
- **Cause**: Default umask during file creation.
- **Change**: Execute `chmod 600` on `.env.test`, `.env`, and database files once operator approves.
- **Scope**: Filesystem permissions on `.env*` and `data/*.db*`.
- **Validation**: `ls -la .env* data/*.db*`.
- **Rollback**: `chmod 644 <target>`.

### Task 15: Legacy Duplicate & Backup Directories Retirement
- **Category**: `APPROVAL REQUIRED`
- **Problem**: Directories such as `testweb.bak-20260922_2105/`, `Programming-Backup/`, `.cleanup-backup-20260807/`, and `release-artifacts/` bloat repository size.
- **Cause**: Manual and automated snapshotting during previous phases.
- **Change**: Move to a non-destructive quarantine path (or off-repo archive storage) after operator confirmation. Do **not** purge in place.
- **Scope**: Stale directory trees outside source code.
- **Validation**: Repository file tree verification.
- **Rollback**: Non-destructive quarantine/move plan — move directories back from quarantine (do **not** rely on restoring from a backup archive, and do **not** purge). On failure, keep originals and STOP.

---

### Task 16: Destructive Working Tree Clean or Reset
- **Category**: `FORBIDDEN`
- **Problem**: Running `git clean -fdx` or `git reset --hard` in dirty root or active worktrees destroys uncommitted agent WIP and diagnostic state.
- **Policy**: Absolutely prohibited.

### Task 17: History Rewriting, Force-Pushing, or Rebasing Shared Branches
- **Category**: `FORBIDDEN`
- **Problem**: Rewriting history breaks distributed agent collaboration and invalidates cryptographic audit trails.
- **Policy**: Absolutely prohibited. Push policy strictly enforces `LOCAL_SHA == REMOTE_SHA` fast-forward only.

### Task 18: Direct Unreviewed Merges into `main`
- **Category**: `FORBIDDEN`
- **Problem**: Direct merging bypasses validation gates, test suites, and audit reviews.
- **Policy**: All merges to `main` must pass peer review and CI checks.

### Task 19: Unsanctioned Cloudflare D1/R2 Mutations or Deployments
- **Category**: `FORBIDDEN`
- **Problem**: Mutating production cloud databases or edge workers risks service outage or data corruption.
- **Policy**: Strictly prohibited without explicit operator authorization.

### Task 20: Storing or Committing Active Credentials and Secrets
- **Category**: `FORBIDDEN`
- **Problem**: Committing credentials exposes production infrastructure and violates security policy.
- **Policy**: Zero secrets allowed in source control. Any detected secrets must be revoked immediately.
