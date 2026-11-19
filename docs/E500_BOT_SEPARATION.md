# E500：Cline-E500 與 OpenClaw 獨立分離

Owner 決議（2026-10-14）：兩個 Agent 各自運作，不互相代收派工或代為驗收。取消以 Cline-E500 作為 OpenClaw 暫時派工別名的做法。

## 身分與派工

| 項目 | Cline-E500 | OpenClaw |
| --- | --- | --- |
| Slack Bot user ID | `U0C59550WHY` | `U0C30BR8ACQ` |
| 派工 mention | `<@U0C59550WHY>` | `<@U0C30BR8ACQ>` |
| 接收任務 | 明確指派 Cline-E500 的任務 | 明確指派 OpenClaw 的任務 |
| 執行身分 | Cline-E500 | OpenClaw |
| session、歷史、記憶與任務佇列 | 專屬、不與 OpenClaw 共用 | 專屬、不與 Cline-E500 共用 |
| Slack App／憑證對應 | Cline-E500 專屬 App 的憑證 | OpenClaw 專屬 App 的憑證 |
| Gateway／接收服務 | 獨立接收程序或經驗證隔離的路由 | 獨立接收程序或經驗證隔離的路由 |

以 Slack user ID 判斷目標，不以顯示名稱或 Agent 自述判斷。每個 Bot 只處理指向自己的任務，不轉交另一 Bot、不以另一 Agent 的名義回覆。若共用頻道，維持 `requireMention=true`，分別使用獨立 thread。不要在同一份派工中同時 mention 兩者。

## 待實施的 Gateway 分離

1. 在管理端確認各接收程序的 Slack App、Bot user ID 與 session 對應；只記錄識別資訊，不輸出憑證。
2. OpenClaw Gateway 必須綁定 `U0C30BR8ACQ`，不得繼續以 `U0C59550WHY` 接收或回覆 OpenClaw 任務。
3. Cline-E500 使用自己的接收服務與 session。不得把目前自稱 OpenClaw 的共用 session 直接重新命名為 Cline-E500。
4. 分離設定、憑證來源、狀態目錄與任務佇列；如果採用兩個 Gateway 程序，使用不同監聽埠與各自服務設定。
5. 保留舊歷史供追查，不把舊任務自動重送至另一 Agent。身分混用尚未解除的接收服務不承接新的專案任務。

## 各自驗收

| 測試 | 正向要求 | 隔離要求 |
| --- | --- | --- |
| 只 mention Cline-E500 | Cline-E500 在原 thread 回覆其專屬測試識別碼 | OpenClaw 不回覆、不建立任務 |
| 只 mention OpenClaw | OpenClaw 在原 thread 回覆其專屬測試識別碼 | Cline-E500 不回覆、不建立任務 |
| 無 mention | 兩者皆不執行任務 | 日誌可顯示 `missing-mention` |

每次測試需使用不同識別碼，記錄訊息連結、實際回覆 Bot user ID、Gateway／路由及 session 識別資訊。正向 ACK 與另一端沒有處理的日誌都確認後，才算該 Agent 隔離驗收通過。

## 已有證據與目前限制

- Cline-E500 於 2026-10-14 08:32:05 回覆 `BOT_BINDING_ACK=PASS`：[Slack 證據](https://b827262.slack.com/archives/C0C8JFLPTSN/p1791937925618409)。這只證明當時文字通道可回覆。
- 同一 Bot user ID 於 08:32:08 又回覆 BLOCKED 並自稱 OpenClaw：[衝突證據](https://b827262.slack.com/archives/C0C8JFLPTSN/p1791937928766699)。因此 Cline-E500 的獨立執行身分尚未驗收。
- OpenClaw 正式 Bot 綁定尚未驗收。
- 本文件是分離規則與實施清單。此工作區沒有 E500 Gateway 設定；尚未修改遠端 Bot 綁定、憑證、程序或 session，兩者的實際隔離仍待實施。
