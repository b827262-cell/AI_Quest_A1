# A-01 Slack 夜間輪值自動化設計

## 目的

在指定 Slack 頻道建立一個低權限的夜間 PM 輪值提示器：單次窗口由
`A01_NIGHTLY_WINDOW_DATE` 指定台北日期，當日 `23:50` 開始，每 30 分鐘
提醒一次，次日 `08:50` 為最後一輪，`09:00` 為
排程的排他結束邊界。腳本只送出狀態回報提示，不替 Agent 做 merge、部署、
secret 或 migration 操作。

預設焦點是 main 與開啟中的 PR；若當晚有特定項目，可由執行環境設定
`A01_NIGHTLY_FOCUS`。`migration 0003` 與 production `require/strict`
不在自動化範圍。

## 執行契約

| 項目 | 設計 |
| --- | --- |
| 時區 | `--execute` 固定要求 `Asia/Taipei`；dry-run 可由 `A01_NIGHTLY_TIMEZONE` 覆寫以檢查顯示 |
| 窗口 | `--execute` 必須指定 `A01_NIGHTLY_WINDOW_DATE=YYYY-MM-DD` 或 `--window-date`；只對該日期 23:50 至次日 08:50 生效，不會每天自動開新窗口 |
| 發送時刻 | `23:50`、`00:20`、`00:50` … `08:50`，共 19 輪 |
| 09:00 | 不發送；只代表窗口結束 |
| 預設模式 | dry-run；必須明確加 `--execute` 才呼叫 Slack API |
| Slack 目的地與 Agent | 明確指定 `A01_NIGHTLY_CHANNEL_ID` 與 `A01_NIGHTLY_AGENT_MENTIONS`；沒有有效的 `<@USER_ID>` 清單就拒絕發送 |
| 身分 | `SLACK_BOT_TOKEN` 由專用、僅擁有者可讀的 Slack 環境檔或執行環境提供；腳本不讀 repo `.env` |
| 併發 | 狀態目錄預設 `~/.local/state/a01-nightly-round`；鎖檔記 PID、建立時間，10 分鐘後視為殘留並清除 |
| 防重送與逾時 | 每個台北時間槽先記錄 `claimed`，成功後標 `sent`；同槽再執行一律跳過；Slack 網路等待上限 15 秒 |
| 訊息內容 | 當輪時間、Agent 回報格式、本機 HEAD、即時查得的遠端 main、下一輪時間與安全邊界 |

## 腳本

```bash
# 預覽目前時刻是否會發送；不會連 Slack
node scripts/a01-nightly-round.mjs

# 以指定時刻測試 23:50 訊息
A01_NIGHTLY_NOW=2026-10-17T15:50:00Z \
  node scripts/a01-nightly-round.mjs

# 實際發送（只應由排程器執行；此處僅示範命令，不要直接貼上執行）
A01_NIGHTLY_WINDOW_DATE=YYYY-MM-DD \
  node scripts/a01-nightly-round.mjs --execute --env-file /etc/a01-nightly/slack.env
```

專用環境檔必須由維運者在 repo 外建立，權限設為 `0600`，且只接受以下
Slack 欄位；其他鍵會使腳本拒絕啟動。不要把實際 token 或環境檔提交到 Git。
既有 secret store 也可直接注入這些欄位。必要的 Agent mention 由部署
環境注入，避免把特定 Workspace 的使用者 ID 硬編碼在程式：

```dotenv
SLACK_BOT_TOKEN=<provided-outside-repo>
A01_NIGHTLY_CHANNEL_ID=C_REPLACE
A01_NIGHTLY_AGENT_MENTIONS=<@HERMES_ID> <@CODEX_ID> <@WORKBUDDY_ID> <@AGY_ID>
```

