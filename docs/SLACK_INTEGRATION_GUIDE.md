# Slack 連接與整合設定指南 (Slack Integration Guide)

本專案已建置 Slack 連線模組（支援 **Incoming Webhook** 與 **Slack Bot API** 雙模式），可用於系統狀態推播、測試/部署通知、錯誤日誌告警等。

---

## 方式一：Incoming Webhook（推薦，最快速簡便）

適用於：單向推播、系統警報、自動化測試或部署通知。

### 1. 建立 Slack App 與 Webhook URL
1. 前往 [Slack API 管理頁面](https://api.slack.com/apps)。
2. 點擊 **"Create New App"** -> 選擇 **"From scratch"**。
3. 輸入 App Name（例如：`AI-SmartBook-Notifier`），並選擇你的 Slack Workspace。
4. 在左側選單進入 **"Incoming Webhooks"**。
5. 將 **"Activate Incoming Webhooks"** 切換為 **On**。
6. 點擊下方 **"Add New Webhook to Workspace"**，選擇你要接收訊息的 Slack 頻道（例如 `#alerts` 或 `#general`）。
7. 完成後複製產生的 **Webhook URL**（格式如 `https://hooks.slack.com/services/T.../B.../...`）。

### 2. 設定環境變數
在專案根目錄的 `.env` 中加入：

```bash
SLACK_WEBHOOK_URL="https://hooks.slack.com/services/<TEAM_ID>/<BOT_ID>/<SECRET_TOKEN>"
```

### 3. 測試連線
在終端機執行：

```bash
pnpm slack:test
```

若成功，會在指定 Slack 頻道中收到漂亮的 Block Kit 卡片訊息！

---

## 方式二：Slack Bot Token（進階，支援多頻道與檔案上傳）

適用於：需動態指定推播頻道、私訊特定成員、或上傳報告檔案。

### 1. 取得 Bot Token
1. 在 [Slack API Apps](https://api.slack.com/apps) 建立或選擇 App。
2. 進入 **"OAuth & Permissions"**。
3. 在 **"Scopes" -> "Bot Token Scopes"** 新增以下權限：
   - `chat:write`（發送訊息）
   - `chat:write.public`（可發送至所有公開頻道，免先手動將 Bot 加入該頻道）
4. 滾動到上方點擊 **"Install to Workspace"**（或 "Reinstall"）。
5. 複製 **Bot User OAuth Token**（以 `xoxb-...` 開頭）。

### 2. 設定環境變數
在專案根目錄的 `.env` 中加入：

```bash
SLACK_BOT_TOKEN="xoxb-your-bot-token"
SLACK_DEFAULT_CHANNEL="#general"
```

### 3. 測試連線
```bash
pnpm slack:test
```

---

## 方式三：在程式碼中調用發送訊息

已封裝好的模組可直接在專案中的各個服務或腳本引用：

```typescript
import { sendSlackMessage } from "./scripts/slack-notify";

// 發送一般訊息
await sendSlackMessage({
  title: "模型配額警告",
  text: "Gemini 3.5 Flash 每日配額已達 80%！",
  level: "warn", // 可選: 'info' | 'success' | 'warn' | 'error'
  fields: {
    "目前使用量": "8,200 / 10,000",
    "觸發模組": "AI Gateway"
  }
});
```

---

## 方式四：Slack Socket Mode 實時轉發訊息到 AGY 對話視窗（XAPP + XOBB）

適用於：**在 Slack 頻道中的訊息或 @機器人提問，能即時自動轉發至 Antigravity (AGY) 對話視窗**。
採用 WebSocket 長連線架構，**不需要**固定公網 IP、網址或 ngrok。

### 1. 取得兩組 Token (XAPP & XOBB)
前往 [Slack API Apps 頁面](https://api.slack.com/apps)：

1. **取得 XAPP (App-Level Token)**：
   - 點擊左側選單 **"Socket Mode"**，將 **"Enable Socket Mode"** 切換為 **On**。
   - 系統會提示產生 App-Level Token，輸入 Token Name（如 `socket-token`），並確保具備 `connections:write` 權限。
   - 產生的 Token 即為 **XAPP**（以 `xapp-1-...` 開頭）。
2. **取得 XOBB / XOXB (Bot User Token)**：
   - 點選左側 **"OAuth & Permissions"**。
   - 在 **"Bot Token Scopes"** 確認已加入：
     - `chat:write`（回覆訊息）
     - `channels:history` / `groups:history` / `im:history`（讀取頻道訊息）
     - `app_mentions:read`（讀取 @ 標記）
   - 複製上方以 `xoxb-...` 開頭的 Token 即為 **XOBB**。
3. **啟用事件監聽 (Event Subscriptions)**：
   - 點擊左側 **"Event Subscriptions"**，切換為 **On**。
   - 在 **"Subscribe to bot events"** 下點擊 **Add Bot User Event**，加入：
     - `message.channels`
     - `message.im`
     - `app_mention`
   - 點擊右下角 **Save Changes**。

### 2. 設定專案環境變數
在專案根目錄 `.env` 加入兩組 Token：

```bash
# App-Level Token (Socket Mode)
SLACK_APP_TOKEN="xapp-1-..."

# Bot User OAuth Token
SLACK_BOT_TOKEN="xoxb-..."
```

也可以直接透過 CLI 傳入金鑰啟動：
```bash
pnpm slack:listen --xapp <xapp-token> --xobb <xoxb-token> [--ack]
```

### 3. 啟動監聽與轉發
在終端機執行：

```bash
pnpm slack:listen
```

或帶 `--ack` 參數（收到訊息時自動在 Slack 頻道給予確認回應）：
```bash
pnpm slack:listen --ack
```

### 4. 轉發效果
一旦 Slack 有人發送訊息或 @機器人：
- 連線監聽器會立即解析並以醒目卡片格式在 **AGY 對話視窗與終端** 印出：
  ```text
  ============================================================
  💬 【Slack 轉發訊息至 AGY 對話視窗】
  ⏰ 時間: 2026-10-13 19:55:00
  📌 頻道 ID: C0123456789
  👤 使用者 ID: U0987654321
  📝 內容:
  <使用者在 Slack 發送的內容>
  ============================================================
  ```
- 同步保存至本地紀錄檔 `data/slack-incoming.log`，確保任何重要訊息皆不遺失。


### CLI 命令列使用
```bash
# 測試連線
pnpm slack:test

# 自訂訊息
node --import ./apps/AI-adm-D1/node_modules/tsx/dist/loader.mjs scripts/slack-notify.ts -m "部署成功完成！" --title "Deploy Status" --level success
```
