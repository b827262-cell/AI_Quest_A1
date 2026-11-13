# 本機隔離安全測試環境

此環境只用於本機安全 smoke 測試，不改變任何產品程式行為或安全邏輯。它啟動真實的 Student API 程序，但由測試專用 preload 將 listener 限制在 `127.0.0.1`，並封鎖 child process 的非 loopback TCP、TLS 與非 loopback `fetch`。測試資料只寫入作業系統暫存目錄中的唯一資料夾。

本環境不取代 `reset-ai-smartbook.sh`，也不呼叫該腳本。該 reset 腳本屬於既有本機 runtime 流程；安全測試使用自己的 ephemeral port、暫存資料目錄與 SQLite 檔，不依賴或重設既有服務。不得以此流程連接 production、Sites、Cloudflare 或外部 provider。

## 前置條件與設定範例

需要 Node.js 22+、Corepack/pnpm workspace 依賴已安裝，以及可寫入的 OS 暫存目錄。`.env.test.example` 僅展示安全的測試設定慣例；命令不會載入任何 `.env` 檔，也不會讀取呼叫端的資料庫 URL、provider key、proxy、Google OAuth 或其他 credentials。測試子程序收到明確 allowlist：隨機且只在記憶體中的 session secret、臨時 SQLite 路徑、動態 loopback port、合成 Cloudflare Access key/certificate URL，以及 `STUDENT_RAG_PROVIDER=fake`。不會把 secret 寫到檔案或輸出到 log。

## 命令

```sh
corepack pnpm security:test:doctor
corepack pnpm security:test:setup
corepack pnpm security:test:cleanup
```

`doctor` 檢查 Node 版本、Student smoke harness/tsx/native SQLite、固定 seed、暫存目錄可寫及 loopback ephemeral port，不啟動 API、不連網。`setup` 是一次性的建立、驗證、清除流程：建立兩本固定 ID/內容/時間的 synthetic 書籍，使用 Student auth runtime 建立隔離 auth schema，啟動本機 fake Access certificate URL 與 fake RAG provider，驗證 health、書籍、匿名拒絕、合成登入、profile 與 grounded RAG 後，在 `finally` 停止程序、關閉 stub、刪除 SQLite/WAL/SHM 與整個 run 目錄。此處的 auth schema 初始化只作用於 throwaway SQLite；不執行 site migration，也不執行 migration 0003。

子程序的 stdout/stderr 會被消耗並丟棄，不寫 log 檔，也不在失敗時回顯。setup 成功與一般錯誤路徑都執行清理；若程序未能停止，腳本保留資料並回報清理失敗，避免刪除仍被開啟的 DB。`cleanup` 只掃描 OS 暫存目錄中符合本 repo 擁有標記的 `aiquest-security-test-env-*` run；若中斷留下帶 pid 的資料夾，只有在 pid 的命令列同時包含本 repo 的 Student API 路徑與該 run 的隨機 ID 時才會停止程序，然後移除資料夾。它不會碰其他 repo、沒有標記的資料夾或既有 runtime。

## 邊界與限制

- Student 資料 DB 與 auth DB 都在一個隨機暫存資料夾；固定 synthetic seed 為 `book-alpha`、`book-beta` 與對應章節內容，沒有真實學生資料。
- Access certificate URL 僅由父程序中的 loopback stub 提供 RSA 公鑰；登入 assertion 的 email 使用 `.test` 保留網域。
- RAG 使用內建 deterministic fake provider；preload 會拒絕測試 Student API 子程序的外部 HTTP(S)/TCP。stub 和資料均於結束時清除。
- 動態 port 在啟動前由 OS 分配並釋放後交給 API，仍有一般的短暫 port-reuse 競爭；若被占用，readiness 失敗並進入清理。API listener 透過測試專用 loopback guard 限制為 loopback。
- 這是本機 smoke fixture，不是作業系統 sandbox，也不替代 CI 的隔離容器或正式滲透測試。
