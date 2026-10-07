# Agent Maintenance & Engineering Guide

**Version**: 1.0.0 (Phase 1B Baseline)
**Maintainer / Phase 1B authoritative writer**: CodeBuddy
**Independent reviewers / evidence sources**: Codex, Qoder, AGY-Hermes (reviewers only — not writers)
**Target Audience**: All AI Coding Agents & Human Maintainers
**Repository**: `/home/b827262/project/AI-Quest-A1`
**Governance Model**: Single-Writer per Phase / Multi-Agent Review

---

## 1. Single-Writer Authority & Concurrency Protocol

To prevent collision, file corruption, and untracked conflicts in multi-agent environments:
1. **Single Designated Writer**: Only ONE agent holds write permissions for any given phase or gate (e.g., CodeBuddy for Phase 1B).
2. **Read-Only / Hold State for Other Agents**: All other concurrent agents must operate in read-only observation mode until the active gate is closed and adjudicated.
3. **Dedicated Isolated Worktree**: Every writing session must operate inside a dedicated, isolated git worktree created specifically for the task. Writing directly to dirty root or shared worktrees is strictly forbidden.

---

## 2. Standard Engineering Cycle

All modifications must adhere to the 5-step engineering cycle:

```
┌───────────┐     ┌───────────┐     ┌───────────┐     ┌───────────┐     ┌───────────┐
│  OBSERVE  │ ──> │  CHANGE   │ ──> │   TEST    │ ──> │REVIEW DIFF│ ──> │  COMMIT   │
└───────────┘     └───────────┘     └───────────┘     └───────────┘     └───────────┘
```

1. **Observe**:
   - Inspect baseline SHA, git branch, and worktree clean status.
   - Verify uncommitted local changes and isolate them before touching files.
2. **Change**:
   - Make minimal, targeted modifications strictly within the authorized scope.
   - Do not reformat unrelated files or run blanket formatting tools.
3. **Test / Validate**:
   - Run side-effect-free syntax and consistency checks (`git diff --check`, lint, typecheck where authorized).
   - Verify that no secrets, credentials, or machine-specific tokens are written.
4. **Review Diff**:
   - Execute `git diff` and `git status --short`.
   - Verify that **ONLY** authorized paths appear in the diff.
5. **Commit**:
   - Stage exact, explicit file paths only (`git add <file1> <file2>`).
   - Never use blanket staging commands.

---

## 3. Commit & Staging Hygiene

### 3.1 Strict Prohibition on Blanket Staging
> [!CAUTION]
> **NEVER run `git add .` or `git add -A`** in any dirty, mixed, or quarantine worktree.
> Always stage explicit file paths:
> `git add path/to/specific-file.md`

### 3.2 Commit Message Specification
All commit messages must strictly follow the Conventional Commits specification:

```
<type>(<scope>): <short description in present tense>

[optional body explaining rationale, problem, and solution]

[optional footer with reference issue / PR]
```

- Allowed `<type>` values:
  - `feat`: New user-facing feature or API capability.
  - `fix`: Bug fix or error resolution.
  - `docs`: Documentation-only updates.
  - `chore`: Tooling, configuration, or maintenance changes.
  - `refactor`: Code reorganization without functional changes.
  - `test`: Adding or correcting tests without code changes.
- `<scope>` examples: `(cleanup)`, `(audit)`, `(governance)`, `(admin)`, `(site)`.

---

## 4. Safety Invariants & Forbidden Operations

Under HOST_DIRECT execution, the following actions are strictly **FORBIDDEN** unless explicitly authorized by the Operator:

| Prohibited Operation | Rationale |
|---|---|
| `git push --force` / `--force-with-lease` | Destroys commit history and corrupts multi-agent synchronization. |
| `git reset --hard` | Irreversibly deletes uncommitted or local agent work in progress. |
| `git clean -fdx` | Destroys untracked diagnostic data, mock assets, and local caches. |
| Rebasing shared branches | Invalidates collaborator SHAs and breaks worktree attachments. |
| Deleting branches or worktrees | High risk of permanent data loss for local-only work. |
| Writing active secrets to files | Violates zero-secret security policy. |
| Modifying Cloudflare D1 / R2 / Worker | Production cloud operations require human operator approval. |

---

## 5. Remote Push Protocol

When remote push is explicitly authorized by the operator:
1. Only perform standard fast-forward pushes (`git push origin <branch>`).
2. Verify remote head parity:
   ```bash
   git ls-remote origin refs/heads/<branch>
   ```
3. Confirm `LOCAL_SHA == REMOTE_SHA` post-push.
4. If remote has diverged, **STOP** immediately and report back without force-pushing.

---

## 6. Task Reporting Format & Rollback Protocol

### 6.1 Task Completion Report Format
When concluding an assigned gate, agents must output a structured status summary:

```text
PHASE_STATUS: [READY | BLOCKED]
BASE_SHA: <sha>
BRANCH: <target-branch>
WORKTREE: <worktree-path>
FILES_CHANGED: <count-and-paths>
DIFF_CHECK: [PASS | FAIL]
SECRET_SANITY: [CLEAN | VIOLATION]
ONLY_ALLOWED_PATHS: [YES | NO]
ROOT_WIP_UNCHANGED: [YES | NO]
FROZEN_A01_UNCHANGED: [YES | NO]
RISK_SUMMARY: <concise summary of residual risks>
BLOCKER: <blocker detail or NONE>
STOP_WRITING: YES
```

### 6.2 Rollback Procedures
If an edit produces unexpected diffs or fails validation:
1. **Uncommitted Changes**:
   ```bash
   git checkout -- <file-path>
   # or for newly created untracked files:
   rm -f <file-path>
   ```
2. **Committed Changes (Pre-Push)**:
   ```bash
   git revert <commit-sha> --no-edit
   # Or reset only within dedicated private worktree:
   git reset --soft HEAD~1
   ```
3. Never perform hard resets or cleanups on root or shared worktrees.
