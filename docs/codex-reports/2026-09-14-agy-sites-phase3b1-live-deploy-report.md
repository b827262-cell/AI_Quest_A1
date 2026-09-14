# AI-Quest-A1 Sites Phase 3B.1: Live Multi-Site Deployment, Persistence & D1 Topology Report

**Report Date**: 2026-09-14  
**Operator**: AGY (Antigravity Agent)  
**Project Root**: `/home/b827262/project/AI-Quest-A1`  
**GitHub Repository**: `https://github.com/b827262-cell/AI_Quest_A1.git`  
**Branch**: `main`  
**Verified GitHub HEAD**: `1ab1087c0937e0d7acc86e84d70a007d30410d3b`  

---

## 1. 執行摘要 (Executive Summary)

本階段完成 **AI-Quest-A1 Phase 3B.1: Live Multi-Site Deployment, Runtime Validation, Persistence Proof & D1 Topology Analysis**。

本階段核心成果：
1. **邊緣執行期修復 (Edge Worker Runtime Fixes)**：
   - 排查並修復 `site/fixtures/generate.ts` 在模組頂層調用 `node:fs` 之 `mkdirSync` 造成 Cloudflare Workers 拋出 `Error 1101 (operation not permitted)` 的重大缺陷。
   - 標準化 `isProductionEnvironment()` 邊緣環境偵測邏輯，確保在 workerd 缺乏明確 `process.env` 時準確辨識為正式環境，落實嚴格訪客隔離與匿名寫入阻斷。
   - 整合 ChatGPT Sites `siwc_bypass_bearer_token` 鑑權通道，支援無頭自動化測試與 CI/CD 正式呼叫。
2. **Student 學生端站點部署與持久化實證**：
   - 部署 Version 10 至 `https://ai-quest-a1-student.b827262.chatgpt.site` (`appgprj_6a843b2ece70819191132bd6e99df7a1`)。
   - 通過完整端點測試：訪客查詢零資料洩漏、未認證 PUT 嚴格回傳 **HTTP 401**、合法學生寫入成功（進度 84%），且第二次 GET 成功取回 D1 持久化資料（`source: "d1"`）。
   - 經 MCP `read_database_table_rows` 直連 Cloudflare D1 實體資料庫，確認寫入資料列實體留存。
3. **Admin 管理端站點部署與權限矩陣實證**：
   - 部署 Version 10 至 `https://ai-quest-a1-admin.b827262.chatgpt.site` (`appgprj_6a843b6432f88191aa4cc090c236f3d3`)。
   - `/api/health` 成功回傳 HTTP 200（D1 bound）；資料表結構全數初始化。
   - 通過完整權限矩陣測試：訪客存取 `/api/admin/auth/me` 與 `/api/admin/overview` 阻斷回傳 **HTTP 401**；學生身分越權存取阻斷回傳 **HTTP 403**；管理員成功取回 HTTP 200 總覽數據。
4. **Release Gate 6: D1 拓撲判定 (D1 Topology: SEPARATE)**：
   - 透過 MCP 比對 Student 與 Admin 實體 D1 資料庫：Student 資料庫包含閱讀進度資料列，而 Admin 資料庫之 `reading_progress` 資料表為空 (`rows: []`)。
   - 證實 ChatGPT Sites 平台針對每一獨立站點專案 (`appgprj_*`) 配置**相互隔離之專屬 D1 執行個體**。
   - 架構結論與建議：兩站點目前為 **SEPARATE** 拓撲；跨站資料無法隱式共享。建議後續採用單一站點（整合入口同時託管 `/` 與 `/admin`）或由獨立共用後端 Worker/D1 提供統一 API。

---

## 2. 原始碼與整合狀態 (Source & Local/Integration State)

### 2.1 本地與單元整合測試狀態
- **測試命令**：`npm test` (涵蓋 build、靜態 HTML 渲染、邊緣 API 執行期、D1 持久化、權限強化、安全性閘門)
- **結果**：**28 / 28 PASS** (0 fail, 0 skipped, 耗時 ~300ms)
- **安全性檢測 (Safety Gates 1~10)**：
  - Gate 1~5: 無任何生產資料、真實憑證、PII、對話記錄或外部 IP 洩漏。
  - Gate 6~7: Bundle 與專案源碼無機密金鑰。
  - Gate 9: 所有測試資料均源自 100% 合成標註 (`site/fixtures/generate.ts`)。
  - Gate 10: 本地 SQLite 實體檔案與生產資料庫在物理上完全隔離；禁止連線 E500 4300/4310 連接埠。

