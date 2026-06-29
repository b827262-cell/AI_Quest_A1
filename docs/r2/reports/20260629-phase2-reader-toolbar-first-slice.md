# 2026-06-29 Phase 2 Reader Toolbar — First Slice

## Changed files

- `apps/AI-Stu-R1/src/components/PdfReaderToolbar.tsx`
- `apps/AI-Stu-R1/src/components/ProtectedPdfViewer.tsx`
- `apps/AI-Stu-R1/src/pages/BookReaderPage.tsx`
- `apps/AI-Stu-R1/src/styles.css`

## Summary

- `selectedText` and `onAddToNotes` props were added to the reader toolbar API.
- "Add to Notes" now supports selected text by wiring selected text into notes flow.
- The toolbar keeps screenshot ask AI / knowledge points / progress actions as disabled placeholders, pending backend endpoint support.
- `suppressContextMenu` was added as best-effort protection to reduce casual download/capture paths.
- Print media protection was added in `styles.css` (`@media print`) to hide reader/PDF viewer and show a copyright message.
- Mobile toolbar simplification was added to keep mobile UI compact:
  - Hide placeholder buttons
  - Hide ratio controls
  - Hide full-width toggle

## Validation

- `pnpm --filter AI-Stu-R1 typecheck` — PASS
- `pnpm --filter AI-Stu-R1 build` — PASS
- Build emitted a chunk-size warning (`Some chunks are larger than 500 kB`), which is existing/non-blocking.

## Security note

- This is best-effort protection only.
- Browser download, DevTools extraction, OS screenshot, and device capture cannot be fully prevented by frontend code.

## Backend endpoints pending

- `POST /api/student/books/:bookId/screenshot-ask`
- `GET /api/student/books/:bookId/chapters/:chapterId/knowledge-points`
- `POST /api/student/books/:bookId/progress`
