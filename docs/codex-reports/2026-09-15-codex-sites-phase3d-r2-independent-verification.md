NATIVE_R2_SUPPORTED = YES

# Phase 3D independent Codex verification: shared R2 textbook storage

- Date: 2026-09-15 (Asia/Taipei)
- Repository: `/home/b827262/project/AI-Quest-A1`
- Independently verified implementation baseline: `4bceb5e71408d5246f3bc1f28b5f21a68b4e8142`
- Corrective implementation commit: `dbdf0ee45cad5c55087473642ff421a472a6ab10`
- Scope: native Sites R2 capability and Phase 3D release gates only
- Excluded: integration Site `appgprj_6a8415716c448191a7a8b8cb3597ca08`; no changes or deployments were made to it
- Test data: synthetic fixture only (`site/fixtures/assets/synthetic-test-book.pdf`, 476 bytes)

## 1. Native R2 gate and authoritative evidence

The native gate is **YES** based on independent bundled-platform evidence and a real production lifecycle, not on the prior AGY report:

1. The bundled Sites capability instructions at `/home/b827262/.codex/plugins/cache/openai-bundled/sites/0.1.43/skills/sites-building/SKILL.md` require logical D1 and R2 declarations in `.openai/hosting.json` and state that Sites owns the physical Cloudflare resources and deployment wiring.
2. The bundled authoritative storage reference at `/home/b827262/.codex/plugins/cache/openai-bundled/sites/0.1.43/skills/sites-building/references/persistence-and-storage.md` says to use R2 for uploaded documents/blobs and D1 for their metadata, and identifies `r2` as the logical hosting field.
3. The successfully packaged Shared Backend deployment used this exact hosting shape:

   ```json
   {
     "project_id": "appgprj_6aa80235182c8191a876361138ecbc36",
     "d1": "DB",
     "r2": "BOOKS_BUCKET"
   }
   ```

4. Shared Backend Version 4 was saved from corrective commit `dbdf0ee45cad5c55087473642ff421a472a6ab10`, with platform archive hash `sha256:68d969ccd5806e97100614242b2b4d0c22fefe5a7b2fca5f24496078afd6706d` (81 files), and deployed successfully.
5. The live backend accepted a real synthetic PDF upload, returned an R2 object key, streamed the identical bytes back through `bucket.get`, then completed a deletion that now verifies `bucket.head(key) === null` before returning success.

The logical R2 binding and object-store identifier is **`BOOKS_BUCKET`**. The physical provider bucket's opaque ID is not exposed by any R2 list/head connector in the Sites tool inventory available to this run. This report does not invent one. Physical existence/removal is instead proven through the deployed R2 API operations described below.

## 2. Architecture before and after

| State | Structured data | PDF bytes | Student/Admin access |
|---|---|---|---|
| Before Phase 3D | D1-backed application records | No verified shared native object lifecycle | No verified shared R2 data plane |
| After Phase 3D | Shared Backend D1 binding `DB` stores textbook metadata/tombstones | Shared Backend R2 binding `BOOKS_BUCKET` stores PDF bytes | Student and Admin frontends proxy every textbook API request to the Shared Backend |

```text
Student Site ──HTTP proxy──┐
                           ├── Shared Backend appgprj_6aa80235182c8191a876361138ecbc36
Admin Site ────HTTP proxy──┘       ├── DB (D1 metadata)
                                   └── BOOKS_BUCKET (R2 PDF objects)
```

The frontend proxy decision is made before local textbook storage access. Binary request and response bodies use `arrayBuffer()` and every verified frontend response carried `x-data-plane: shared-backend`.

## 3. Project ownership, versions, and deployments

| Role | Project | Live version | Source commit | Deployment | Status |
|---|---|---:|---|---|---|
| Shared Backend | `appgprj_6aa80235182c8191a876361138ecbc36` | 4 (`appgver_29168e1fb47481918766d24a5c904b7d`) | `dbdf0ee45cad5c55087473642ff421a472a6ab10` | `appgdep_6aa821471638819181d823ddd1fc3cbd` | `succeeded` |
| Student proxy | `appgprj_6a843b2ece70819191132bd6e99df7a1` | 13 (`appgver_64808c131bc88191915632e38b958f91`) | `6518326c770a7dd3e00ace4f7e0891b289b84cac` | `appgdep_6aa81a5ee9f08191954d5e826e408b6e` | `succeeded` |
| Admin proxy | `appgprj_6a843b6432f88191aa4cc090c236f3d3` | 12 (`appgver_54e0ae1c4ed881918722768ccebe090c`) | `fccb53f327e8d3deb29516751dc27c031923350c` | `appgdep_6aa81b8007ec81918248298e904c015a` | `succeeded` |

