# R24 派工總計劃 — Phase 2 學員課業筆記本 `/notes`（標籤篩選、編輯、追問）＋ `/api/student/ai-ask` 伺服器端 AI 代理

- **輪次**：R24（Phase 2）
- **簽發者**：PM (`t16` Antigravity)
- **技術統籌**：TL (`t17` Hermes)
- **基線提交**：HEAD `8574b37`（R23 Phase 1 MVP 已合入 `origin/main`，E500 四埠運行正常且 `student_notes` 表已遷移完成）
- **參考方案**：`docs/plans/R22-student-google-ai-notes-proposal.md` §3、§4、§7、§8

---

## 1. 本輪核心目標（Phase 2 兩大主軸）

1. **主軸 A：獨立「我的課業筆記本」`/notes`（支援標籤篩選、關鍵字搜尋、編輯與追問）**
   - 後端 `GET /api/student/notes` 擴充查詢參數：`tag`（單一標籤精確過濾）、`q`（標題／內容不分大小寫子字串搜尋），嚴格維持 `AND student_id = ?` 防 IDOR。
   - 前端新增 `/notes` 路由（`RequireStudent` 保護）、`StudentHeader` 新增「我的筆記」導覽連結、實作 `StudentNotesPage.tsx`（含標籤篩選 chip、關鍵字搜尋框、筆記內容與標籤編輯 `PATCH /api/student/notes/:id`、刪除 `DELETE`、以及一鍵「對此筆記追問」帶入 `StudentAiAssistant`）。
2. **主軸 B：`POST /api/student/ai-ask` 伺服器端受控 AI 課業提問代理（可選配、預設 fail-closed / mock-safe）**
   - 在 `apps/AI-Stu-R1/server/student-ai-ask.ts` 實作受控代理端點 `POST /api/student/ai-ask`（掛於 `createStudentSessionMiddleware` 之後 + `originGuard` + 獨立 per-student 滑動視窗節流 429 + `Retry-After`）。
   - **支援 `mock` / `gemini` 雙模式**：未設金鑰或測試模式走安全決定性 `mock` 模式（不外連、不洩漏任何內部錯誤）；設定伺服器端 `GEMINI_API_KEY` 時由伺服器端代理呼叫（key 永不出 server，符合 `boundary-check.sh`）。
   - **統一落地契約**：`POST /api/student/ai-ask` 產生回答後，自動寫入同一 auth DB 的 `student_learning_history`（`strategy: "api"`），回傳 `{ entryId, question, answer, strategy: "api", providerMode }`，前端即可直接透過既有 `POST /api/student/notes/from-history` 一鍵轉存為課業筆記（`source: "gemini-api"`）！
   - 前端 `StudentAiAssistant.tsx` 升級提供「Google AI（免金鑰中繼）」與「平台 AI（伺服器代理）」雙模式切換，共用同一套「存為課業筆記」流程。

---

## 2. 席位編制（採 17:26 互換後最新 10 席配置）

