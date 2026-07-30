import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { artifactPath, redactText, releaseMetadata, sanitizeDiagnostic, writeSanitizedArtifact } from "./release-artifacts.mjs";
import { browserE2eGate, combineGate, exitCodeForState, overallState, rollbackRestoreRehearsalGate, stateForExit } from "./release-gate-core.mjs";

const root = new URL("..", import.meta.url).pathname;
const summaryPath = artifactPath("release-gate-summary", "RELEASE_GATE_REPORT_PATH");
const commandTimeoutMs = Math.max(30_000, Math.min(900_000, Number(process.env.RELEASE_GATE_COMMAND_TIMEOUT_MS || 600_000)));

function killProcessTree(child) {
  if (!child?.pid) return;
  try { process.kill(-child.pid, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch { /* best effort */ } }
  setTimeout(() => {
    try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* best effort */ } }
  }, 1000).unref();
}

function runCommand(label, args) {
  return new Promise((resolveResult) => {
    const started = Date.now();
    const child = spawn("pnpm", args, { cwd: root, detached: true, stdio: ["ignore", "pipe", "pipe"], env: process.env });
    let stdout = "";
    let stderr = "";
    const append = (current, chunk) => `${current}${String(chunk)}`.slice(-6000);
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, commandTimeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      resolveResult({ label, args, state: "FAIL", code: null, durationMs: Date.now() - started, output: sanitizeDiagnostic(error.message) });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      const output = redactText(`${stdout}\n${stderr}`).replace(/\s+/g, " ").trim();
      resolveResult({ label, args, state: stateForExit(code, timedOut), code, durationMs: Date.now() - started, output: output.slice(-500) || undefined });
    });
  });
}

function fileGate(label, paths) {
  const missing = paths.filter((path) => !existsSync(new URL(`../${path}`, import.meta.url)));
  const state = missing.length === 0 ? "PASS" : "FAIL";
  return {
    label,
    state,
    durationMs: 0,
    checks: [{ command: "release procedure files", state, exitCode: state === "PASS" ? 0 : 1, durationMs: 0, summary: state === "PASS" ? undefined : `missing ${missing.length} release procedure file(s)` }]
  };
}

async function main() {
  const results = [];
  const localCommands = [
    ["typecheck", ["-r", "typecheck"]],
    ["release-script typecheck", ["typecheck:release-scripts"]],
    ["lint", ["-r", "lint"]],
    ["release-script lint", ["lint:release-scripts"]],
    ["unit and integration tests", ["-r", "test"]],
    ["build", ["-r", "build"]]
  ];
  for (const [label, args] of localCommands) results.push(await runCommand(label, args));
  const localGate = combineGate("Local Test", results);

  const preflight = await runCommand("database preflight", ["db:preflight:phase2"]);
  const rotationTests = await runCommand("credential rotation tests", ["--filter", "AI-adm-D1", "exec", "vitest", "run", "--no-file-parallelism", "src/server/ai/credential-rotation.test.ts", "src/server/ai/credential-crypto.test.ts"]);
  let rotationVerification;
  if (!process.env.AI_CREDENTIAL_ENCRYPTION_KEY?.trim()) {
    rotationVerification = { label: "credential key verification", args: ["credential-key:verify"], state: "BLOCKED", code: 2, durationMs: 0, output: "AI_CREDENTIAL_ENCRYPTION_KEY is unavailable; no DB key verification attempted" };
  } else {
    rotationVerification = await runCommand("credential key verification", ["credential-key:verify"]);
  }
  const rotationTestsGate = combineGate("Rotation Implementation Tests", [rotationTests]);
  const targetCredentialVerificationGate = combineGate("Target DB Credential Verification", [rotationVerification]);

  const e2e = await runCommand("browser UI E2E", ["e2e:admin-providers"]);
  const e2eGate = browserE2eGate(e2e, artifactPath("admin-provider-e2e", "E2E_REPORT_PATH"));
  const staging = await runCommand("staging HTTP smoke", ["smoke:phase3a"]);
  const providerArgs = process.env.PROVIDER_LIVE_PROVIDER?.trim()
    ? ["smoke:provider", "--provider", process.env.PROVIDER_LIVE_PROVIDER.trim()]
    : ["smoke:provider"];
  const providerLive = await runCommand("Vault-based Provider live smoke", providerArgs);
  const production = await runCommand("production verification", ["production:verify:phase3a"]);
  const rollbackProcedure = fileGate("Rollback Procedure Available", [
    "docs/PHASE2_RELEASE_RUNBOOK.md",
    "docs/PHASE3A_PRODUCTION_VERIFICATION.md",
    "scripts/credential-key-rotation.ts"
  ]);
  const rollbackRehearsal = rollbackRestoreRehearsalGate();

  const gates = [localGate, combineGate("Database Preflight", [preflight]), rotationTestsGate, targetCredentialVerificationGate,
    e2eGate, combineGate("Staging HTTP Smoke", [staging]), combineGate("Provider Vault Live Smoke", [providerLive]),
    combineGate("Production Verification", [production]), rollbackProcedure, rollbackRehearsal];
  const overall = overallState(gates);
  const reportLocations = {
    browserUiE2e: artifactPath("admin-provider-e2e", "E2E_REPORT_PATH"),
    staging: artifactPath("staging-smoke", "PHASE3A_SMOKE_REPORT"),
    providerLive: artifactPath("provider-live-smoke", "PROVIDER_LIVE_REPORT_PATH"),
    production: artifactPath("production-verification", "PRODUCTION_REPORT_PATH"),
    summary: summaryPath
  };
  const artifact = writeSanitizedArtifact(summaryPath, {
    ...releaseMetadata(process.env.RELEASE_ENVIRONMENT || "local-release-candidate"),
    status: overall,
    productionReady: overall === "PASS" ? "Yes" : "No",
    gates,
    reportLocations,
    policy: "FAIL dominates BLOCKED; BLOCKED dominates PASS; no production deployment is performed"
  });
  const finalStatus = artifact.written ? overall : "FAIL";
  const finalExitCode = exitCodeForState(finalStatus);
  for (const gate of gates) console.log(`[${gate.state}] ${gate.label} — ${gate.durationMs}ms`);
  for (const [label, path] of Object.entries(reportLocations)) console.log(`Report ${label}: ${path}`);
  console.log(`Overall Release Gate: ${finalStatus}`);
  console.log(`Production Ready: ${finalStatus === "PASS" ? "Yes" : "No"}`);
  console.log(`Summary artifact: ${artifact.written ? summaryPath : "unavailable (safe write/leakage scan failed)"}`);
  console.log(`Child process policy: detached runner groups terminated on timeout; no deployment command is invoked`);
  process.exitCode = finalExitCode;
  return finalExitCode;
}

void main().catch(() => {
  console.error("Phase 3A release gate: FAIL (details redacted)");
  process.exitCode = 1;
});