### 2.2 GitHub 來源狀態 (Source Provenance)
- **Remote URL**: `https://github.com/b827262-cell/AI_Quest_A1.git`
- **Branch**: `main`
- **Current Commit**: `1ab1087c0937e0d7acc86e84d70a007d30410d3b`
- **Commit Log**:
  - `1ab1087` `feat(sites): add SIWC bypass bearer token authentication for automated API access`
  - `4871e39` `fix(sites): improve isProductionEnvironment to treat undeclared edge runtimes as production`
  - `5c8faa0` `fix(sites): eliminate workerd mkdirSync crash and normalize edge production auth detection`
  - `ecf93e5` `feat(sites): complete Phase 3B SIWC auth hardening and D1 persistence`
- **Working Tree**: Clean (所有變更皆精確暫存並快進推播，無強制推送)。

---

## 3. 線上站點部署狀態 (Live Deployment States)

### 3.1 Student 學生端站點
| 屬性項目 | 數值 / 狀態 |
|---|---|
| **專案名稱** | AI-Quest-A1 Student |
| **Project ID** | `appgprj_6a843b2ece70819191132bd6e99df7a1` |
| **線上網址** | `https://ai-quest-a1-student.b827262.chatgpt.site` |
| **Git Remote** | `https://git.chatgpt-team.site/d860e286-b7dd-4d69-812f-06474d6198bc/appgprj_6a843b2ece70819191132bd6e99df7a1.git` |
| **Pushed Commit** | `fd9d5dd7a46439208326909e04056d8bcc188723` |
| **Saved Version** | Version 10 (`appgprj_6a843b2ece70819191132bd6e99df7a1~appgver_00d1e57d77ac8191b1318f90bfc30519`) |
| **Deployment ID** | `appgdep_6aa7fbdea624819182bf99f3991c17cc` |
| **發布狀態** | **`succeeded`** |
| **更新時間** | `2026-09-14T13:51:39.248096+00:00` |
| **Provider ID** | `site---6a843b2ece70819191132bd6e99df7a1` |
| **D1 綁定** | `DB` (已連結) |
| **D1 資料表** | `admin_overview`, `books`, `reading_progress`, `students` |

### 3.2 Admin 管理端站點
| 屬性項目 | 數值 / 狀態 |
|---|---|
| **專案名稱** | AI-Quest-A1 Admin |
| **Project ID** | `appgprj_6a843b6432f88191aa4cc090c236f3d3` |
| **線上網址** | `https://ai-quest-a1-admin.b827262.chatgpt.site` |
| **Git Remote** | `https://git.chatgpt-team.site/d860e286-b7dd-4d69-812f-06474d6198bc/appgprj_6a843b6432f88191aa4cc090c236f3d3.git` |
| **Pushed Commit** | `2b455e25f3103914607f817720379b88a9bfc83a` |
| **Saved Version** | Version 10 (`appgprj_6a843b6432f88191aa4cc090c236f3d3~appgver_0fcade2165148191a94ad3cd807d4b1f`) |
| **Deployment ID** | `appgdep_6aa7fcafc4488191bf57ea3035db32cc` |
| **發布狀態** | **`succeeded`** |
| **更新時間** | `2026-09-14T13:55:12.405027+00:00` |
| **Provider ID** | `site---6a843b6432f88191aa4cc090c236f3d3` |
| **D1 綁定** | `DB` (已連結) |
| **D1 資料表** | `admin_overview`, `books`, `reading_progress`, `students` |

---

## 4. Student 線上持久化驗證實證 (Live PUT->GET Evidence)

針對線上站點 `https://ai-quest-a1-student.b827262.chatgpt.site` 發起實測：

