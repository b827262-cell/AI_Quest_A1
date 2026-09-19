# PROJECT_SECRETARY_SKILL — Summary & Index

> **Readable index** of the formal Project Secretary skill. For the full canonical source, see the **Formal Skill Path** below.

---

## 1. Role Summary

The **Project Secretary** maintains a traceable, version-controlled, handoff-ready engineering record for the AI-Quest-A1 monorepo. The Secretary does **not** implement features — they maintain evidence chains, supersede records, gate provenance, and ownership handoff.

**Active since:** 2026/09/17
**Note directory:** `note/` (supersedes `docs/project-journal/`)
**Last provenance re-verification:** 2026/09-19 11:31 CST
**Canonical repo path:** `/home/b827262/project/AI-Quest-A1` (`PATH_RESOLUTION` — user-specified `/home/project/AI-Quest-A1` does not exist)

---

## 2. Formal Skill Path

| Item | Location |
|------|----------|
| **Formal Skill (canonical)** | `skills/github/SKILL.md` |
| **Note index (this file)** | `note/PROJECT_SECRETARY_SKILL.md` |

> The `skills/github/SKILL.md` file is the **source of truth**. This note exists only as a readable index and entry point.

---

## 3. Record Categories (Tags)

Every entry in `note/` MUST carry one or more of these tags:

| Tag | Purpose |
|-----|---------|
| `DECISION` | Architecture / pipeline / policy choices that affect subsequent work |
| `FRESH_EVIDENCE` | Live-smoke results, audit outputs, real verification data |
| `SUPERSEDED` | Prior decisions/hypothesies that are no longer active (with replacement) |
| `DONE_GATE` | A verification gate fully passed and closed |
| `BLOCKER` | An unresolved issue blocking forward progress |
| `NEXT_OWNER` | Handoff / ownership assignment for open work |
| `GIT_PROVENANCE` | Exact SHA / branch / ls-remote state for reproducibility |

---

## 4. Core Workflow Rules (from `skills/github/SKILL.md`)

1. **Always identify the latest non-superseded plan** before recording.
2. **Separate GitHub remote vs. E500 local** — never conflate the two.
3. **Mandatory local inventory before every commit**:
   ```
   git branch --show-current
   git rev-parse HEAD
   git status --short
   git diff --cached --stat
   git diff --stat
   git rev-list --left-right --count origin/main..HEAD
   git ls-remote origin HEAD
   ```
4. **Isolated commits** — no mixing of AUTO / Homepage / Phase4A / skill/docs into a single commit.
5. **RC evidence** requires exact SHA + file scope + tests + audit + live-smoke.
6. **Supersede messages** must state: what is superseded → what replaces it → why.
7. **Deploy / mutation safety boundary** — production deploy, D1/R2, sync, secret rotation are strictly separated from docs/skill commits.

---

## 5. Current Note Directory Contents

| File | Description |
|------|-------------|
| `note/2026-09-17_19-ai-quest-a1-development-log.md` | Development chronicle for 2026/09/17–09/19 |
| `note/PROJECT_SECRETARY_SKILL.md` | This file — index and summary |

---

## 6. Supersede Chain

| Superseded | Replacement | Reason |
|------------|-------------|--------|
| `docs/project-journal/` | `note/` | User-designated canonical location (2026/09/19) |
| `timeout-only candidate` | `user-activation remediation` | Real Chrome live smoke proved user-gesture required |
| `10:30 long-run primitive feasibility` | `LOCAL_GIT_INVENTORY_FIRST` | 9/17–09/19 local Git must be reconciled first |

---

## 7. Safety Boundaries

- **DO NOT** touch production deploy / D1 / R2 / sync / `.env` in docs/skill commits.
- **DO NOT** commit before the local Git inventory is complete (currently `BLOCKER`).
- **DO NOT** bundle skill/docs commits with functional code.
- **DO NOT** force push, reset DB, or expose secrets.

---

*Last updated: 2026-09-19 · Points to `skills/github/SKILL.md` as canonical source*
