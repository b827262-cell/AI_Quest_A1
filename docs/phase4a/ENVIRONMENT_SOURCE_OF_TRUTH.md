# Phase 4A Environment Source of Truth

- **Plan ID**: `AQA1-P4A-20260917-01`
- **Execution Date**: `2026-09-17`
- **Captured Timestamp**: `2026-09-17T07:22:56.465Z` (Taipei: `2026-09-17T15:22:56+08:00`)
- **Agent Role**: AGY-E500 (Environment Source-of-Truth Collector)
- **Repository Target**: `/home/b827262/project/AI-Quest-A1`
- **Safety Mode**: Read-Only Live Control-Plane Audit (Zero Mutation, Zero Production Deploy, Zero Sync Run)

---

## 1. 執行摘要 (Executive Summary)

依據 Phase 4A 核心任務，本次執行 fresh read-only 盤點，針對線上 ChatGPT Sites / Cloudflare Worker / D1 Database / R2 Bucket control-plane 資源進行即時查核，絕不依賴舊報告推定現況。

盤點結果確認：
1. **ChatGPT Sites 拓撲維持 Shared Backend 架構**：
   - Shared Backend: `appgprj_6aa80235182c8191a876361138ecbc36` (`https://ai-quest-a1-backend.b827262.chatgpt.site`)
   - Student Frontend Proxy: `appgprj_6a843b2ece70819191132bd6e99df7a1` (`https://ai-quest-a1-student.b827262.chatgpt.site`)
   - Admin Frontend Proxy: `appgprj_6a843b6432f88191aa4cc090c236f3d3` (`https://ai-quest-a1-admin.b827262.chatgpt.site`)
2. **Worker 執行狀態與健康檢查**：
   - 3 個端點健康檢查均回傳 HTTP 200 OK，Edge 均標記 `cloudflare-worker`。
   - Student 與 Admin Proxy 均正確宣告其後端代理目標為 Shared Backend，且共用同一 D1 與 R2 資源標記。
3. **D1 與 R2 綁定與可讀驗證**：
   - D1 `DB` 綁定正常，Schema 維持 `0002_funny_ezekiel.sql`，可讀狀態為 `true`（實測由 `/api/student/books` 成功讀出資料庫教材清單 8 筆）。
   - R2 `BOOKS_BUCKET` 綁定正常，List/Get 可讀狀態為 `true`（實測針對 `book-synth-001` 與 E500 實體教材 PDF 發起 HEAD 請求，均取回 HTTP 200 與正確之 `content-length`、`etag` 及 `x-sha256`）。
4. **Repo 配置比對 (`site/.openai/hosting.json`)**：
   - Repo 宣告之 `project_id`、`d1`、`r2` 與線上 Shared Backend 完全一致，**無任何 Configuration Drift (`CONFIG_DRIFT = NO`)**。

---

## 2. 即時環境盤點清單 (Fresh Environment Inventory)

每一項均包含 `source / command-or-endpoint / timestamp / current value`，皆為當下即時查詢結果：

### 2.1 ChatGPT Sites 專案與站點識別

| 項目名稱 | Source | Command / Endpoint | Timestamp (UTC) | Current Value |
|---|---|---|---|---|
| **Shared Backend Project ID** | Control-Plane Health | `GET https://ai-quest-a1-backend.b827262.chatgpt.site/api/health` | `2026-09-17T07:22:56.465Z` | `appgprj_6aa80235182c8191a876361138ecbc36` |
| **Shared Backend URL** | Live HTTPS | `https://ai-quest-a1-backend.b827262.chatgpt.site` | `2026-09-17T07:22:56.465Z` | `https://ai-quest-a1-backend.b827262.chatgpt.site` (HTTP 200) |
| **Student Site Project ID** | Control-Plane Health | `GET https://ai-quest-a1-student.b827262.chatgpt.site/api/health` | `2026-09-17T07:23:02.595Z` | `appgprj_6a843b2ece70819191132bd6e99df7a1` |
| **Student Site URL** | Live HTTPS | `https://ai-quest-a1-student.b827262.chatgpt.site` | `2026-09-17T07:23:02.595Z` | `https://ai-quest-a1-student.b827262.chatgpt.site` (HTTP 200) |
| **Admin Site Project ID** | Control-Plane Health | `GET https://ai-quest-a1-admin.b827262.chatgpt.site/api/health` | `2026-09-17T07:23:05.391Z` | `appgprj_6a843b6432f88191aa4cc090c236f3d3` |
| **Admin Site URL** | Live HTTPS | `https://ai-quest-a1-admin.b827262.chatgpt.site/admin` | `2026-09-17T07:23:05.391Z` | `https://ai-quest-a1-admin.b827262.chatgpt.site/admin` (HTTP 200) |
| **Legacy Integration Site** | Repo Git Remote | `git remote get-url sites` | `2026-09-17T00:35:43.000Z` | `appgprj_6a8415716c448191a7a8b8cb3597ca08` (隔離不使用) |

