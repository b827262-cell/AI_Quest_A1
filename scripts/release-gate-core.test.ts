import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  E2E_ASSERTION_TOTAL,
  browserE2eGate,
  evaluateBrowserE2eReport,
  evaluateRollbackRehearsal,
  exitCodeForState,
  overallState,
  rollbackRestoreRehearsalGate
} from "./release-gate-core.mjs";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function passingE2eReport() {
  return {
    assertionCounts: { executed: E2E_ASSERTION_TOTAL, passed: E2E_ASSERTION_TOTAL, failed: 0, blocked: 0 },
    browserConsoleSecretScan: "PASS",
    networkResponseSecretScan: "PASS",
    cleanup: { chromeProcess: "PASS", temporaryProfile: "PASS", testServer: "PASS" }
  };
}

function passingRollbackReport() {
  return {
    timestamp: "2026-07-23T00:00:00.000Z", commitSha: "abc123", environmentLabel: "staging",
    sourceBackupSummary: "backup-20260723 (redacted identifier)", schemaVersionBefore: "12", schemaVersionAfter: "12",
    databaseConsistencySummary: "checksum verified", backupResult: "PASS", restoreResult: "PASS", migrationResult: "PASS",
    dbPreflightResult: "PASS", providerMetadataVerification: "PASS", credentialMetadataCountVerification: "PASS",
    usageLogReferentialVerification: "PASS", auditLogReferentialVerification: "PASS", serviceStartupVerification: "PASS",
    secretLeakageScan: "PASS", cleanupResult: "PASS", finalState: "PASS"
  };
}

function tempArtifact(content: unknown) {
  const directory = mkdtempSync(join(tmpdir(), "ai-release-gate-test-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "artifact.json");
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
  return path;
}

describe("Phase 3A release gate state matrix", () => {
  it("returns PASS and exit 0 when every gate passes", () => {
    expect(overallState([{ state: "PASS" }, { state: "PASS" }])).toBe("PASS");
    expect(exitCodeForState("PASS")).toBe(0);
  });

  it("lets one FAIL dominate BLOCKED and returns exit 1", () => {
    expect(overallState([{ state: "BLOCKED" }, { state: "FAIL" }])).toBe("FAIL");
    expect(exitCodeForState("FAIL")).toBe(1);
  });

  it("returns BLOCKED and exit 2 when no gate fails", () => {
    expect(overallState([{ state: "PASS" }, { state: "BLOCKED" }])).toBe("BLOCKED");
    expect(exitCodeForState("BLOCKED")).toBe(2);
  });

  it("accepts an E2E report only when all 23 assertions pass", () => {
    expect(evaluateBrowserE2eReport(passingE2eReport(), "PASS").state).toBe("PASS");
  });

  it("rejects partially blocked E2E assertions as FAIL", () => {
    expect(evaluateBrowserE2eReport({ ...passingE2eReport(), assertionCounts: { executed: 2, passed: 2, failed: 0, blocked: 21 } }, "BLOCKED").state).toBe("FAIL");
  });

  it("marks zero executed assertions BLOCKED only for a blocked browser command", () => {
    const report = { ...passingE2eReport(), assertionCounts: { executed: 0, passed: 0, failed: 0, blocked: 23 } };
    expect(evaluateBrowserE2eReport(report, "BLOCKED").state).toBe("BLOCKED");
    expect(evaluateBrowserE2eReport(report, "PASS").state).toBe("FAIL");
  });

  it("uses the E2E artifact rather than command exit alone", () => {
    const path = tempArtifact(passingE2eReport());
    expect(browserE2eGate({ label: "e2e", args: ["e2e"], state: "PASS", code: 0, durationMs: 1 }, path).state).toBe("PASS");
  });

  it("blocks restore rehearsal when no artifact exists even when procedure files exist", () => {
    const missing = join(tmpdir(), "ai-release-gate-no-rehearsal.json");
    expect(rollbackRestoreRehearsalGate(missing).state).toBe("BLOCKED");
  });

  it("accepts a complete passing rollback rehearsal artifact", () => {
    expect(evaluateRollbackRehearsal(passingRollbackReport()).state).toBe("PASS");
  });

  it("fails a rehearsal artifact with a failed secret scan", () => {
    expect(evaluateRollbackRehearsal({ ...passingRollbackReport(), secretLeakageScan: "FAIL" }).state).toBe("FAIL");
  });

  it("fails a rehearsal artifact containing a detected secret marker", () => {
    const path = tempArtifact('{"apiKey":"sk-12345678901234567890"}');
    expect(rollbackRestoreRehearsalGate(path).state).toBe("FAIL");
  });

  it("keeps the default report path in the repository artifact directory", async () => {
    const { artifactPath } = await import("./release-artifacts.mjs");
    expect(artifactPath("release-gate-summary", "UNSET_RELEASE_GATE_TEST_PATH")).toMatch(/release-artifacts\/phase3a\/release-gate-summary\.json$/);
  });
});
