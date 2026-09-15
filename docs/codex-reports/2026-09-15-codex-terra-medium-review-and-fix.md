# AI-Quest-A1 current-state review and repair

- Date: 2026-09-15 (Asia/Taipei)
- Requested model alias: `terra`, medium reasoning
- Actual model: **gpt-5.6-sol, medium reasoning**; Terra was unavailable on this ChatGPT-backed Codex account.
- Starting HEAD: `44f521ade332d4899c589d45f51b80b5c0ae0448`
- Implementation HEAD: `ef8ddb549d643aa9042339ca8418c283461d0a83`
- Final Git HEAD: the report commit containing this document; its exact SHA is recorded in the required terminal status line and final handoff because a commit cannot embed its own SHA.

## Verdict

**FIXED.** The review confirmed three material defects and two lower-risk hardening gaps in the Phase 3D storage/auth changes and the quota timezone fix. All confirmed issues were repaired, focused regressions were added, every required local gate passed, and the Shared Backend was deployed and validated with synthetic data. Student and Admin continue to delegate to the same Shared Backend. The unrelated integration project `appgprj_6a8415716c448191a7a8b8cb3597ca08` was not modified or deployed.

## Findings and fixes

### 1. High: production validation authentication used public constants

The committed bearer fixtures became production identities when paired with a second committed `x-validation-gate` constant. Anyone who knew the repository values could reproduce the pair, so this was not a genuine gate. The static `x-admin-key` fixture was also accepted in production.

Fix:

- Production bearer validation now requires an exact match against the server-only `RELEASE_VALIDATION_SECRET` Sites secret, with a minimum configured length of 32 characters.
- The former public gate values and the static admin-key fixture return 401 in production.
- Synthetic bearer/admin-key behavior remains available in local test/development.
- The validation secret is held only in Sites runtime configuration as a secret (environment revision 1); it is absent from source, bundles, reports, and Git.
- CORS no longer advertises the removed public gate or static admin-key path.

### 2. Medium: duplicate/concurrent book IDs could orphan R2 objects

Uploading an existing ID created a fresh server object key and then upserted D1 metadata, leaving the previous R2 PDF unreachable. A read-before-write check alone would still race across concurrent uploads.

Fix:

- Existing IDs receive controlled HTTP 409 `book_already_exists` before an R2 write when detected early.
- D1 metadata creation is now insert-only (`onConflictDoNothing` plus `returning`) rather than an upsert, providing the authoritative conflict check.
- A conflict discovered after R2 creation runs verified R2 compensation and reports its result.
- Concurrent same-ID regression coverage proves one 201, one 409, and exactly one surviving object.

### 3. Medium: skipped-midnight timezones could produce an expired daily reset

The fixpoint calculation at `44f521a` correctly added hour/minute/second handling for ordinary offsets and common DST boundaries, but it oscillated when a zone skipped 00:00. For `America/Santiago` on 2026-09-06 it returned `03:00Z`, which was still 23:00 on the preceding local date; quota ledgers could repeatedly see an already-expired daily boundary.

Fix:

- `localMidnightUtc` now binary-searches the first UTC instant whose local calendar date reaches the requested date.
- This chooses 01:00 local when midnight is skipped, handles UTC, positive/negative and fractional offsets, standard DST changes, and historical skipped dates.
- The credential quota and token-pool repositories now share the tested timezone utility instead of maintaining divergent copies.
- Inputs containing seconds and milliseconds now deterministically produce a future reset boundary with zero boundary minutes/seconds where midnight exists.

### 4. Medium: R2 writes and compensating restores were trusted but not verified

The upload route treated a resolved `put` as persistence, and D1-failure cleanup used an unchecked delete. A failed restore after a D1 delete failure could also be reported as compensated merely because `put` resolved.

Fix:

- New and restored objects are verified with R2 `head`/`get`, exact byte size, and SHA-256 custom metadata when present.
- A failed write verification is cleaned up and returns controlled HTTP 502 without D1 metadata.
- D1-insert compensation uses the existing delete-and-head verification and exposes `r2Compensated`.
- Delete lifecycle remains R2 delete + physical absence verification, then D1 tombstone; D1 failure restores and verifies the snapshot.

### 5. Low: degenerate object-key segments and multipart field typing

An ID containing only stripped traversal punctuation produced an empty path segment, and a non-file multipart field was handled through an incidental type exception.

Fix:

- Empty sanitized IDs fall back to `unknown`; extensions are sanitized; object suffixes use `crypto.randomUUID`.
- Multipart `file` must be an actual `File` before MIME and byte validation.

## Mandatory review results

### Upload lifecycle

- Raw and multipart bodies require `application/pdf`; JSON/base64 requires explicit `contentType: application/pdf`.
- Empty bodies, decoded bodies over 15 MiB, and payloads without the leading `%PDF-` magic are rejected before storage.
- Multipart, raw, and JSON/base64 paths preserve the exact fixture bytes and SHA-256.
- Object keys are server-generated and traversal-safe; clients cannot supply an object key.
- The `books` D1 schema contains only metadata (`object_key`, content type, byte size, SHA-256, state, descriptive fields), never PDF bytes or a binary/blob column.
- R2 put is verified before D1 create; every D1 create failure/conflict triggers verified object cleanup.