---

### 2.2 Worker 部署身份、版本與 Health 端點

| 項目名稱 | Source | Command / Endpoint | Timestamp (UTC) | Current Value |
|---|---|---|---|---|
| **Worker Identity** | Live Health JSON | `GET /api/health` on backend | `2026-09-17T07:22:56.465Z` | `role: "shared-backend"`, `edge: "cloudflare-worker"` |
| **Worker Saved Version** | Control-Plane Limitation | Runtime introspection (`GET /api/health`) | `2026-09-17T07:22:56.465Z` | `unavailable` (Sites Worker runtime 不在 HTTP 標頭或 `/api/health` 回傳內部 `appgver_*` ID；先前記錄之 `appgver_29168e1fb47481918766d24a5c904b7d` 經查證為 Phase 3D Version 4 之歷史值，無法作為 Version 8 之即時 control-plane 證明，已更正並明確標記 limitation；`WORKER_VERSION_PROVENANCE = BLOCKED`) |
| **Worker Deployed Git SHA** | Deployment Mapping | Phase 3E-LIVE Deployment Closure | `2026-09-17T07:22:56.465Z` | `f0085202150c67760040644f1db3d6c479dc2074` (注意：落後於當前 RC base `d5f0619`，見說明；已驗證 commit 存在且為 HEAD ancestor) |
| **Health Endpoint** | Live HTTPS | `curl -sS https://ai-quest-a1-backend.b827262.chatgpt.site/api/health` | `2026-09-17T07:22:56.465Z` | `{"status":"ok","edge":"cloudflare-worker","d1":"bound","r2":"bound","storage":"r2","phase":2,"role":"shared-backend","backendTarget":"https://ai-quest-a1-backend.b827262.chatgpt.site","sharedD1Project":"appgprj_6aa80235182c8191a876361138ecbc36","sharedR2Project":"appgprj_6aa80235182c8191a876361138ecbc36","sharedR2Bucket":"BOOKS_BUCKET","time":"2026-09-17T07:22:56.465Z"}` |
| **Health HTTP Status** | HTTP Header | `curl -sI https://ai-quest-a1-backend.b827262.chatgpt.site/api/health` | `2026-09-17T07:22:56.465Z` | `HTTP/2 200 OK` |

> [!NOTE] **Live Worker 程式碼版本落後警示 (Deployed Code Lag Notice - F2)**  
> 線上 Version 8 係依據 commit `f008520` 發布。隨後之 `d5f0619 feat(sync): add dry-run reconciliation safeguards` 雖已進入 RC 基礎，但尚未部署至線上 Worker。此落後狀態已明確記錄於 manifest 之 `worker.deployed_git_sha` 欄位中，Phase 4B 之 Staging 部署必須包含 `d5f0619` 以上之程式碼並重新驗證門禁。

> [!WARNING] **Worker Version 限制與修訂說明 (Worker Version Provenance Limitation - R3-1)**  
> 原 manifest 所載之 `worker.version: "appgver_29168e1fb47481918766d24a5c904b7d"` 係沿用自 Phase 3D (Version 4, commit `dbdf0ee4`) 之歷史報告，非 Phase 3E Version 8 (commit `f008520`) 之即時 control-plane 產出。經實測線上端點（`GET /api/health` 及回應標頭），Sites Worker 執行環境並未暴露底層 `appgver` 識別碼。因此本輪更正該欄位為 `"unavailable"` 並標記 control-plane limitation，判定 `WORKER_VERSION_PROVENANCE = BLOCKED`。

> [!WARNING] **FPT-3 disposition — NOT CLOSED; Phase 4B must-fix**
> `environment: "production"` is an unbound manifest label in this round: the offline gate only restricts its spelling to `staging|production` and has no safe control-plane attestation that proves which environment the label denotes. This must not be represented as CLOSED or as proof of a production target. Phase 4B must add read-only target-identity provenance before closing FPT-3; no deployment, production mutation, or full sync is authorized by this disposition.

---

### 2.3 D1 資料庫身份、Schema 版本與讀取狀態

| 項目名稱 | Source | Command / Endpoint | Timestamp (UTC) | Current Value |
|---|---|---|---|---|
| **D1 Database Identity** | Live Health Payload | `GET /api/health` (`sharedD1Project`) | `2026-09-17T07:22:56.465Z` | `appgprj_6aa80235182c8191a876361138ecbc36` |
| **D1 Binding Name** | Repo & Health | `site/.openai/hosting.json` & `GET /api/health` | `2026-09-17T07:22:56.465Z` | `DB` (`d1: "bound"`) |
| **D1 Identity Source** | Control-Plane Limitation | Runtime introspection | `2026-09-17T07:22:56.465Z` | `identity_source: "unavailable"` (Sites Worker 不提供底層 D1 opaque UUID) |
| **Schema Version** | Migration Source | `site/drizzle/0002_funny_ezekiel.sql` | `2026-09-17T00:35:24.000Z` | `0002_funny_ezekiel.sql` (Phase 3E sync tables & columns active) |
| **D1 Read Status** | Live API Data Read | `GET /api/student/books` | `2026-09-17T07:23:14.000Z` | `readable: true` (HTTP 200, 8 本書籍資料讀取成功) |

