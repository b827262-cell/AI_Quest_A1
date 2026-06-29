# 20260629 Phase 2 Backend/API Inventory (Reader Learning UX)

Branch: `fix/pdf-reader-ai-core/pdf-404-mobile-20260629`

Note: `docs/r2/specs/20260629-phase2-reader-learning-ux-spec.md` is not present in this checkout (`docs/r2` only contains `reports`, `tasks`, and module docs). The inventory below is derived from current code + route/data inspection.

## 1) Existing reusable tables

- Core content
  - `books`, `book_files`, `book_contents`, `book_chapters` in [schema](/home/b827262/project/AI-SmartBook-R1-PR4/packages/db/src/schema.ts)
  - Repos: [book.repo](/home/b827262/project/AI-SmartBook-R1-PR4/packages/db/src/repositories/book.repo.ts), [bookFile.repo](/home/b827262/project/AI-SmartBook-R1-PR4/packages/db/src/repositories/bookFile.repo.ts), [bookContent.repo](/home/b827262/project/AI-SmartBook-R1-PR4/packages/db/src/repositories/bookContent.repo.ts), [chapter.repo](/home/b827262/project/AI-SmartBook-R1-PR4/packages/db/src/repositories/chapter.repo.ts)

- AI/chat
  - `chat_sessions`, `chat_messages` in [schema](/home/b827262/project/AI-SmartBook-R1-PR4/packages/db/src/schema.ts)
  - Repos: [chat.repo](/home/b827262/project/AI-SmartBook-R1-PR4/packages/db/src/repositories/chat.repo.ts)

- Notes + Q&A logs
  - `smart_book_notes` in [schema](/home/b827262/project/AI-SmartBook-R1-PR4/packages/db/src/schema.ts)
  - `book_qa_logs` in [schema](/home/b827262/project/AI-SmartBook-R1-PR4/packages/db/src/schema.ts)
  - Repos: [smartBookNote.repo](/home/b827262/project/AI-SmartBook-R1-PR4/packages/db/src/repositories/smartBookNote.repo.ts), [qaLog.repo](/home/b827262/project/AI-SmartBook-R1-PR4/packages/db/src/repositories/qaLog.repo.ts)

- Access tracking
  - `pdf_access_logs` in [schema](/home/b827262/project/AI-SmartBook-R1-PR4/packages/db/src/schema.ts)
  - Repo: [pdfAccessLog.repo](/home/b827262/project/AI-SmartBook-R1-PR4/packages/db/src/repositories/pdfAccessLog.repo.ts)

- Supporting tables
  - `book_ai_jobs`, `app_settings` already exist and are used by admin routes/jobs/settings.

- Migration coverage
  - All above are created in [migrate.ts](/home/b827262/project/AI-SmartBook-R1-PR4/packages/db/src/migrate.ts).

## 2) Existing reusable endpoints

### Student API routes (central admin server)
- `apps/AI-adm-D1/src/server/index.ts`
- `GET /api/student/books`
- `GET /api/student/books/:bookId`
- `GET /api/student/books/:bookId/outline`
- `GET /api/student/books/:bookId/contents`
- `POST /api/student/books/:bookId/session`
- `GET /api/student/books/:bookId/files/:fileId/pdf-view`
- `GET /api/student/books/:bookId/notes`
- `POST /api/student/books/:bookId/notes`
- `PATCH /api/student/books/:bookId/notes/:noteId`
- `DELETE /api/student/books/:bookId/notes/:noteId`
- `POST /api/student/books/:bookId/chat`
- `GET /api/student/books/:bookId/chat-sessions/:sessionId`

### Student API routes (standalone app)
- `apps/AI-Stu-R1/server/stu-api.ts`
- `GET /api/student/books`
- `GET /api/student/books/:bookId`
- `GET /api/student/books/:bookId/contents`
- `POST /api/student/books/:bookId/session`
- `GET /api/student/books/:bookId/files/:fileId/pdf-view`
- `POST /api/student/books/:bookId/chat`

### Frontend client contracts already aligned
- [studentClient](/home/b827262/project/AI-SmartBook-R1-PR4/apps/AI-Stu-R1/src/studentClient.ts) expects: books/outline/contents/session/pdf-view/chat/chat-sessions/notes endpoints with `note` and `chat` payloads.

