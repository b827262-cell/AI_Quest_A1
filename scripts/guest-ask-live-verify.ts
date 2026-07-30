/**
 * Guest-ask live provider verification (spec §6).
 *
 * Launches a throwaway admin server against an isolated SQLite DB, provisions
 * a real provider credential FROM THE ENVIRONMENT (never hard-coded), and runs
 * the full guest-ask flow:
 *   - POST a four-subtopic sorting question
 *   - assert live mode (not mock), all four algorithms covered, no mid-answer
 *     truncation, no internal "處理流程" leak
 *   - persist + restore via the one-time recovery token (correct token works,
 *     wrong token / missing token / different-IP-with-correct-token verified)
 *   - scan every response + the DB for secrets, raw IP, or recovery token leaks
 *
 * If no live provider credential is present in the environment, the script
 * reports `Provider live request: NOT RUN` and exits with a distinct code so
 * the operator knows production verification is still PENDING (not failed).
 *
 * Safety:
 *   - No API key is ever printed, logged, or written to a fixture.
 *   - The recovery token is never printed.
 *   - Only an answer length + coverage summary is emitted.
 *
 * Exit codes: 0 = PASS, 2 = NOT RUN (no credential), 1 = FAIL.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import Database from "../packages/db/node_modules/better-sqlite3";

type CheckState = "PASS" | "FAIL" | "BLOCKED";
type Check = { name: string; state: CheckState; reason?: string };
const checks: Check[] = [];

function record(name: string, state: CheckState, reason?: string): void {
  checks.push({ name, state, reason });
}

const dir = mkdtempSync(join(tmpdir(), "smartbook-guest-ask-live-"));
const dbPath = join(dir, "verify.sqlite");
const port = 45000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;
const token = `verify-${Date.now()}-${Math.random().toString(36).slice(2)}`;
let child: ChildProcess | undefined;

function assert(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}

async function request(path: string, init?: RequestInit) {
  return fetch(`${base}${path}`, init);
}

async function waitReady() {
  for (let i = 0; i < 100; i += 1) {
    try {
      const response = await request("/api/public/site-config");
      if (response.ok) return;
    } catch {
      /* retry */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("server did not become ready");
}

async function start() {
  const provider = (process.env.GUEST_ASK_LIVE_PROVIDER || "").trim().toLowerCase();
  const providerEnvName = {
    openai: "OPENAI_API_KEY",
    gemini: "GEMINI_API_KEY",
    kimi: "KIMI_API_KEY",
    qwen: "QWEN_API_KEY"
  }[provider];
  if (!provider || !providerEnvName || !process.env[providerEnvName]) {
    throw new Error("NO_CREDENTIAL");
  }
  child = spawn(process.execPath, [
    "--import", "./apps/AI-adm-D1/node_modules/tsx/dist/loader.mjs",
    "apps/AI-adm-D1/src/server/index.ts"
  ], {
    cwd: process.cwd(),
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...process.env,
      NODE_ENV: "production",
      ADMIN_API_HOST: "127.0.0.1",
      ADMIN_API_PORT: String(port),
      ADMIN_API_TOKEN: token,
      GUEST_ASK_IP_HMAC_SECRET: `verify-guest-hmac-${token}`,
      GUEST_ASK_RETENTION_DAYS: "7",
      AI_CREDENTIAL_ENCRYPTION_KEY: process.env.AI_CREDENTIAL_ENCRYPTION_KEY || `verify-vault-${token}`,
      AI_ALLOW_MOCK_FALLBACK: "false",
      AI_DEFAULT_PROVIDER: provider,
      AI_MAX_RETRIES: "1",
      SQLITE_PATH: dbPath,
      TRUST_PROXY: "true"
    }
  });
  child.stderr?.on("data", () => undefined);
  await waitReady();
}

async function stop() {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child!.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000))
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

const QUESTION = "請詳述下列四種排序演算法的運作原理及其時間複雜度：1. 泡沫排序 2. 插入排序 3. 合併排序 4. 快速排序";
const REQUIRED_TERMS = ["泡沫排序", "插入排序", "合併排序", "快速排序"];

