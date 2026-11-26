# 學員課業筆記與 AI 助教系統說明文件

> 適用範圍：`apps/AI-Stu-R1` 學員端「智慧筆記 / AI 助教」功能
> 相關程式：`apps/AI-Stu-R1/server/stu-api.ts`、`packages/auth/src/student-notes-express.ts`
> 相關計畫：`docs/plans/R22-student-google-ai-notes-proposal.md`、`docs/plans/R24-sprint-dispatch-plan.md`

本文件提供四個面向的說明：架構概覽、API 契約速查、環境變數與部署 SOP、安全與隱私清單。閱讀者假設為接手維運的工程師與審查者。

---

## 1. 架構概覽

### 1.1 雙 DB 隔離原則

學員筆記與學習歷程**只存放於 auth DB**，並與學員身分資料同庫，確保「誰能讀哪一筆」可由同一交易與同一授權邊界保證。

| 資料表 | 用途 | 所在 DB | 是否可經 `StudentDataSource`（唯讀）存取 |
| --- | --- | --- | --- |
| `student_notes` | 學員筆記本體（標題、內容、標籤、來源） | auth DB | **永不** |
| `student_learning_history` | 學習歷程（AI 提問、回應、來源、時間） | auth DB | **永不** |

關鍵原則：

1. **`student_notes` 與 `student_learning_history` 同置於 auth DB**，不複製到學員唯讀資料源。
2. **永不經唯讀 `StudentDataSource`**：所有筆記與歷程的讀寫一律走 auth DB 的連線與 repository，避免唯讀連線繞過授權與租戶隔離。
3. 唯讀 `StudentDataSource` 僅供學員端唯讀查詢（例如課表、成績等），**不得**承載任何筆記或 AI 歷程資料。
4. 任何新功能若需要寫入學員個人資料，必須先確認落在 auth DB，再開 API；不得為了方便而在唯讀資料源建表。

### 1.2 資料流

兩條 AI 來源都先落地 `learning_history`，再由 `from-history` 一鍵轉存為筆記，確保「先留存、後整理」：

```
┌────────────────────────┐        ┌──────────────────────────────┐
│ Google AI Relay        │        │ 平台 AI（/api/student/ai-ask）│
│ （學員於 Google 端提問）│        │  mock / gemini 模式           │
└───────────┬────────────┘        └──────────────┬───────────────┘
            │                                     │
            └──────────────┬──────────────────────┘
                           ▼
              ┌──────────────────────────────┐
              │ student_learning_history      │  ← 一律先寫入歷程（auth DB）
              │ （來源、提問、回應、時間）      │
              └──────────────┬───────────────┘
                             │  POST /api/student/notes/from-history
                             ▼
              ┌──────────────────────────────┐
              │ student_notes                 │  ← 一鍵轉存為筆記（auth DB）
              │ （標題、內容、標籤、來源）      │
              └──────────────────────────────┘
```

- **Google AI Relay**：學員在 Google 端使用 AI 的問答，經 Relay 寫入 `learning_history`。伺服器**不會**自動去抓取 Google URL 內容，僅接受已由前端/Relay 帶入的結構化資料。
- **平台 AI**：`POST /api/student/ai-ask` 產生回應後，同樣先寫入 `learning_history`，回應可即時顯示，也可稍後由 `from-history` 轉存成筆記。
- **`from-history` 一鍵轉存**：以歷程 ID 為來源，複製內容到 `student_notes`，並保留來源關聯，方便追溯。

---

## 2. API 契約速查

所有端點皆位於 `/api/student`，需通過學員身分驗證（session）與來源檢查（`originGuard`）。

### 2.1 筆記端點：`/api/student/notes`

| # | 方法與路徑 | 用途 | 主要請求欄位 | 成功回應 |
| --- | --- | --- | --- | --- |
| 1 | `GET /api/student/notes` | 列出筆記（支援 Phase 2 `?tag=&q=` 過濾） | `tag`（選填）、`q`（選填，關鍵字） | `200` 筆記陣列 |
| 2 | `GET /api/student/notes/:id` | 取得單一筆記 | 路徑參數 `id` | `200` 筆記物件 |
| 3 | `POST /api/student/notes` | 新增筆記 | `title`、`content`、`tags`（選填）、`source`（選填） | `201` 新筆記 |
| 4 | `PATCH /api/student/notes/:id` | 更新筆記 | 路徑參數 `id`，可含 `title`、`content`、`tags` | `200` 更新後筆記 |
| 5 | `DELETE /api/student/notes/:id` | 刪除筆記 | 路徑參數 `id` | `204` 無內容 |
| 6 | `POST /api/student/notes/from-history` | 由學習歷程一鍵轉存筆記 | `historyId`（必填）、`title`（選填，預設取歷程摘要） | `201` 新筆記 |

Phase 2 查詢參數：

- `?tag=<tag>`：依標籤過濾，僅回傳含該標籤的筆記。
- `?q=<keyword>`：全文關鍵字搜尋（標題與內容）。
- 兩者可合併使用，採 AND 邏輯。

### 2.2 AI 提問端點（Phase 2）：`POST /api/student/ai-ask`

請求欄位：

| 欄位 | 型別 | 必填 | 說明 |
| --- | --- | --- | --- |
| `question` | string | 是 | 學員提問內容，受 body 大小限制（見 2.3） |
| `context` | string | 否 | 補充上下文（例如課堂筆記片段） |
| `source` | string | 否 | 來源標記，預設 `platform` |

回應：`200`，包含 AI 回應內容與寫入 `learning_history` 後的歷程 ID，供後續 `from-history` 使用。

