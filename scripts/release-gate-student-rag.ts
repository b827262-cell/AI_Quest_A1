import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { runMigrations } from "../packages/db/src/index";

/**
 * release-gate:student-rag — ordered release gate for the Phase 6 student
 * auth + dashboard + RAG integration.
 *
 * Order matters: the student bundle build must finish before `test`, because
 * security-bundle tests assert against the built output. Every step must
 * exit 0; the first failure stops the gate.
 */

const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const artifactsDir = join(repoRoot, "release-artifacts/student-rag");

// The native better-sqlite3 build has no ambient typings at the repo root;
// load it through a minimal typed cast, mirroring the smoke harness approach.
const dbPackageRequire = createRequire(join(repoRoot, "packages/db/package.json"));
interface SqliteHandle {
  prepare(sql: string): { get(...params: unknown[]): unknown; run(...params: unknown[]): unknown };
  close(): void;
}
const Database = dbPackageRequire("better-sqlite3") as new (path: string) => SqliteHandle;

interface GateStepResult {
  name: string;
  ok: boolean;
  exitCode: number | null;
  durationMs: number;
  detail?: string;
}

const results: GateStepResult[] = [];

function runShell(name: string, command: string, args: string[], options: { cwd?: string } = {}): void {
  const startedAt = Date.now();
  console.log(`\n── ${name}: ${command} ${args.join(" ")}`);
  const child = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    stdio: "inherit",
    env: process.env
  });
  const durationMs = Date.now() - startedAt;
  if (child.error) {
    results.push({ name, ok: false, exitCode: null, durationMs, detail: String(child.error) });
    finish(`step failed to start: ${name}`);
  }
  results.push({ name, ok: child.status === 0, exitCode: child.status, durationMs });
  if (child.status !== 0) {
    finish(`step failed: ${name} (exit ${child.status})`);
  }
}

function runStep(name: string, body: () => string | void): void {
  const startedAt = Date.now();
  console.log(`\n── ${name}`);
  try {
    const detail = body();
    results.push({ name, ok: true, exitCode: 0, durationMs: Date.now() - startedAt, detail: detail ?? undefined });
  } catch (error) {
    results.push({
      name,
      ok: false,
      exitCode: 1,
      durationMs: Date.now() - startedAt,
      detail: error instanceof Error ? error.message : String(error)
    });
    finish(`step failed: ${name}`);
  }
}

function finish(failure?: string): void {
  mkdirSync(artifactsDir, { recursive: true });
  const summary = {
    gate: "release-gate:student-rag",
    completedAt: new Date().toISOString(),
    pass: !failure,
    failure: failure ?? null,
    steps: results
  };
  const summaryPath = join(artifactsDir, "release-gate-summary.json");
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  if (failure) {
    console.error(`\nrelease-gate:student-rag FAIL — ${failure}\nsummary: ${summaryPath}`);
    process.exit(1);
  }
  console.log(`\nrelease-gate:student-rag PASS (${results.length} steps) — summary: ${summaryPath}`);
  process.exit(0);
}

/** DB preflight: migrations must run cleanly on a throwaway database. */
function dbPreflight(): string {
  const dir = mkdtempSync(join(tmpdir(), "ai-release-gate-preflight-"));
  const dbPath = join(dir, "preflight.db");
  const db = new Database(dbPath);
  runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
  const required = [
    "student_sessions",
    "student_oauth_states",
    "books",
    "book_chapters",
    "book_contents",
    "book_files"
  ];
  const missing = required.filter((table) => {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
    return !row;
  });
  db.close();
  if (missing.length > 0) throw new Error(`missing tables after migration: ${missing.join(", ")}`);
  return `migrations ok; tables verified: ${required.join(", ")}`;
}

/** Secret scan over tracked files (lockfile excluded — it is noise). */
function secretScan(): string {
  const patterns = [
    "AIza[0-9A-Za-z_-]{20,}",
    "csk-[A-Za-z0-9_-]{16,}",
    "\\bsk-[A-Za-z0-9_-]{24,}\\b",
    "-----BEGIN [A-Z ]*PRIVATE KEY-----"
  ];
  const findings: string[] = [];
  for (const pattern of patterns) {
    const scan = spawnSync("git", ["grep", "-nIE", pattern, "--", ".", ":!pnpm-lock.yaml"], {
      cwd: repoRoot,
      encoding: "utf8"
    });
    // git grep exits 1 when nothing matches; anything else is suspicious.
    if (scan.status === 0) findings.push(...scan.stdout.trim().split("\n").filter(Boolean));
    else if (scan.status !== 1) throw new Error(`git grep failed for pattern ${pattern}: ${scan.stderr}`);
  }
  const trackedEnv = spawnSync("git", ["ls-files", ".env"], { cwd: repoRoot, encoding: "utf8" });
  if (trackedEnv.stdout.trim()) findings.push(`tracked env file: ${trackedEnv.stdout.trim()}`);
  if (findings.length > 0) throw new Error(`secret scan findings: ${findings.slice(0, 5).join(" | ")}`);
  return `scanned ${patterns.length} patterns over tracked files; no secrets detected`;
}

function gitDiffCheck(): string {
  const scan = spawnSync("git", ["diff", "--check"], { cwd: repoRoot, encoding: "utf8" });
  if (scan.status !== 0) throw new Error(`git diff --check reported whitespace errors:\n${scan.stdout.slice(0, 800)}`);
  return "no whitespace errors";
}

function main(): void {
  console.log("release-gate:student-rag — ordered Phase 6 release gate");

  runShell("install (frozen lockfile)", "pnpm", ["install", "--frozen-lockfile"]);
  runStep("db migration preflight", dbPreflight);
  runShell("contracts:validate", "pnpm", ["run", "contracts:validate"]);
  runShell("typecheck", "pnpm", ["run", "typecheck"]);
  runShell("lint", "pnpm", ["run", "lint"]);
  // build before test: security-bundle tests assert against built output.
  runShell("build", "pnpm", ["run", "build"]);
  runShell("test", "pnpm", ["run", "test"]);
  runShell("student:auth-smoke", "pnpm", ["run", "student:auth-smoke"]);
  runShell("student:dashboard-smoke", "pnpm", ["run", "student:dashboard-smoke"]);
  runShell("rag:smoke", "pnpm", ["run", "rag:smoke"]);
  runShell("browser/server boundary", "bash", ["scripts/boundary-check.sh"]);
  runStep("secret scan", secretScan);
  runStep("git diff --check", gitDiffCheck);

  finish();
}

main();
