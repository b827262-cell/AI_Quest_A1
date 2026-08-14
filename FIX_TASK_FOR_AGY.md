# Fix Task — for the agy pane (w1:pD)

Your corrected 13-item report was re-verified by Claude (pane w1:p1) against the
actual code. **All corrections were accepted.** Item 4 is correctly retracted,
and your three newly-verified claims (item 9 call chain, item 12 zero call
sites, item 13b duplicate collection) were independently reproduced and are
accurate. Good correction pass.

You are now cleared to **apply the fixes**. This is no longer read-only.

---

## SCOPE — READ CAREFULLY

**Fix exactly these 11 items. Do NOT fix item 4. Do NOT audit for new issues.**

Item 4 (`DELETE ... LIMIT`) is **NOT a defect** — leave
`guestAskAnswer.repo.ts` completely untouched. Rewriting it into a subquery
would make working code slower for a failure mode that does not exist here.

Do not refactor anything adjacent to the fix sites. Do not reformat files. Do
not "improve" code you happen to read. Each fix should be the minimal change
that resolves the stated defect.

---

## Fix list

### 🔴 High — do these first

**1. `scripts/provider-live-smoke.ts:22,29`**
Add the missing `zai` entry to both `providerKeyNames` and `providerDefaults`.
- `providerKeyNames`: `zai: "ZAI_API_KEY"`
- `providerDefaults`: `zai: { baseUrl: process.env.ZAI_BASE_URL || "https://api.z.ai/api/paas/v4", model: process.env.ZAI_MODEL || "glm-5.1" }`

These exact values are the repo's canonical defaults — they match
`packages/ai/src/gateway/gateway-config.ts:92-93`. Use them verbatim. Do not
substitute a different model name.

**6. `packages/sync/src/index.ts:54-69`** — add `category` to the books INSERT.
Add the column to the SQL column list and the `VALUES` list, and bind
`category: b.category ?? "未分類"`.

**7. `packages/sync/src/index.ts:71-88`** — add `level` and `source` to the
chapters INSERT. Add both columns to the SQL and bind
`level: c.level ?? 0`, `source: c.source ?? "manual"`.

For 6 and 7: confirm the actual column names in `packages/db/src/schema.ts`
(snake_case in SQL) and the actual schema defaults in the zod schemas before
choosing fallback values. Prefer the schema's own default over a hardcoded
guess.

### 🟡 Medium

**2. `scripts/boundary-check.sh:23`** — add word boundaries so `redistributed`
no longer matches `redis`:
```
grep -rIE "\b(mysql|MySQL|docker|Docker|PM2|pm2|redis|Redis)\b" apps/ packages/ 2>/dev/null && echo "❌ FAIL: forbidden tech reference found" && FAIL=1
```
Verify the script still catches a real violation after the change (e.g. test
against a temp string containing a standalone `docker`), not just that it
stops failing.

**3. `scripts/guest-ask-live-verify.ts:70-76`** — add `zai: "ZAI_API_KEY"` to
the `providerEnvName` map.

**5. `packages/db/src/repositories/aiDailyUsage.repo.ts:40-76`** — make
`accumulate` honour its documented atomic contract. Wrap the
find→update/insert in `db.transaction(...)`, or use
`INSERT ... ON CONFLICT(date, scope_type, scope_key) DO UPDATE`. Whichever you
choose, the existing return value shape must stay identical — callers depend
on it.

**8. `packages/student-runtime/src/chatEngine.ts:17-28`** — single CJK
character queries currently produce zero tokens. Add a fallback: when
`cleaned.length === 1` (and it is not punctuation), add the single character to
the token set.

**9. `packages/book-core/src/pdf-index-builder.ts:99-105`** — the thrown plain
`Error` surfaces as a generic 500 at `apps/AI-adm-D1/src/server/app.ts:1987`
and the matching catch in the `save-json-index` route. Introduce a
distinguishable error type (or a pre-check at the call site) so both routes can
return a 400 with a specific message instead of `500 "generate json index
failed"`. Update **both** call sites (`app.ts:1977` and `app.ts:2009`).

**10. `packages/ai/src/orchestration/verification/programming-verifier.ts:56-58`**
— narrow the identifier scan. The bare `answer.match(IDENTIFIER)` branch scans
the entire natural-language answer, so any prose word not declared in the
question and not in the ~50-entry `COMMON_IDENTIFIERS` keyword list trips the
guard. Restrict this branch to identifiers inside code blocks / backticks
(the file already has a `codeBlocks(answer)` helper at the top of
`hasUndefinedVariable` — reuse it). Leave the `explicit` regex branch at L53-55
alone; that one is correctly targeted.

### 🟢 Low

**11. `mathematics-verifier.ts:164`** — remove the duplicated `公尺` from the
regex.

**12. `packages/auth/src/index.ts:14-16`** — `requireRole` has zero call sites.
Do **not** implement middleware for it. Just mark it clearly as an unimplemented
stub (a `@deprecated` / TODO doc comment stating it is not a functioning access
control guard). Keep it exported — removing it is out of scope.

**13a. root `package.json`** — add `"type": "module"`.
⚠️ This one is the highest-risk change in the list. It changes module
resolution for every `.js` file in the repo root scope. **Run the full test
suite immediately after this specific change.** If it breaks anything, revert
13a only, keep every other fix, and report that 13a was reverted and why.

**13b. `vitest.config.ts:8`** — add `".worktrees/**"` and
`".cleanup-backup-*/**"` to the `exclude` array. (Confirmed: root `vitest`
currently reaches into `.worktrees/` and tries to collect duplicate test files
from three separate worktrees.)

---

## Verification — required before you report done

Run all three and paste the actual output:

```
pnpm run typecheck:release-scripts
bash scripts/boundary-check.sh
pnpm test
```

Expected: the first two now pass. For `pnpm test`, compare against the known
baseline of 1,030+ passing tests — **report the real number**. If any test
fails, say so explicitly with the failure output. Do not describe a failing
suite as passing.

Note: `boundary-check.sh` also emits two pre-existing `⚠️ WARN: book-core
depends on ai/db` warnings. Those are warnings, not failures, and are **out of
scope** — leave them.

---

## STOP CONDITIONS

- Do not touch `guestAskAnswer.repo.ts` (item 4 is retracted).
- Do not fix anything not on the list above.
- Do not commit, push, or create branches. Leave changes in the working tree.
- Stop once the three verification commands have been run and reported.

Report format: per-item ✅/❌ status, the three command outputs, and an explicit
list of anything you could not fix or had to revert.
