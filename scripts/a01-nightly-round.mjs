#!/usr/bin/env node

import { readFileSync, mkdirSync, writeFileSync, unlinkSync, openSync, closeSync, lstatSync, statSync, renameSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

const DEFAULT_TIME_ZONE = "Asia/Taipei";
const START_MINUTE = 23 * 60 + 50;
const END_MINUTE = 9 * 60;
const LAST_SLOT_OFFSET = 8 * 60 + 50 - START_MINUTE + 24 * 60;
const LOCK_STALE_MS = 10 * 60 * 1000;
const SLACK_ENV_KEYS = new Set([
  "SLACK_BOT_TOKEN",
  "A01_NIGHTLY_CHANNEL_ID",
  "A01_NIGHTLY_AGENT_MENTIONS",
]);

function loadSlackEnvFile(path) {
  const info = lstatSync(path);
  if (!info.isFile() || (info.mode & 0o077) !== 0) {
    throw new Error("Slack environment file must be a regular file with owner-only permissions");
  }
  const values = {};
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match || !SLACK_ENV_KEYS.has(match[1])) {
      throw new Error("Slack environment file contains an invalid or unsupported entry");
    }

    let value = match[2].trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "");
    }

    values[match[1]] = value;
  }
  return values;
}

function parseArgs(argv) {
  const options = {
    execute: false,
    help: false,
    now: undefined,
    channel: undefined,
    mentions: undefined,
    focus: undefined,
    timeZone: undefined,
    repo: undefined,
    envFile: undefined,
    windowDate: undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--execute") options.execute = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--now") options.now = argv[++index];
    else if (arg.startsWith("--now=")) options.now = arg.slice("--now=".length);
    else if (arg === "--channel") options.channel = argv[++index];
    else if (arg.startsWith("--channel=")) options.channel = arg.slice("--channel=".length);
    else if (arg === "--mentions") options.mentions = argv[++index];
    else if (arg.startsWith("--mentions=")) options.mentions = arg.slice("--mentions=".length);
    else if (arg === "--focus") options.focus = argv[++index];
    else if (arg.startsWith("--focus=")) options.focus = arg.slice("--focus=".length);
    else if (arg === "--timezone") options.timeZone = argv[++index];
    else if (arg.startsWith("--timezone=")) options.timeZone = arg.slice("--timezone=".length);
    else if (arg === "--repo") options.repo = argv[++index];
    else if (arg.startsWith("--repo=")) options.repo = arg.slice("--repo=".length);
    else if (arg === "--env-file") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error("--env-file requires a path");
      options.envFile = value;
    }
    else if (arg.startsWith("--env-file=")) options.envFile = arg.slice("--env-file=".length);
    else if (arg === "--window-date") options.windowDate = argv[++index];
    else if (arg.startsWith("--window-date=")) options.windowDate = arg.slice("--window-date=".length);
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function usage() {
  return [
    "A-01 Slack overnight PM round",
    "",
    "Usage:",
    "  node scripts/a01-nightly-round.mjs                 # dry-run",
    "  node scripts/a01-nightly-round.mjs --execute --window-date YYYY-MM-DD --env-file /secure/slack-only.env",
    "",
    "Required for --execute: A01_NIGHTLY_WINDOW_DATE (or --window-date), SLACK_BOT_TOKEN, A01_NIGHTLY_CHANNEL_ID, and A01_NIGHTLY_AGENT_MENTIONS",
    "Use --env-file or A01_NIGHTLY_ENV_FILE for a dedicated owner-only Slack file; repo .env is never loaded.",
    "Optional: A01_NIGHTLY_AGENT_MENTIONS, A01_NIGHTLY_FOCUS, A01_NIGHTLY_TIMEZONE, A01_NIGHTLY_REPO",
    "",
    "The normal window is 23:50, 00:20, ..., 08:50 in the configured timezone.",
    "09:00 is the end boundary and is not a send time.",
  ].join("\n");
}

function getTimeZoneParts(date, timeZone = DEFAULT_TIME_ZONE) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const values = Object.fromEntries(
    formatter.formatToParts(date).map(({ type, value }) => [type, value]),
  );

  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
    date: `${values.year}-${values.month}-${values.day}`,
    label: `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}`,
  };
}

function nightlyOffset(parts) {
  const minute = parts.hour * 60 + parts.minute;
  if (minute >= START_MINUTE) return minute - START_MINUTE;
  if (minute < END_MINUTE) return minute + (24 * 60 - START_MINUTE);
  return null;
}

function getNightlySlot(parts) {
  const offset = nightlyOffset(parts);
  if (offset === null || offset < 0 || offset > LAST_SLOT_OFFSET || offset % 30 !== 0) {
    return null;
  }

  return {
    offset,
    key: `${parts.date}T${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`,
    label: parts.label,
  };
}

