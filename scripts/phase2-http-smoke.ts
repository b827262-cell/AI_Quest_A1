import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import Database from "../packages/db/node_modules/better-sqlite3";

const dir = mkdtempSync(join(tmpdir(), "smartbook-phase2-smoke-"));
const db = join(dir, "smoke.sqlite");
const port = 44000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;
const token = `smoke-${Date.now()}-${Math.random().toString(36).slice(2)}`;
let child: ChildProcess | undefined;

function assert(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
async function request(path: string, init?: RequestInit) {
  return fetch(`${base}${path}`, init);
}
async function waitReady() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const response = await request("/api/public/site-config");
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("server did not become ready");
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
async function start(allowMock: boolean) {
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
      AI_IP_HASH_SALT: `smoke-salt-${token}`,
      GUEST_ASK_IP_HMAC_SECRET: `phase2-smoke-guest-hmac-${token}`,
      GUEST_ASK_RETENTION_DAYS: "7",
      AI_CREDENTIAL_ENCRYPTION_KEY: `phase2-smoke-vault-${token}`,
      AI_ALLOW_MOCK_FALLBACK: String(allowMock),
      AI_DEFAULT_PROVIDER: "openai",
      AI_MAX_RETRIES: "0",
      SQLITE_PATH: db
    }
  });
  child.stderr?.on("data", () => undefined);
  await waitReady();
}

async function main() {
try {
  await start(true);
  assert((await request("/api/public/site-config")).status === 200, "site-config");
  const invalid = await request("/api/public/guest-ask", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}"
  });
  assert(invalid.status === 400, "invalid guest input");
  const ask = () => request("/api/public/guest-ask", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.12" },
    body: JSON.stringify({ question: "1+1 是多少？" })
  });
  const good = await ask();
  assert(good.status === 200, "mock guest success");
  const body = JSON.stringify(await good.json());
  assert(!/AIza|sk-|authorization|198\\.51\\.100\\.12|stack/i.test(body), "secret/IP/stack leak");
  assert((await ask()).status === 429, "rate limit");
  assert((await request("/api/admin/ai-analytics/summary")).status === 401, "admin no token");
  assert((await request("/api/admin/ai-analytics/summary", { headers: { "x-admin-token": "wrong" } })).status === 401, "admin wrong token");
  const auth = { "x-admin-token": token, "content-type": "application/json" };
  assert((await request("/api/admin/ai-analytics/summary", { headers: auth })).status === 200, "analytics");
  const policies = await request("/api/admin/ai-budget-policies", { headers: auth });
  assert(policies.status === 200, "policy list");
  const policy = (await policies.json() as { policies: Array<{ id: string }> }).policies[0];
  assert(policy?.id, "default policy");
  assert((await request(`/api/admin/ai-budget-policies/${policy.id}`, {
    method: "PUT", headers: auth, body: JSON.stringify({ warningPercentage: 70 })
  })).status === 200, "policy update");
  assert((await request(`/api/admin/ai-budget-policies/${policy.id}`, {
    method: "PUT", headers: auth, body: JSON.stringify({ warningPercentage: 101 })
  })).status === 400, "invalid policy");
  await stop();
  const sqlite = new Database(db, { readonly: true, fileMustExist: true });
  const requestCount = (sqlite.prepare("SELECT COUNT(*) AS count FROM ai_request_logs").get() as { count: number }).count;
  const mockUsage = sqlite.prepare(
    "SELECT COUNT(*) AS count, COALESCE(SUM(actual_cost_micro_usd),0) AS cost FROM ai_usage_logs WHERE provider='mock'"
  ).get() as { count: number; cost: number };
  const pending = (sqlite.prepare(
    "SELECT COUNT(*) AS count FROM ai_budget_reservations WHERE status='pending'"
  ).get() as { count: number }).count;
  const negativeDaily = (sqlite.prepare(
    "SELECT COUNT(*) AS count FROM ai_daily_usage WHERE total_tokens<0 OR actual_cost_micro_usd<0 OR reserved_tokens<0 OR reserved_cost_micro_usd<0"
  ).get() as { count: number }).count;
  sqlite.close();
  assert(requestCount >= 1, "request log missing");
  assert(mockUsage.count >= 1 && mockUsage.cost === 0, "mock usage must be logged at zero cost");
  assert(pending === 0, "pending reservation leaked");
  assert(negativeDaily === 0, "negative daily usage");

  await start(false);
  const unavailable = await request("/api/public/guest-ask", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.7" },
    body: JSON.stringify({ question: "測試無 Provider" })
  });
  assert(unavailable.status === 503, "mock disabled must return 503");
  console.log("[smoke] public site-config/input/rate-limit/mock policy: PASS");
  console.log("[smoke] admin fail-closed/token/analytics/budget validation: PASS");
  console.log("[smoke] response secret/IP/stack scan: PASS");
  console.log("[smoke] request/usage/daily/reservation accounting: PASS");
  console.log("[smoke] isolated DB and shutdown cleanup: PASS");
} catch (error) {
  console.error(`[smoke] FAIL: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
} finally {
  await stop();
  rmSync(dir, { recursive: true, force: true });
}
}
void main();
