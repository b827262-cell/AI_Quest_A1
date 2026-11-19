import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnv, sendSplitSlackMessage, replyToSlack, ManagedTask } from "./slack-socket-listener.js";

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
  writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2), "utf-8");
}

async function main() {
  loadEnv();
  const botToken = process.env.SLACK_BOT_TOKEN;
  if (!botToken) {
    console.error("❌ 找不到 SLACK_BOT_TOKEN，請檢查 .env");
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const command = args[0] || "list";

  if (command === "list") {
    const tasks = loadTasks();
    if (tasks.length === 0) {
      console.log("目前無任務記錄。");
      return;
    }
    console.log(`\n📋 【AGY 任務管理清單】(共 ${tasks.length} 筆)`);
    console.log("------------------------------------------------------------");
    for (const t of tasks.slice(-15).reverse()) {
      console.log(`• ID: [${t.id}] | 狀態: [${t.status.toUpperCase()}] | 標題: ${t.title}`);
      console.log(`  接收時間: ${t.receivedAt} | 頻道: ${t.channel} | Thread: ${t.threadTs || "無"}`);
      if (t.summary) console.log(`  摘要/備註: ${t.summary}`);
      console.log("------------------------------------------------------------");
    }
  } else if (command === "show") {
    const taskId = args[1];
    if (!taskId) {
      console.error("用法: npx tsx scripts/slack-tasks.ts show <taskId>");
      process.exit(1);
    }
    const tasks = loadTasks();
    const task = tasks.find((t) => t.id === taskId);
    if (!task) {
      console.error(`❌ 找不到任務 ID: ${taskId}`);
      process.exit(1);
    }
    console.log(`\n📌 任務 [${task.id}] 資訊：`);
    console.log(`標題: ${task.title}`);
    console.log(`狀態: ${task.status}`);
    console.log(`頻道: ${task.channel}`);
    console.log(`ThreadTs: ${task.threadTs || "無"}`);
    console.log(`接收時間: ${task.receivedAt}`);
    console.log(`\n--- 原始派工全文 ---\n${task.text}\n--------------------`);
  } else if (command === "reply") {
    const taskId = args[1];
    let content = args.slice(2).join(" ");
    if (!taskId) {
      console.error("用法: npx tsx scripts/slack-tasks.ts reply <taskId> <報告內容或檔案路徑>");
      process.exit(1);
    }
    const tasks = loadTasks();
    const task = tasks.find((t) => t.id === taskId);
    if (!task) {
      console.error(`❌ 找不到任務 ID: ${taskId}`);
      process.exit(1);
    }

    if (existsSync(content)) {
      content = readFileSync(content, "utf-8");
    }

    if (!content.trim()) {
      console.error("❌ 回覆內容不可為空！");
      process.exit(1);
    }

    console.log(`🚀 正在將報告回覆至 Slack (頻道: ${task.channel}, Thread: ${task.threadTs})...`);
    await sendSplitSlackMessage(botToken, task.channel, content.trim(), task.threadTs, true);

    const completedAt = new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei" });
    task.status = "completed";
    task.completedAt = completedAt;
    task.summary = "已由人工/主控視窗回報審查結果";
    saveTasks(tasks);

    console.log(`✅ 任務 [${taskId}] 已成功回覆並標記為 completed！`);
  } else {
    console.log("可用指令:");
    console.log("  npx tsx scripts/slack-tasks.ts list               # 查看最近任務清單");
    console.log("  npx tsx scripts/slack-tasks.ts show <taskId>      # 顯示指定任務全文");
    console.log("  npx tsx scripts/slack-tasks.ts reply <taskId> <內容/檔名> # 回覆結果至 Slack Thread");
  }
}

main().catch((err) => {
  console.error("執行異常:", err);
  process.exit(1);
});
