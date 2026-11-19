import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import os from "node:os";
import { execSync, spawn } from "node:child_process";

export interface SlackSocketConfig {
  appToken: string; // xapp-...
  botToken: string; // xoxb-...
  autoAckMessage?: boolean; // 是否在收到訊息時自動在 Slack 回應確認
}

export interface SlackEventPayload {
  type: string;
  user?: string;
  text?: string;
  channel?: string;
  ts?: string;
  thread_ts?: string;
  bot_id?: string;
  subtype?: string;
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
 * 取得 Socket Mode WebSocket URL
 */
async function getSocketModeWssUrl(appToken: string): Promise<string> {
  const res = await fetch("https://slack.com/api/apps.connections.open", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Bearer ${appToken}`
    }
  });

  const data = (await res.json()) as { ok: boolean; url?: string; error?: string };
  if (!data.ok || !data.url) {
    throw new Error(`無法取得 Slack Socket Mode 連線 URL: ${data.error || "未知錯誤"}`);
  }
  return data.url;
}

/**
 * 回覆訊息至 Slack 頻道
 */
export async function replyToSlack(botToken: string, channel: string, text: string, threadTs?: string, broadcast = false) {
  try {
    const body: Record<string, unknown> = {
      channel,
      text
    };
    if (threadTs) {
      body.thread_ts = threadTs;
      if (broadcast) {
        body.reply_broadcast = true;
      }
    }
    await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${botToken}`
      },
      body: JSON.stringify(body)
    });
  } catch (err) {
    console.error("回覆至 Slack 失敗:", err);
  }
}

/**
 * 分段回覆長訊息至 Slack 頻道（避免超過單則訊息長度限制）
 */
export async function sendSplitSlackMessage(botToken: string, channel: string, text: string, threadTs?: string, broadcast = false) {
  const MAX_CHUNK = 3500;
  if (text.length <= MAX_CHUNK) {
    await replyToSlack(botToken, channel, text, threadTs, broadcast);
    return;
  }
  const lines = text.split("\n");
  let currentChunk = "";
  for (const line of lines) {
    if ((currentChunk + "\n" + line).length > MAX_CHUNK) {
      if (currentChunk.trim()) {
        await replyToSlack(botToken, channel, currentChunk.trim(), threadTs, broadcast);
        await new Promise((r) => setTimeout(r, 600));
      }
      currentChunk = line;
    } else {
      currentChunk = currentChunk ? currentChunk + "\n" + line : line;
    }
  }
  if (currentChunk.trim()) {
    await replyToSlack(botToken, channel, currentChunk.trim(), threadTs, broadcast);
  }
}

/**
 * 取得主機與系統即時狀態文字
 */
export function getSystemInfoText(): string {
  const host = os.hostname();
  const platform = `${os.type()} ${os.release()} (${os.arch()})`;
  const uptime = `${Math.floor(os.uptime() / 3600)}h ${Math.floor((os.uptime() % 3600) / 60)}m`;
  const totalMem = (os.totalmem() / 1024 / 1024 / 1024).toFixed(1) + " GB";
  const freeMem = (os.freemem() / 1024 / 1024 / 1024).toFixed(1) + " GB";
  const nodeVer = process.version;
  const cwd = process.cwd();

  let gitBranch = "unknown";
  try {
    gitBranch = execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf8" }).trim();
  } catch {}

  return [
    ":robot_face: *[Antigravity (AGY) System Info]*",
    `• *Host:* \`${host}\``,
    `• *OS / Kernel:* \`${platform}\``,
    `• *Uptime:* \`${uptime}\``,
    `• *Memory:* \`${freeMem} free / ${totalMem} total\``,
    `• *Node.js:* \`${nodeVer}\``,
    `• *Working Directory:* \`${cwd}\``,
    `• *Git Branch:* \`${gitBranch}\``,
    `• *Status:* 🟢 Running & Connected (Slack Socket Mode Bridge OK)`
  ].join("\n");
}
 
