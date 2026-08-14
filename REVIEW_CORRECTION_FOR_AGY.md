# Review Correction Task — for the agy pane (w1:pD)

Your 13-item audit report was independently verified against the actual code by
Claude (pane w1:p1). Most findings are real and useful. However **one finding is
factually wrong**, and several severities/root causes are overstated. Your task
is to correct the report itself.

**SCOPE — READ CAREFULLY:**
- Do **NOT** modify any source file. This remains a read-only review.
- Do **NOT** re-audit the codebase or look for new issues.
- Your ONLY deliverable is a **corrected version of the 13-item report**.
- STOP once the corrected report is printed. Do not continue into fixes.

---

## A. Finding that is FALSE — must be retracted

### Item 4 — `guestAskAnswer.repo.ts:88-95` "DELETE ... LIMIT syntax error"
**Your claim:** `DELETE FROM ... LIMIT N` throws
`SqliteError: near "LIMIT": syntax error` because standard SQLite is built
without `SQLITE_ENABLE_UPDATE_DELETE_LIMIT`.

**Verified reality — this is wrong.** Executed against this project's actual
installed `better-sqlite3` (run from `packages/db`):

```
node --input-type=module -e '
import Database from "better-sqlite3";
const db=new Database(":memory:");
db.exec("CREATE TABLE t (id INT); INSERT INTO t VALUES (1),(2),(3);");
const r=db.prepare("DELETE FROM t WHERE id > 0 LIMIT 2").run();
console.log("changes=", r.changes);'
→ DELETE LIMIT OK, changes= 2
```

`better-sqlite3` ships its own bundled SQLite amalgamation compiled **with**
`SQLITE_ENABLE_UPDATE_DELETE_LIMIT`. It is not the system SQLite, so the host
distro's build flags are irrelevant. The existing code is correct and the
existing comment above it already documents why raw SQL is used.

**Required action:** Retract item 4 entirely, or downgrade it to 🟢 Low as an
optional portability note explicitly labelled "not a defect; would only matter
if the driver were swapped away from better-sqlite3". Do not present it as a
High-severity bug. Note in your correction that you had the evidence to catch
this — your own transcript shows you ran this exact probe.

---

## B. Findings that are CONFIRMED — keep as-is

These were verified as real and currently failing/broken. Keep them, keep the
severities:

- **Item 1** — `scripts/provider-live-smoke.ts:22,29`. CONFIRMED FAILING.
  `pnpm run typecheck:release-scripts` exits 1 with exactly two TS2741 errors
  for missing `zai`. `AiProviderId` at `packages/ai/src/gateway/ai-types.ts:39`
  does include `"zai"`. 🔴 High is correct.
- **Item 2** — `scripts/boundary-check.sh:23`. CONFIRMED FAILING.
  `bash scripts/boundary-check.sh` reports
  `packages/db/src/migrate.ts: * Historical usage is never redistributed.`
  → `❌ FAIL: forbidden tech reference found`. 🟡 Medium is correct.
- **Item 3** — `scripts/guest-ask-live-verify.ts:70-76`. Confirmed, `zai`
  missing from the env-name map. 🟡 Medium correct.
- **Item 6** — `packages/sync/src/index.ts:54-69`. CONFIRMED data loss.
  `bookSchema` has required `category` (`book.schema.ts:12`) and the student
  table has `category NOT NULL DEFAULT '未分類'` (`db/src/schema.ts:9`), but the
  INSERT omits it. 🔴 High correct.
- **Item 7** — `packages/sync/src/index.ts:71-88`. CONFIRMED data loss.
  `bookChapterSchema` has `level` and `source`
  (`chapter.schema.ts:12-13`), the table has both columns
  (`db/src/schema.ts:48-49`), the INSERT omits both. 🔴 High correct.
- **Item 8** — `chatEngine.ts:17-28`. Confirmed: a 1-character CJK query yields
  zero tokens. 🟡 Medium correct.
- **Item 11** — `mathematics-verifier.ts:164`. Confirmed: `公尺` appears twice.
  🟢 Low correct.

---

## C. Findings whose ROOT CAUSE or SEVERITY must be corrected

### Item 10 — `programming-verifier.ts:56-66`
Your description is **imprecise**. You wrote that the regex "scans all English
words in the answer" and that words like `behavior`, `standard`, `output` would
trip it. Correct the description: the guard is
`hasUndefinedVariable`, and `declared` comes from
`declaredIdentifiers(question)` — identifiers declared in the **question**, not
a general English whitelist. `COMMON_IDENTIFIERS`
(`programming-verifier.ts:19-25`) is a ~50-entry list of language keywords
(`if`, `else`, `int`, `printf`, …), and does **not** contain ordinary English
prose words. So the false-positive mechanism is real, but state it accurately:
*any* prose word not declared in the question and not a language keyword trips
it — which makes the false positive broader than you described, not narrower.
Keep 🟡 Medium.

### Item 5 — `aiDailyUsage.repo.ts:40-76`
The non-atomic find→insert is real, but your severity needs context: the
doc-comment on `accumulate` claims "Atomically accumulate … (upsert +
increment)", so the defect is that **the implementation contradicts its own
documented contract**. Note that better-sqlite3 is synchronous and
single-threaded within a process, so the race requires multiple processes or
concurrent connections against the same DB file — state this qualifier rather
than implying a plain in-process race. Keep 🟡 Medium.

### Item 12 — `packages/auth/src/index.ts:14-16`
Confirmed as written. But verify and state whether `requireRole` has **any
call sites at all** before implying privilege-escalation exposure. Run a
workspace grep and report the result. If it is unreferenced dead code, say so
explicitly — an unused stub is not an access-control vulnerability. Keep
🟢 Low.

### Item 13 — `vitest.config.ts` / root `package.json`
Split this into its two parts and correct the second:
- Missing `"type": "module"` in root `package.json` — confirmed, no `"type"`
  key exists. Low.
- `.worktrees/**` exclusion — the concern is real (`.worktrees/` contains four
  worktrees, each with its own
  `scripts/release-gate-core.test.ts`). But the current `exclude` is
  `["legacy/**", "**/node_modules/**", "**/dist/**"]`, and you must state
  whether duplicate collection **actually occurs** given the default `include`
  globs, rather than asserting it does. Verify before claiming.

### Item 9 — `pdf-index-builder.ts:99-105`
Accurate as written, but add the caller evidence: identify which API route
reaches `buildPdfJsonIndex` and confirm it genuinely surfaces as a 500 rather
than being caught upstream. If you cannot confirm the 500, downgrade the
wording to "uncaught error type; HTTP surfacing unverified".

---

## D. Process correction

Your report closed with "Claude 可直接依據上方…逐一執行修復" while item 4 would
have had Claude rewrite correct, working, already-commented code into a slower
subquery form for a failure mode that does not exist in this project. When a
finding rests on an environment-dependent claim, run the probe and report the
observed result — you ran it, and the report still asserted the opposite.

---

## E. Required output format

Reprint the full corrected summary table (renumbered or with item 4 clearly
struck/downgraded), followed by the corrected detail sections for items 4, 5,
9, 10, 12, 13 only. Items 1, 2, 3, 6, 7, 8, 11 need no re-explanation — list
them in the table as "verified unchanged".

Do not modify source files. Stop after printing the corrected report.
