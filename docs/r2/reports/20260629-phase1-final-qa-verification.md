# 2026-06-29 Phase 1 Final QA Verification

Current AGY QA result: PASS

## AGY QA Summary

| Check | Result |
|---|---|
| Books list loads | PASS |
| Target book opens | PASS |
| Desktop PDF renders | PASS |
| Mobile PDF renders | PASS |
| No PDF 404 in console | PASS |
| No appearance image 404 | PASS |
| /uploads/books/* returns 404 from Nginx | PASS |
| pdf-view is used for PDF loading | PASS |
| Reader does not show obvious download button | PASS |
| Mobile does not white-screen | PASS |

## Runtime Notes

- PDF 404 root cause was stale R1/R2 absolute `file_path` values in DB.
- PDF assets were restored into PR4 `uploads/books`.
- `book_files.file_path` values were updated to PR4 absolute paths.
- Appearance image 404 was fixed by runtime asset restoration and a symlink under `apps/AI-adm-D1/uploads/appearance` pointing to the restored `uploads/appearance` location.
- This symlink is runtime environment setup, not source code.
- `data/` and `uploads/` remain runtime-only and must not be committed.

## Final Phase 1 Status

PR4 Phase 1 PDF 404 / PDF loading / mobile PDF display / 1GB proxy verification — DONE PASS.