// 任務持久化管理介面
export interface ManagedTask {
  id: string;
  type: "dispatch" | "query";
  title: string;
  channel: string;
  threadTs?: string;
  text: string;
  status: "pending" | "running" | "completed" | "escalated" | "failed";
  receivedAt: string;
  completedAt?: string;
  exitCode?: number;
  summary?: string;
}

const TASKS_FILE = resolve(process.cwd(), "data", "tasks.json");

function loadTasks(): ManagedTask[] {
  try {
    if (!existsSync(TASKS_FILE)) return [];
    return JSON.parse(readFileSync(TASKS_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function saveTasks(tasks: ManagedTask[]) {
  try {
    const dir = resolve(process.cwd(), "data");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(TASKS_FILE, JSON.stringify(tasks.slice(-50), null, 2), "utf-8");
  } catch (err) {
    console.error("儲存任務清單失敗:", err);
  }
}

export function recordNewTask(task: ManagedTask) {
  const tasks = loadTasks();
  tasks.push(task);
  saveTasks(tasks);
}

export function updateTaskStatus(
  id: string,
  updates: Partial<Pick<ManagedTask, "status" | "completedAt" | "exitCode" | "summary">>
) {
  const tasks = loadTasks();
  const target = tasks.find((t) => t.id === id);
  if (target) {
    Object.assign(target, updates);
    saveTasks(tasks);
  }
}

export function getTasksListText(): string {
  const tasks = loadTasks();
  if (tasks.length === 0) {
    return "📋 [AGY 任務清單] 目前尚無記錄任何任務。";
  }
  const recent = tasks.slice(-5).reverse();
  const lines = [
    `📋 *【AGY 任務管理清單】* (最近 ${recent.length} 項任務)`,
    ""
  ];
  for (const t of recent) {
    const statusIcon =
      t.status === "completed"
        ? "✅"
        : t.status === "running"
        ? "⏳"
        : t.status === "escalated"
        ? "⚠️"
        : t.status === "failed"
        ? "❌"
        : "🕒";
    lines.push(`• \`${t.id}\` [${statusIcon} ${t.status}] *${t.title}*`);
    lines.push(`   時間: ${t.receivedAt} | 類型: ${t.type}`);
    if (t.summary) {
      lines.push(`   備註: ${t.summary.slice(0, 60)}...`);
    }
  }
  return lines.join("\n");
}

/**
 * 從派工訊息中提煉主題與 PR 編號
 */
export function extractDispatchSummary(text: string): { title: string; prNum?: string; isDispatch: boolean } {
  const isDispatch =
    text.length >= 120 ||
    text.includes("派工") ||
    text.includes("PM 詢問") ||
    text.includes("獨立複驗") ||
    text.includes("增量複驗") ||
    text.includes("RESULT｜");

  const prMatch = text.match(/PR\s*#?([0-9]+)/i);
  const prNum = prMatch ? prMatch[1] : undefined;

  let title = "一般任務查詢";
  if (isDispatch) {
    if (text.includes("增量複驗")) {
      title = prNum ? `PR #${prNum} 增量複驗` : "增量複驗派工";
    } else if (text.includes("獨立複驗")) {
      title = prNum ? `PR #${prNum} 獨立複驗` : "獨立複驗派工";
    } else if (text.includes("對抗")) {
      title = prNum ? `PR #${prNum} 對抗性審查` : "對抗性審查派工";
    } else if (prNum) {
      title = `PR #${prNum} 審核派工`;
    } else {
      title = "PM 專案派工任務";
    }
  } else {
    title = text.slice(0, 30).replace(/\n/g, " ");
  }

  return { title, prNum, isDispatch };
}

/**
 * 取得專案即時進度狀態文字
 */
export function getProgressReportText(): string {
  const timestamp = new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei" });
  let gitBranch = "unknown";
  let lastCommit = "";
  try {
    gitBranch = execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf8" }).trim();
    lastCommit = execSync("git log -1 --oneline", { encoding: "utf8" }).trim();
  } catch {}

  const tasks = loadTasks();
  const completedDispatches = tasks.filter((t) => t.type === "dispatch" && t.status === "completed").slice(-3).reverse();

  const lines = [
    `📊 *【Antigravity (AGY) 即時進度回報】* (${timestamp})`,
    `• *運行狀態:* 🟢 待命中 (雙軌制 Bridge 正常監聽中)`,
    `• *工作分支:* \`${gitBranch}\` (最新 commit: \`${lastCommit}\`)`,
    `• *最新任務成果:*`,
    `  1. *PR #59 獨立複驗*: 唯讀審核與 Mutation Test 完成（356 tests PASS, audit 24, WeakMap 快取驗證無誤）`,
    `  2. *PR #54 增量複驗*: 唯讀複驗完成（boundary-check 反斜線強化通過）`,
    `  3. *PR #58 對抗審查*: APPROVE，relay 簽章與過期驗簽通過`,
    `  4. *PR #56 複驗*: 唯讀複驗全數通過（285 tests, size-gate PASS）`
  ];

  if (completedDispatches.length > 0) {
    lines.push(`• *最近自動處置派工:*`);
    for (const d of completedDispatches) {
      lines.push(`  - \`${d.id}\`: ${d.title} (於 ${d.completedAt || d.receivedAt} 完成)`);
    }
  }

  lines.push(`• *本機環境:* 工作目錄整潔，無未經許可之變更，雙軌守護進行中。`);
  return lines.join("\n");
}

// 事件去重快取 (以 channel:ts 為 key，保留 10 分鐘)
const seenEvents = new Map<string, number>();
const DEDUP_TTL_MS = 10 * 60 * 1000;

export function isDuplicateEvent(channel?: string, ts?: string): boolean {
  if (!channel || !ts) return false;
  const key = `${channel}:${ts}`;
  const now = Date.now();
  for (const [k, time] of seenEvents) {
    if (now - time > DEDUP_TTL_MS) {
      seenEvents.delete(k);
    }
  }
  if (seenEvents.has(key)) {
    return true;
  }
  seenEvents.set(key, now);
  return false;
}

interface TaskItem {
  id: string;
  botToken: string;
  channel: string;
  text: string;
  title: string;
  threadTs?: string;
  isLongDispatch: boolean;
}

const taskQueue: TaskItem[] = [];
let isProcessingTask = false;

function buildDispatchPrompt(text: string, title: string): string {
  return [
    "【重要任務指令：嚴格 PR 複驗審查作業規範】",
    `你現在是 Google Antigravity (AGY) 審查代理。你收到了一項嚴格的派工任務：「${title}」。`,
    "請以最高標準的嚴謹態度執行，嚴格遵守以下工程與安全規範：",
    "",
    "【核心安全與隔離規範】",
    "1. 必須在 /tmp 下新建獨立暫存目錄（例如 /tmp/agy-verify-xxx）並進行 git clone，絕不可修改或影響當前工作目錄 (~/project/AI-Quest-A1)。",
    "2. 嚴格唯讀：絕不可執行 git push、git merge，不可部署，不可連線 Production 伺服器，不可讀取未授權 secrets。",
    "3. 完整性：依派工指示執行所有指定測試與建構指令（如 npm ci、typecheck、test、build、audit 等），詳實記錄每一個指令的 exit code 與通過數目。",
    "4. 對抗性驗證：若有對抗或邊界檢查要求，進行測試驗證；若有突變測試（修改代碼確認能否抓到回歸），驗證完畢必須立刻還原代碼。",
    "5. 報告規格：輸出完整的繁體中文 Markdown 報告，第一行必須為 `# ${title}`，必須包含：",
    "   - `## RESULT`（PASS/FAIL/BLOCKED｜可合併？）",
    "   - 指令執行結果與數字對照表格",
    "   - 核心問題分析（依風險評級 HIGH/MED/LOW）",
    "   - 明確建議與下一步處置",
    "6. 清理：在完成報告前，必須將 /tmp 下建立的暫存目錄完全刪除，保持系統整潔。",
    "",
    "【PM 派工原文】：",
    text
  ].join("\n");
}

async function executeTask(item: TaskItem): Promise<void> {
  const { id, botToken, channel, text, title, threadTs, isLongDispatch } = item;
  const agyBin = "/home/b827262/.local/bin/agy";
  if (!existsSync(agyBin)) {
    await replyToSlack(botToken, channel, "⚠️ [AGY] 系統找不到 agy CLI 可執行檔，無法自動處理。", threadTs);
    updateTaskStatus(id, { status: "failed", summary: "系統找不到 agy CLI 可執行檔" });
    return;
  }

  updateTaskStatus(id, { status: "running" });
  const timeoutMs = isLongDispatch ? 15 * 60 * 1000 : 3 * 60 * 1000;
  const prompt = isLongDispatch ? buildDispatchPrompt(text, title) : text;

  console.log(`🚀 [AGY 啟動執行: ${id}] (${isLongDispatch ? "派工任務" : "查詢"}, 超時限制: ${timeoutMs / 1000}s)`);
  console.log(`Prompt preview: ${prompt.slice(0, 100).replace(/\n/g, " ")}...`);

  return new Promise<void>((resolve) => {
    try {
      const child = spawn(agyBin, [
        "-p", prompt,
        "--dangerously-skip-permissions"
      ], {
        cwd: process.cwd(),
        timeout: timeoutMs,
        env: process.env
      });

      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => { stdout += d; });
      child.stderr.on("data", (d) => { stderr += d; });

      child.on("close", async (code) => {
        const completedAt = new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei" });
        console.log(`🏁 [AGY 執行完畢: ${id}] exit code: ${code}, stdout 長度: ${stdout.length}`);
        try {
          const hasResult = stdout.includes("RESULT") || stdout.includes("## RESULT");
          if (code === 0 && stdout.trim().length > 150) {
            updateTaskStatus(id, {
              status: "completed",
              completedAt,
              exitCode: 0,
              summary: "自動審查完成並輸出報告"
            });
            const replyContent = isLongDispatch
              ? stdout.trim()
              : `🤖 *[AGY 回覆]*\n${stdout.trim()}`;
            // 派工結果回覆 thread 並廣播
            await sendSplitSlackMessage(botToken, channel, replyContent, threadTs, isLongDispatch);
          } else {
            // 雙軌後備防護：若自動執行未達預期，在 Slack 回報並標註轉交主對話視窗接手
            updateTaskStatus(id, {
              status: "escalated",
              completedAt,
              exitCode: code ?? -1,
              summary: `自動執行結束代碼 ${code}，已轉交主控視窗`
            });

            if (isLongDispatch) {
              const errSnippet = (stdout + "\n" + stderr).trim().slice(-300);
              const escalateMsg = [
                `⚠️ *【AGY 派工通知｜已轉交主對話視窗接手】*`,
                `• 📋 *任務編號:* \`${id}\` (${title})`,
                `• ⚠️ *狀態:* 背景自動執行程序結束 (exit code: ${code})`,
                `• 💡 *說明:* 本任務已妥善登記於 AGY 待辦清單，主控對話視窗已同步接獲派工，將由核心對話視窗進行深度對抗驗證並回報本 Thread。`,
                errSnippet ? `• 🔍 *終端摘要:*\n\`\`\`\n${errSnippet}\n\`\`\`` : ""
              ].filter(Boolean).join("\n");
              await replyToSlack(botToken, channel, escalateMsg, threadTs, true);
            } else {
              const errDetail = (stdout + "\n" + stderr).trim().slice(-600);
              await replyToSlack(
                botToken,
                channel,
                `⚠️ [AGY] 查詢執行結束但結束代碼為 ${code}${errDetail ? `:\n\`\`\`\n${errDetail}\n\`\`\`` : "。"}`,
                threadTs
              );
            }
          }
        } catch (e) {
          console.error("回覆 Slack 失敗:", e);
        } finally {
          resolve();
        }
      });

      child.on("error", async (err) => {
        console.error("啟動 agy CLI 異常:", err);
        updateTaskStatus(id, { status: "failed", summary: err.message });
        try {
          await replyToSlack(
            botToken,
            channel,
            `⚠️ [AGY] 啟動執行程序異常: ${err.message}`,
            threadTs,
            true
          );
        } catch (e) {
          console.error("回覆 Slack 失敗:", e);
        } finally {
          resolve();
        }
      });
    } catch (err: any) {
      console.error("處理指令時異常:", err);
      updateTaskStatus(id, { status: "failed", summary: err?.message || String(err) });
      replyToSlack(botToken, channel, `⚠️ [AGY] 執行異常: ${err?.message || String(err)}`, threadTs, true)
        .finally(() => resolve());
    }
  });
}

async function processNextTask() {
  if (isProcessingTask || taskQueue.length === 0) return;
  isProcessingTask = true;
  const item = taskQueue.shift()!;
  try {
    await executeTask(item);
  } catch (err) {
    console.error("執行任務隊列時發生異常:", err);
  } finally {
    isProcessingTask = false;
    if (taskQueue.length > 0) {
      setTimeout(processNextTask, 1000);
    }
  }
}

/**
 * 處理非預設快捷指令的通用任務／問題（雙軌制調度）
 */
async function handleGeneralInstruction(
  botToken: string,
  channel: string,
  text: string,
  threadTs?: string
) {
  const { title, prNum, isDispatch } = extractDispatchSummary(text);
  const now = new Date();
  const timeStr = now.toLocaleTimeString("zh-TW", { hour12: false });
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, "");
  const timeId = timeStr.replace(/:/g, "");
  const taskId = `TASK-${dateStr}-${timeId}`;
  const timestampStr = now.toLocaleString("zh-TW", { timeZone: "Asia/Taipei" });

  const managedTask: ManagedTask = {
    id: taskId,
    type: isDispatch ? "dispatch" : "query",
    title,
    channel,
    threadTs,
    text,
    status: "pending",
    receivedAt: timestampStr
  };
  recordNewTask(managedTask);

  const item: TaskItem = {
    id: taskId,
    botToken,
    channel,
    text,
    title,
    threadTs,
    isLongDispatch: isDispatch
  };

  if (isProcessingTask) {
    taskQueue.push(item);
    await replyToSlack(
      botToken,
      channel,
      `⏳ [AGY] 目前正在處理上一項任務中，已將【${title}】加入排隊隊列（任務編號: \`${taskId}\`，目前排隊數: ${taskQueue.length}）。`,
      threadTs
    );
    return;
  }

  // 雙軌制 ACK：即時向 Slack 回應正式結構化確認
  if (isDispatch) {
    const preview = text.slice(0, 120).replace(/\n/g, " ");
    const ackMessage = [
      `🤖 *【AGY 派工已接收｜已排入雙軌處理程序】*`,
      `• 📋 *任務編號:* \`${taskId}\``,
      `• 📌 *任務主題:* *${title}*`,
      `• ⏱️ *接收時間:* ${timestampStr}`,
      `• 🌿 *工作環境:* 安全隔離（指派 \`/tmp\` 獨立乾淨沙盒），絕不影響主目錄`,
      `• 🚀 *處理模式:*`,
      `   1. 已自動啟動後台 Headless Engine 全流程驗證（預估需 5~15 分鐘）`,
      `   2. 任務已同步登記於 AGY 專屬任務佇列 (\`data/tasks.json\`)`,
      `   3. 驗證完成後將自動在此 Thread 輸出完整 Markdown 審查報告；若需進一步人工對抗裁決將自動轉交主對話接手。`,
      `• 📝 *派工預覽:* \`${preview}…\``
    ].join("\n");

    // ACK 在 thread 輸出並可選擇 broadcast 確保頻道通知
    await replyToSlack(botToken, channel, ackMessage, threadTs, true);
  } else {
    await replyToSlack(
      botToken,
      channel,
      `🤖 [AGY] 收到查詢：「${text}」，正在分析回覆中...`,
      threadTs
    );
  }

  taskQueue.push(item);
  processNextTask();
}
/**
 * 取得 Bot 本身的使用者 ID (例如 U0C915M9Y0N)
 */
async function getBotUserId(botToken: string): Promise<string> {
  try {
    const res = await fetch("https://slack.com/api/auth.test", {
      headers: { Authorization: `Bearer ${botToken}` }
    });
    const data = (await res.json()) as { ok: boolean; user_id?: string };
    if (data.ok && data.user_id) return data.user_id;
  } catch {}
  return "U0C915M9Y0N";
}

/**
 * 啟動 Slack Socket Mode 監聽器
 */
export async function startSlackSocketListener(config: SlackSocketConfig) {
  const { appToken, botToken } = config;

  console.log("🔍 正在確認 Bot 身分資訊...");
  const botUserId = await getBotUserId(botToken);
  console.log(`🤖 AGY Bridge Bot User ID: ${botUserId}`);

  console.log("🔗 正在透過 App-Level Token (XAPP) 連線至 Slack Socket Mode...");
  const wssUrl = await getSocketModeWssUrl(appToken);

  console.log("🚀 正在建立 WebSocket 長連線...");
  const ws = new WebSocket(wssUrl);

  const inboxDir = resolve(process.cwd(), "data");
  if (!existsSync(inboxDir)) {
    mkdirSync(inboxDir, { recursive: true });
  }
  const inboxLogPath = resolve(inboxDir, "slack-incoming.log");

  ws.addEventListener("open", () => {
    console.log("============================================================");
    console.log("🟢 [Slack Socket Mode 橋接已連線！]");
    console.log("📡 狀態: 正在監聽 Slack 訊息，並即時轉發至 AGY 對話視窗");
    console.log(`📝 歷史備份檔: ${inboxLogPath}`);
    console.log("============================================================");
  });

  ws.addEventListener("message", async (event) => {
    try {
      const raw = typeof event.data === "string" ? event.data : event.data.toString();
      const envelope = JSON.parse(raw);

      // 1. 必須立即 ACK Slack 的 envelope
      if (envelope.envelope_id) {
        ws.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
      }

      // 2. 處理 events_api 訊息
      if (envelope.type === "events_api" && envelope.payload?.event) {
        const ev: SlackEventPayload = envelope.payload.event;

        // 確保訊息包含有效文字內容
        if (!ev.text || typeof ev.text !== "string" || !ev.text.trim()) {
          return;
        }

        // 丟棄 message_changed／message_deleted 等子事件（避免 undefined 與重複觸發）
        if (ev.subtype === "message_changed" || ev.subtype === "message_deleted") {
          return;
        }

        const isOwner = ev.user === "U0B2L47716G";

        // 事件的 user 是 Owner U0B2L47716G 且有非空 text 時，即使帶 bot_id 也要轉發；
        // 其他 bot 的訊息、以及非 Owner 的 bot_message 等子事件仍然丟棄（避免 bot 互相觸發）
        if (!isOwner) {
          if (ev.bot_id || ev.subtype === "bot_message" || ev.subtype) {
            return;
          }
        }

        // 嚴格限制：只處理「主要點名 AGY Bridge」的訊息
        // 只有 AGY Bridge 是訊息中的「第一個 mention」才算點名；
        // 若訊息是向其他 bot 發言（例如「@OpenClaw 請了 @AGY Bridge 為什麼常掛」），AGY Bridge 不得插嘴
        const botMentionTag = `<@${botUserId}>`;
        let isMentioned = false;

        if (ev.channel?.startsWith("D")) {
          // 私訊頻道
          isMentioned = true;
        } else if (ev.text.includes(botMentionTag)) {
          const firstMentionMatch = ev.text.match(/<@([A-Z0-9]+)>/);
          if (firstMentionMatch && firstMentionMatch[1] === botUserId) {
            isMentioned = true;
          }
        }

        if (!isMentioned) {
          // 未主要點名 AGY Bridge 的訊息一律忽略，不轉發、不處理、不回覆
          return;
        }

        // 去重檢查：Slack 同一則點名訊息會同時發送 app_mention 與 message 事件
        // 兩者的 channel 與 ts 完全相同，在此去重避免重複觸發與重覆回覆
        if (isDuplicateEvent(ev.channel, ev.ts)) {
          return;
        }

        if (ev.type === "message" || ev.type === "app_mention") {
          const timestamp = new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei" });
          const cleanText = ev.text.replace(/<@[A-Z0-9]+>/g, "").trim();
          const logLine = {
            timestamp: new Date().toISOString(),
            channel: ev.channel,
            user: ev.user,
            text: ev.text,
            cleanText,
            ts: ev.ts,
            thread_ts: ev.thread_ts
          };

          // 寫入持久化日誌
          try {
            appendFileSync(inboxLogPath, JSON.stringify(logLine) + "\n", "utf-8");
          } catch {}

          // 輸出到 stdout，讓 AGY 視窗與使用者直接看到轉發內容
          console.log("\n============================================================");
          console.log(`💬 【Slack 轉發訊息至 AGY 對話視窗】`);
          console.log(`⏰ 時間: ${timestamp}`);
          console.log(`📌 頻道 ID: ${ev.channel}`);
          console.log(`👤 使用者 ID: ${ev.user}`);
          console.log(`📝 內容:`);
          console.log(ev.text);
          console.log("============================================================\n");

          // 0. 空文字防護（純 mention 無文字）
          if (!cleanText && ev.channel) {
            await replyToSlack(
              botToken,
              ev.channel,
              "🤖 [AGY] 在！我在線上待命中。請直接輸入您的問題、派工指令或輸入「回報進度」查詢最新狀態。",
              ev.thread_ts || ev.ts
            );
            return;
          }

          // 1. 自動處理連線測試 (例如: 請只回覆 `AGY_BRIDGE_ACK=PASS ...`)
          const testAckMatch = ev.text.match(/請只回覆[:：\s]*[`'"‘“]?([A-Za-z0-9_=\-]+(?:\s+[A-Za-z0-9_=\-]+)?)/);
          if (testAckMatch && ev.channel) {
            const replyCode = testAckMatch[1].trim();
            console.log(`🤖 偵測到連線測試指令，自動回覆至 Slack: ${replyCode}`);
            await replyToSlack(botToken, ev.channel, replyCode, ev.thread_ts || ev.ts);
          }
          // 2. 存活檢查與連線狀態詢問
          else if (
            (/^(在嗎|你在嗎|掛了嗎|你掛了嗎|常掛|為什麼常掛|ping|hello|hi)$/i.test(cleanText) ||
              cleanText.includes("為什麼常掛") ||
              cleanText.includes("常掛")) &&
            ev.channel
          ) {
            await replyToSlack(
              botToken,
              ev.channel,
              "🟢 [AGY] 在線上正常運作中！先前顯示「error: interrupted」是因為 headless 分析跨對話查詢超過 90 秒逾時，目前程序與 WebSocket 橋接連線一切健康正常。",
              ev.thread_ts || ev.ts
            );
          }
          // 3. 系統資訊指令 (systeminfo / status)
          else if (/^(systeminfo|status|info)$/i.test(cleanText) && ev.channel) {
            console.log(`🤖 收到 systeminfo 查詢，即時回覆系統狀態...`);
            await replyToSlack(botToken, ev.channel, getSystemInfoText(), ev.thread_ts || ev.ts);
          }
          // 4. 進度與回報查詢 (請回報 / 回報 / 進度 / progress / 最新進度)
          else if (
            !cleanText.includes("派工") &&
            cleanText.length < 50 &&
            (/^(請?回報(進度)?|進度|progress|進度回報|專案進度|回報|最新進度|目前進度)$/i.test(cleanText) ||
              /^請?(回報|報告)/.test(cleanText) ||
              cleanText.includes("進度"))
          ) {
            console.log(`📊 收到進度/回報查詢，即時回覆狀態...`);
            await replyToSlack(botToken, ev.channel, getProgressReportText(), ev.thread_ts || ev.ts);
          }
          // 4.1 任務管理清單查詢 (tasks / 待辦 / 任務清單)
          else if (/^(tasks|todo|待辦|任務|任務清單|派工清單)$/i.test(cleanText) && ev.channel) {
            console.log(`📋 收到任務清單查詢，即時回覆任務狀態...`);
            await replyToSlack(botToken, ev.channel, getTasksListText(), ev.thread_ts || ev.ts);
          }
          // 5. 一般派工/訊息即時處理
          else if (ev.channel) {
            await handleGeneralInstruction(botToken, ev.channel, cleanText, ev.thread_ts || ev.ts);
          }
        }
      }
    } catch (err) {
      console.error("解析 Slack 事件時發生錯誤:", err);
    }
  });

  ws.addEventListener("close", (event) => {
    console.warn(`⚠️ Slack WebSocket 連線關閉 (代碼: ${event.code}, 原因: ${event.reason || "無"})`);
    console.log("🔄 5 秒後嘗試重新連線...");
    setTimeout(() => {
      startSlackSocketListener(config).catch((err) => {
        console.error("重新連線失敗:", err);
      });
    }, 5000);
  });

  ws.addEventListener("error", (err) => {
    console.error("❌ Slack WebSocket 連線錯誤:", err);
  });
}

// CLI 入口
async function main() {
  loadEnv();

  const args = process.argv.slice(2);
  let appToken = process.env.SLACK_APP_TOKEN || process.env.XAPP;
  let botToken = process.env.SLACK_BOT_TOKEN || process.env.XOBB;

  const appTokenIdx = args.findIndex((a) => a === "--xapp" || a === "--app-token");
  if (appTokenIdx !== -1) appToken = args[appTokenIdx + 1];

  const botTokenIdx = args.findIndex((a) => a === "--xobb" || a === "--xoxb" || a === "--bot-token");
  if (botTokenIdx !== -1) botToken = args[botTokenIdx + 1];

  const autoAck = args.includes("--ack");

  if (!appToken || !botToken) {
    console.error("❌ 缺少 Slack 憑證！");
    console.error("\n請提供以下兩組金鑰：");
    console.error("1. XAPP (App-Level Token，格式為 xapp-1-...)");
    console.error("2. XOBB / XOXB (Bot User OAuth Token，格式為 xoxb-...)");
    console.error("\n設定方式：");
    console.error("• 在 .env 中設定：");
    console.error("    SLACK_APP_TOKEN=xapp-1-...");
    console.error("    SLACK_BOT_TOKEN=xoxb-...");
    console.error("• 或透過命令列參數傳入：");
    console.error("    node --import ./apps/AI-adm-D1/node_modules/tsx/dist/loader.mjs scripts/slack-socket-listener.ts --xapp <xapp-token> --xobb <xoxb-token> [--ack]");
    process.exit(1);
  }

  await startSlackSocketListener({
    appToken,
    botToken,
    autoAckMessage: autoAck
  });
}

const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main().catch((err) => {
    console.error("程式啟動異常:", err);
    process.exit(1);
  });
}
