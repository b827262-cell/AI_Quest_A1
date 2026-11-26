# R23 派工總計劃 — 學員登入後整合 Google AI 課業問答並寫筆記（Phase 1 MVP 實作與驗證）

- **輪次**：R23
- **簽發者**：PM (`t16` Antigravity)
- **技術統籌**：TL (`t17` Hermes)
- **參考基線方案**：`docs/plans/R22-student-google-ai-notes-proposal.md`（HEAD `861eef3`）
- **核心目標**：落實 R22 核定之 **Phase 1 MVP（方案 C 雙軌整合）**，讓登入學員在 `/dashboard` 與 `/books/:bookId` 能使用 Google AI Relay 問課業、寫入 `learning_history` 並一鍵或手動儲存至同庫 `student_notes`，同時同步 `PHASE3A_PRODUCTION_VERIFICATION.md` 13 步門控文件，通過全鏈路單元／整合／E2E／安全邊界審查。

---

## 1. 席位編制與 R23 任務映射

> 注意：舊 `t1`–`t10` 已退役（`t2` signal 1 終止），本輪全面採用新 10 席位位址；其中 **DE (`t1j`, Freebuff)** 為 **TL (`t17`) 直屬下屬**，由 TL 依 `.agents/skills/freebuff-tui-dispatch/SKILL.md` 直接派工、驗證與執行結束後等待 3 分鐘模擬滑鼠點擊 `✕ End session`。

| 角色代號 | 中文職稱 | hc 位址 | 載體 / 模型 | Wave | 任務編號與職責範圍 | 授權寫入檔案範圍 |
|---|---|---|---|---|---|---|
| **PM** | 專案經理 | `t16` | Antigravity | 全程 | 簽發 R23 總計劃、最終驗收與核定 | `docs/plans/R23-sprint-dispatch-plan.md`、`scripts/dispatch-*` |
| **TL** | 技術主管 | `t17` | Hermes | 全程 | 統籌 Wave 1→2→3 進度、**直屬派工與收尾 DE (`t1j`)**、卡關協調、彙整 `R23-ROUND-REPORT.md` 與 `R23-KPI-REPORT.md` 回報 `PM_INBOX.md` | `reports/dispatch/R23-ROUND-REPORT.md`、`reports/dispatch/R23-KPI-REPORT.md`、`reports/PM_INBOX.md` |
| **SA** | 系統架構師 | `t19` | CodeBuddy | Wave 1 | **`R23-SA`**：先行定義 `studentNote.schema.ts`（含 `type: text\|ai_answer\|canvas`、`canvasData` 選填、`.strict()` 防 `studentId`）與匯出，產出前後端契約鎖定清單供 BE/SD/FE 對齊 | `packages/schema/src/studentNote.schema.ts`、`packages/schema/src/index.ts`、`packages/schema/src/studentNote.schema.test.ts`、`reports/dispatch/R23-SA.md` |
| **BE** | 後端工程師 *(17:26 互換接任)* | `t1f` | Junie | Wave 1→2 補強 | **`R23-BE` / `R23-BE-FIX`**：前任 Vibe 已完成 `student_notes` 基礎表與 repo（206/206 PASS）；現任 BE (`t1f` Junie) 接手後端職責，補強 `studentNote.repo.ts` 的 `create()` 非空 `entryId` 唯一約束衝突防呆（改冪等回傳或明確錯誤），並補齊單元測試 | `packages/db/src/repositories/studentNote.repo.ts`、`packages/db/test/studentNote.repo.test.ts`、`reports/dispatch/R23-BE-FIX.md` |
| **SE** | 軟體工程師 | `t1h` | OpenCode | Wave 1 | **`R23-SE`**：同步更新 `docs/PHASE3A_PRODUCTION_VERIFICATION.md`（由 R19 舊 11 步/1.2.0 升級為對齊 `scripts/phase3a-release-gate.mjs` 的 **13 步 / 1.3.0** 實碼規範，消除 R20 遺留文件漂移） | `docs/PHASE3A_PRODUCTION_VERIFICATION.md`、`reports/dispatch/R23-SE.md` |
| **DE** | 維運工程師 *(TL 直屬)* | `t1j` | Freebuff TUI | Wave 1 (由 TL 派發) | **`R23-DE`**：E500 環境與雙 DB 健康度預檢、清理 R21 遺留臨時測試檔（若存在 `.r21-e2e-verify.mjs` 檢視回報，不動真實使用者資料）、驗證 workspace symlinks 與 lockfile store sync | `reports/dispatch/R23-DE.md`（唯讀巡檢報告） |
| **SD** | 資深開發工程師 | `t1d` | Codex | Wave 2 (待 SA+BE) | **`R23-SD`**：實作 `packages/auth/src/student-notes-express.ts`（6 端點、逐路由 `originGuard`、`from-history` 伺服器端快照與去重）、`oversizeJsonBodyHandler` 擴充 `NOTE_TOO_LARGE`、`stu-api.ts` 前置 256 KiB parser 與路由掛載，以及 Express/API 整合測試 | `packages/auth/src/student-notes-express.ts`、`packages/auth/src/learning-history-express.ts`、`packages/auth/src/express.ts`、`packages/auth/src/server.ts`、`packages/auth/src/student-notes-express.test.ts`、`apps/AI-Stu-R1/server/stu-api.ts`、`reports/dispatch/R23-SD.md` |
| **FE** | 前端工程師 *(17:26 互換接任)* | `t1c` | Vibe | Wave 2 (待 SA) | **`R23-FE`**：修正 `studentClient.ts` 兩處 TS 型別尾項，建立 `StudentAiAssistant.tsx`（Phase 1 僅開 Google AI Relay，隱藏平台 AI），整合 `/dashboard`（登入後隱藏訪客剩餘提示、提供課業筆記列表）與 `BookReaderPage.tsx`／`SmartNotesPanel.tsx` 及前端單元測試 | `apps/AI-Stu-R1/src/studentClient.ts`、`apps/AI-Stu-R1/src/components/student-ai/StudentAiAssistant.tsx`、`apps/AI-Stu-R1/src/components/dashboard/DashboardShell.tsx`、`apps/AI-Stu-R1/src/components/dashboard/GuestAnswerSection.tsx`、`apps/AI-Stu-R1/src/pages/BookReaderPage.tsx`、`apps/AI-Stu-R1/src/components/SmartNotesPanel.tsx`（及對應前端測試）、`reports/dispatch/R23-FE.md` |
| **QA** | 品質驗證工程師 *(17:26 互換接任)* | `t1b` | Pi | Wave 3 (待 Wave 1+2) | **`R23-QA`**：執行全套驗收測試矩陣（`pnpm -r typecheck`、`pnpm -r lint`、相關套件 `vitest run`、`scripts/boundary-check.sh`、`scripts/check-lockfile-store-sync.mjs`、`E2E_REPORT_PATH=/tmp/r23-relay.json node scripts/student-relay-e2e.mjs`）並出具實測報告 | `reports/dispatch/R23-QA.md` |
| **CR** | 程式碼審查員 | `t1g` | dsh | Wave 3 (待 Wave 1+2) | **`R23-CR`**：唯讀安全與程式碼終審（IDOR `student_id` 隔離、CSRF `originGuard`、XSS 純文字渲染、雙 DB 零 `StudentDataSource` 寫入、`pnpm-lock.yaml` SHA256 未變、授權檔案邊界），出具 `TECH_SIGNOFF` | `reports/dispatch/R23-CR.md` |