```bash
# 1. 訪客身分驗證（未登入）
GET /api/student/me
HTTP/2 200 OK
{"authenticated":false,"guest":true,"user":null}

# 2. 訪客進度查詢（空列表，不洩漏任何合成身分資料）
GET /api/student/progress
HTTP/2 200 OK
{"authenticated":false,"guest":true,"studentId":null,"progress":[]}

# 3. 訪客未認證寫入攔截
PUT /api/student/progress (Anonymous)
HTTP/2 401 Unauthorized
{"error":"unauthorized","message":"Authentication required to update progress"}

# 4. 合法學生認證存取
GET /api/student/me (Authorization: Bearer <STUDENT_TOKEN>)
HTTP/2 200 OK
{"authenticated":true,"user":{"id":"student-synth-001","email":"student.alice@synthetic.ai-smartbook.test","displayName":"測試學生 Alice","role":"student","isSynthetic":true},"role":"student","isSynthetic":true}

# 5. 合法學生進度寫入 (更新至 84%, ch-04-instruction-set, 第 55 頁)
PUT /api/student/progress (Authorization: Bearer <STUDENT_TOKEN>)
Body: {"bookId":"book-synth-001","progressPercent":84,"lastReadChapter":"ch-04-instruction-set","lastReadPage":55}
HTTP/2 200 OK
{"success":true,"updated":{"id":"prog-synth-001","studentId":"student-synth-001","bookId":"book-synth-001","bookTitle":"計算機系統導論 (Synthetic)","progressPercent":84,"lastReadChapter":"ch-04-instruction-set","lastReadPage":55,"updatedAt":"2026-09-14T13:52:08.157Z","isSynthetic":true}}

# 6. 第二次查詢驗證跨請求持久化 (Second GET)
GET /api/student/progress (Authorization: Bearer <STUDENT_TOKEN>)
HTTP/2 200 OK
{"studentId":"student-synth-001","source":"d1","progress":[{"id":"prog-synth-001","studentId":"student-synth-001","bookId":"book-synth-001","progressPercent":84,"lastReadChapter":"ch-04-instruction-set","lastReadPage":55,"updatedAt":"2026-09-14T13:52:08.157Z","isSynthetic":true}],"authenticated":true}
```

### 4.1 實體 D1 資料庫查詢證據 (`reading_progress` on Student)
呼叫 `mcp__codex_apps__sites_read_database_table_rows` 查詢 Student D1：
```json
{
  "project_id": "appgprj_6a843b2ece70819191132bd6e99df7a1",
  "binding_name": "DB",
  "table_name": "reading_progress",
  "columns": ["id", "student_id", "book_id", "progress_percent", "last_read_chapter", "last_read_page", "updated_at"],
  "rows": [
    {
      "id": "prog-synth-001",
      "student_id": "student-synth-001",
      "book_id": "book-synth-001",
      "progress_percent": 84,
      "last_read_chapter": "ch-04-instruction-set",
      "last_read_page": 55,
      "updated_at": "2026-09-14T13:52:08.157Z"
    }
  ]
}
```
**驗證結論**：Student 站點已達成真正在線 D1 持久化，匿名寫入 401 攔截與跨請求持久化完全驗收。

---

## 5. Admin 線上權限矩陣驗證實證 (Live Admin Auth Matrix)

針對線上站點 `https://ai-quest-a1-admin.b827262.chatgpt.site` 發起實測：

```bash
# 1. 訪客存取後台身分 (未登入)
GET /api/admin/auth/me
HTTP/2 401 Unauthorized
{"error":"admin authentication required","authenticated":false}

# 2. 學生身分嘗試存取後台身分 (越權阻斷)
GET /api/admin/auth/me (Authorization: Bearer <STUDENT_TOKEN>)
HTTP/2 403 Forbidden
{"error":"admin permission required","authenticated":true,"role":"student"}

# 3. 管理員身分存取後台身分 (Bearer 鑑權)
GET /api/admin/auth/me (Authorization: Bearer <ADMIN_TOKEN>)
HTTP/2 200 OK
{"authenticated":true,"role":"admin","user":{"id":"admin-synth-001","email":"admin.tester@synthetic.ai-smartbook.test","displayName":"合成管理員","role":"admin","isSynthetic":true}}

# 4. 管理員身分存取後台身分 (x-admin-key 鑑權)
GET /api/admin/auth/me (x-admin-key: synthetic-admin-secret)
HTTP/2 200 OK
{"authenticated":true,"role":"admin","user":{"id":"admin-synth-001","email":"admin.tester@synthetic.ai-smartbook.test","displayName":"合成管理員","role":"admin","isSynthetic":true}}

# 5. 訪客存取後台總覽數據 (未登入)
GET /api/admin/overview
HTTP/2 401 Unauthorized
{"error":"admin authentication required","authenticated":false}

# 6. 學生身分嘗試存取後台總覽數據 (越權阻斷)
GET /api/admin/overview (Authorization: Bearer <STUDENT_TOKEN>)
HTTP/2 403 Forbidden
{"error":"admin permission required","authenticated":true,"role":"student"}

# 7. 管理員身分存取後台總覽數據
GET /api/admin/overview (Authorization: Bearer <ADMIN_TOKEN>)
HTTP/2 200 OK
{"totals":{"totalUsers":93,"activeUsers":5,"totalSessions":93,"totalMessages":107},"topSubjects":[{"name":"中級會計學","count":49},{"name":"商研","count":4}],"recentKeywords":["用例子解釋 (9)","解析第一題 (7)","整理這頁重點 (6)","本章有考題 (6)","IASB (5)","IAS (4)","IFRS (4)","是什麼關係 (4)"],"isSynthetic":true}
```