| 角色 | hc 位址 | 載體 | Wave | 任務編號與授權範圍 |
|---|---|---|---|---|
| **PM** | `t16` | Antigravity | 全程 | 簽發 R24 總計劃與派工單、最終驗收 |
| **TL** | `t17` | Hermes | 全程 | 統籌 Wave 1→2→3 派工、監控、**直屬管理與收尾 DE (`t1j`)**、彙整 `R24-ROUND-REPORT.md` 與 `R24-KPI-REPORT.md` |
| **SA** | `t19` | CodeBuddy | Wave 1 | **`R24-SA`**：在 `packages/schema` 定義 `studentAiAskInputSchema`、`studentAiAskResponseSchema`、`studentNotesQuerySchema`（含 `tag`、`q` 長度與字元上限）及單元測試 |
| **BE** | `t1f` | Junie | Wave 1 | **`R24-BE`**：擴充 `packages/db/src/repositories/studentNote.repo.ts` 的 `list()` 支援 `tag` 與 `q` 過濾（純參數化查詢防 SQLi + `AND student_id = ?`），補齊單元測試 |
| **SE** | `t1h` | OpenCode | Wave 1 | **`R24-SE`**：新增或更新學員端「課業筆記與 AI 助教使用與維運說明」文件 `docs/STUDENT_AI_NOTES_GUIDE.md`（涵蓋 Phase 1 Relay + Phase 2 `/notes` & `/api/student/ai-ask` 環境變數、節流與資安邊界） |
| **DE** *(TL 直屬)* | `t1j` | Freebuff | Wave 1 (TL 派發) | **`R24-DE`**：驗證 E500 剛重啟的四埠（4300/4310/5173/5174）實機健康度、`data/ai-smartbook-r1.db` 的 `student_notes` 表與索引就緒狀況、以及 `boundary` / `symlinks` / `lock-sync` 基線（完成後 TL 等滿 180 秒模擬點擊 `✕ End session`） |
| **SD** | `t1d` | Codex | Wave 2 (待 SA+BE) | **`R24-SD`**：(1) 更新 `packages/auth/src/student-notes-express.ts` 串接 `GET /notes?tag=&q=`；(2) 新增 `apps/AI-Stu-R1/server/student-ai-ask.ts` 實作 `POST /api/student/ai-ask`（session 保護、`originGuard`、per-student 429 節流、mock/gemini 雙模式、寫入 `learning_history` `strategy="api"`）並掛載於 `stu-api.ts`；(3) 撰寫完整整合測試 |
| **FE** | `t1c` | Vibe | Wave 2 (待 SA) | **`R24-FE`**：(1) 擴充 `studentClient.ts`（`listStudentNotes` 支援 `tag`/`q` + 新增 `askStudentAi()`）；(2) 新增 `/notes` 路由與 `StudentNotesPage.tsx`（標籤篩選、關鍵字搜尋、行內編輯 title/content/tags、刪除、一鍵追問）並在 `StudentHeader.tsx` 加上「我的筆記」連結；(3) 升級 `StudentAiAssistant.tsx` 支援「Google AI 中繼」與「平台 AI」切換並共用 `from-history` 存筆記；(4) 補齊前端測試 |
| **QA** | `t1b` | Pi | Wave 3 (待 Wave 1+2) | **`R24-QA`**：執行全套 `pnpm -r typecheck`、`pnpm -r lint`、核心套件與前端測試、Admin 隔離測試、Google AI Relay E2E（42/42）、`boundary-check.sh`、`check-workspace-symlinks.sh`、`check-lockfile-store-sync.mjs` 與 lockfile hash 驗證 |
| **CR** | `t1g` | dsh *(若滿載或異常由 TL 協調獨立複審)* | Wave 3 (待 Wave 1+2) | **`R24-CR`**：唯讀行號級資安與架構終審（`ai-ask` key 零外洩、429 節流、IDOR/CSRF/XSS、SQLi 參數化、`boundary-check` 合規），出具 `TECH_SIGNOFF` |

---

## 3. 全域安全與工程鐵律
1. **API Key 零外洩**：`GEMINI_API_KEY` 僅限伺服器端（`apps/AI-Stu-R1/server/`）讀取，絕不進入前端 `src/`；provider 錯誤一律走 opaque error code（如 `AI_ASK_UNAVAILABLE`），絕不把上游 raw error 吐給瀏覽器。
2. **嚴禁破壞既有功能**：公開首頁 Google AI Relay E1–E7（42/42）與 `apps/AI-adm-D1` 既有路由零回歸。
3. **全域紀律**：嚴禁對 PM (`t16`) 送任何 `hc send` / `hc keys`；禁止修改 `pnpm-lock.yaml`；禁止 `git commit` / `git push` / `git reset` / `git stash`；禁止輸出任何 secret 真值。