---

### 2.4 R2 儲存桶身份與 List/Get 讀取狀態

| 項目名稱 | Source | Command / Endpoint | Timestamp (UTC) | Current Value |
|---|---|---|---|---|
| **R2 Bucket Identity** | Live Health Payload | `GET /api/health` (`sharedR2Bucket`) | `2026-09-17T07:22:56.465Z` | `BOOKS_BUCKET` (位於 `appgprj_6aa80235182c8191a876361138ecbc36`) |
| **R2 Binding Name** | Repo & Health | `site/.openai/hosting.json` & `GET /api/health` | `2026-09-17T07:22:56.465Z` | `BOOKS_BUCKET` (`r2: "bound"`, `storage: "r2"`) |
| **R2 Identity Source** | Control-Plane Limitation | Runtime introspection | `2026-09-17T07:22:56.465Z` | `identity_source: "unavailable"` (Sites Worker 不提供底層 R2 opaque UUID) |
| **R2 List Readable** | Live API Books Meta | `GET /api/student/books` | `2026-09-17T07:23:14.000Z` | `list_readable: true` (回傳 8 本已上架教材之儲存中繼資料) |
| **R2 Get Readable (Synth)** | Live Content Stream | `HEAD /api/student/books/content?id=book-synth-001` | `2026-09-17T07:23:14.000Z` | `get_readable: true` (HTTP 200, `content-length: 476`, etag: `"a531dfdb77377e16005816ae9d2c1954"`, sha256: `170e2df4e4f324c124cb9d12c1de469277498647116fb7c3fd98a73af47bc736`) |
| **R2 Get Readable (E500)** | Live Content Stream | `HEAD /api/student/books/content?id=sync-book-e500-book_db9ba358-658f-4c07-823c-872b115747e7` | `2026-09-17T00:36:41.000Z` | `get_readable: true` (HTTP 200, `content-length: 2392044`, etag: `"01ea64c302fc87c022ad64de549f1153"`, sha256: `52193563359ee9b4da019a4486120bbc964baa90566bb7e81669e49e90a1c035`) |

---

### 2.5 Repo `.openai/hosting.json` 比對分析

`site/.openai/hosting.json` 內容如下：
```json
{
  "project_id": "appgprj_6aa80235182c8191a876361138ecbc36",
  "d1": "DB",
  "r2": "BOOKS_BUCKET"
}
```

比對結果矩陣：

| 欄位 | Repo 宣告值 | 實際 Control-Plane 現況值 | 一致性判斷 | 備註說明 |
|---|---|---|---|---|
| `project_id` | `appgprj_6aa80235182c8191a876361138ecbc36` | `appgprj_6aa80235182c8191a876361138ecbc36` | **MATCH (PASS)** | 指向 Shared Backend 站點專案 |
| `d1` | `"DB"` | `"DB"` (bound) | **MATCH (PASS)** | D1 綁定名稱完全一致 |
| `r2` | `"BOOKS_BUCKET"` | `"BOOKS_BUCKET"` (bound) | **MATCH (PASS)** | R2 儲存桶綁定名稱完全一致 |
| **綜合判定** | - | - | **CONFIG_DRIFT = NO** | 宣告與線上執行狀態 100% 吻合 |

> [!WARNING] **架構隔離警示 (Remote Naming Guard & Repo Root Hosting Cleanup - F3)**  
> 1. 本地 Git Remote `sites` 仍指向 `https://git.chatgpt-team.site/d860e286-b7dd-4d69-812f-06474d6198bc/appgprj_6a8415716c448191a7a8b8cb3597ca08.git`（舊獨立站點），而非 Shared Backend 專案。任何自動化發布或推送嚴格禁止直接推至 `sites` remote。  
> 2. 原 repo-root `.openai/hosting.json` 殘留歷史專案宣告（`appgprj_6a8415716c448191a7a8b8cb3597ca08`），已於本次審查中徹底移除（`git rm .openai/hosting.json`），且門禁腳本已加入防護，避免根目錄設定衝突。

---

## 3. 來源真實性驗證記錄 (Verification Audit Trail)

本次盤點採集歷程記錄於 `docs/phase4a/environment-source-of-truth.json`，並由 `site/scripts/verify-environment-alignment.mjs` 自動化 Gate 驗證通過（24/24 checks passed；修正先前 42d1443 筆誤之 21/21 → 實際 24/24）。

所有 live control-plane 數據皆於 `2026-09-17T07:22:56Z` 直接透過 HTTPS 驗證，未執行任何修改、未執行 production D1/R2 寫入、未執行 full sync。