The Admin project also has an undeployed saved Version 13; it is not claimed as live. The integration project named in the task exclusion was not touched.

## 4. SAME shared object-store topology proof

**Topology conclusion: SAME.**

- Backend `/api/health`: HTTP 200, `role=shared-backend`, `d1=bound`, `r2=bound`, `storage=r2`, `sharedR2Project=appgprj_6aa80235182c8191a876361138ecbc36`, `sharedR2Bucket=BOOKS_BUCKET`.
- Student `/api/health`: HTTP 200, `role=frontend-proxy`, the same backend target, shared project, and `BOOKS_BUCKET` identifier.
- Admin `/api/health`: HTTP 200, `role=frontend-proxy`, the same backend target, shared project, and `BOOKS_BUCKET` identifier.
- Student and Admin detail responses both carried `x-data-plane: shared-backend` and returned the same synthetic book ID.
- Production Worker logs show the Student and Admin origins forwarding to the same backend Worker service, `site---6aa80235182c8191a876361138ecbc36`.
- Only the Shared Backend deployment archive declares `r2: "BOOKS_BUCKET"` for this release. Frontend textbook routes delegate rather than performing local bucket access.

## 5. D1 metadata model

The live Sites D1 viewer independently returned binding `DB`, table `books`, and these columns:

`id`, `title`, `description`, `total_chapters`, `total_pages`, `is_synthetic`, `created_at`, `object_key`, `content_type`, `byte_size`, `sha256`, `storage_state`, `updated_at`.

D1 therefore stores metadata and lifecycle state, not PDF bytes. The live verification tombstone for `book-codex-v4-1789403525` retained:

- `content_type=application/pdf`
- `byte_size=476`
- `sha256=170e2df4e4f324c124cb9d12c1de469277498647116fb7c3fd98a73af47bc736`
- `storage_state=deleted`
- separate creation/update timestamps
- cleared `object_key` after confirmed physical removal

Before deletion, the upload response and both frontend detail routes returned the server-created object key `textbooks/book-codex-v4-1789403525/1789403542155-orvvp05h.pdf`.

## 6. Object keys, upload validation, and storage failure policy

- Object keys are generated server-side as `textbooks/<sanitized-book-id>/<timestamp>-<random>.pdf`; client-controlled slashes and traversal characters are stripped.
- Payload must be non-empty.
- Maximum size is 15 MiB (`15 * 1024 * 1024`), a conservative application limit.
- Raw and multipart files must declare `application/pdf`. JSON/base64 transport must explicitly declare `contentType: application/pdf`.
- The first five bytes must be `%PDF-`.
- SHA-256 is calculated before persistence and stored in D1 and R2 custom metadata.
- Missing production R2 raises a controlled HTTP 503 `r2_unavailable`; no production filesystem or in-memory fallback is used.
- An active metadata record whose R2 object is absent returns controlled HTTP 404 `object_not_found`.

The independent review found and fixed two gaps before release: a PDF body labeled `text/plain` had been accepted, and an R2 delete exception had been swallowed while returning HTTP 200. The deployed fix rejects the former with 415 and fails the latter closed with 502 while leaving metadata active.

## 7. D1/R2 compensation and delete semantics

Upload order and compensation:

1. Validate and hash bytes.
2. Put the object in R2.
3. Upsert metadata in D1.
4. If the D1 operation fails, delete the newly written R2 object to avoid an orphan.

Delete order and compensation after the corrective commit:

1. Return HTTP 200 immediately when D1 already says `deleted` (documented idempotence).
2. Read and retain the current R2 object, returning controlled 404 if it is absent.
3. Delete the object and verify its absence using native `bucket.head` (falling back to `get` only for compatible test doubles).
4. Mark the D1 row deleted and clear its object key.
5. If the D1 update fails after R2 deletion, restore the retained object bytes and metadata; the error response records whether compensation succeeded.
6. If R2 deletion fails, return 502 and do not mark D1 deleted.

