# Branch Inventory & Tracking Notes (Phase 1B)

**Last Verified**: 2026-10-06
**Maintainer / Phase 1B authoritative writer**: CodeBuddy
**Independent reviewers / evidence sources**: Codex, Qoder, AGY-Hermes (reviewers only — not writers)
**Status**: HOLD / APPROVAL REQUIRED on all merges and deletions
**Policy**: ZERO branch deletions or pruning in Phase 1B. All local commits preserved.
**Snapshot Basis**: Counts and SHAs below are the **2026-10-06 Phase 1B evidence snapshot**. Where the live repository has since advanced, the current value is annotated inline as `current: …`.

---

## 1. Branch Management Policy

1. **NO DELETE / NO PRUNE**: Absolutely no branch deletion, dropping, or pruning is authorized during Phase 1B.
2. **HOLD ON MERGES**: Merging active feature or agent branches into `main` is strictly deferred until Phase 1C adjudication and CI stabilization.
3. **LOCAL-ONLY PRESERVATION**: The fresh audit finds **20 local-only refs** — defined strictly as *branches with no same-named `origin` ref* — spanning feature branches, agent/worktree bookkeeping refs, the root WIP quarantine ref, and the Phase 1B docs branch. All must remain untouched.
4. **THREE DISTINCT METRICS — DO NOT CONFLATE**:
   - **Local-only (no same-named `origin` ref)** — a *ref-name* test. 20 refs qualify (2026-10-06 snapshot).
   - **Commits ahead of `origin/main`** — a *commit-distance* test, independent of whether a same-named remote ref exists. Reported per branch in §3.
   - **Truly unpushed** — a *reachability* test: the commit exists on **no** remote ref at all. A branch can be "ahead of `origin/main`" yet fully pushed (it has its own remote-tracking ref), and a ref with no same-named remote can still have its commits reachable from another pushed ref.
   (An earlier Qoder figure of "8 local-only ≈ 25 commits" used a different definition and is **not** directly comparable to the 20-ref count here.)

---

## 2. Canonical & Active Branches

| Branch / Ref | Purpose | Base / Head SHA | Remote / Local | Owner / Origin | Risk Level | Action Gate | Last Verified |
|---|---|---|---|---|---|---|---|
| `main` | Production trunk reference | Head: `d5f0619` | Tracking `origin/main` | Central Repository | MEDIUM (Lags active feature work) | NO MERGE / NO REBASE | 2026-10-06 |
| `agent/a01-agy-a1-a3` | Canonical active baseline for A-01 | Head: `0542066` (2026-10-06 snapshot; current: `bcb31f3d`) | Tracking `origin/agent/a01-agy-a1-a3` | AGY / Cell | LOW (Remote verified clean source) | CANONICAL BASE | 2026-10-06 |
| `cleanup/project-health` | Phase 1B documentation baseline | Base: `0542066`<br>Head: `0542066` (**0** commits added above base)<br>Ahead of `origin/main`: **32** | Local-only (no same-named `origin` ref; not yet pushed) | CodeBuddy (Phase 1B authoritative writer) | LOW (Isolated docs-only worktree) | ACTIVE WRITER GATE | 2026-10-06 |
| `wip/a01-site-wip-quarantine-20261004` | Root dirty WIP checkout snapshot | Head: `067937d` | Local-only | Root Workspace | HIGH (87 dirty entries — 2026-10-06 snapshot; current: 88; contains experimental diffs) | QUARANTINE / NO DIRECT ADD | 2026-10-06 |

---

## 3. Local-Only Branches — Fresh Audit (Forbidden to Delete)

The following refs are **local-only** — i.e. they have **no same-named `origin` ref** — as measured on **2026-10-06** via `git ls-remote origin` per branch. This is the authoritative local-only list.

> [!NOTE]
> **The "ahead of `origin/main`" column is a separate metric from local-only status.** A ref can be local-only *and* far ahead of `main`, or local-only *and* level with `main` (0 ahead). "Local-only" describes the absence of a same-named remote ref; it does **not** by itself mean the commits are unpushed (they may be reachable from another pushed ref).

