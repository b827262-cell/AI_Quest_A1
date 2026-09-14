# AI-Quest-A1 Sites Phase 3D: Shared R2 Textbook Storage & Object Lifecycle Report

**Report Date**: 2026-09-15  
**Operator**: AGY (Antigravity Agent)  
**Project Root**: `/home/b827262/project/AI-Quest-A1`  
**GitHub Repository**: `https://github.com/b827262-cell/AI_Quest_A1.git`  
**Branch**: `main`  
**Verified GitHub HEAD**: `03ff4455badaa97328093a2b34de244a6cec72b3`  

---

## 1. 執行摘要 (Executive Summary)

本階段完成 **AI-Quest-A1 Phase 3D: Shared R2 Textbook Storage & Object Lifecycle (共用 R2 教材物件儲存與生命週期架構)**。

### 核心成果與門禁判定
1. **MANDATORY GATE — Native R2 判定結論**：
   - **NATIVE_R2_SUPPORTED**: **YES**
   - **證據來源**: 
     - 官方 Sites 技能文檔：`references/persistence-and-storage.md`（宣告 `"r2"` binding 與 D1 metadata + R2 blob 模式）。
     - 建置腳本驗證：`prepare-site-build.cjs`（明確校驗 `config?.r2 != null` 為合法 runtime binding）。
     - 實際線上生產環境實證：Shared Backend 專案 (`appgprj_6aa80235182c8191a876361138ecbc36`) Version 3 成功發布並回傳 `{"d1":"bound","r2":"bound","storage":"r2","sharedR2Bucket":"BOOKS_BUCKET"}`。
   - **Binding 名稱與配置形狀**: 
     - `.openai/hosting.json` 中配置 `"r2": "BOOKS_BUCKET"`。
     - Cloudflare Worker 執行期掛載於 `env.BOOKS_BUCKET`（全域委派至 `globalThis.BOOKS_BUCKET`）。
   - **所有權歸屬**: 由 **Shared Backend 專案** (`appgprj_6aa80235182c8191a876361138ecbc36`) 單一擁有，Student 與 Admin 前端完全不直連 R2，所有讀寫操作均透過代理委派集中於 Shared Backend。

2. **統一資料平面拓撲 (Centralized Storage Architecture)**：
   ```text
   Shared Backend (appgprj_6aa80235182c8191a876361138ecbc36)
      ├── Shared D1 (DB)                 -> 教材中繼資料 (books, reading_progress, admin_overview, students)
      └── Shared R2 (BOOKS_BUCKET)      -> 實體 PDF 與教材二進位物件 (textbooks/<id>/<timestamp>-<rand>.pdf)
   ```
   - **Student 前端** (`appgprj_6a843b2ece70819191132bd6e99df7a1`，Version 13): 透過 `/api/student/books` 與 `/api/student/books/:id/content` 代理轉發至 Shared Backend，安全串流讀取 R2 PDF。
   - **Admin 前端** (`appgprj_6a843b6432f88191aa4cc090c236f3d3`，Version 12): 透過 `/api/admin/books/upload`、`/api/admin/books` 與 `/api/admin/books/:id` 代理轉發至 Shared Backend 進行管理、上傳與刪除。

3. **PDF 安全驗證與補償機制 (Safety & Consistency)**：
   - 上傳防護：嚴格檢查二進位魔術標頭 `%PDF-`、檔案大小限制（15MB）、SHA-256 完整性雜湊計算。
   - 伺服器端防路徑遍歷：由伺服器自動生成 `textbooks/<bookId>/<timestamp>-<rand>.pdf` 物件路徑。
   - 事務補償機制：若 D1 中繼資料寫入失敗，立即對 R2 物件執行補償性物理刪除，防止產生孤立物件 (Orphaned Blobs)。

4. **全數通過 8 項線上實體發布驗證閘門 (Live Release Gates 1-8)**：
   - 透過 Admin 前端完成 476 bytes 合成測試 PDF 上傳（HTTP 201 Created）。
   - 透過 Student 前端即時於書架看見新書，並串流下載完整 PDF（驗證 `%PDF-` 標頭與 SHA-256 完全一致）。
   - 透過 Admin 前端執行刪除與冪等刪除（HTTP 200，R2 實體刪除 + D1 標記 deleted）。
   - 刪除後 Student 前端請求立即回傳 HTTP 404。

---

