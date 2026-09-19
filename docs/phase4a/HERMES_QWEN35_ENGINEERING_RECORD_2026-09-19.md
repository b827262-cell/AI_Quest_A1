# Hermes Engineering Record — Qwen3.5-0.8B Auto Candidate

**Record date:** 2026-09-19
**Scope:** documentation-only provenance record for the isolated Qwen3.5 candidate.
**Repository/worktree:** `/home/b827262/project/AI-Quest-A1/.worktrees/auto-fallback-qwen35`
**Branch:** `agent/auto-fallback-qwen35`

## DECISION

- The only candidate for this handoff is code commit
  `aa2ef3405b1c66090e2e7f7dda3133303909d745` on
  `agent/auto-fallback-qwen35`. Its parent is
  `291b72b2b694364a3967ccbb241ac9f51adfdca4`.
- Audit and any GitHub upload are limited to the four-file whitelist: the three
  code/test/type files in that code commit and its Codex Desktop handoff
  document. This record is a separate docs-only addition.
- The unrelated Auto RC `rc/auto-chrome-built-in-a1-37d89f2` is not evidence,
  source, or a QA substitute for this candidate. No result from it may be
  transplanted here.

## FRESH_EVIDENCE

- `git cat-file -t aa2ef...` returned `commit`; the isolated worktree
  `HEAD` resolved to `aa2ef3405b1c66090e2e7f7dda3133303909d745` before this
  documentation commit.
- `git show --name-status aa2ef...` showed exactly:
  `site/app/chrome-built-in-ai.ts`, `site/tests/chrome-built-in-ai.test.mjs`,
  `site/types/prompt-api-polyfill.d.ts`, and
  `docs/phase4a/QWEN35_AUTO_CODEX_DESKTOP_HANDOFF_2026-09-19.md`.
- The source pins `onnx-community/Qwen3.5-0.8B-ONNX` and maps
  `webgpu` to ordered `q4f16`, then `q8`; it maps `wasm` to `q8`.
  These dtype values select Transformers.js `_quantized.onnx` artifacts.
  The older Hermes proposal to use the dtype name `quantized` is
  **SUPERSEDED** and must not be restored.
- Prior recorded focused evidence for this exact code commit is build, focused
  TypeScript check, focused ESLint, and the Chrome AI test file: **20/20
  PASS**. This is engineering/static evidence only; it is not an independent
  Qwen model inference pass.
- This record's post-audit rerun also passed: `npm run build`,
  `npx tsc --noEmit app/chrome-built-in-ai.ts`,
  `NODE_ENV=test node --import tsx --test --test-concurrency=1
  tests/chrome-built-in-ai.test.mjs`, `npx eslint app/chrome-built-in-ai.ts
  tests/chrome-built-in-ai.test.mjs`, and `node --import tsx
  scripts/scan-secrets.ts` (0 secrets). The build emitted only its standard
  >500 kB chunk advisory.

## SUPERSEDED

- `4d2a6b8e84196032dd1527e71c06de76ac4e5bd5` is not present in the shared
  object database and `agent/auto-fallback-qwen35-e500` is absent. Neither is
  a valid handoff source.
- Any QA claim belonging to `rc/auto-chrome-built-in-a1-37d89f2` is out of
  scope for this branch.
- `quantized` dtype terminology is superseded by the concrete q4f16/q8 mapping
  above.

## DONE_GATES

| Gate | Status | Evidence / boundary |
| --- | --- | --- |
| Code provenance | PASS | Exact commit and whitelist verified locally. |
| Whitespace audit | PASS | `git diff --check` for parent..code commit returned success. |
| Focused engineering tests | PASS | 20/20 prior focused tests; post-audit build/tsc/focused test/lint rerun also passed. |
| Qwen inference | NOT INDEPENDENTLY PASS | No verified actual Qwen generation result exists for this exact commit. |
| Browser model download | ENV_BLOCKED | Actual model download remains incomplete; observedAnswer is `null`. |
| Live deployment | NOT DONE | No Sites save/deploy, production, D1, R2, hosting, or secrets mutation is permitted or performed. |

## BLOCKER

- Headless Chrome cannot supply the real user activation required for the
  physical model download. No answer to `你好嗎？` from Qwen is observed; do not
  treat RWD, cloud-zero interception, mocks, or `observedAnswer=null` as a
  model-answer pass.
- A Sites WASM artifact was measured at **26,861,777 bytes**, exceeding the
  25 MB limit. The Sites source-to-worktree mapping also remains unresolved.
  These are release blockers, and this candidate is
  **PRE_RELEASE / NOT_LIVE_VERIFIED**.
- The present environment cannot resolve `github.com` for `git ls-remote`.
  A push must stop if remote topology cannot be proven or if authorization
  fails; force push, rebase, and merges to `main` are prohibited.

## NEXT_OWNER

Codex Desktop operator, in a Chrome environment with genuine user activation
and usable GPU, must download the actual model and verify a Traditional Chinese
Qwen response to `你好嗎？`. Before any user-operated Sites publication, verify
the source mapping and the 25 MB WASM limit. This record author has not
published or deployed anything.

## COMMIT_PROVENANCE

```text
CODE_COMMIT_SHA = aa2ef3405b1c66090e2e7f7dda3133303909d745
CODE_PARENT_SHA = 291b72b2b694364a3967ccbb241ac9f51adfdca4
BRANCH          = agent/auto-fallback-qwen35
REPO_PATH       = /home/b827262/project/AI-Quest-A1/.worktrees/auto-fallback-qwen35
```

## CODEX_DESKTOP_HANDOFF

Read `docs/phase4a/QWEN35_AUTO_CODEX_DESKTOP_HANDOFF_2026-09-19.md` together
with this record. Only the isolated worktree and the SHA above are valid.
Treat the candidate as PRE_RELEASE/NOT_LIVE_VERIFIED until the real-browser
QA and Sites preflight blockers are resolved. GitHub branch push, when remote
connectivity permits it, is a handoff mechanism only and never proves release
or deployment readiness.
