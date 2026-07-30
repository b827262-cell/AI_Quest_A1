import { existsSync, readFileSync } from "node:fs";
import { artifactPath, scanArtifactText } from "./release-artifacts.mjs";

export const RELEASE_GATE_EXIT = Object.freeze({ PASS: 0, FAIL: 1, BLOCKED: 2 });
export const E2E_ASSERTION_TOTAL = 23;

export function stateForExit(code, timedOut = false) {
  if (timedOut || code === null || code === undefined) return "FAIL";
  if (code === 0) return "PASS";
  if (code === 2) return "BLOCKED";
  return "FAIL";
}

export function combineGate(label, results) {
  const failed = results.some((result) => result.state === "FAIL");
  const blocked = results.some((result) => result.state === "BLOCKED");
  return {
    label,
    state: failed ? "FAIL" : blocked ? "BLOCKED" : "PASS",
    durationMs: results.reduce((sum, result) => sum + (result.durationMs || 0), 0),
    checks: results.map((result) => ({
      command: result.args?.length ? `pnpm ${result.args.join(" ")}` : result.label,
      state: result.state,
      exitCode: result.code,
      durationMs: result.durationMs || 0,
      summary: result.output
    }))
  };
}

export function overallState(gates) {
  if (gates.some((gate) => gate.state === "FAIL")) return "FAIL";
  if (gates.some((gate) => gate.state === "BLOCKED")) return "BLOCKED";
  return "PASS";
}

export function exitCodeForState(state) {
  return RELEASE_GATE_EXIT[state] ?? RELEASE_GATE_EXIT.FAIL;
}

export function evaluateBrowserE2eReport(report, commandState = "PASS") {
  const counts = report?.assertionCounts;
  if (!counts || !["executed", "passed", "failed", "blocked"].every((key) => Number.isInteger(counts[key]) && counts[key] >= 0)) {
    return { state: commandState === "BLOCKED" ? "BLOCKED" : "FAIL", reason: "missing or invalid E2E assertion counts" };
  }
  const total = counts.passed + counts.failed + counts.blocked;
  if (total !== E2E_ASSERTION_TOTAL || counts.executed !== counts.passed + counts.failed) {
    return { state: "FAIL", reason: `E2E assertion accounting must equal ${E2E_ASSERTION_TOTAL}` };
  }
  if (counts.executed === 0) {
    return { state: commandState === "BLOCKED" ? "BLOCKED" : "FAIL", reason: "no browser assertions executed" };
  }
  if (counts.failed > 0 || counts.blocked > 0 || counts.passed !== E2E_ASSERTION_TOTAL) {
    return { state: "FAIL", reason: `E2E requires ${E2E_ASSERTION_TOTAL}/${E2E_ASSERTION_TOTAL} passed assertions` };
  }
  if (report.browserConsoleSecretScan !== "PASS" || report.networkResponseSecretScan !== "PASS") {
    return { state: "FAIL", reason: "browser or network secret scan did not pass" };
  }
  if (report.cleanup?.chromeProcess !== "PASS" || report.cleanup?.temporaryProfile !== "PASS" || report.cleanup?.testServer !== "PASS") {
    return { state: "FAIL", reason: "browser cleanup did not pass" };
  }
  return { state: commandState === "PASS" ? "PASS" : "FAIL", reason: commandState === "PASS" ? undefined : "E2E command did not exit successfully" };
}

export function readJsonArtifact(filePath) {
  if (!existsSync(filePath)) return { found: false };
  try {
    const raw = readFileSync(filePath, "utf8");
    const leakage = scanArtifactText(raw);
    if (!leakage.passed) return { found: true, leakage: "FAIL", reason: leakage.reason };
    return { found: true, report: JSON.parse(raw), leakage: "PASS" };
  } catch {
    return { found: true, reason: "artifact is unreadable or invalid JSON" };
  }
}

export function browserE2eGate(commandResult, reportPath) {
  const artifact = readJsonArtifact(reportPath);
  const evaluation = artifact.report
    ? evaluateBrowserE2eReport(artifact.report, commandResult.state)
    : { state: commandResult.state === "BLOCKED" ? "BLOCKED" : "FAIL", reason: artifact.reason || "E2E artifact is missing" };
  return {
    label: "Browser UI E2E",
    state: evaluation.state,
    durationMs: commandResult.durationMs || 0,
    checks: [{
      command: commandResult.args?.length ? `pnpm ${commandResult.args.join(" ")}` : commandResult.label,
      state: evaluation.state,
      exitCode: commandResult.code,
      durationMs: commandResult.durationMs || 0,
      summary: evaluation.reason,
      reportPath
    }]
  };
}

const ROLLBACK_FIELDS = [
  "timestamp", "commitSha", "environmentLabel", "sourceBackupSummary", "schemaVersionBefore", "schemaVersionAfter",
  "databaseConsistencySummary", "backupResult", "restoreResult", "migrationResult", "dbPreflightResult",
  "providerMetadataVerification", "credentialMetadataCountVerification", "usageLogReferentialVerification",
  "auditLogReferentialVerification", "serviceStartupVerification", "secretLeakageScan", "cleanupResult", "finalState"
];
const ROLLBACK_PASS_FIELDS = ROLLBACK_FIELDS.slice(6).filter((field) => field !== "databaseConsistencySummary");

export function evaluateRollbackRehearsal(report) {
  if (!report || typeof report !== "object") return { state: "BLOCKED", reason: "rollback restore rehearsal artifact is missing" };
  const missing = ROLLBACK_FIELDS.filter((field) => report[field] === undefined || report[field] === null || report[field] === "");
  if (missing.length) return { state: "FAIL", reason: `rollback rehearsal artifact is incomplete (${missing.length} required fields missing)` };
  const failed = ROLLBACK_PASS_FIELDS.find((field) => report[field] !== "PASS");
  if (failed) return { state: "FAIL", reason: `rollback rehearsal check failed: ${failed}` };
  return { state: "PASS" };
}

export function rollbackRestoreRehearsalGate(reportPath = artifactPath("rollback-restore-rehearsal", "ROLLBACK_REHEARSAL_REPORT_PATH")) {
  const artifact = readJsonArtifact(reportPath);
  const evaluation = artifact.leakage === "FAIL"
    ? { state: "FAIL", reason: "rollback rehearsal artifact secret scan failed" }
    : evaluateRollbackRehearsal(artifact.report);
  return {
    label: "Rollback Restore Rehearsal",
    state: evaluation.state,
    durationMs: 0,
    checks: [{ command: "sanitized rollback restore rehearsal artifact", state: evaluation.state, exitCode: exitCodeForState(evaluation.state), durationMs: 0, summary: evaluation.reason, reportPath }]
  };
}