> [!IMPORTANT]
> `rc/d09-freshness-freeze` is **NOT** local-only — it is remote-tracked with matching local/remote SHA (see §4). It must not appear in this list.

| Branch / Ref | Commits Ahead of `origin/main` | Head SHA | Purpose & Content | Risk Assessment | Action Gate |
|---|---|---|---|---|---|
| `agent/a01-slot-d-real-wiring` | 30 | `73d217a` | A-01 Slot D: 高普考資料快照 real wiring onto B's exam modules | HIGH — unpushed core exam wiring | HOLD / APPROVAL REQUIRED |
| `feature/a01-public-noauth-feedback` | 28 | `aa96756` | A-01 Slot C: runtime diagnostics, offline/degraded UX, health identity | HIGH — unpushed diagnostic UX logic | HOLD / APPROVAL REQUIRED |
| `agent/b3-ibrain-search-api` | 29 | `23c756a` | Read-only B2 exam-course Search API implementation | HIGH — unpushed search API endpoints | HOLD / APPROVAL REQUIRED |
| `agent/zh-hant-eval-fp-fix` | 13 | `1b5ea63` | 20-question offline matrix results across sample+greedy models | HIGH — unpushed evaluation benchmark | HOLD / APPROVAL REQUIRED |
| `feat/auto-qwen3-staging-test` | 11 | `937a24c` | 72h boundary verification matrix and `--test-run-at` option | HIGH — unpushed staging test harness | HOLD / APPROVAL REQUIRED |
| `fix/ipad-local-fallback-diagnostics` | 10 | `809efd0` | Homepage V5 frozen snapshot, hero dual CTA, RWD, iPad a11y | HIGH — unpushed UI/a11y fixes | HOLD / APPROVAL REQUIRED |
| `agent/auto-fallback-pipeline-qwen25` | 9 | `291b72b` | Worker version provenance & SHA gate hardening (FS-1) | MEDIUM-HIGH — unpushed worker provenance | HOLD / APPROVAL REQUIRED |
| `feat/auto-fallback-qwen35` | 9 | `291b72b` | Shares head `291b72b` with auto-fallback-pipeline | MEDIUM-HIGH — shared head | HOLD / APPROVAL REQUIRED |
| `feat/auto-mobile-qwen25-fallback` | 9 | `291b72b` | Mobile fallback implementation sharing commit `291b72b` | MEDIUM-HIGH — shared head | HOLD / APPROVAL REQUIRED |
| `integration/qm-runtime-bringup` | 6 | `131c5c0` | Record Phase 5 runtime enablement as ENVIRONMENT_BLOCKED | MEDIUM — unpushed runtime bringup docs | HOLD / APPROVAL REQUIRED |
| `phase4/qm-sandbox-foundation` | 5 | `c310461` | Sandbox foundation Dockerfile for QM sandbox build | MEDIUM — unpushed Docker sandbox commits | HOLD / APPROVAL REQUIRED |
| `worktree-agent-a30972d373d0b7755` | 4 | `c8813c8` | QM trailing blank line fixes flagged by git diff | MEDIUM — unpushed worktree commits | HOLD / APPROVAL REQUIRED |
| `worktree-a01-slot-d-exam-snapshot` | 1 | `3c41ed4` | A-01 Slot D exam snapshot admin shell mock | MEDIUM — unpushed mock contract commit | HOLD / APPROVAL REQUIRED |
| `agent/qwen-grounding-r1-r5` | 0 | `0cd41b2` | Qwen grounding R1–R5 (matches external review worktree `reviews/independent-review-0cd41b2`) | LOW — local-only ref, no commits ahead of `main` | HOLD / APPROVAL REQUIRED |
| `agent/student-rag-grounding-hardening` | 0 | `f170efc` | Student RAG grounding hardening | LOW — local-only ref | HOLD / APPROVAL REQUIRED |
| `chore/retire-ai-quest-a1-qa` | 0 | `2e0ffe2` | Retire A-01 QA assets | LOW — local-only ref | HOLD / APPROVAL REQUIRED |
| `integration-check` | 0 | `ea2dda7` | Integration check (shares SHA `ea2dda7` with `origin/agent/cerebras-rag-integration`) | LOW — local-only ref | HOLD / APPROVAL REQUIRED |
| `worktree-agent-ada2c5b68fec98477` | 0 | `c3002ab` | Agent worktree bookkeeping ref | LOW — local-only ref | HOLD / APPROVAL REQUIRED |
| `wip/a01-site-wip-quarantine-20261004` | — | `067937d` | Root dirty WIP quarantine checkout (see §2) | HIGH — 87 dirty entries (2026-10-06 snapshot; current: 88) | QUARANTINE / NO DIRECT ADD |
| `cleanup/project-health` | **32** | `0542066` | Phase 1B documentation baseline (see §2); **0** commits added *above base* `0542066` (docs still uncommitted) | LOW — isolated docs-only worktree | ACTIVE WRITER GATE |