## 2. 部署專案與執行期元資料 (Deployment Metadata)

| 專案角色 | 專案名稱 | Project ID | 發布版本 ID | 部署狀態 | 綁定資源 | 線上正式 URL |
|---|---|---|---|---|---|---|
| **Shared Backend** | AI-Quest-A1 Backend | `appgprj_6aa80235182c8191a876361138ecbc36` | Version 3 (`appgver_ad4ee5d19ac08191af593ebdb3ab0458`) | **`succeeded`** (`appgdep_6aa8192aedf88191a00975895cd4a5e7`) | `DB` (D1) + `BOOKS_BUCKET` (R2) | `https://ai-quest-a1-backend.b827262.chatgpt.site` |
| **Student Frontend** | AI-Quest-A1 Student | `appgprj_6a843b2ece70819191132bd6e99df7a1` | Version 13 (`appgver_64808c131bc88191915632e38b958f91`) | **`succeeded`** (`appgdep_6aa81a5ee9f08191954d5e826e408b6e`) | 委派 Shared Backend | `https://ai-quest-a1-student.b827262.chatgpt.site` |
| **Admin Frontend** | AI-Quest-A1 Admin | `appgprj_6a843b6432f88191aa4cc090c236f3d3` | Version 12 (`appgver_54e0ae1c4ed881918722768ccebe090c`) | **`succeeded`** (`appgdep_6aa81b8007ec81918248298e904c015a`) | 委派 Shared Backend | `https://ai-quest-a1-admin.b827262.chatgpt.site` |

---

## 3. 變更檔案清單 (Files Implemented & Verified)

1. `site/lib/storage.ts` (NEW):
   - 封裝 `getStorageBucket()`，生產環境連接 `env.BOOKS_BUCKET`，非生產環境提供記憶體 `InMemoryR2Bucket` 模擬。
   - 實作 `validatePdfBytes()`，校驗 `%PDF-` 魔術標頭、非空、15MB 大小限制。
   - 實作 `generateBookObjectKey()` 防目錄遍歷路徑生成器。
   - 實作 `calculateSha256()` 二進位完整性雜湊計算。
2. `site/lib/book-store.ts` (NEW):
   - 提供 `listAllBooks()`、`getBookById()`、`saveBookMetadata()` 與 `markBookDeleted()`。
   - 與 D1 `books` 表結構綁定，支援 `active` / `deleted` 狀態過濾與 D1 離線例外處理。
3. `site/db/schema.ts` & `site/drizzle/0001_cool_microbe.sql`:
   - 擴充 `books` 資料表：`object_key`, `content_type`, `byte_size`, `sha256`, `storage_state`, `updated_at`。
4. `site/app/api/admin/books/`:
   - `route.ts`: 支援書籍列表查詢 (`GET`) 與刪除 (`DELETE`)。
   - `upload/route.ts`: 支援多格式上傳（multipart / binary stream / JSON base64），整合 R2 上傳、SHA-256 計算、D1 保存與補償回滾。
   - `[id]/route.ts`: 單一書籍查詢與刪除。
5. `site/app/api/student/books/`:
   - `route.ts`: 學生端書籍列表查詢（過濾已刪除教材）。
   - `[id]/route.ts`: 學生端單一書籍資訊查詢。
   - `content/route.ts` & `[id]/content/route.ts`: 從 R2 串流輸出 PDF 二進位資料，附帶 `Content-Disposition`, `ETag`, `x-sha256` 標頭。
6. `site/app/api/backend-client.ts`:
   - 改造委派轉發管線，使用 `request.arrayBuffer()` 與 `response.arrayBuffer()` 取代純文字處理，防止二進位 PDF 毀損。
   - CORS 允許方法納入 `DELETE`。
7. `site/app/api/health/route.ts`:
   - 揭露 `r2: "bound"`, `storage: "r2"`, `sharedR2Project`, `sharedR2Bucket: "BOOKS_BUCKET"`。
8. `site/tests/phase3d-r2-storage.test.mjs`:
   - 7 項自動化測試全數通過（39/39 總測試 PASS）。

---

## 4. 線上發布實體驗證實證 (Live Verification Evidence)

