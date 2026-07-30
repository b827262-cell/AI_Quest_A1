import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import Database from "../packages/db/node_modules/better-sqlite3";
import { createDbHandle, createRepositories, resolveDbPath, runMigrations } from "../packages/db/src/index";

const sourcePath = resolveDbPath();
if (!existsSync(sourcePath)) {
  console.error(`[preflight] database does not exist: ${sourcePath}`);
  process.exit(2);
}

async function main(): Promise<void> {
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
  const hasTable = (name: string) =>
    Boolean(source.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  let failed = false;
  if (hasTable("ai_request_logs")) {
    const duplicates = source.prepare(
      "SELECT request_id AS requestId, COUNT(*) AS count FROM ai_request_logs GROUP BY request_id HAVING COUNT(*) > 1"
    ).all() as Array<{ requestId: string; count: number }>;
    for (const row of duplicates) console.error(`[duplicate] ${row.requestId} ${row.count}`);
    const invalid = source.prepare(
      "SELECT request_id AS requestId, COUNT(*) AS count FROM ai_request_logs WHERE request_id IS NULL OR trim(request_id)='' OR length(request_id)>200 GROUP BY request_id"
    ).all() as Array<{ requestId: string | null; count: number }>;
    for (const row of invalid) console.error(`[invalid-request-id] ${row.requestId ?? "<NULL>"} ${row.count}`);
    failed ||= duplicates.length > 0 || invalid.length > 0;
  }
  if (hasTable("ai_usage_logs") && hasTable("ai_request_logs")) {
    const orphans = source.prepare(
      "SELECT u.request_id AS requestId, COUNT(*) AS count FROM ai_usage_logs u LEFT JOIN ai_request_logs r ON r.request_id=u.request_id WHERE r.request_id IS NULL GROUP BY u.request_id"
    ).all() as Array<{ requestId: string; count: number }>;
    for (const row of orphans) console.error(`[orphan-usage] ${row.requestId} ${row.count}`);
    failed ||= orphans.length > 0;
  }
  source.close();
  if (failed) {
    process.exitCode = 1;
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), "smartbook-phase2-preflight-"));
  const copy = join(dir, "preflight.sqlite");
  try {
    // A byte-for-byte copy of the main file can omit uncheckpointed WAL pages.
    // better-sqlite3's backup API takes a consistent snapshot instead.
    const backupSource = new Database(sourcePath, { readonly: true, fileMustExist: true });
    await backupSource.backup(copy);
    backupSource.close();
    const handle = createDbHandle(copy);
    runMigrations(handle.sqlite);
    runMigrations(handle.sqlite);
    const unique = handle.sqlite.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_ai_request_logs_request_id_unique'"
    ).get();
    if (!unique) throw new Error("request_id unique index missing");

    const reservations = createRepositories(handle.db).aiBudgetReservations;
    const base = { provider: "openai", model: "preflight", date: "2099-01-01",
      estimatedTokens: 60, estimatedCostMicroUsd: 0, dailyTokenLimit: 100,
      dailyCostLimitMicroUsd: 1_000_000 };
    const first = reservations.reserve({ ...base, requestId: "preflight-a" });
    const second = reservations.reserve({ ...base, requestId: "preflight-b" });
    if (!first.allowed || second.allowed || !first.reservationId) {
      throw new Error("reservation concurrency guard failed");
    }
    reservations.release(first.reservationId);
    const counters = handle.sqlite.prepare(
      "SELECT reserved_tokens AS tokens, reserved_cost_micro_usd AS cost FROM ai_daily_usage WHERE date='2099-01-01' AND scope_type='global' AND scope_key='default'"
    ).get() as { tokens: number; cost: number };
    if (counters.tokens !== 0 || counters.cost !== 0) throw new Error("reservation release failed");
    handle.sqlite.close();
    console.log("[preflight] duplicate request IDs: 0");
    console.log("[preflight] invalid request IDs: 0");
    console.log("[preflight] orphan usage rows: 0");
    console.log("[preflight] migration idempotency: PASS");
    console.log("[preflight] reservation concurrency/release: PASS");
  } catch {
    console.error("[preflight] validation failed (details redacted)");
    process.exitCode = 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

void main().catch(() => {
  console.error("[preflight] validation failed (details redacted)");
  process.exitCode = 1;
});