---

## 4. Remote-Tracking Feature & Release Candidate Branches

| Branch / Ref | Remote Tracking Ref | Head SHA | Purpose / Context | Risk Level | Action Gate | Last Verified |
|---|---|---|---|---|---|---|
| `agent/cerebras-rag-integration` | `origin/agent/cerebras-rag-integration` | `ea2dda7` | Secure Cerebras RAG orchestration | LOW | HOLD | 2026-10-06 |
| `agent/d07-cache-integrity-qwen-e500` | `origin/agent/d07-cache-integrity-qwen-e500` | `dc00ae6` | Freeze b67f28e build instance & offline handoff | LOW | HOLD | 2026-10-06 |
| `agent/qm-feedback-platform` | `origin/agent/qm-feedback-platform` | `fd6373e` | Daily quota reset test date alignment | LOW | HOLD | 2026-10-06 |
| `agent/sites-original-ui-production` | `origin/agent/sites-original-ui-production` | `896f47c` | Same-origin Admin API proxy for chatgpt.site | LOW | HOLD | 2026-10-06 |
| `agent/student-rag-release-gate` | `origin/agent/student-rag-release-gate` | `db8de65` | Exclude redaction-test fixtures from secret scan | LOW | HOLD | 2026-10-06 |
| `rc/d06-auto-fallback-integration` | `origin/rc/d06-auto-fallback-integration` | `52a67f9` | Cold-start download timeout & Google AI consent | LOW | HOLD | 2026-10-06 |
| `rc/d09-freshness-freeze` | `origin/rc/d09-freshness-freeze` | `f6ac8943b4e05fb8aa76cf845e1cffd7eb4a1da3` | F7 72h + 24h holiday deduction freshness policy | LOW | HOLD | 2026-10-06 |
| `rc/homepage-v2-0206b198` | `origin/rc/homepage-v2-0206b198` | `809efd0` | Homepage V5 frozen snapshot | LOW | HOLD | 2026-10-06 |
| `docs/project-secretary-20260919` | `origin/docs/project-secretary-20260919` | `fe028fb` | Governance roles swap (Hermes <-> OpenClaw) | LOW | HOLD | 2026-10-06 |
| `integration/admin-books-availability-clean-e60b708` | `origin/integration/admin-books-availability-clean-e60b708` | `e39b312` | Books availability enforcement across student routes | LOW | HOLD | 2026-10-06 |

> [!NOTE]
> `rc/d09-freshness-freeze` is **remote-tracked, not local-only**: local `f6ac8943b4e05fb8aa76cf845e1cffd7eb4a1da3` == `origin/rc/d09-freshness-freeze` `f6ac8943b4e05fb8aa76cf845e1cffd7eb4a1da3` (same SHA, verified via `git ls-remote`). It therefore does **not** appear in the local-only list in §3.

---

## 5. Worktree Ref Summary & Decommissioning Policy

All **29** worktrees listed in `PROJECT_AUDIT.md` remain under protection. Worktree removal is **APPROVAL REQUIRED** (never SAFE) and is forbidden in Phase 1B. Any future decommissioning must follow this sequence:
1. Verify `git status` inside the specific worktree.
2. If uncommitted work exists, either create a WIP commit or transfer to a dedicated branch.
3. Obtain explicit operator sign-off.
4. Execute `git worktree remove <path>`.