### 4.1 健康檢查閘門 (Gate 0: Health Endpoints)
```http
GET https://ai-quest-a1-backend.b827262.chatgpt.site/api/health
HTTP/2 200 OK
{"status":"ok","edge":"cloudflare-worker","d1":"bound","r2":"bound","storage":"r2","phase":2,"role":"shared-backend","backendTarget":"https://ai-quest-a1-backend.b827262.chatgpt.site","sharedD1Project":"appgprj_6aa80235182c8191a876361138ecbc36","sharedR2Project":"appgprj_6aa80235182c8191a876361138ecbc36","sharedR2Bucket":"BOOKS_BUCKET","time":"2026-09-14T15:57:43.070Z"}

GET https://ai-quest-a1-student.b827262.chatgpt.site/api/health
HTTP/2 200 OK
{"status":"ok","edge":"cloudflare-worker","d1":"bound","r2":"bound","storage":"r2","phase":2,"role":"frontend-proxy","backendTarget":"https://ai-quest-a1-backend.b827262.chatgpt.site","sharedD1Project":"appgprj_6aa80235182c8191a876361138ecbc36","sharedR2Bucket":"BOOKS_BUCKET",...}

GET https://ai-quest-a1-admin.b827262.chatgpt.site/api/health
HTTP/2 200 OK
{"status":"ok","edge":"cloudflare-worker","d1":"bound","r2":"bound","storage":"r2","phase":2,"role":"frontend-proxy","backendTarget":"https://ai-quest-a1-backend.b827262.chatgpt.site","sharedD1Project":"appgprj_6aa80235182c8191a876361138ecbc36","sharedR2Bucket":"BOOKS_BUCKET",...}
```

### 4.2 教材生命週期線上全流程驗證 (Gates 1-8)
| 測試步驟 | 請求端點 | 請求身分 | 預期結果 | 實際線上結果 | 判定 |
|---|---|---|---|---|---|
| **Step 1: 上傳 PDF** | `POST https://ai-quest-a1-admin.../api/admin/books/upload` | Admin Bearer + Gate Header | HTTP 201 Created，產生 R2 物件路徑與 SHA-256 | HTTP 201, `byteSize: 476`, `sha256: 170e2df4...` | **PASS** |
| **Step 2: Admin 列表** | `GET https://ai-quest-a1-admin.../api/admin/books` | Admin Bearer + Gate Header | HTTP 200，包含剛上傳教材 | HTTP 200, 找到該教材 | **PASS** |
| **Step 3: Student 列表** | `GET https://ai-quest-a1-student.../api/student/books` | 匿名訪客 / 學生 | HTTP 200，在學生書架上看見新教材 | HTTP 200, 找到該教材 | **PASS** |
| **Step 4: Student 詳情** | `GET https://ai-quest-a1-student.../api/student/books/:id` | 匿名訪客 / 學生 | HTTP 200，包含章節與頁數中繼資料 | HTTP 200, 章節 8, 頁數 160 | **PASS** |
| **Step 5: Student 串流** | `GET https://ai-quest-a1-student.../api/student/books/:id/content` | 匿名訪客 / 學生 | HTTP 200，串流 PDF 二進位，魔術標頭 `%PDF-`，SHA-256 完全吻合 | HTTP 200, 476 bytes, `%PDF-`, SHA-256 完全吻合 | **PASS** |
| **Step 6: Admin 刪除** | `DELETE https://ai-quest-a1-admin.../api/admin/books?id=...` | Admin Bearer + Gate Header | HTTP 200，物理刪除 R2 物件並更新 D1 | HTTP 200, `deleted: true` | **PASS** |
| **Step 7: 冪等刪除** | `DELETE https://ai-quest-a1-admin.../api/admin/books?id=...` | Admin Bearer + Gate Header | HTTP 200，回傳 `alreadyDeleted: true` | HTTP 200, `alreadyDeleted: true` | **PASS** |
| **Step 8: 刪後讀取** | `GET https://ai-quest-a1-student.../api/student/books/:id/content` | 匿名訪客 / 學生 | HTTP 404 Not Found | HTTP 404 `book_not_found` | **PASS** |

---

## 5. 結論與後續閘門 (Conclusion & Next Steps)

Phase 3D 已正式驗證 ChatGPT Sites 平台具備完全原生的 Cloudflare R2 物件儲存能力，並已成功將 AI-Quest-A1 的教材檔案管理與串流架構建立在統一的 Shared Backend 上。

- **目前狀態**: **PHASE 3D COMPLETE**
- **下一個閘門**: **Phase 4 (RAG / Vector Search & Embeddings Architecture Gate)**
