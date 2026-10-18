# Issue #72: 學習紀錄同步 V1（部署 HOLD）

此變更在 monorepo 的 `AI-Stu-R1` 與 `AI-adm-D1` 加入學習紀錄同步。訪客紀錄仍留在舊的裝置儲存鍵；登入後依學員 ID 使用獨立本機鍵，畫面上的「匯入這台裝置的訪客紀錄」才會複製訪客紀錄到學員帳戶。兩個問題範例「AI agents」與「AI 如何寫程式」僅供 fixture；程式沒有讀取使用者真實裝置資料。

## 資料與安全

- 專用 SQLite 表 `student_learning_history`，以 `(student_id, entry_id)` 為主鍵。`sync_version` 只接受更高版本；相同請求重試不產生重複列。刪除留下 tombstone，舊版本不能復活。刪除時清掉題目、答案、原始回答、整理後回答與來源連結。
- 學員 ID 僅由已驗證、可撤銷的 HttpOnly student session 取得。沒有 session 回 401；跨帳戶刪除回 404。寫入需要同源或明確設定的 Origin。每批 1–25 筆、最大 256 KiB；JSON parser 與路由檢查共用同一個 256 KiB 位元組上限（不是 Express 預設的 100 KB），超限一律回 `413 {"error":"BATCH_TOO_LARGE"}` 且不回傳請求內容。`BATCH_TOO_LARGE` 只代表學習紀錄端點；其他路由的 body 超限回通用的 `413 {"error":"PAYLOAD_TOO_LARGE"}`，兩者都不含 stack trace 或請求內容。單題 2,000 字，答案與原始回答各 20,000 字。來源連結只准確切 `https://www.google.com/search`、`udm=50` 且 `q` 對應題目。
- 管理 API 沿用現有 session、CSRF 與 Origin middleware；列表只有摘要與有無原始回答的狀態，詳情才提供完整內容。管理者不會從此表看到未匯入的訪客紀錄。
- 保留政策：未刪除紀錄與原始回答留存至學員刪除；刪除後清空回答內容並保留最小 tombstone（ID、時間、版本）以阻止離線重試復活。V1 不做自動時限清除；正式保留期限需在部署前由 Owner 明定。管理端不得將詳情回答寫入日誌。

## 路由與部署界線

| 執行方式 | 前台 API | 管理 API | 身分來源 |
| --- | --- | --- | --- |
| 本機 Vite + 獨立 student API | `5173` 代理至 `4310` | `5174` 代理至 `4300` | 共用 SQLite 的 student HttpOnly session |
| 本機 Vite + admin API | `5173` 可代理至 `4300` | `5174` 代理至 `4300` | 同上 |
| `site/` ChatGPT Sites | **未接入此 V1** | **未接入此 V1** | Sites 使用另一套 SIWC／relay 身分和 D1，不能當成相同 student session |

本機／staging 的 Vite 代理會改寫上游 Host；啟用學員寫入前，須把實際學員前台 origin 明確列入 `STUDENT_ALLOWED_ORIGINS`。未設定時跨代理 Origin 會回 403；不要關閉來源檢查來繞過。

`site/` 是另一套 vinext/D1 應用，不載入 `AI-Stu-R1`/`AI-adm-D1` 的 React 程式，也沒有這些新 API。若日後要在 Sites 上啟用，需另外設計可信身分映射、D1 schema 與 route；不能直接把 `student-synth-001` 或瀏覽器傳來的 `studentId` 當成學員 ID。此 Draft PR 只驗證 monorepo 的本機／測試環境。`packages/db/sql/20261016_student_learning_history.sql` 是待審 migration；沒有在 production 執行。

## 本機驗證

使用暫存 SQLite 與 fixture 帳號執行單元、HTTP 整合、遷移重跑與 CDP UI 測試。登入 fixture 不涉及真實 Google 帳密或 production。正式 migration、merge、deploy 皆維持 `OWNER_GATE=HOLD`。