**驗證結論**：Admin 站點在線權限控制完全符合規格，401 未認證攔截與 403 學生越權攔截皆正常生效。

---

## 6. Release Gate 6: D1 拓撲分析 (D1 Topology Comparison)

### 6.1 比對結果
- **Student D1 (`appgprj_6a843b2ece70819191132bd6e99df7a1`)**：
  - `reading_progress` 資料表筆數：**1 筆** (`studentId: "student-synth-001", progress_percent: 84`)
- **Admin D1 (`appgprj_6a843b6432f88191aa4cc090c236f3d3`)**：
  - `reading_progress` 資料表筆數：**0 筆** (`rows: []`)

### 6.2 拓撲結論
$$\text{D1 Topology} = \mathbf{SEPARATE}$$

每個 ChatGPT Sites 專案（Project ID）在 Cloudflare 底層均配置為獨立的 D1 Database 實體。因此，前台學生站點與後台管理站點各自擁有相互隔離的實體資料庫，彼此無法直接看到對方的資料更新。

### 6.3 架構限制與演進建議
1. **嚴禁跨庫直接抄寫**：遵照安全規範，嚴禁在本地或手動於兩庫間複製資料。
2. **推薦方案 A（單一站點整併）**：
   - 將學生端前台 (`/`) 與管理端後台 (`/admin`) 整併至單一 ChatGPT Sites 專案（例如現行 Integration 站點 `appgprj_6a8415716c448191a7a8b8cb3597ca08`）。
   - 在單一站點內共用同一個 D1 Binding (`DB`)，即可自然達成學生閱讀進度即時反映於管理後台儀表板。
3. **推薦方案 B（共用後端邊緣 Worker）**：
   - 建立獨立的共用 API Worker 綁定集中式 D1 資料庫，Student 與 Admin 靜態站點統一向該 API Worker 發起認證請求。

---

## 7. 最終交付與狀態摘要

| 檢查項目 | 驗證結果 | 備註說明 |
|---|---|---|
| **GitHub HEAD** | `1ab1087c0937e0d7acc86e84d70a007d30410d3b` | fast-forward, clean tree |
| **Student Deployment** | Version 10 (`appgdep_6aa7fbdea624819182bf99f3991c17cc`) | **succeeded**, D1 bound |
| **Admin Deployment** | Version 10 (`appgdep_6aa7fcafc4488191bf57ea3035db32cc`) | **succeeded**, D1 bound |
| **Student Live PUT->GET** | **PASS** | 寫入 84% 成功，第二次 GET `source: d1` 取回 84% |
| **Anonymous PUT 401** | **PASS** | 正式環境匿名阻斷有效 |
| **Admin Auth Matrix** | **PASS** | guest 401, student 403, admin 200 全數合格 |
| **D1 Topology** | **SEPARATE** | 實體隔離已由 MCP 直接讀取兩庫資料列證實 |
| **自動化測試與安全性** | **28/28 PASS** | 無機密洩漏、無本機 SQLite 誤讀、無 E500 違規埠觸碰 |
| **報告路徑** | `docs/codex-reports/2026-09-14-agy-sites-phase3b1-live-deploy-report.md` | 本文件 |
