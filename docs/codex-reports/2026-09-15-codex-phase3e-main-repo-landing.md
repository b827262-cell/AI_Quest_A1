# Phase 3E main-repo landing: controlled E500 → Shared D1/R2 synchronization

- Date: 2026-09-15 (Asia/Taipei)
- Repository: `/home/b827262/project/AI-Quest-A1` (branch `main`, starting HEAD `d16d711`)
- Source of implementation: independently re-verified mirror
  `/home/b827262/.codex/.chatgpt-projects/g-p-6aa79b4357608191b7b285f655b02932/ai-smartbook-sites`
  (Phase 3E uncommitted worktree on an early Sites base)
- Scope: selective port into `site/` + incremental migration + CLI retry fix +
  route-level tests. No Sites deployment, no live D1/R2 mutation, no real
  documents, no secrets in the repository.

## Gates

```text
PHASE_3E_MIRROR_VERIFIED = YES   (re-verified locally: npm test 3/3, lint,
                                  fixture:safety, dry-run zero writes)
PHASE_3E_MAIN_REPO_LANDED = YES  (this report)
PHASE_3E_LIVE_READY = NO         (deployment + secret + E500 auth pending)
```

## 1. What landed

New: `site/app/api/internal/sync/**` (runs, students, progress, books,
`books/[id]/content`, commit, conflicts, `_shared.ts`), `site/lib/sync-core.ts`,
`site/tools/e500-sync/index.mjs`, `site/tests/sync-core.test.mjs`,
`site/tests/sync-internal-api.test.mjs`, `site/drizzle/0002_funny_ezekiel.sql`.
Modified: `site/db/schema.ts` (5 sync columns on 4 domain tables +
`sync_runs`/`sync_items`/`audit_logs`/`sync_nonces`), `site/worker/index.ts`
(`SYNC_IMPORT_SECRET`, `SYNC_MAX_PDF_BYTES` bindings), `site/package.json`
(`sync:e500:*` scripts, test list), `site/README.md` (import runbook).

## 2. Deliberate deviations from the mirror

1. **CLI retry re-signing (merge blocker fix).** Every HTTP attempt now builds
   a fresh `timestamp + nonce + body digest + HMAC signature`. The mirror
   reused one signature across 3 attempts, so a request the server had already
   applied but whose response was lost would be rejected as
   `replayed_sync_request`. Transport retries are now decoupled from business
   idempotency (per-item version/checksum skip), as designed. The `verify`
   GET also sends no body while still signing the empty-body digest.
2. **First-content 409 bug fix (new route-level test caught it).** The mirror
   raised `content_conflict` whenever `incomingVersion === book.syncVersion`
   and checksums differed — including a never-uploaded book whose `sha256` is
   `""`. A content PUT at the book's own sync version (the normal CLI flow
   after a metadata batch) therefore always failed 409. The guard now only
   conflicts when a non-empty checksum exists: `book.sha256 &&
   book.sha256 !== sha256`.
3. **Incremental migration instead of full-create.** The mirror's
   `0000_remarkable_puck.sql` recreates every table and cannot apply to the
   live D1 (which already carries 0000/0001). The landed
   `drizzle/0002_funny_ezekiel.sql` is additive only: 20 `ALTER TABLE ADD`
   column statements, 4 `CREATE UNIQUE INDEX`, 4 `CREATE TABLE` — zero DROP,
   zero rebuild, zero default changes.
4. **`books.storage_state` default stays `'active'`.** The mirror flipped it to
   `'pending'`; existing upload paths always set the state explicitly, so
   flipping the default would have forced a table rebuild and changed row
   semantics. Sync-created rows get `storage_state='pending'` explicitly from
   `applyBook`; pre-existing production rows are untouched.
5. **Async `getDb()` adaptation.** Main-repo `db/index.ts` exposes an async
   `getDb` with `globalThis.DB` fallback; all sync handlers await it. Test
   injection uses a `node:sqlite`-backed D1 double implementing
   `prepare/bind/all/run/raw` exactly as drizzle-orm 0.45.2 consumes it.
6. **No `BUCKET` alias, no phantom role header.** The worker binds only
   `BOOKS_BUCKET` (the declared logical name) and the identity presence check
   uses `oai-authenticated-user-id`/`authorization` (the mirror also checked a
   non-platform `oai-authenticated-user-role` header).
7. **Base64 transport limit documented + tested (known limitation, not a
   blocker).** The JSON `contentBase64` path is bounded by the 8,000,000-char
   body cap (≈6 MiB payload); large PDFs must use the raw `application/pdf`
   path (`SYNC_MAX_PDF_BYTES`, default 50 MiB). `tests/sync-internal-api.test.mjs`
   asserts an oversized base64 body is rejected with 400 `too large`.

## 3. Verification (all executed locally on `main`)

- `cd site && npm test`: PASS — **60/60** (52 pre-existing + 2 sync-core +
  6 sync-internal-api covering guest 401 / signed-in 403 / bad signature 401,
  insert→skip idempotency, nonce replay rejection, equal-version conflict with
  no overwrite, cross-entity source→target id resolution, content upload with
  R2 HEAD/GET verification, resend skip, stale/conflict/identity 409,
  `invalid_pdf`, oversized base64).
- `cd site && npm run lint`: 36 errors, **all pre-existing baseline files**;
  every landed file contributes 0 (verified per-file and against `HEAD`).
- `cd site && npm run fixture:safety`: PASS (10/10 fixtures, 0 secrets,
  production isolation).
- `cd site && npm run sync:e500:dry-run`: PASS — zero cloud writes.
- Root `pnpm test`: **1,209/1,209** across all workspaces. The first run
  showed 2 admin integration failures traced to a leaked
  `ADMIN_PASSWORD_HASH` in the invoking shell environment (hash branch
  outranks the tests' `ADMIN_PASSWORD`); with `ADMIN_*` scrubbed the suite is
  fully green. Tracked as a test-hardening candidate for the admin work line,
  unrelated to this landing.
- `git diff --check`: clean.

## 4. Live readiness checklist (pending, in order)

1. Back up / snapshot the shared-backend D1; pre-check
   `SELECT student_id, book_id, COUNT(*) FROM reading_progress GROUP BY 1,2
   HAVING COUNT(*)>1` (empty) so `uq_progress_student_book` can apply.
2. Apply `0002` to the live D1 and verify column/index/table presence.
3. Deploy the new backend version with the R2 binding and a server-only
   `SYNC_IMPORT_SECRET` (≥32 chars, out of version control).
4. `npm run sync:e500:dry-run` against live E500 endpoints (401 from E500
   today is correct behavior — supply `E500_ADMIN_AUTHORIZATION`; do not
   bypass auth).
5. Synthetic-only live sync → verify idempotent rerun → `sync:e500:verify`
   conflicts list empty.

RAG remains NOT IMPLEMENTED. No Sites project was deployed or mutated by this
landing.
