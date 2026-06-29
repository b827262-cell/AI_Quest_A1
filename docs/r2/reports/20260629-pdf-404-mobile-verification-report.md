# 2026-06-29 PDF 404 / PDF 載入 / 手機 PDF 驗收報告

## 基本資訊

- Repo：`b827262-cell/AI-SmartBook-R1-PR4`
- 工作分支：`fix/pdf-reader-ai-core/pdf-404-mobile-20260629`
- 依據：`docs/r2/R2_MODULE_GOVERNANCE_ARCHITECTURE.md`
- 任務檔：`docs/r2/tasks/20260629-pdf-404-mobile-task.md`
- 不直接 merge：`main`

## 本次變更摘要

| 區塊 | 檔案 | 結果 |
|---|---|---|
| Student runtime config | `packages/student-runtime/src/config.ts` | 新增 `uploadDir`，支援 `STU_UPLOAD_DIR` / `UPLOAD_DIR` |
| Student data source contract | `packages/student-runtime/src/dataSource.ts` | 新增 `StudentBookPdfFile`、`pdfFileId`、`pdfFileName`、`getPdfFile()` |
| SQLite mode | `packages/student-runtime/src/sqliteDataSource.ts` | `getBook()` 可回傳主 PDF；`getPdfFile()` 可查 PDF source document |
| Static mode | `packages/student-runtime/src/staticDataSource.ts` | 補 contract；demo 書明確回傳無 PDF |
| Remote mode | `packages/student-runtime/src/remoteDataSource.ts` | 改讀 `/api/student/*` shape，避免 admin shape mismatch |
| Standalone student API | `apps/AI-Stu-R1/server/stu-api.ts` | 新增 reader session 與 `pdf-view`，修獨立學生端 PDF 404 |

## 架構符合性檢查

| 檢查項 | 狀態 | 說明 |
|---|---:|---|
| 使用新 repo `AI-SmartBook-R1-PR4` | ✅ | 本次所有檔案皆寫入 `b827262-cell/AI-SmartBook-R1-PR4` |
| 不沿用舊 R2 修補分支 | ✅ | 新建 `fix/pdf-reader-ai-core/pdf-404-mobile-20260629` |
| 不直接 merge main | ✅ | 僅建立工作分支與 commits，未 merge |
| 依五大模組治理 | ✅ | 本次鎖定 A/B，C 僅列驗收，不改 D/E |
| 先修 PDF 404 / PDF 載入 / 手機 PDF | ✅ | 優先補學生獨立 API 的 PDF 來源與 route |
| 產出 MD 任務檔 | ✅ | `docs/r2/tasks/20260629-pdf-404-mobile-task.md` |
| 產出 MD 驗收報告 | ✅ | 本檔 |

## PDF 404 驗收對照

| 驗收標準 | 狀態 | 對應變更 |
|---|---:|---|
| `/api/student/books/:bookId` 可取得 `pdfFileId` | ✅ 已補 | `SqliteDataSource.getBook()` 會查 `book_files` 最新 `source_document` PDF 並回傳 `pdfFileId` / `pdfFileName` |
| `/api/student/books/:bookId/files/:fileId/pdf-view` 回傳 200 或 206 | ✅ 已補 | `AI-Stu-R1/server/stu-api.ts` 新增 route，使用 `res.sendFile()` 串流；Express `sendFile` 可處理一般檔案傳送與 range 請求 |
| 回傳 `Content-Type: application/pdf` | ✅ 已補 | standalone `pdf-view` route 明確設定 `Content-Type` |
| Chrome 開啟 `/books/:bookId` 後 PDF 正常顯示 | ⚠️ 待實機 | GitHub connector 無法啟動本機瀏覽器；需在部署機執行 smoke test |
| 手機 PDF 正常顯示 | ⚠️ 待實機 | 後端 404 根因已修；Android/iOS 實機 rendering 仍需跑 UI smoke |
| 若檔案不存在，報告列出缺少的實體 `filePath` | ✅ 已補 | 缺檔 404 JSON 回傳 `filePath`、`uploadDir`、`checkedPaths` |

## 主要風險與限制

### 1. 尚未在部署機實跑 build / typecheck

本次透過 GitHub connector 進行 repo 檔案修改，無法直接在目標部署機執行：

```bash
pnpm --filter @ai-smartbook/student-runtime typecheck
pnpm --filter AI-Stu-R1 typecheck
pnpm --filter AI-Stu-R1 build
```

因此目前驗收狀態為：

```text
Code patch completed / runtime smoke pending
```

### 2. remote-api 模式 PDF proxy 尚未完整串流

`RemoteDataSource` 已修正 book shape 讀取，但 standalone `pdf-view` 仍以本機檔案為主。若未來 `AI-Stu-R1/server/stu-api.ts` 使用 `STU_RUNTIME_MODE=remote-api`，應再補：

```text
local /session → proxy remote /session
local /pdf-view → proxy remote /pdf-view response stream
```

目前第一優先是 `sqlite-api` / MacBook / 1GB 備援學生端 PDF 404。

### 3. FilesTab 上傳鏈路未改

本次沒有修改 Admin FilesTab。若主 PDF record 根本不存在或角色不是 `source_document`，仍需在 C 模組驗收與修正。

## 建議實機驗收流程

### A. Typecheck / build

```bash
git checkout fix/pdf-reader-ai-core/pdf-404-mobile-20260629
pnpm install
pnpm --filter @ai-smartbook/student-runtime typecheck
pnpm --filter AI-Stu-R1 typecheck
pnpm --filter AI-Stu-R1 build
```

### B. API smoke

```bash
STU_RUNTIME_MODE=sqlite-api \
STU_DB_PATH=/opt/AI-Stu-R1/data/student.db \
STU_UPLOAD_DIR=/opt/AI-Stu-R1/uploads/books \
pnpm --filter AI-Stu-R1 server:dev
```

```bash
curl -s http://127.0.0.1:4310/api/student/books/<bookId> | jq .book.pdfFileId
```

```bash
SESSION=$(curl -s -X POST http://127.0.0.1:4310/api/student/books/<bookId>/session \
  -H 'Content-Type: application/json' \
  -d '{}' | jq -r .sessionId)
```

```bash
curl -I http://127.0.0.1:4310/api/student/books/<bookId>/files/<pdfFileId>/pdf-view \
  -H "X-Student-Session-Id: $SESSION"
```

預期：

```text
HTTP/1.1 200 OK
Content-Type: application/pdf
```

若檔案不存在，預期：

```json
{
  "error": "PDF file not found on disk",
  "filePath": "...",
  "uploadDir": "...",
  "checkedPaths": ["..."]
}
```

### C. 手機 / Chrome UI smoke

1. 開啟 `/books/<bookId>`。
2. 確認第一頁 PDF 不是空白。
3. 點下一頁 / 上一頁。
4. 手機直向、橫向各測一次。
5. Android Chrome / Samsung Internet 若仍空白，再進入 A 模組前端 rendering 修正。

## 結論

本次已先修最可能造成 PDF 404 的學生獨立 API 缺口：

```text
AI-Stu-R1 standalone API 原本沒有 /session 與 /pdf-view
```

並補上 SQLite PDF metadata 與 `STU_UPLOAD_DIR` remap。下一步應在部署機執行 typecheck/build/API smoke；通過後，再以手機實機確認 PDF.js rendering 是否還需要前端 CSS 或 Android snapshot 調整。
