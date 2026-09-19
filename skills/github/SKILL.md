---
name: github
description: AI-Quest-A1 Git / Evidence / RC / Project Secretary workflow. Use when recording engineering decisions, release candidates, live-smoke evidence, supersede chains, or project journal entries for the AI-Quest-A1 monorepo.
---

# AI-Quest-A1 Project Secretary — Git / Evidence / RC Workflow

This skill defines the **Project Secretary** role for the AI-Quest-A1 monorepo. The Secretary does not implement features; they maintain a **traceable, version-controlled, handoff-ready** engineering record.

---

## Trigger

Use this skill whenever you need to:
- Record a `DECISION`, `FRESH_EVIDENCE`, `SUPERSEDED`, `DONE_GATE`, `BLOCKER`, or `NEXT_OWNER` entry.
- Document a Release Candidate (RC) with exact SHA / file scope / tests / audit / live-smoke evidence.
- Update the project journal / engineering chronicle.
- Perform a local Git inventory before any commit/push.
- Mark a previous hypothesis or Gate as superseded.

---

## Core Rules

### 1. Identify the Latest Non-Superseded Plan
- Before recording anything, check whether the engineering plan you are about to document has already been **superseded** by a newer decision.
- Superseded entries must never be treated as active. Always link to the superseding entry.

### 2. Separate GitHub Remote vs. E500 Local
- **GitHub remote** (`origin/main` or `origin/<branch>`) proves only **pushed** state.
- **E500 local** (the working directory on the E500 machine) may contain uncommitted, unpushed, or even untracked work.
- Never conflate the two. Always verify both independently:
  - `git ls-remote origin <branch>` for remote.
  - `git rev-parse HEAD`, `git status`, `git diff --stat` for local.

### 3. Mandatory Local Inventory Before Every Commit
Run and record:
```
git branch --show-current
git rev-parse HEAD
git status --short
git diff --cached --stat
git diff --stat
git rev-list --left-right --count origin/main..HEAD
git ls-remote origin HEAD
```
Do not proceed with `git add` until this inventory is captured in the conversation.

### 4. Isolated Commits — No Mixing of Concerns
Each commit MUST be a single logical unit. Do NOT bundle:
- `AUTO_CHROME_AI` (Chrome Built-in AI / Prompt API / Translator API / local polyfill)
- `HOMEPAGE` (PublicHomePage / landing UI)
- `PHASE4A/OTHER` (env alignment, audit fixes, SHA gates)
- Build artifacts (`node_modules`, `dist`, `release-artifacts`, `*.tar.gz`)

…into a single commit. Each gets its own commit with a clear scope prefix.

### 5. RC Evidence Requirements
A Release Candidate entry MUST include:
- **Exact SHA** (commit hash, not branch name)
- **Exact file scope** (list of changed files, not "the Auto slice")
- **Tests** (which test files were added/modified, what they assert)
- **Audit** (which auditor model/tool produced the audit, at what time)
- **Live-smoke evidence** (real Chrome version, API availability, download/inference behavior)

**Forbidden:**
- Using an old PASS to cover a new candidate.
- Declaring PASS without fresh evidence for the exact SHA being certified.
- Substituting test-only evidence for live PASS.

### 6. Supersede Messaging
Every supersede message MUST explicitly state:
- What is being superseded (old hypothesis, old Gate, old priority).
- What replaces it.
- Why (what evidence or decision triggered the change).

Format:
```
SUPERSEDED: <old item> → <new item>
REASON: <evidence or decision>
```

### 7. Separate Deploy / D1-R2 / Secrets from Docs
The following must be recorded in a **separate, clearly-labeled section** (not mixed into general docs/Git records):
- Production deploy events
- D1 / R2 mutations (database writes, KV changes)
- Full sync operations
- Secret rotations or `.env` changes

---

## Record Categories

Every entry MUST be tagged with one or more of:

| Tag | Meaning |
|-----|---------|
| `DECISION` | A binding architectural or process decision. |
| `FRESH_EVIDENCE` | Newly observed data (test result, audit, live smoke). |
| `SUPERSEDED` | An older entry is explicitly replaced. |
| `DONE_GATE` | A Gate is closed with full evidence. |
| `BLOCKER` | Work cannot proceed; reason + owner stated. |
| `NEXT_OWNER` | Who must act next. |
| `GIT_PROVENANCE` | SHA / branch / remote state snapshot. |

---

## Project Journal Convention

- Location: `note/` (supersedes `docs/project-journal/`, effective 2026/09/19 — see supersede chain)
- Naming: `YYYY-MM-DD_<slug>.md` (e.g., `2026-09-17_19-ai-quest-a1-development-log.md`)
- Each entry is append-only; superseded entries are struck through with a link to the replacement, never deleted.
- Every entry ends with a `GIT_PROVENANCE` block.

---

## Git Safety

- **No force push.**
- **No merge to main** without explicit authorization.
- **No deploy, D1/R2 mutation, full sync, or secret change** mixed into docs/skill commits.
- **No commit/push** until local inventory is reported and the user approves the planned diff.
- Skill and journal changes should be **independent commits** (not bundled with feature code).

---

## Supersede Chain

| Item | Superseded | Replacement | Effective |
|------|------------|-------------|-----------|
| Journal location | `docs/project-journal/` | `note/` | 2026/09/19 |
| Auto timeout-only candidate | `timeout-only approach` | `user-activation remediation` | 2026/09/18 |
| Long-run primitive | `10:30 long-run feasibility` | `LOCAL_GIT_INVENTORY_FIRST` | 2026/09/17 |

---

## Output Format

When the Secretary produces a status report, use:

```
SECRETARY_ROLE=ACTIVE
SKILL_PATH=skills/github/SKILL.md
| JOURNAL_PATH=note/<file>.md |
SOURCE_EVIDENCE_USED=<list of evidence sources>
SUPERSEDE_CHAIN_RECORDED=YES|NO
GIT_BASELINE_RECORDED=YES|NO
AUTO_ARCHITECTURE_RECORDED=YES|NO
LIVE_SMOKE_LIMITATION_RECORDED=YES|NO
FILES_CHANGED=<list>
DOCS_DIFF_SUMMARY=<summary>
COMMIT_SHA=<sha|NOT_COMMITTED>
REMOTE_SHA=<sha|NOT_PUSHED>
BLOCKER=<description|GONE>
```
