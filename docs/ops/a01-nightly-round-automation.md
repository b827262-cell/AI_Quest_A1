# A-01 Slack 夜間輪值自動化設計

## 目的

在 `#a-01-v01` 建立一個低權限的夜間 PM 輪值提示器：每天台北時間
`23:50` 開始，每 30 分鐘提醒一次，`08:50` 為最後一輪，`09:00` 為
排程的排他結束邊界。腳本只送出狀態回報提示，不替 Agent 做 merge、部署、
secret 或 migration 操作。

預設焦點是 main 與開啟中的 PR；若當晚有特定項目，可由執行環境設定
`A01_NIGHTLY_FOCUS`。`migration 0003` 與 production `require/strict`
不在自動化範圍。

## 執行契約

| 項目 | 設計 |
| --- | --- |
| 時區 | `Asia/Taipei`，由 `A01_NIGHTLY_TIMEZONE` 覆寫 |
| 發送時刻 | `23:50`、`00:20`、`00:50` … `08:50`，共 19 輪 |
| 09:00 | 不發送；只代表窗口結束 |
| 預設模式 | dry-run；必須明確加 `--execute` 才呼叫 Slack API |
| Slack 目的地 | 明確指定 `A01_NIGHTLY_CHANNEL_ID`，不回退其他頻道 |
| 身分 | `SLACK_BOT_TOKEN` 由專用、僅擁有者可讀的 Slack 環境檔或執行環境提供；腳本不讀 repo `.env` |
| 併發 | 狀態目錄預設 `~/.local/state/a01-nightly-round`；鎖檔記 PID、建立時間，10 分鐘後視為殘留並清除 |
| 防重送 | 每個台北時間槽先記錄 `claimed`，成功後標 `sent`；同槽再執行一律跳過 |
| 訊息內容 | 當輪時間、Agent 回報格式、目前 git branch/head、下一輪時間與安全邊界 |

## 腳本

```bash
# 預覽目前時刻是否會發送；不會連 Slack
node scripts/a01-nightly-round.mjs

# 以指定時刻測試 23:50 訊息
A01_NIGHTLY_NOW=2026-10-17T15:50:00Z \
  node scripts/a01-nightly-round.mjs

# 實際發送（只應由排程器執行；此處僅示範命令，不要直接貼上執行）
node scripts/a01-nightly-round.mjs --execute --env-file /etc/a01-nightly/slack.env
```

專用環境檔必須由維運者在 repo 外建立，權限設為 `0600`，且只接受以下
Slack 欄位；其他鍵會使腳本拒絕啟動。不要把實際 token 或環境檔提交到 Git。
既有 secret store 也可直接注入這些欄位。可選的 Agent mention 由部署
環境注入，避免把特定 Workspace 的使用者 ID 硬編碼在程式：

```dotenv
SLACK_BOT_TOKEN=<provided-outside-repo>
A01_NIGHTLY_CHANNEL_ID=C_REPLACE
A01_NIGHTLY_AGENT_MENTIONS=<@HERMES_ID> <@CODEX_ID> <@WORKBUDDY_ID> <@AGY_ID>
```

`A01_NIGHTLY_AGENT_MENTIONS` 只影響 Slack 顯示與通知，不會改變腳本的
執行權限或行為。

`A01_NIGHTLY_TIMEZONE`、`A01_NIGHTLY_FOCUS`、`A01_NIGHTLY_REPO` 與
`A01_NIGHTLY_STATE_DIR` 可由執行環境設定，不放進專用 Slack 檔。dry-run
不讀取該檔，也不建立鎖或狀態檔。發送前先登記時間槽以避免重送；若 Slack
呼叫失敗，該槽標為 `failed` 並停止自動重試，需由維運者查明是否已送達後
再人工處理，避免網路回應不明時重複發送。狀態檔不含 token。

## Cron 排程

`deploy/cron/a01-nightly-round.cron` 是待維運審核的範例，**本 PR 不安裝**。
只有已確認使用支援 `CRON_TZ` 的 cronie 時，才能直接採用以下排程；若
cron 不支援 `CRON_TZ`，必須將主機排程時區設為 `Asia/Taipei`，或改用
明確指定 `Asia/Taipei` 的 systemd timer。僅設定執行程序的 `TZ` 不會
改變 cron 的觸發時間；腳本內部時間槽檢查也無法補回被錯過的輪次。

```cron
CRON_TZ=Asia/Taipei
50 23 * * * cd /opt/AI-Quest-A1 && /usr/bin/node scripts/a01-nightly-round.mjs --execute --env-file /etc/a01-nightly/slack.env >> /var/log/a01-nightly-round.log 2>&1
20,50 0-8 * * * cd /opt/AI-Quest-A1 && /usr/bin/node scripts/a01-nightly-round.mjs --execute --env-file /etc/a01-nightly/slack.env >> /var/log/a01-nightly-round.log 2>&1
```

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
