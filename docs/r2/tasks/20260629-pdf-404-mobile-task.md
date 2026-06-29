# 2026-06-29 PDF 404 / PDF 載入 / 手機 PDF 任務檔

## 任務定位

- Repo：`b827262-cell/AI-SmartBook-R1-PR4`
- 工作分支：`fix/pdf-reader-ai-core/pdf-404-mobile-20260629`
- 不沿用：舊 `AI-SmartBook-R1` 的 R2 修補分支
- 不可直接 merge：`main`
- 依據文件：`docs/r2/R2_MODULE_GOVERNANCE_ARCHITECTURE.md`

## 模組歸屬

| 模組 | 責任 | 本次處理 |
|---|---|---|
| A. PDF Reader & AI Core | Reader 取得 `pdfFileId`、建立 session、呼叫 `pdf-view`、交給 PDF.js 顯示 | 修正學生獨立 API 回傳 PDF metadata 與新增 `pdf-view` |
| B. Book / Content Pipeline | `book_files` 的 `source_document`、`filePath`、`UPLOAD_DIR` / `STU_UPLOAD_DIR` | 修正 SQLite data source 查詢主 PDF 與補檔案路徑 remap |
| C. Admin / Files / Settings | FilesTab 上傳與 file record 管理 | 本次不改 FilesTab；保留為後續驗收項 |
| D. Smart AI Backend | AI provider / jobs | 本次不處理 |
| E. Question Bank / Solve | 題庫與解題 | 本次不處理 |

## 問題拆解

原本主後台 `AI-adm-D1/src/server/index.ts` 已有：

```text
GET /api/student/books/:bookId
GET /api/student/books/:bookId/session
GET /api/student/books/:bookId/files/:fileId/pdf-view
```

但 `apps/AI-Stu-R1/server/stu-api.ts` 的獨立學生 API 只有：

```text
GET /api/student/books
GET /api/student/books/:bookId
GET /api/student/books/:bookId/contents
POST /api/student/books/:bookId/chat
```

因此當手機或備援學生端走 `AI-Stu-R1/server/stu-api.ts` 時，Reader 會依照前端 `studentClient.getProtectedPdfBlob()` 呼叫：

```text
/api/student/books/:bookId/files/:fileId/pdf-view
```

但該 route 不存在，形成 PDF 404。

## 實作項目

### 1. Student runtime config

檔案：`packages/student-runtime/src/config.ts`

新增：

```text
STU_UPLOAD_DIR / UPLOAD_DIR / /opt/AI-Stu-R1/uploads/books
```

用途：學生端獨立部署時，可以把從主機同步來的 `student.db` 內 `file_path` 重新對應到學生端實際 PDF 目錄。

### 2. Student data source contract

檔案：`packages/student-runtime/src/dataSource.ts`

新增：

- `StudentBookPdfFile`
- `StudentBookDetail.pdfFileId`
- `StudentBookDetail.pdfFileName`
- `StudentDataSource.getPdfFile(bookId, fileId)`

### 3. SQLite data source

檔案：`packages/student-runtime/src/sqliteDataSource.ts`

新增：

- 從 `book_files` 查詢最新 `role = 'source_document'` 且 PDF 的檔案
- `getBook()` 回傳 `pdfFileId` / `pdfFileName`
- `getPdfFile()` 給獨立學生 API 串流 PDF 用

### 4. Static / Remote data source

檔案：

- `packages/student-runtime/src/staticDataSource.ts`
- `packages/student-runtime/src/remoteDataSource.ts`

調整：

- 補齊 `getPdfFile()` contract
- remote 模式改讀 `/api/student/*` shape，避免誤把 `/api/admin/books/:bookId` 的 `{ book, chapters, files }` 當成學生端 `BookDetail`

### 5. Student standalone API

檔案：`apps/AI-Stu-R1/server/stu-api.ts`

新增：

- `POST /api/student/books/:bookId/session`
- `GET /api/student/books/:bookId/files/:fileId/pdf-view`
- PDF session 記憶體管理
- `filePath` remap：
  - 原始 `file.filePath`
  - 目前執行目錄相對路徑
  - `STU_UPLOAD_DIR/<bookId>/<basename>`
  - 從舊主機絕對路徑中擷取 `/uploads/books/<bookId>/...` tail 後 remap
- 缺檔時回傳 `filePath`、`uploadDir`、`checkedPaths`，符合 PDF 404 驗收要求的缺檔報告
- PDF 回傳 headers：
  - `Content-Type: application/pdf`
  - `Content-Disposition: inline; filename="reader.pdf"`
  - `Cache-Control: private, no-store, no-cache, must-revalidate`
  - `X-Content-Type-Options: nosniff`

## 手機 PDF 驗收焦點

手機端目前前端已有：

- PDF.js in-memory blob rendering
- Android canvas snapshot fallback
- mobile fixed PDF viewport
- mobile page jump bar

本次優先處理手機 PDF 載入失敗的後端 404 / PDF Blob 來源問題。若後續仍有 Android / iOS 畫面空白，下一步才進入 A 模組前端 CSS / PDF.js rendering 調整。

## 本次不處理項目

依優先順序暫緩：

- Reader Toolbar 新功能
- 貼回 AI 筆記
- 截圖問 AI
- 5×5 ICO
- 知識點
- 一鍵完成 workflow
- 知識達點數

## 建議驗收命令

```bash
# 1. 安裝 / 型別檢查
pnpm install
pnpm --filter @ai-smartbook/student-runtime typecheck
pnpm --filter AI-Stu-R1 typecheck

# 2. 啟動獨立學生 API
STU_RUNTIME_MODE=sqlite-api \
STU_DB_PATH=/opt/AI-Stu-R1/data/student.db \
STU_UPLOAD_DIR=/opt/AI-Stu-R1/uploads/books \
pnpm --filter AI-Stu-R1 server:dev

# 3. 取得書籍與 PDF id
curl -s http://127.0.0.1:4310/api/student/books/<bookId>

# 4. 建立 reader session
SESSION=$(curl -s -X POST http://127.0.0.1:4310/api/student/books/<bookId>/session \
  -H 'Content-Type: application/json' \
  -d '{}' | jq -r .sessionId)

# 5. 檢查 PDF headers
curl -I http://127.0.0.1:4310/api/student/books/<bookId>/files/<pdfFileId>/pdf-view \
  -H "X-Student-Session-Id: $SESSION"

# 6. 手機瀏覽器驗收
# 開啟 /books/<bookId>，確認 PDF 第一頁可見、頁碼可切換、旋轉螢幕後仍可顯示。
```