`A01_NIGHTLY_AGENT_MENTIONS` 只影響 Slack 顯示與通知，不會改變腳本的
執行權限或行為。維運者須在啟用前將每個 `<@USER_ID>` 對照預期的代理
帳號，確認 `SLACK_BOT_TOKEN` 所屬 Bot 身分、其已加入目標頻道，且
`A01_NIGHTLY_CHANNEL_ID` 確實是批准的 `#a-01-v01`；不要只憑名稱猜 ID。

`A01_NIGHTLY_WINDOW_DATE`、`A01_NIGHTLY_TIMEZONE`、`A01_NIGHTLY_FOCUS`、`A01_NIGHTLY_REPO` 與
`A01_NIGHTLY_STATE_DIR` 可由執行環境設定，不放進專用 Slack 檔。dry-run
不讀取該檔，也不建立鎖或狀態檔。發送前先登記時間槽以避免重送；若 Slack
呼叫失敗或逾時，該槽標為 `failed` 並停止自動重試，需由維運者查明是否已
送達後再人工處理，避免網路回應不明時重複發送。殘留鎖滿 10 分鐘會清除；
同槽已登記的狀態仍保留，故鎖恢復不會重送。狀態檔不含 token。

訊息內分開顯示本機 checkout 的完整 HEAD 與即時查得的遠端 `main` SHA；
遠端查詢最多等待 5 秒，失敗時顯示 `unavailable`，不把本機追蹤分支冒充
遠端現況。預設焦點不含固定 PR 編號。

本地假 Slack 測試只能證明訊息包含設定的 `<@USER_ID>` 並送往設定的
頻道，**不能證明 Slack Bot 訊息確實喚起代理**；有些代理可能忽略其他
Bot 所發的訊息。啟用前須由 Owner 核准
在目標頻道做一次端到端測試，確認各代理收到提示並回覆；目前此項為
`UNVERIFIED`，不可據此將腳本標為可啟用。

## Cron 排程

`deploy/cron/a01-nightly-round.cron` 是待維運審核的範例，**本 PR 不安裝**。
只有已確認使用支援 `CRON_TZ` 的 cronie 時，才能直接採用以下排程；若
cron 不支援 `CRON_TZ`，必須將主機排程時區設為 `Asia/Taipei`，或改用
明確指定 `Asia/Taipei` 的 systemd timer。僅設定執行程序的 `TZ` 不會
改變 cron 的觸發時間；腳本內部時間槽檢查也無法補回被錯過的輪次。

```cron
CRON_TZ=Asia/Taipei
A01_NIGHTLY_WINDOW_DATE=YYYY-MM-DD
50 23 * * * cd /opt/AI-Quest-A1 && /usr/bin/node scripts/a01-nightly-round.mjs --execute --env-file /etc/a01-nightly/slack.env >> /var/log/a01-nightly-round.log 2>&1
20,50 0-8 * * * cd /opt/AI-Quest-A1 && /usr/bin/node scripts/a01-nightly-round.mjs --execute --env-file /etc/a01-nightly/slack.env >> /var/log/a01-nightly-round.log 2>&1
```

`YYYY-MM-DD` 必須換成此**單次窗口開始日期**。cron 本身每日觸發，但
窗口結束後腳本只會輸出 `SKIP`；下一次窗口須由 Owner 明確指定新日期。
正式安裝前需由維運者決定並確認：排程器的時區支援、執行帳號、repo
絕對路徑、log rotation、狀態目錄持久性、Slack Bot 是否已加入目標頻道，
以及該帳號只具備發訊息所需權限。不要把 Bot token 放在 crontab。

## 驗證與回滾

```bash
node --test scripts/a01-nightly-round.test.mjs
node scripts/a01-nightly-round.mjs --now 2026-10-17T15:50:00Z
node scripts/a01-nightly-round.mjs --now 2026-10-18T01:00:00Z
```

回滾只需移除兩行 cron 或停用該執行帳號的排程；不涉及程式部署、Cloudflare
設定、D1/R2 或 production 流量。若要更換提示內容，先以 dry-run 檢視，再由
Owner 決定是否恢復 `--execute`。