---

## 2. 關鍵架構與避坑鐵律（R22-T3 阻斷修正強制落實）

1. **雙 DB 鐵律**：`student_notes` 一律建於 **auth DB**（由 `createStudentAuthRuntime` 共用同一 SQLite handle 並自動執行 `runMigrations`），**嚴禁**透過唯讀的 `StudentDataSource` 讀寫筆記。
2. **相容性守衛（Admin 測試零破壞）**：注意 `apps/AI-adm-D1/src/server/student-books-router.ts` 仍有舊 `/api/student/books/:bookId/notes` 供 `student-isolation.integration.test.ts` 測試——**嚴禁修改 `apps/AI-adm-D1` 既有路由**；`studentClient.ts` 更新為打 `/api/student/notes`（查詢可帶 `?bookId=...`），方法簽名若調整請同步更新 `SmartNotesPanel.tsx`、`SmartNotesPanel.confirm.test.tsx` 與 `BookReaderPage.tsx`。
3. **Schema 與欄位對齊（F2/F3/F4）**：
   - `studentNoteTypeSchema = z.enum(["text", "ai_answer", "canvas"])`（預設 `"text"`），支援 `canvasData: z.string().max(200_000).nullable().optional()`，讓閱讀器 `SmartNotesPanel` 文字／AI 解答／手寫畫布三型皆能無縫存入 `student_notes`！
   - `GET /api/student/notes` 支援 `?bookId=...&offset=0&limit=50&includeDeleted=1`。
   - `CREATE UNIQUE INDEX IF NOT EXISTS uq_student_notes_entry ON student_notes(student_id, entry_id) WHERE entry_id IS NOT NULL;` 確保併發 `from-history` 冪等。
4. **Body Parser 256 KiB 前置（F6）**：`stu-api.ts` 必須在全域 `app.use(express.json())` **之前**掛載 `app.use("/api/student/notes", express.json({ limit: MAX_LEARNING_HISTORY_BODY_BYTES }))`，且 `oversizeJsonBodyHandler` 對 `/api/student/notes` 回傳 `413 { error: "NOTE_TOO_LARGE" }`。
5. **Phase 1 範圍收斂（F9/F10/F13）**：
   - Phase 1 **隱藏**「平台 AI（API）」切換（不呼叫未實作的 `/api/student/ai-ask`）。
   - Google AI Relay 貼回答案後，先寫入 `learning_history`（`strategy: "google-ai"`）再呼叫 `POST /api/student/notes/from-history`（若在書內選字或手動新增則可直接 `POST /api/student/notes`）。
6. **全域安全紀律**：
   - **嚴禁對 PM (`t16`) 送任何 `hc send` / `hc keys` 輸入**。
   - **禁止修改 `pnpm-lock.yaml`**（SHA256 必須維持 `11af3fe5b189f8413b1292cd252ae220af6c1a8fd8434ef67078029d28a11b4c`）。
   - **禁止執行 `git commit` / `git push` / `git reset` / `git stash`**，禁止輸出任何 secret 真值。
