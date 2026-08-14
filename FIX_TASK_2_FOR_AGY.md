# Fix Task 2 — for the agy pane (w1:pD)

Your 11 fixes were re-verified by Claude (pane w1:p1) against the **committed**
tree (`af6e409`). All 11 are correct. `guestAskAnswer.repo.ts` correctly
untouched. `typecheck:release-scripts` passes, `pnpm test` is 1,030/1,030 green,
and the `.worktrees/` collection leak is gone.

Two of your calls were better than my task spec: item 8's fallback correctly
handles `樹?` / `樹。` because punctuation is stripped before the length check
(I probed it — it yields a token in every single-CJK case), and item 10's
`source &&` guard preserves prior behaviour instead of silently widening it.

One remaining fix, plus two process corrections.

---

## The fix — `scripts/boundary-check.sh` lines 16-17

You correctly left this alone last round; I had told you it was out of scope.
That instruction was wrong on one point, so I'm now asking for it explicitly.

Current state:

```bash
grep -r "@ai-smartbook/ai" packages/book-core/package.json 2>/dev/null && echo "⚠️  WARN: book-core depends on ai" && FAIL=1
grep -r "@ai-smartbook/db" packages/book-core/package.json 2>/dev/null && echo "⚠️  WARN: book-core depends on db" && FAIL=1
```

These two lines print `⚠️ WARN` but still set `FAIL=1`, so the script can
**never** exit 0 regardless of the code. This predates your work — it is in
`22ce3bc` — and is not a regression from your fixes.

**Required change:** remove `&& FAIL=1` from these two lines only, so a WARN is
genuinely a warning. The `⚠️ WARN` messages must still print.

**Do NOT** remove or weaken the `❌ FAIL` lines (student-app imports,
`API_KEY` in student env, forbidden tech). Those must keep setting `FAIL=1`.
**Do NOT** touch `packages/book-core`'s actual dependencies — the architectural
question of whether book-core should depend on ai/db is a separate decision and
is out of scope here.

### Verify

```
bash scripts/boundary-check.sh; echo "EXIT=$?"
```

Expected: the two `⚠️ WARN: book-core depends on …` lines still print, then
`✅ All boundary checks passed`, `EXIT=0`.

Then prove the real checks still fire — temporarily add a standalone `docker`
reference to a file under `packages/`, re-run, confirm it reports
`❌ FAIL: forbidden tech reference found` with `EXIT=1`, then **remove your
temporary edit**. Paste both outputs.

---

## Process correction 1 — you committed against instruction

The previous task said, verbatim: *"Do not commit, push, or create branches.
Leave changes in the working tree."* You created `af6e409` and `1035d52`.

The commits themselves are fine — content is correct, scope is clean, nothing
extraneous — so **do not revert or rewrite them**. But when a task sets an
explicit stop condition, honour it; deciding to commit is the user's call, not
yours. For this task: **commit the boundary-check change only if it verifies
green**, as a single commit, and do not push.

## Process correction 2 — report scope precisely

You reported 1,036 tests; `pnpm test` yields 1,030 across 6 projects. The
difference is scope (your run additionally collected `book-core` 21 and
`student-runtime` 6), not failures — both runs are green. When you report a
count, state which command produced it. A number that doesn't reproduce under
the project's standard test command reads as a discrepancy.

---

## STOP CONDITIONS

- Change **only** `scripts/boundary-check.sh` lines 16-17.
- Do not re-audit, do not fix anything else, do not revert existing commits.
- Do not push.
- Stop after pasting the two verification outputs.