### 2.3 錯誤碼與 256 KiB parser 順序

| HTTP | 錯誤碼 | 觸發情境 | 說明 |
| --- | --- | --- | --- |
| `401` | `AUTH_REQUIRED` | 未登入或 session 失效 | 需先完成學員登入 |
| `403` | `STUDENT_ORIGIN_NOT_ALLOWED` | `originGuard` 判定來源不符 | 請求來源不在允許清單 |
| `404` | `NOTE_NOT_FOUND` | 指定筆記或歷程不存在（或非本人） | 避免洩漏他人資源是否存在 |
| `413` | `NOTE_TOO_LARGE` | 筆記或請求 body 超過大小上限 | 見下方 parser 順序 |
| `422` | `VALIDATION_FAILED` | 必填欄位缺失或型別錯誤 | 請求格式不符契約 |
| `429` | `AI_ASK_RATE_LIMITED` | AI 提問超過速率限制 | 請退避後重試 |
| `500` | `INTERNAL_ERROR` | 未預期伺服器錯誤 | 不輸出內部細節給前端 |

**256 KiB parser 順序**（重要）：

1. 先經 `originGuard` 與身分驗證，**在解析 body 之前**即拒絕非法來源與未授權請求。
2. 再以 256 KiB 上限的 body parser 解析 JSON；超過上限立即回 `413 NOTE_TOO_LARGE`，不進入業務邏輯。
3. 解析成功後才做欄位驗證（`422`）與業務處理（含 `429` 速率限制）。

此順序確保：過大或非法來源的請求不會消耗後續業務資源，且錯誤碼語意一致（來源錯 → `403`、過大 → `413`、格式錯 → `422`、太頻繁 → `429`）。

---

## 3. 環境變數與部署步驟

### 3.1 環境變數

| 變數 | 允許值 | 位置 | 說明 |
| --- | --- | --- | --- |
| `STUDENT_AI_ASK_MODE` | `mock` / `gemini` | 伺服器端 | `mock`：不呼叫外部模型，回傳固定測試回應；`gemini`：呼叫 Gemini 產生回應。 |
| `GEMINI_API_KEY` | 字串 | **僅伺服器端** | 呼叫 Gemini 的憑證。**禁止**在前端程式、打包產物、範例檔或文件中出現真實值；前端一律經後端代理。 |

注意事項：

- `GEMINI_API_KEY` **僅伺服器端**讀取，不得以任何形式下發到瀏覽器（含 `NEXT_PUBLIC_*` 之類前綴）。
- 本文件與版本庫**不得**包含任何真實 secret；範例值一律以 `<redacted>` 表示。
- 切換 `mock` / `gemini` 僅需調整 `STUDENT_AI_ASK_MODE` 並重啟服務，不需改程式。

### 3.2 部署與維運 SOP

使用專案提供的 `./reset-ai-smartbook.sh restart` 進行重啟，**順序不可顛倒**：

1. **先啟 Admin**：由 Admin 服務套用資料庫 migration，確保 `student_notes` 與 `student_learning_history` 等 schema 已就緒。
2. **確認 migration 成功**：檢查 Admin 啟動日誌無 migration 失敗，才進行下一步。
3. **再啟 Student**：啟動學員端服務，載入 `stu-api` 與 `student-notes-express` 路由。
4. **健康檢查**：以已登入學員帳號驗證 `GET /api/student/notes` 回 `200`，並確認 `STUDENT_AI_ASK_MODE` 生效。

> 若順序顛倒（先啟 Student），學員端可能因 schema 未套用而在首次請求時失敗。遇到此情況請重新依上述順序執行 `./reset-ai-smartbook.sh restart`。

---

## 4. 安全與隱私清單

上線前逐項確認：

- [ ] **IDOR 防護**：所有 `:id` 操作（筆記讀取/更新/刪除、`from-history` 的 `historyId`）皆以「目前登入學員」為授權範圍查詢，非本人資源一律回 `404 NOTE_NOT_FOUND`，不區分「不存在」與「無權限」，避免資源探測。
- [ ] **CSRF `originGuard`**：寫入型端點（`POST` / `PATCH` / `DELETE`）必須通過 `originGuard`，來源不符回 `403 STUDENT_ORIGIN_NOT_ALLOWED`；且 `originGuard` 在 body 解析前執行。
- [ ] **XSS 純文字渲染**：筆記與 AI 回應一律以純文字渲染，不將使用者輸入當 HTML 插入；前端不得使用 `innerHTML` 或等效危險 API 直接輸出未淨化內容。
- [ ] **禁止伺服器自動抓取 Google URL**：伺服器不主動對外抓取 Google（或任何使用者提供的 URL）內容；Google AI Relay 僅接收前端/Relay 已備妥的結構化資料，避免 SSRF 與資料外洩風險。
- [ ] **速率限制**：`POST /api/student/ai-ask` 具速率限制，超過回 `429 AI_ASK_RATE_LIMITED`，避免資源濫用與成本失控。
- [ ] **大小上限**：body parser 上限 256 KiB，超過回 `413 NOTE_TOO_LARGE`。
- [ ] **Secret 管理**：`GEMINI_API_KEY` 僅存在伺服器端環境，日誌與錯誤回應不得輸出金鑰或內部堆疊細節。
- [ ] **雙 DB 隔離**：確認 `student_notes` 與 `student_learning_history` 未出現在唯讀 `StudentDataSource`，且無任何查詢繞過 auth DB 授權邊界。
- [ ] **錯誤訊息最小化**：對外錯誤僅回錯誤碼與通用訊息，不洩漏 SQL、路徑或內部實作細節。
