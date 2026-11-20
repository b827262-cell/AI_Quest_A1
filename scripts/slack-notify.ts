import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface SlackMessageOptions {
  text: string;
  title?: string;
  level?: "info" | "success" | "warn" | "error";
  channel?: string;
  webhookUrl?: string;
  token?: string;
  fields?: Record<string, string>;
}

export interface SlackSendResult {
  success: boolean;
  mode: "webhook" | "bot_token";
  error?: string;
  response?: unknown;
}

/**
 * 載入專案根目錄的 .env 檔案
 */
export function loadEnv(): void {
  const envPath = resolve(process.cwd(), ".env");
  if (!existsSync(envPath)) return;
  const content = readFileSync(envPath, "utf-8");
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "");
    }
    if (process.env[match[1]] === undefined) {
      process.env[match[1]] = value;
    }
  }
}

/**
 * 依據等級取得色彩與圖示
 */
function getLevelMeta(level: SlackMessageOptions["level"] = "info") {
  switch (level) {
    case "success":
      return { emoji: "✅", color: "#2eb886", name: "SUCCESS" };
    case "warn":
      return { emoji: "⚠️", color: "#daa038", name: "WARNING" };
    case "error":
      return { emoji: "🚨", color: "#a30200", name: "ERROR" };
    case "info":
    default:
      return { emoji: "ℹ️", color: "#3AA3E3", name: "INFO" };
  }
}

/**
 * 發送訊息至 Slack
 * 支援 Incoming Webhook 與 Slack Bot Token (chat.postMessage)
 */
export async function sendSlackMessage(options: SlackMessageOptions): Promise<SlackSendResult> {
  loadEnv();

  const webhookUrl = options.webhookUrl || process.env.SLACK_WEBHOOK_URL;
  const token = options.token || process.env.SLACK_BOT_TOKEN;
  const channel = options.channel || process.env.SLACK_DEFAULT_CHANNEL || process.env.SLACK_CHANNEL;

  const meta = getLevelMeta(options.level);
  const titleText = options.title ? `${meta.emoji} [${meta.name}] ${options.title}` : undefined;

  // 構造 Block Kit 結構
  const blocks: unknown[] = [];

  if (titleText) {
    blocks.push({
      type: "header",
      text: {
        type: "plain_text",
        text: titleText,
        emoji: true
      }
    });
  }

  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: options.text
    }
  });

  if (options.fields && Object.keys(options.fields).length > 0) {
    const fieldBlocks = Object.entries(options.fields).map(([k, v]) => ({
      type: "mrkdwn",
      text: `*${k}:*\n${v}`
    }));
    blocks.push({
      type: "section",
      fields: fieldBlocks
    });
  }

  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `*Timestamp:* ${new Date().toISOString()} | *System:* AI-SmartBook (AI-Quest-A1)`
      }
    ]
  });

  const payload: Record<string, unknown> = {
    text: titleText ? `${titleText}: ${options.text}` : options.text,
    blocks
  };

  // 1. 若有 Webhook URL，優先使用 Webhook
  if (webhookUrl) {
    try {
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const resText = await res.text();
      if (!res.ok) {
        return {
          success: false,
          mode: "webhook",
          error: `HTTP ${res.status}: ${resText}`
        };
      }
      return { success: true, mode: "webhook", response: resText };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, mode: "webhook", error: msg };
    }
  }

  // 2. 若無 Webhook，但有 Bot Token + Channel，使用 Slack Web API
  if (token) {
    if (!channel) {
      return {
        success: false,
        mode: "bot_token",
        error: "Missing channel: please provide options.channel or set SLACK_DEFAULT_CHANNEL / SLACK_CHANNEL"
      };
    }

    try {
      const res = await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          channel,
          ...payload
        })
      });

      const data = (await res.json()) as { ok: boolean; error?: string };
      if (!data.ok) {
        return {
          success: false,
          mode: "bot_token",
          error: data.error || "Failed to post message to Slack API"
        };
      }
      return { success: true, mode: "bot_token", response: data };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, mode: "bot_token", error: msg };
    }
  }

  return {
    success: false,
    mode: "webhook",
    error: "未設定 Slack 連線資訊！請在 .env 中設定 SLACK_WEBHOOK_URL 或 SLACK_BOT_TOKEN。"
  };
}

// CLI 執行模式
async function runCli() {
  loadEnv();
  const args = process.argv.slice(2);

  const isTest = args.includes("--test");
  const levelIdx = args.findIndex((a) => a === "--level");
  const level = (levelIdx !== -1 ? args[levelIdx + 1] : "info") as SlackMessageOptions["level"];

  const titleIdx = args.findIndex((a) => a === "--title");
  const title = titleIdx !== -1 ? args[titleIdx + 1] : (isTest ? "Slack 連線測試通知" : undefined);

  const channelIdx = args.findIndex((a) => a === "--channel");
  const channel = channelIdx !== -1 ? args[channelIdx + 1] : undefined;

  const msgIdx = args.findIndex((a) => a === "-m" || a === "--message");
  const message = msgIdx !== -1 ? args[msgIdx + 1] : (isTest ? "這是一則來自 AI-Quest-A1 系統的 Slack 連線測試訊息！🎉" : undefined);

  if (isTest || message) {
    console.log("🚀 正在發送 Slack 訊息...");
    const result = await sendSlackMessage({
      text: message || "連線測試",
      title,
      level: isTest ? "success" : level,
      channel,
      fields: isTest ? {
        "專案名稱": "AI_Quest_A1 (AI-SmartBook)",
        "測試時間": new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei" }),
        "測試模式": process.env.SLACK_WEBHOOK_URL ? "Incoming Webhook" : "Bot Token"
      } : undefined
    });

    if (result.success) {
      console.log(`✅ 發送成功！[模式: ${result.mode}]`);
      process.exit(0);
    } else {
      console.error(`❌ 發送失敗：${result.error}`);
      console.error("\n💡 設定提示：");
      console.error("1. Incoming Webhook 方式：在 .env 加入 SLACK_WEBHOOK_URL=https://hooks.slack.com/services/xxx/yyy/zzz");
      console.error("2. Bot Token 方式：在 .env 加入 SLACK_BOT_TOKEN=xoxb-... 與 SLACK_DEFAULT_CHANNEL=#general");
      process.exit(1);
    }
  } else {
    console.log(`
使用方式:
  tsx scripts/slack-notify.ts --test
  tsx scripts/slack-notify.ts --message "系統通知內容" [--title "標題"] [--level info|success|warn|error] [--channel "#channel"]

環境變數 (在 .env 設定):
  SLACK_WEBHOOK_URL      Slack Incoming Webhook URL (最推薦、最簡便)
  SLACK_BOT_TOKEN        Slack Bot User OAuth Token (xoxb-...)
  SLACK_DEFAULT_CHANNEL  預設推播頻道 (例如 #general 或 C0123456789)
    `);
  }
}

// 判斷是否為直接執行腳本
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  runCli().catch((err) => {
    console.error("執行發生未預期錯誤:", err);
    process.exit(1);
  });
}