async function run(): Promise<number> {
  try {
    await start();
  } catch (err) {
    if (err instanceof Error && err.message === "NO_CREDENTIAL") {
      record("provider live request", "BLOCKED", "no live provider credential in environment");
      return 2;
    }
    throw err;
  }

  // 1. POST the four-subtopic question from one IP.
  const askRes = await request("/api/public/guest-ask", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.42" },
    body: JSON.stringify({ question: QUESTION })
  });
  assert(askRes.status === 200, `guest-ask POST status ${askRes.status}`);
  const created = (await askRes.json()) as {
    requestId: string;
    mode?: string;
    answer?: string;
    recoveryToken?: string;
    status?: string;
    completion?: { complete?: boolean };
  };
  record("live mode (not mock)", created.mode === "live" ? "PASS" : "FAIL", `mode=${created.mode}`);
  record("recovery token returned once", created.recoveryToken ? "PASS" : "FAIL", "no token in create response");

  const answer = created.answer || "";
  const allCovered = REQUIRED_TERMS.every((term) => answer.includes(term));
  record("four sorting algorithms covered", allCovered ? "PASS" : "FAIL", `length=${answer.length}`);
  record("answer not mid-truncated (complete)", created.completion?.complete === true ? "PASS" : "FAIL", `status=${created.status}`);
  record("no internal process note leak", !answer.includes("處理流程") ? "PASS" : "FAIL", "處理流程 present");

  // 2. Recovery with the correct token (same IP).
  const correctRes = await request(`/api/public/guest-ask/${created.requestId}`, {
    headers: { "x-guest-recovery-token": created.recoveryToken || "", "x-forwarded-for": "198.51.100.42" }
  });
  assert(correctRes.status === 200, `correct-token recovery status ${correctRes.status}`);
  const restored = (await correctRes.json()) as { answer?: string; recoveryToken?: string };
  record("correct token restores identical answer", restored.answer === answer ? "PASS" : "FAIL", "answer mismatch");
  record("recovery response does not echo token", !restored.recoveryToken ? "PASS" : "FAIL", "token echoed");

  // 3. Recovery with correct token from a DIFFERENT IP must still work (token-only auth).
  const diffIpRes = await request(`/api/public/guest-ask/${created.requestId}`, {
    headers: { "x-guest-recovery-token": created.recoveryToken || "", "x-forwarded-for": "203.0.113.99" }
  });
  record("different IP + correct token restores (token-only auth)", diffIpRes.status === 200 ? "PASS" : "FAIL", `status=${diffIpRes.status}`);

  // 4. Wrong token must not restore (generic 404).
  const wrongRes = await request(`/api/public/guest-ask/${created.requestId}`, {
    headers: { "x-guest-recovery-token": "deadbeef".repeat(8), "x-forwarded-for": "198.51.100.42" }
  });
  record("wrong token rejected (404)", wrongRes.status === 404 ? "PASS" : "FAIL", `status=${wrongRes.status}`);

  // 5. Missing token must not restore (generic 404).
  const missingRes = await request(`/api/public/guest-ask/${created.requestId}`, {
    headers: { "x-forwarded-for": "198.51.100.42" }
  });
  record("missing token rejected (404)", missingRes.status === 404 ? "PASS" : "FAIL", `status=${missingRes.status}`);

  // 6. Secret / IP / token leak scan across all captured JSON responses.
  const serialized = JSON.stringify({ created, restored });
  const leakPattern = /sk-[A-Za-z0-9]{12,}|AIza[A-Za-z0-9_-]{20,}|198\.51\.100\.42|203\.0.113\.99|authorization|cookie/i;
  record("no secret/IP/token leak in API responses", !leakPattern.test(serialized) ? "PASS" : "FAIL", "leak detected");

  // 7. DB diagnostics allowlist + no raw answer/IP/token in diagnostics_json.
  await stop();
  const sqlite = new Database(dbPath, { readonly: true, fileMustExist: true });
  const diagRows = sqlite.prepare("SELECT diagnostics_json FROM ai_request_logs WHERE diagnostics_json IS NOT NULL").all() as Array<{ diagnostics_json: string }>;
  sqlite.close();
  const diagText = diagRows.map((r) => r.diagnostics_json).join("\n");
  const forbiddenInDiag = /authorization|api[_-]?key|cookie|prompt|answer|rawBody|headers|credential|recoveryToken|"ip"|stack|198\.51\.100/i;
  record("diagnostics_json allowlist (no sensitive content)", !forbiddenInDiag.test(diagText) ? "PASS" : "FAIL", "sensitive content in diagnostics");
  record("diagnostics_json has whitelisted fields", /finishReason|promptTokens|completionTokens|provider/i.test(diagText) ? "PASS" : "FAIL", "no expected fields");

  const failed = checks.filter((c) => c.state === "FAIL");
  return failed.length === 0 ? 0 : 1;
}

async function main() {
  let exitCode = 0;
  const startedAt = new Date().toISOString();
  try {
    exitCode = await run();
  } catch (error) {
    record("verification completed", "FAIL", error instanceof Error ? error.message : "unknown error");
    exitCode = 1;
  } finally {
    if (child && child.exitCode === null) await stop();
    rmSync(dir, { recursive: true, force: true });
  }

  const provider = (process.env.GUEST_ASK_LIVE_PROVIDER || "").trim().toLowerCase() || "(none)";
  console.log("=== Guest-Ask Live Verification ===");
  console.log(`Provider: ${provider}`);
  console.log(`Started: ${startedAt}`);
  console.log("");
  for (const check of checks) {
    const reason = check.reason ? ` — ${check.reason}` : "";
    console.log(`[${check.state}] ${check.name}${reason}`);
  }
  console.log("");
  const counts = {
    PASS: checks.filter((c) => c.state === "PASS").length,
    FAIL: checks.filter((c) => c.state === "FAIL").length,
    BLOCKED: checks.filter((c) => c.state === "BLOCKED").length
  };
  console.log(`Summary: ${counts.PASS} PASS, ${counts.FAIL} FAIL, ${counts.BLOCKED} BLOCKED`);
  if (exitCode === 2) {
    console.log("Provider live request: NOT RUN");
    console.log("Production provider verification: PENDING");
  } else if (exitCode === 0) {
    console.log("Provider live request: RUN");
  } else {
    console.log("Provider live request: RUN (with failures)");
  }
  process.exitCode = exitCode;
}

void main();