### Delete lifecycle

- Success is returned only after the object is absent by `head`/`get`.
- Missing active objects return controlled 404 without tombstoning D1.
- R2 deletion failure returns 502 and leaves metadata active.
- D1 failure after R2 deletion restores the full bytes and metadata, then verifies the restored object before reporting compensation.
- A second delete of a D1 tombstone remains idempotent HTTP 200 with `alreadyDeleted=true`.
- Insert-only metadata removes the upload/delete replacement race introduced by same-ID upserts; object keys remain unique and server-owned.

### Auth, proxy, and topology

- Guest/Student/Admin upload matrix is 401/403/201.
- The former public bearer gate and static admin-key are rejected in production; the server-secret validation gate is narrowly configured for synthetic release validation.
- Live caller-supplied `oai-authenticated-*` headers were stripped by the Sites edge and did not create an identity.
- Student and Admin routes still return `x-data-plane: shared-backend` and delegate to `https://ai-quest-a1-backend.b827262.chatgpt.site`.
- Shared Backend health confirms both `sharedD1Project` and `sharedR2Project` are `appgprj_6aa80235182c8191a876361138ecbc36`, with `DB` and `BOOKS_BUCKET` bound.

## Tests added

- Eight timezone cases covering UTC, Taipei, Kathmandu fractional offset, New York spring/fall DST, Santiago skipped midnight, a seconds/milliseconds future-boundary assertion, and Samoa's skipped calendar date.
- Production auth regressions for the former public gate, the configured server-secret gate, and the static admin-key fixture.
- R2 upload regressions for empty/oversized bodies, raw MIME rejection, multipart, JSON/base64, traversal-like IDs, silently dropped puts, repeated IDs, and concurrent same-ID uploads.
- Existing lifecycle regressions continue to cover Guest/Student/Admin authorization, exact streamed hash, delete failure, missing objects, physical removal, second-delete idempotency, and production missing bindings.

## Required local gates

- `site: npm test`: **PASS**, 52/52 tests.
- `site: npm run build`: **PASS**.
- `site: npm run fixture:safety`: **PASS**, 10/10 fixture checks, 0 secret findings, production DB isolation PASS.
- `root: pnpm test`: **PASS**. Contracts 10, Schema 4, AI 745, DB 176, Auth 4, Admin 250, Student 20 (1,209 tests total).
- `git diff --check`: **PASS**.
- No E500 4300/4310 ports were used. No `.env`, local production database, secret value, PII, real textbook, or production PDF was read or uploaded.

## Live Sites deployment and validation

Only Shared Backend source required deployment. Student and Admin proxy/frontend source was unchanged, so neither frontend was redeployed.

Final Shared Backend release:

- Project: `appgprj_6aa80235182c8191a876361138ecbc36`
- URL: `https://ai-quest-a1-backend.b827262.chatgpt.site`
- Version 6: `appgprj_6aa80235182c8191a876361138ecbc36~appgver_4e845eaa4f848191b15cf14967da39c9`
- Deployment: `appgdep_6aa89554a9d0819189715f0b5403933e`
- Deployment status: `succeeded`
- Source commit: `ef8ddb549d643aa9042339ca8418c283461d0a83`
- Environment revision: 1

An intermediate Version 5 / deployment `appgdep_6aa89469c0a0819182e7fa3dc26d75fd` succeeded before the server-secret validation wiring; Version 6 supersedes it and is the final production release.

Final synthetic lifecycle ID: `book-codex-review-1789433204758`.

- Health: 200; D1 bound; R2 bound; role `shared-backend`; `BOOKS_BUCKET`; same Shared project ID.
- Former public gate: 401; static synthetic admin-key: 401.
- Upload through Admin proxy: Guest 401, Student 403, secret-gated Admin 201.
- Upload metadata: 476 bytes, `application/pdf`, active, expected SHA-256, server-created traversal-safe key.
- Student detail, Admin detail, and Student content: 200 with `x-data-plane: shared-backend`.
- Stream: `%PDF-`, 476 bytes, SHA-256 `170e2df4e4f324c124cb9d12c1de469277498647116fb7c3fd98a73af47bc736`.
- First delete through Admin proxy: 200 `deleted=true`; the route returns success only after R2 absence verification.
- Second delete: 200 `alreadyDeleted=true`.
- Post-delete Student content: 404 `book_not_found`.

## Git and scope

- Implementation commits:
  - `315c445c1d9290f0a40363427f0f4466fd7e6d67` — storage, auth fixture rejection, and timezone repairs.
  - `ef8ddb549d643aa9042339ca8418c283461d0a83` — server-secret production validation gate.
- Focused test commit: `9dea0900657da54813e99693ced5defdd60c78e3` — verified compensation persistence and silent-put failure coverage.
- Both implementation commits were pushed fast-forward to `origin/main` and the Shared Backend Sites source repository.
- This report is a separate report commit and is pushed fast-forward to `origin/main`; it is not a backend source change and does not require another deployment.
- The final handoff records the exact report HEAD and confirms worktree cleanliness.

## RAG boundary

**RAG = NOT IMPLEMENTED.** No vector database, embeddings, chunking, retrieval, or RAG runtime was added or changed.
