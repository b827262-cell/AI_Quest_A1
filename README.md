# AI_Quest_A1 (AI-SmartBook 智慧閱讀與 AI 學習系統)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node Version](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)
[![pnpm Version](https://img.shields.io/badge/pnpm-%3E%3D9-orange.svg)](package.json)

**`AI_Quest_A1`** 是一個整合 AI 多模型 Gateway、PDF 智慧閱讀解析與問答、題庫生成與學生互動學習的現代化 Monorepo 全棧系統。

本 Repository ([b827262-cell/AI_Quest_A1](https://github.com/b827262-cell/AI_Quest_A1)) 作為正式的 AI 題目處理、智慧書籍閱讀、解題流程、AI 模型整合與版本管理的中央程式碼倉庫。

---

## 📍 A-01 最新工程狀態與 PR 追蹤

> **狀態快照：2026-10-13（Asia/Taipei）**。本段反映 GitHub PR/commit 與當日 Slack Owner 指令，**不是 Production 部署或整體驗收 PASS 的宣告**。實際採用前須重新核對 HEAD、審查意見與測試證據。

### 整合基線

- **`main`**：PR [#37 — A-01 consolidation](https://github.com/b827262-cell/AI_Quest_A1/pull/37) 已於 2026-10-13 合併；合併後記錄的主線 HEAD 為 `76ff0b9`（寫入本段說明前的快照）。
- **整合來源**：`agent/a01-agy-a1-a3`（A 線功能）、`cleanup/project-health`（維護文件）、`codex/a01-p1-d2-20261012`（Phase 2 v4 修正），由 `integration/a01-consolidation-20261013` 整合。
- **測試證據**：PR #37 與 Slack 工程交付紀錄報告 root 961 項、Admin 296 項、`site/` 249 項測試通過，並有 typecheck/lint 結果。這是**該 PR/執行環境所報告的結果**；不代表本段 README 更新已重新執行測試，也不等於所有審查問題已結清。
- **已知審查差距**：PR #37 自動 review 曾提出 PostgreSQL 驅動相依、教師/適用範圍資料欄位、B3 sidecar 啟動、離線快取推論、待處理答案與候選配對、並發冪等性等問題。即使 PR 已 merge，後續仍應逐項核對或建立追蹤。

### PR 狀態與後續審查

| PR | 主要內容 | GitHub 狀態 | 待完成/風險 |
|---|---|---|---|
| [#37](https://github.com/b827262-cell/AI_Quest_A1/pull/37) | A-01 多分支整合、Phase 2 v4 基線與 B3 功能 | **MERGED** | 自動審查提出的 6 項意見需追蹤，合併不代表 Production 驗收 |
| [#38](https://github.com/b827262-cell/AI_Quest_A1/pull/38) | B3 搜尋改用已驗證 B1 snapshot（無 PostgreSQL 部署依賴） | **OPEN** | PR 報告定向測試 33/33；`OR`、引號、否定詞等搜尋語法與 PostgreSQL 不等價；對外公開前應處理 rate limiting 與審查 |
| [#39](https://github.com/b827262-cell/AI_Quest_A1/pull/39) | Cloudflare 類型宣告與正式環境 manifest 擷取 | **OPEN** | PR 報告 `site/` 249/249；仍須處理 health payload 欄位不一致、R2 內容雜湊未獨立驗證、R2 list 權能未實測等 review 意見 |
| [#36](https://github.com/b827262-cell/AI_Quest_A1/pull/36) | 一鍵 runtime 腳本的維運知識文件 | **OPEN** | 此 PR 較早提出；需對照現有 README 與目前主線，避免重複/過期資訊 |

> **狀態分層**：`MERGED` 是 GitHub 合併事實；`PASS` 僅適用於附證據的特定測試；`OPEN` / `PARTIAL` / `BLOCKED` 應保留其未完成範圍。請勿把 Agent ACK、CLI exit 0 或 smoke test 當成正式獨立驗收。

### 協作治理與交付標準

依 2026-10-13 下午 Slack `#a-01` 的 Owner 指揮權調整，**Claude 為 A-01 專案經理及指定主要 Writer**；其他 Agent 僅依具體指名任務做審核或支援。舊 H01–H08 與 RCA 資格核驗流程已公告結案，不能以舊流程的 HOLD 取代新的指令，也不能把任何例外當成無限制授權。

工程或 PR 更新時請提供：**Why / What / Tests / Risk / Rollback、base/head 分支、commit SHA、異動檔案、測試指令與 exit code、已知審查意見、Reviewer/Owner 待決議事項與可驗證證據連結**。部署、正式環境變更及合併權限應按個別 Owner 授權執行，不因文件更新而自動開放。

專案協調紀錄：Slack `#a-01`（現行 PM 協調）與 `#a-01-v01`（先前階段性稽核紀錄）；Slack 內容僅對具備該 Workspace 權限的人員可讀。

---

## 🎯 專案任務與核心目標

1. **智慧書籍與 PDF 閱讀體驗 (SmartBook)**：
   - 提供學生端流暢的 PDF 閱讀、分類圖書館、動態分類統計與封面展示。
   - 內建右側 AI 知識庫問答 (QA) 聊天面板，支援對話歷史持久化與跨書對話隔離。

2. **AI 多模型 Gateway 與憑證安全管理**：
   - 支援多 AI Provider (Gemini, Claude, OpenAI 等) 抽象層與切換。
   - 整合憑證每日配額控管 (Daily Quota Hardening) 與安全防護機制 (Plan B Safe Masking)。

3. **管理員後端與題庫/內容解析引擎**：
   - 提供管理員後端進行書籍上架、分類中繼資料維護、PDF 內容切割、章節建立與題庫產生。

4. **Option A 輕量化雲端部署設計**：
   - 針對前端節點支援無資料庫、純靜態 SPA 資產託管模式，透過 Nginx 反向代理將 API 與 PDF 安全串流請求至中央服務主機 (E500)。

---

## 🏗️ 專案架構 (Monorepo)

本專案使用 **pnpm workspaces** 與 **Turborepo** 進行模組化管理：

```text
.
├── apps/
│   ├── AI-Stu-R1/          # 學生端前端應用 (Vite / React SPA)
│   └── AI-adm-D1/          # 管理員前端與後端 API 服務 (Hono / Node.js)
├── packages/
│   ├── ai/                 # AI 多模型 Gateway 與憑證/配額控管
│   ├── book-core/          # PDF 解析、章節切割與 AI 問答核心
│   ├── db/                 # SQLite / Drizzle ORM Schema 與 Repositories
│   ├── schema/             # 全域 TypeScript 型別與 Zod 驗證定義
│   ├── student-runtime/    # 學生端運行時狀態支援
│   ├── sync/               # 學生學習資料匯出 / 匯入工具
│   ├── ui/                 # 跨應用共享 UI 元件庫
│   ├── auth/               # 身份驗證與 Token 管理模組
│   └── quiz-core/          # 測驗與題庫核心模組
├── docs/                   # 專案架構與完成報告文檔
├── reset-ai-smartbook.sh   # 一鍵服務控制與監控腳本
└── package.json
```

---

## 🚀 快速開始

### 環境需求
* **Node.js** >= 20.0.0
* **pnpm** >= 9.0.0

### 1. 安裝套件
```bash
pnpm install
```

### 2. 使用一鍵服務控制腳本 (推薦)

專案根目錄提供 `reset-ai-smartbook.sh` 腳本，可一鍵啟動、停止與監控所有服務：

```bash
chmod +x reset-ai-smartbook.sh

# 啟動所有服務 (預設自動建立 log 與 run 目錄)
./reset-ai-smartbook.sh start

# 檢查各服務執行狀態與 Port
./reset-ai-smartbook.sh status

# 檢視即時服務日誌
./reset-ai-smartbook.sh logs

# 重啟所有服務
./reset-ai-smartbook.sh restart

# 停止所有服務
./reset-ai-smartbook.sh stop
```

### 服務預設埠號 (Default Ports)

| 服務名稱 | 類型 | 網址 |
|---|---|---|
| **Student Web** | 學生端前端 | `http://127.0.0.1:5173` |
| **Admin Web** | 管理端前端 | `http://127.0.0.1:5174` |
| **Admin API** | 管理端 API | `http://127.0.0.1:4300` |
| **Student API** | 學生端 API | `http://127.0.0.1:4310` |

---

## 🛠️ 開發與驗證

### 分別啟動開發服務

```bash
# 啟動 Admin API
pnpm --filter AI-adm-D1 server:dev

# 啟動 Student 前端
pnpm --filter AI-Stu-R1 dev

# 啟動 Admin 前端
pnpm --filter AI-adm-D1 dev
```

### 類型檢查與打包驗證

```bash
# 驗證 Student 前端
pnpm --filter AI-Stu-R1 typecheck
pnpm --filter AI-Stu-R1 build

# 驗證 Admin 前端與 API
pnpm --filter AI-adm-D1 typecheck
pnpm --filter AI-adm-D1 build
```

---

## 🔒 資料庫與資安規範

1. **SQLite 運行時資料庫隔離**：
   - 運行時產生的 `*.db`, `*.sqlite`, `*.sqlite3` 均為本地資料，已被 `.gitignore` 排除，**嚴禁 commit 進 Git 儲存庫**。
2. **PDF 安全串流**：
   - 學生端不直接暴露實體 PDF 檔案路徑，需透過 `pdf-view` API 授權檢驗後進行安全串流讀取。

---

## 📄 License

[MIT](LICENSE)