function getWindowDate(parts) {
  if (parts.hour >= 23) return parts.date;
  const midnight = Date.parse(parts.date + "T00:00:00Z");
  return new Date(midnight - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function isValidWindowDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(value + "T00:00:00Z");
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function nextSlotLabel(date, timeZone, slot) {
  if (!slot || slot.offset >= LAST_SLOT_OFFSET) return "09:00（窗口結束）";
  return getTimeZoneParts(new Date(date.getTime() + 30 * 60 * 1000), timeZone).label;
}

function readGitState(repo) {
  let head = "unknown";
  let branch = "unknown";
  let remoteMain = "unavailable";
  try {
    head = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    branch = execFileSync("git", ["-C", repo, "branch", "--show-current"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || "detached";
  } catch {
    // The repo path may not be a Git checkout.
  }
  try {
    const line = execFileSync("git", ["-C", repo, "ls-remote", "origin", "refs/heads/main"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    }).trim();
    const match = line.match(/^([0-9a-f]{40})\s+refs\/heads\/main$/);
    if (match) remoteMain = match[1];
  } catch {
    // Keep the local checkout visible even when GitHub is unavailable.
  }
  return { head, branch, remoteMain };
}

function createRoundMessage({ parts, next, mentions, focus = "main／開啟中的 PR", git, windowDate }) {
  const prefix = mentions?.trim() ? `${mentions.trim()} ` : "";
  return [
    `【A-01 夜間 PM 輪值｜${parts.label}】`,
    `單次窗口：${windowDate || getWindowDate(parts)} 23:50–次日 09:00（08:50 最後一輪）。`,
    `${prefix}請回報目前專案狀態（最多 5 行，附實際 head SHA）：${focus}、staging、ingress 證據、blocker 與下一步。`,
    "安全邊界：不 merge、不 push、不部署 production、不讀 secret、不跑 migration 0003；staging 只有 Owner 明確授權且具備權限才可操作。",
    `本機 HEAD：${git.branch} @ ${git.head}；遠端 main：${git.remoteMain || "unavailable"}；下一輪：${next}。`,
  ].join("\n");
}

function acquireLock(lockPath, nowMs = Date.now()) {
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  const token = randomUUID();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      try {
        writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date(nowMs).toISOString(), token }) + "\n");
      } finally {
        closeSync(fd);
      }
      return () => {
        try {
          if (JSON.parse(readFileSync(lockPath, "utf8")).token === token) unlinkSync(lockPath);
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let info;
      try {
        info = statSync(lockPath);
      } catch (statError) {
        if (statError?.code === "ENOENT") continue;
        throw statError;
      }
      let startedAt = info.mtimeMs;
      try {
        const recorded = Date.parse(JSON.parse(readFileSync(lockPath, "utf8")).startedAt);
        if (Number.isFinite(recorded)) startedAt = recorded;
      } catch {
        // A partial lock still has a filesystem modification time.
      }
      if (nowMs - startedAt <= LOCK_STALE_MS) return null;
      try {
        if (statSync(lockPath).ino === info.ino) unlinkSync(lockPath);
      } catch (removeError) {
        if (removeError?.code !== "ENOENT") throw removeError;
      }
    }
  }
  return null;
}

function readSlotState(statePath) {
  try {
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    if (!state || typeof state !== "object" || !state.slots || typeof state.slots !== "object") {
      throw new Error("Invalid nightly slot state");
    }
    return state;
  } catch (error) {
    if (error?.code === "ENOENT") return { slots: {} };
    throw error;
  }
}

function writeSlotState(statePath, state) {
  mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
  const temporaryPath = statePath + "." + process.pid + "." + randomUUID() + ".tmp";
  try {
    writeFileSync(temporaryPath, JSON.stringify(state, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    renameSync(temporaryPath, statePath);
  } catch (error) {
    try { unlinkSync(temporaryPath); } catch { /* No temporary file to remove. */ }
    throw error;
  }
}

function claimSlot(statePath, key, nowMs = Date.now()) {
  const state = readSlotState(statePath);
  if (Object.hasOwn(state.slots, key)) return false;
  state.slots[key] = { status: "claimed", at: new Date(nowMs).toISOString() };
  writeSlotState(statePath, state);
  return true;
}

function finishSlot(statePath, key, status, slackTs) {
  const state = readSlotState(statePath);
  if (!state.slots[key]) throw new Error("Nightly slot was not claimed");
  state.slots[key] = { ...state.slots[key], status, ...(slackTs ? { slackTs } : {}) };
  writeSlotState(statePath, state);
}

async function postToSlack({ token, channel, text, fetchImpl, timeoutMs = 15_000 }) {
  const response = await fetchImpl("https://slack.com/api/chat.postMessage", {
    method: "POST",
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      channel,
      text,
      unfurl_links: false,
      unfurl_media: false,
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.ok) {
    const code = typeof payload.error === "string" && /^[a-z_]{1,64}$/.test(payload.error)
      ? payload.error
      : `HTTP ${response.status}`;
    throw new Error(`Slack chat.postMessage failed: ${code}`);
  }

  return payload;
}

export { acquireLock, claimSlot, createRoundMessage, getNightlySlot, getTimeZoneParts, getWindowDate, loadSlackEnvFile, nextSlotLabel, nightlyOffset, parseArgs, readSlotState };

async function main({ argv = process.argv.slice(2), env = process.env, fetchImpl = fetch, output = console.log, nowDate = new Date(), nowMs = Date.now(), slackTimeoutMs = 15_000 } = {}) {
  const options = parseArgs(argv);
  if (options.help) {
    output(usage());
    return;
  }

  if (options.execute && (options.now || env.A01_NIGHTLY_NOW)) {
    throw new Error("--now and A01_NIGHTLY_NOW are dry-run only");
  }
  const windowDate = options.windowDate || env.A01_NIGHTLY_WINDOW_DATE;
  if (windowDate && !isValidWindowDate(windowDate)) throw new Error("Invalid A01_NIGHTLY_WINDOW_DATE");
  if (options.execute && !windowDate) throw new Error("A01_NIGHTLY_WINDOW_DATE is required for --execute");
  const timeZone = options.timeZone || env.A01_NIGHTLY_TIMEZONE || DEFAULT_TIME_ZONE;
  if (options.execute && timeZone !== DEFAULT_TIME_ZONE) {
    throw new Error("--execute requires Asia/Taipei time zone");
  }
  const now = options.now
    ? new Date(options.now)
    : env.A01_NIGHTLY_NOW
      ? new Date(env.A01_NIGHTLY_NOW)
      : nowDate;
  if (Number.isNaN(now.getTime())) throw new Error("Invalid --now or A01_NIGHTLY_NOW value");

  const parts = getTimeZoneParts(now, timeZone);
  const slot = getNightlySlot(parts);
  if (!slot) {
    output(`SKIP ${parts.label} (${timeZone}): outside the 23:50–09:00 schedule.`);
    return;
  }
  if (windowDate && getWindowDate(parts) !== windowDate) {
    output(`SKIP ${parts.label}: outside the configured one-time window ${windowDate}.`);
    return;
  }

  const envFile = options.envFile || env.A01_NIGHTLY_ENV_FILE;
  const runtimeEnv = options.execute && envFile
    ? { ...env, ...loadSlackEnvFile(resolve(envFile)) }
    : env;
  const repo = resolve(options.repo || runtimeEnv.A01_NIGHTLY_REPO || process.cwd());
  const git = readGitState(repo);
  const next = nextSlotLabel(now, timeZone, slot);
  const mentions = options.mentions || runtimeEnv.A01_NIGHTLY_AGENT_MENTIONS;
  if (options.execute && (typeof mentions !== "string" || !/^<@[A-Z0-9]+>(?:\s+<@[A-Z0-9]+>)*$/.test(mentions.trim()))) {
    throw new Error("A01_NIGHTLY_AGENT_MENTIONS must contain explicit Slack user mentions");
  }
  const message = createRoundMessage({
    parts,
    next,
    mentions,
    focus: options.focus || runtimeEnv.A01_NIGHTLY_FOCUS || "main／開啟中的 PR",
    git,
    windowDate,
  });

  if (!options.execute) {
    output(message);
    output("DRY_RUN: nothing was sent to Slack. Use --execute to post.");
    return;
  }

  const token = runtimeEnv.SLACK_BOT_TOKEN;
  const channel = options.channel || runtimeEnv.A01_NIGHTLY_CHANNEL_ID;
  if (!token) throw new Error("SLACK_BOT_TOKEN is required for --execute");
  if (!channel) throw new Error("A01_NIGHTLY_CHANNEL_ID is required for --execute");

  const stateDir = resolve(runtimeEnv.A01_NIGHTLY_STATE_DIR || join(homedir(), ".local", "state", "a01-nightly-round"));
  const lockPath = resolve(runtimeEnv.A01_NIGHTLY_LOCK_FILE || join(stateDir, "run.lock"));
  const statePath = resolve(runtimeEnv.A01_NIGHTLY_STATE_FILE || join(stateDir, "slots.json"));
  const releaseLock = acquireLock(lockPath, nowMs);
  if (!releaseLock) {
    output("SKIP: another A-01 nightly round is already running.");
    return;
  }

  try {
    const slotKey = slot.key;
    if (!claimSlot(statePath, slotKey, nowMs)) {
      output(`SKIP: slot ${slotKey} was already attempted.`);
      return;
    }
    try {
      const result = await postToSlack({ token, channel, text: message, fetchImpl, timeoutMs: slackTimeoutMs });
      finishSlot(statePath, slotKey, "sent", result.ts);
      output(`SENT ${slotKey} to ${channel} (ts=${result.ts || "unknown"})`);
    } catch (error) {
      finishSlot(statePath, slotKey, "failed");
      throw error;
    }
  } finally {
    releaseLock();
  }
}

export { main };

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main().catch((error) => {
    console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