### Admin/content lifecycle and AI management (reusable)
- `GET /api/admin/books`
- `POST /api/admin/books`
- `GET /api/admin/books/:bookId`
- `PATCH /api/admin/books/:bookId`
- `POST /api/admin/books/:bookId/files`
- `GET /api/admin/books/:bookId/files/:fileId/raw`
- `DELETE /api/admin/books/:bookId/files/:fileId`
- `POST /api/admin/books/:bookId/files/:fileId/parse-content`
- `POST /api/admin/books/:bookId/files/:fileId/attach-reference-image`
- `POST /api/admin/books/:bookId/files/:fileId/outline-preview`
- `POST /api/admin/books/:bookId/files/:fileId/generate-json-index`
- `POST /api/admin/books/:bookId/files/:fileId/save-json-index`
- `POST /api/admin/books/:bookId/json-indexes/upload`
- `GET /api/admin/books/:bookId/json-indexes`
- `POST /api/admin/books/:bookId/json-indexes/:indexFileId/set-active-qa-reference`
- `GET /api/admin/books/:bookId/json-indexes/:indexFileId/raw`
- `DELETE /api/admin/books/:bookId/json-indexes/:indexFileId`
- `POST /api/admin/books/:bookId/reader-toc/import`
- `GET /api/admin/books/:bookId/reader-toc`
- `DELETE /api/admin/books/:bookId/reader-toc`
- `POST /api/admin/books/:bookId/reader-toc/generate-from-json-index`
- `POST /api/admin/books/:bookId/files/:fileId/apply-chapters`
- `GET /api/admin/books/:bookId/contents`
- `DELETE /api/admin/books/:bookId/contents`
- `GET /api/admin/books/:bookId/chapters`
- `POST /api/admin/books/:bookId/chapters`
- `PATCH /api/admin/books/:bookId/chapters/:chapterId`
- `DELETE /api/admin/books/:bookId/chapters/:chapterId`
- `POST /api/admin/books/:bookId/chapters/build`
- `POST /api/admin/books/:bookId/chapters/link-content`
- `POST /api/admin/books/:bookId/ai/split-book`
- `POST /api/admin/books/:bookId/ai/build-chapters`
- `POST /api/admin/books/:bookId/qa`
- `POST /api/admin/books/:bookId/qa/import-markdown`
- `GET /api/admin/books/:bookId/ai-jobs`
- `GET /api/admin/books/:bookId/qa-logs`
- `GET /api/admin/dashboard/stats`
- `GET /api/admin/accounts`
- `PATCH /api/admin/accounts/:sessionId/risk`
- `PATCH /api/admin/accounts/:sessionId/block`
- `GET /api/admin/student-questions`
- `DELETE /api/admin/student-questions/:id`
- `POST /api/admin/student-questions/delete`

## 3) Missing endpoints (as-is)

- No dedicated phase-2 endpoints for:
  - knowledge index / learner knowledge graph (e.g. `/api/student/books/:bookId/knowledge`)
  - completion/progress state (`/api/student/books/:bookId/completion*`, chapter/page checkpoints)
  - achievement / ICO / score endpoints
- No endpoint to read `pdf_access_logs` by book/session for analytics.
- No endpoint to read `chat_sessions` / `chat_messages` by book scoped with pagination filters for reporting.
- In `apps/AI-Stu-R1/server/stu-api.ts`, notes/chat-session/outline endpoints are absent (`/notes`, `/chat-sessions/:sessionId`, `/outline`) so the local runtime cannot serve the full student learning UX alone.

## 4) Minimal endpoint contract for Phase 2 (proposed)

Assuming Phase 2 is centered on learner UX + learning analytics:

- Keep and reuse:
  - `POST /api/student/books/:bookId/chat`
  - `GET /api/student/books/:bookId/chat-sessions/:sessionId`
  - `GET /api/student/books/:bookId/notes`
  - `POST /api/student/books/:bookId/notes`
  - `PATCH /api/student/books/:bookId/notes/:noteId`
  - `DELETE /api/student/books/:bookId/notes/:noteId`
  - `GET /api/student/books/:bookId/contents`
  - `GET /api/student/books/:bookId/outline`

- Add minimal read endpoints first:
  - `GET /api/student/books/:bookId/qa-history`
    - `200`: `{ bookId, items: BookQaLog[] }`
    - map from existing `book_qa_logs` filtered by `book_id`
  - `GET /api/student/books/:bookId/progress`
    - `200`: `{ bookId, completionRate: number, completedChapters: number, totalChapters: number, noteCount: number, qaCount: number, lastActiveAt?: string }`
    - derive from existing tables only
  - `GET /api/admin/books/:bookId/pdf-access-logs`
    - `200`: `{ bookId, sessions: number, rows: PdfAccessLog[] }`
    - expose read path for existing `pdf_access_logs`

- Add missing write endpoints if completion is explicit (requires schema addition, see below):
  - `POST /api/student/books/:bookId/completion`
  - `GET /api/student/books/:bookId/achievements`

## 5) Features possible without schema migration

Can be implemented immediately using current tables/repos:

- Learning notes capture (create/edit/delete/list), including AI answer note workflow in `/api/student/books/:bookId/notes`.
- Chat continuity and history restoration using `chat_sessions` + `chat_messages`.
- Read-side learning analytics prototypes (counts/rate) by aggregating:
  - notes (`smart_book_notes`)
  - chat messages (`chat_messages`)
  - QA events (`book_qa_logs` created by `/api/admin/books/:bookId/qa` path)
- PDF access audit UI if only reading existing `pdf_access_logs` (requires read endpoint only).

## 6) Features requiring schema additions

- Per-student identity table / user linking for cross-device completion and achievement semantics beyond session-local storage.
- First-class completion state and checkpointing (book/chapter/page/timestamp, totals) instead of inferring from chat/notes.
- Achievement/ICO scoring entities and history events.
- Structured learner knowledge graph entities (if requirement is more than free-form QA logs).
- Optional migration of `riskLevel` into a tighter enum validation path at API boundary (currently stored as string in schema model).

## 7) Recommended first backend implementation slice

1. Baseline hardening (no new migrations)
   - Add read endpoints for existing analytics primitives:
     - `/api/admin/books/:bookId/pdf-access-logs`
     - `/api/admin/books/:bookId/chat-sessions`
     - `/api/student/books/:bookId/qa-history`
     - `/api/student/books/:bookId/progress` (aggregated)
   - Reuse existing repos directly; no runtime schema changes.

2. Learner contract stabilization
   - Return consistent `Session/Message/Note` projection types for all student-facing endpoints.
   - Ensure `admin` route set and `studentClient` contracts remain aligned.

3. Phase-2 expansion (with migration)
   - Add completion and achievement tables.
   - Expose `/api/student/books/:bookId/completion*` and `/api/student/books/:bookId/achievement*`.
   - Add optional account/user link in `chat_sessions` if cross-device persistence is required.