## 8. API and authorization matrix

All live calls used synthetic identifiers and the production validation context. The Sites bypass bearer by itself was also tried without the required validation gate and was rejected with 401, proving there is no bearer-only production bypass.

| Surface | Guest | Student | Admin | Result |
|---|---:|---:|---:|---|
| Upload | 401 | 403 | 201 | PASS |
| Admin list | 401 | 403 | 200 | PASS |
| Admin detail | 401 | 403 | 200 | PASS |
| Admin delete | 401 | 403 | 200 | PASS |
| Student list | — | 200 | — | PASS via Shared Backend |
| Student detail | — | 200 | — | PASS via Shared Backend |
| Student content | — | 200 | — | PASS via Shared Backend |
| Admin bearer without validation gate | 401 | n/a | 401 | PASS |

## 9. Live upload/read/integrity/delete evidence

Final verification object: `book-codex-v4-1789403525`.

| Gate | Live result |
|---|---|
| Synthetic upload | HTTP 201; `isSynthetic=true`; R2 key returned |
| Media-type rejection | Same `%PDF-` bytes as `text/plain` returned HTTP 415 |
| Admin/Student visibility | Both list/detail paths returned HTTP 200 and the same ID |
| Data plane | Both carried `x-data-plane: shared-backend` |
| Content read | HTTP 200, `application/pdf`, 476 bytes, `%PDF-` |
| Integrity | Download SHA-256 and size exactly matched upload and D1 metadata |
| First delete | HTTP 200, `deleted=true`; v4 code returned only after `bucket.head` confirmed absence |
| Second delete | HTTP 200, `alreadyDeleted=true` |
| Post-delete read | HTTP 404 `book_not_found` |
| D1 lifecycle | Live D1 row retained with `storage_state=deleted` and metadata/digest |

Physical existence is proven by the successful production `bucket.get` content stream and its matching non-zero digest. Physical removal is proven by Version 4's success condition (`delete`, then `head` must be null), the successful first delete in Worker logs, and the D1 tombstone. The connector inventory exposed no separate R2 object browser/list tool, so no claim is made that such a tool was used.

## 10. Local tests, build, and safety

- `cd site && npm test`: PASS, 42/42 tests.
- `cd site && npm run build`: PASS.
- `cd site && npm run fixture:safety`: PASS, 10/10 fixture checks, 0 secret findings, production DB isolation PASS.
- Root `pnpm test`: first run exposed a time-sensitive DB quota assertion (1 failure); its targeted retry passed 32/32 and the complete second root run passed all workspaces: contracts 10, schema 4, AI 745, DB 168, auth 4, Admin 250, Student 20.
- `npm run lint`: baseline lint is not a release script and remains failing with 38 pre-existing/site-wide errors; it was not listed as a Phase 3D release gate. The corrective files introduced no `git diff --check` failures.
- E500 ports 4300/4310 were not touched. No local `.env`, production DB, production PDF, secrets, PII, or real documents were read or uploaded.

## 11. Git and final state

- Starting HEAD: `4bceb5e71408d5246f3bc1f28b5f21a68b4e8142`.
- Corrective implementation commit: `dbdf0ee45cad5c55087473642ff421a472a6ab10`.
- The verification report is intentionally a separate commit after the implementation commit.
- The final HEAD is the report commit containing this document; its full SHA and fast-forward push result are recorded in the run's final handoff because a commit cannot truthfully embed its own hash.
- At report preparation time, three unrelated `packages/db/src/repositories/*` working-tree edits appeared concurrently. They were neither modified, staged, reverted, nor included by this Phase 3D task. Final cleanliness is reported accurately in the handoff after the report-only commit.

## 12. RAG boundary and next phase

**RAG = NOT IMPLEMENTED** in the Phase 3D Sites runtime. No embeddings, chunking pipeline, vector index, vector search, or retrieval API was added. Synthetic RAG fixture data elsewhere in the repository is test data, not a Phase 3D runtime implementation.

Recommended next phase: begin a separately gated Phase 4 design for ingestion, chunk/version lineage, embeddings, authorization-aware retrieval, vector-store ownership, deletion propagation, and end-to-end synthetic evaluation. Do not couple that work to the verified R2 lifecycle without a new migration and release plan.
