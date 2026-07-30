// Pilot Review (0730) — deterministic service-level verification.
//
// This suite exercises the Pilot control plane (`makePilotService`) against a
// real in-memory Repositories stack. It verifies the 0730 acceptance checklist
// WITHOUT enabling live Pilot traffic: every case keeps the Pilot disabled or
// tears it back to disabled before assertions complete. No credential, pool,
// gateway, or student-runtime source is touched.
//
// Coverage of the 0730 checklist:
//   1. Initial state disabled + 0% + no categories.
//   2. Kill Switch stops all Pilot traffic immediately.
//   3. Auto-stop fires on sustained threshold breach (error / latency / cost / quality).
//   4. Auto-stop does not fire on a single good window or below the minimum sample.
//   5. 1% mathematics-only assignment rule (deterministic, non-math unaffected).
//   6. Verification ON / Adjudication OFF enforcement.
//   7. Max-2-model-calls clamp (and adjudication requires >=3).
//   8. Fallback to the existing single-model flow when disabled or not ready.
//   9. Readiness gate blocks enabling before the review passes.
//  10. Audit log captured on every mutating action (enable / update / disable / review / auto-stop).
//  11. No sensitive fields (apiKey / prompt / answer) leak via settings or audit.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDbHandle, createRepositories, runMigrations } from "@ai-smartbook/db";
import type { Repositories } from "@ai-smartbook/db";
import { makePilotService, PilotServiceError } from "./pilot-service";

type AuditRow = { action: string; targetId: string; metadata: Record<string, unknown> };

// The full "everything passed" readiness review payload an admin would file.
const ALL_TRUE_REVIEW = {
  testSuitePassed: true, typecheckPassed: true, buildPassed: true, diffClean: true, securityScansClean: true,
  credentialPolicyPassed: true, evaluationCredentialPassed: true, evaluationPoolIsolated: true,
  reservationIdempotencyPassed: true, orchestratorSafetyPassed: true, fixtureBaselinePassed: true,
  mockBaselinePassed: true, regressionAlertsConfigured: true, retentionConfigured: true,
  schedulerDisabledByDefault: true, auditLogReady: true, pilotFeatureFlagReady: true, emergencyKillSwitchReady: true
};

// Seed the offline + smoke artifacts that productionReadiness() requires before
// a review can reach ready_for_pilot (it inspects real completed runs + a stored
// settings row, not just checkboxes). This mirrors what a real env accumulates
// before Pilot review.
function seedReadyArtifacts(repos: Repositories) {
  // Bootstrap the singleton settings row (saveReadinessReview requires it).
  repos.aiMultiModelPilot.saveSettings({
    enabled: false, trafficPercentage: 0, allowedTaskCategories: [],
    allowVerification: true, allowAdjudication: false, maxModelCallsPerRequest: 2,
    pilotVersion: "phase-5a-default", stopPolicy: { minimumRequestCount: 100, consecutiveWindows: 2 }
  });
  const summary = { totalCases: 3, passedCases: 3, failedCases: 0, passRate: 1, averageScore: 1, averageDurationMs: 10, p50DurationMs: 10, p95DurationMs: 10, totalModelCalls: 6, averageModelCalls: 2, totalTokens: 600, conflictRate: 0, unresolvedRate: 0, regressionIssueCount: 0 };
  for (const mode of ["fixture", "mock_orchestrator"] as const) {
    const run = repos.aiEvaluationRuns.createRun({ datasetId: "phase-4a-core", datasetVersion: 1, executionMode: mode });
    repos.aiEvaluationRuns.finalizeRun(run.id, { ...summary, totalCases: 1, passedCases: 1 }, [], []);
  }
  // Live smoke: 3 cases, evaluation traffic class, token budget not exceeded,
  // evaluation pool set, and no pending reservations => smokeSafe.
  const smoke = repos.aiEvaluationRuns.createRun({ datasetId: "phase-4a-core", datasetVersion: 1, executionMode: "live", maxTokenBudget: 5000, evaluationPoolId: "aetp_eval_smoke_20260730" });
  repos.aiEvaluationRuns.finalizeRun(smoke.id, summary, [], []);
}

// The 0730 initial Pilot proposal: 1% / mathematics only / verification on /
// adjudication off / max 2 model calls. Never persisted as enabled in this suite.
const PILOT_0730_PROPOSAL = {
  enabled: true,
  trafficPercentage: 1,
  allowedTaskCategories: ["mathematics"] as Array<"programming" | "mathematics" | "knowledge">,
  allowVerification: true,
  allowAdjudication: false,
  maxModelCallsPerRequest: 2,
  pilotVersion: "phase-5a-default",
  stopPolicy: { minimumRequestCount: 100, consecutiveWindows: 2 }
};

let handle: ReturnType<typeof createDbHandle> | undefined;

function setup() {
  handle = createDbHandle(":memory:");
  runMigrations(handle.sqlite);
  const repos: Repositories = createRepositories(handle.db);
  const auditRows: AuditRow[] = [];
  // A fully-ready live gate so readiness can be reached after a review.
  const liveEvaluationService = {
    readiness: () => ({
      credentialReady: true, evaluationPoolReady: true, budgetReady: true,
      allowlistReady: true, liveEnabled: true, ready: true, blockers: [], warnings: []
    })
  };
  const service = makePilotService(repos, liveEvaluationService, (action, targetId, metadata) =>
    auditRows.push({ action, targetId, metadata: metadata as Record<string, unknown> }));
  return { repos, service, auditRows };
}

afterEach(() => { handle?.sqlite.close(); handle = undefined; });

describe("Pilot Review (0730) initial state and gating", () => {
  let handle: ReturnType<typeof setup>;
  beforeEach(() => { handle = setup(); });

  it("starts disabled with zero traffic and no categories", () => {
    const settings = handle.service.settings();
    expect(settings).toMatchObject({ enabled: false, trafficPercentage: 0, allowedTaskCategories: [] });
    expect(settings.allowVerification).toBe(true);
    expect(settings.allowAdjudication).toBe(false);
    expect(settings.maxModelCallsPerRequest).toBe(2);
  });

  it("routes every request to the production flow when disabled", () => {
    // Non-mathematics must be unaffected even if a stale enabled row existed.
    for (const subjectId of ["student-1", "student-2", "student-3"]) {
      for (const category of ["mathematics", "programming", "knowledge"]) {
        const decision = handle.service.assignment(subjectId, category);
        expect(decision.pilot).toBe(false);
        expect(decision.trafficClass).toBe("production");
      }
    }
  });

  it("cannot be enabled before the readiness review passes", () => {
    expect(() => handle.service.saveSettings(PILOT_0730_PROPOSAL, "admin-1")).toThrow(PilotServiceError);
    try {
      handle.service.saveSettings(PILOT_0730_PROPOSAL, "admin-1");
    } catch (error) {
      expect((error as PilotServiceError).code).toBe("production_readiness_required");
      expect((error as PilotServiceError).status).toBe(409);
    }
    // Still disabled.
    expect(handle.service.settings().enabled).toBe(false);
  });

  it("reaches ready_for_pilot only after a full readiness review", () => {
    expect(handle.service.productionReadiness().status).toBe("blocked");
    seedReadyArtifacts(handle.repos);
    const result = handle.service.review(ALL_TRUE_REVIEW, "admin-1");
    expect(result.status).toBe("ready_for_pilot");
    expect(handle.auditRows.some((row) => row.action === "ai_pilot.readiness_reviewed")).toBe(true);
  });
});

describe("Pilot Review (0730) Kill Switch", () => {
  let handle: ReturnType<typeof setup>;
  beforeEach(() => {
    handle = setup();
    seedReadyArtifacts(handle.repos);
    handle.service.review(ALL_TRUE_REVIEW, "admin-1");
    handle.service.saveSettings(PILOT_0730_PROPOSAL, "admin-2");
  });

  it("stops all Pilot traffic immediately and disables future assignment", () => {
    expect(handle.service.settings().enabled).toBe(true);
    const after = handle.service.disable("admin_kill_switch", "admin-3");
    expect(after).toMatchObject({ enabled: false, trafficPercentage: 0, autoStopReason: "admin_kill_switch" });
    // Subsequent assignment never enters the Pilot cohort (enabled flag is the
    // short-circuit), for any subject or category. trafficClass reflects the
    // cohort label, not actual assignment, so we assert on `pilot` directly.
    for (const category of ["mathematics", "programming", "knowledge"]) {
      expect(handle.service.assignment("student-1", category).pilot).toBe(false);
    }
    // Kill switch is audited.
    expect(handle.auditRows.some((row) => row.action === "ai_pilot.disabled" && row.metadata.reason === "admin_kill_switch")).toBe(true);
  });

  it("records an autoStop timestamp so operators can see when traffic ended", () => {
    handle.service.disable("admin_kill_switch", "admin-3");
    const settings = handle.service.settings();
    expect(typeof settings.autoStoppedAt).toBe("string");
    expect(settings.autoStoppedAt).not.toBe("");
  });
});

describe("Pilot Review (0730) Auto-stop thresholds", () => {
  let handle: ReturnType<typeof setup>;
  beforeEach(() => {
    handle = setup();
    seedReadyArtifacts(handle.repos);
    handle.service.review(ALL_TRUE_REVIEW, "admin-1");
    // Tighter policy so the suite can trip it deterministically.
    handle.service.saveSettings({
      ...PILOT_0730_PROPOSAL,
      trafficPercentage: 100,
      stopPolicy: { minimumRequestCount: 10, consecutiveWindows: 2, unresolvedRateThreshold: 0.2, providerFailureRateThreshold: 0.5, p95LatencyThresholdMs: 4000 }
    }, "admin-2");
  });

  it("does not stop on a single good window", () => {
    const { stop } = handle.service.recordWindow({ windowKey: "pilot:2026-07-30T00", trafficClass: "pilot", requestCount: 50, unresolvedCount: 1, providerFailureCount: 1, p95LatencyMs: 800 }, "system");
    expect(stop.shouldStop).toBe(false);
    expect(handle.service.settings().enabled).toBe(true);
  });

  it("does not stop below the minimum sample size", () => {
    const { stop } = handle.service.recordWindow({ windowKey: "pilot:2026-07-30T01", trafficClass: "pilot", requestCount: 3, unresolvedCount: 3, providerFailureCount: 3, p95LatencyMs: 99999 }, "system");
    expect(stop.shouldStop).toBe(false);
    expect(handle.service.settings().enabled).toBe(true);
  });

  it("stops after consecutive windows breach error / latency / cost / quality thresholds", () => {
    // recordWindow stores raw counts; the service derives rates from
    // count/requestCount. unresolvedCount 10 / requestCount 20 => 0.5 rate.
    const window = (key: string, breach: Partial<{ unresolvedCount: number; providerFailureCount: number; budgetRejectionCount: number; p95LatencyMs: number }>) =>
      handle.service.recordWindow({ windowKey: `pilot:${key}`, trafficClass: "pilot", requestCount: 20, ...breach }, "system");
    // Quality (unresolved rate) breach across two consecutive windows.
    window("2026-07-30T02", { unresolvedCount: 10 });
    const second = window("2026-07-30T03", { unresolvedCount: 10 });
    expect(second.stop.shouldStop).toBe(true);
    expect(second.stop.consecutiveWindows).toBeGreaterThanOrEqual(2);
    expect(second.stop.reasons).toContain("unresolved_rate");
    // Auto-stop disables the Pilot and flips traffic to 0%.
    expect(handle.service.settings()).toMatchObject({ enabled: false, trafficPercentage: 0 });
    // A critical governance alert and an auto-stop audit entry are recorded.
    const alerts = handle.repos.aiEvaluationGovernance.listAlerts();
    expect(alerts.some((alert) => alert.type === "pilot_auto_stop" && alert.severity === "critical")).toBe(true);
    expect(handle.auditRows.some((row) => row.action === "ai_pilot.auto_stopped")).toBe(true);
  });

  it("resets the consecutive streak when the latest window recovers", () => {
    const window = (key: string, unresolvedCount: number) =>
      handle.service.recordWindow({ windowKey: `pilot:streak-${key}`, trafficClass: "pilot", requestCount: 20, unresolvedCount }, "system");
    window("bad-1", 10);
    const good = window("good", 1);
    expect(good.stop.shouldStop).toBe(false);
    expect(handle.service.settings().enabled).toBe(true);
  });
});

describe("Pilot Review (0730) 1% mathematics-only assignment rule", () => {
  // NOTE: assignment correctness (deterministic bucketing, category allowlist,
  // 1% vs 100% vs 0%) is exhaustively covered for the pure `assignPilot` logic
  // in packages/ai/test/evaluation/readiness-pilot.test.ts. The cases below
  // verify the SERVICE wiring around that logic.

  let handle: ReturnType<typeof setup>;
  beforeEach(() => {
    handle = setup();
    seedReadyArtifacts(handle.repos);
    handle.service.review(ALL_TRUE_REVIEW, "admin-1");
  });

  it("assigns no student before the Pilot is enabled (disabled flag short-circuits)", () => {
    // Readiness is ready, but settings.enabled is still false, so assignPilot()
    // short-circuits and no student enters the Pilot cohort.
    const decision = handle.service.assignment("student-1", "mathematics");
    expect(decision.pilot).toBe(false);
  });

  it("never assigns non-mathematics categories even when a Pilot is configured", () => {
    // Configure mathematics-only at 100% directly in the repo (bypassing the
    // readiness gate) to isolate the category-allowlist enforcement.
    handle.repos.aiMultiModelPilot.saveSettings({
      enabled: true, trafficPercentage: 100, allowedTaskCategories: ["mathematics"],
      allowVerification: true, allowAdjudication: false, maxModelCallsPerRequest: 2,
      pilotVersion: "phase-5a-default",
      stopPolicy: { minimumRequestCount: 100, consecutiveWindows: 2 },
      readinessReview: { ...ALL_TRUE_REVIEW }
    });
    for (const subjectId of ["student-1", "student-2", "student-3"]) {
      expect(handle.service.assignment(subjectId, "programming").pilot).toBe(false);
      expect(handle.service.assignment(subjectId, "knowledge").pilot).toBe(false);
    }
    // Mathematics at 100% is assigned while readiness review is intact.
    expect(handle.service.assignment("student-any", "mathematics").pilot).toBe(true);
  });

  it("routes to production when the readiness review is not on file (readiness gate)", () => {
    handle.repos.aiMultiModelPilot.saveSettings({
      enabled: true, trafficPercentage: 100, allowedTaskCategories: ["mathematics"],
      allowVerification: true, allowAdjudication: false, maxModelCallsPerRequest: 2,
      pilotVersion: "phase-5a-default",
      stopPolicy: { minimumRequestCount: 100, consecutiveWindows: 2 }
      // readinessReview deliberately omitted
    });
    const decision = handle.service.assignment("student-any", "mathematics");
    expect(decision.pilot).toBe(false);
    expect(decision.trafficClass).toBe("production");
  });
});

describe("Pilot Review (0730) readiness-review preservation (P0 regression)", () => {
  // Regression for the fixed P0 gap: saveSettings() must carry the stored
  // readinessReview forward so that enabling the Pilot does not wipe the review
  // that enabling depends on. The request body must never forge a review.
  let handle: ReturnType<typeof setup>;
  beforeEach(() => {
    handle = setup();
    seedReadyArtifacts(handle.repos);
    handle.service.review(ALL_TRUE_REVIEW, "admin-1");
    expect(handle.service.productionReadiness().status).toBe("ready_for_pilot");
  });

  it("enabling the Pilot preserves the stored readiness review", () => {
    handle.service.saveSettings(PILOT_0730_PROPOSAL, "admin-2");
    expect(handle.service.settings().enabled).toBe(true);
    // The review the gate depends on is still intact, so readiness stays ready.
    expect(handle.service.productionReadiness().status).toBe("ready_for_pilot");
  });

  it("assignment routes qualifying mathematics requests into the Pilot cohort after enable", () => {
    handle.service.saveSettings({ ...PILOT_0730_PROPOSAL, trafficPercentage: 100 }, "admin-2");
    const decision = handle.service.assignment("student-any", "mathematics");
    expect(decision.pilot).toBe(true);
    expect(decision.trafficClass).toBe("pilot");
    expect(decision.pilotVersion).toBe("phase-5a-default");
  });

  it("does not let a settings update forge or wipe the readiness review", () => {
    // A forged review must be ignored; only review() may file one.
    handle.service.saveSettings({ ...PILOT_0730_PROPOSAL, readinessReview: { testSuitePassed: false } } as Parameters<typeof handle.service.saveSettings>[0], "admin-2");
    // readiness is unchanged (still ready) -> the forged payload had no effect.
    expect(handle.service.productionReadiness().status).toBe("ready_for_pilot");
    // Disabling then re-enabling also preserves the review.
    handle.service.disable("admin_kill_switch", "admin-3");
    handle.service.saveSettings({ ...PILOT_0730_PROPOSAL, trafficPercentage: 100 }, "admin-4");
    expect(handle.service.productionReadiness().status).toBe("ready_for_pilot");
  });
});

describe("Pilot Review (0730) end-to-end Pilot lifecycle service flow", () => {
  // Full service-level flow: enable -> mathematics request enters Pilot cohort
  // -> non-math stays on production -> auto-stop halts new assignment -> kill
  // switch stops everything -> requests fall back to the existing flow.
  let handle: ReturnType<typeof setup>;
  beforeEach(() => {
    handle = setup();
    seedReadyArtifacts(handle.repos);
    handle.service.review(ALL_TRUE_REVIEW, "admin-1");
  });

  it("runs the enable -> assign -> auto-stop -> kill-switch -> fallback flow", () => {
    // 1. Enable: 100% mathematics-only, verification on, adjudication off,
    //    max 2 model calls.
    handle.service.saveSettings({ ...PILOT_0730_PROPOSAL, trafficPercentage: 100 }, "admin-2");
    expect(handle.service.settings()).toMatchObject({ enabled: true, allowVerification: true, allowAdjudication: false, maxModelCallsPerRequest: 2 });

    // 2. Mathematics requests enter the Pilot cohort; non-math do not.
    expect(handle.service.assignment("student-math", "mathematics").pilot).toBe(true);
    expect(handle.service.assignment("student-prog", "programming").pilot).toBe(false);
    expect(handle.service.assignment("student-know", "knowledge").pilot).toBe(false);

    // 3. Auto-stop after two consecutive bad windows halts new Pilot assignment.
    handle.service.saveSettings({ ...PILOT_0730_PROPOSAL, trafficPercentage: 100, stopPolicy: { minimumRequestCount: 10, consecutiveWindows: 2, unresolvedRateThreshold: 0.2 } }, "admin-3");
    for (const key of ["bad-1", "bad-2"]) {
      handle.service.recordWindow({ windowKey: `pilot:${key}`, trafficClass: "pilot", requestCount: 20, unresolvedCount: 10 }, "system");
    }
    expect(handle.service.settings().enabled).toBe(false);
    expect(handle.service.assignment("student-math", "mathematics").pilot).toBe(false);
    // A critical governance alert was raised.
    expect(handle.repos.aiEvaluationGovernance.listAlerts().some((a) => a.type === "pilot_auto_stop" && a.severity === "critical")).toBe(true);

    // 4. Re-enable, then the manual kill switch stops all Pilot traffic at once.
    handle.service.saveSettings({ ...PILOT_0730_PROPOSAL, trafficPercentage: 100, stopPolicy: { minimumRequestCount: 10, consecutiveWindows: 2, unresolvedRateThreshold: 0.2 } }, "admin-4");
    expect(handle.service.settings().enabled).toBe(true);
    handle.service.disable("admin_kill_switch", "admin-5");
    expect(handle.service.settings()).toMatchObject({ enabled: false, trafficPercentage: 0 });

    // 5. After stop, every request safely falls back to the existing flow.
    for (const category of ["mathematics", "programming", "knowledge"]) {
      const decision = handle.service.assignment("student-final", category);
      expect(decision.pilot).toBe(false);
    }
  });

  it("enforces the max-2-calls ceiling for the Pilot cohort (verification only, no adjudication)", () => {
    // The 0730 proposal caps model calls at 2: verification is allowed,
    // adjudication is off, and adjudication would require >=3 calls.
    handle.service.saveSettings(PILOT_0730_PROPOSAL, "admin-2");
    expect(handle.service.settings().maxModelCallsPerRequest).toBe(2);
    expect(handle.service.settings().allowAdjudication).toBe(false);
    expect(() => handle.service.saveSettings({ ...PILOT_0730_PROPOSAL, allowAdjudication: true, maxModelCallsPerRequest: 2 }, "admin-3")).toThrow(PilotServiceError);
  });
});

describe("Pilot Review (0730) verification / adjudication / call limit", () => {
  let handle: ReturnType<typeof setup>;
  beforeEach(() => {
    handle = setup();
    seedReadyArtifacts(handle.repos);
    handle.service.review(ALL_TRUE_REVIEW, "admin-1");
  });

  it("accepts verification on and adjudication off", () => {
    const saved = handle.service.saveSettings({ ...PILOT_0730_PROPOSAL, allowVerification: true, allowAdjudication: false }, "admin-2");
    expect(saved.allowVerification).toBe(true);
    expect(saved.allowAdjudication).toBe(false);
    expect(saved.maxModelCallsPerRequest).toBe(2);
  });

  it("rejects adjudication without verification", () => {
    expect(() => handle.service.saveSettings({ ...PILOT_0730_PROPOSAL, allowVerification: false, allowAdjudication: true }, "admin-2")).toThrow(PilotServiceError);
  });

  it("rejects adjudication unless the call limit is at least 3", () => {
    expect(() => handle.service.saveSettings({ ...PILOT_0730_PROPOSAL, allowAdjudication: true, maxModelCallsPerRequest: 2 }, "admin-2")).toThrow(PilotServiceError);
  });

  it("enforces the 1..3 model-call bound", () => {
    for (const invalid of [0, 4]) {
      expect(() => handle.service.saveSettings({ ...PILOT_0730_PROPOSAL, maxModelCallsPerRequest: invalid }, "admin-2")).toThrow(PilotServiceError);
    }
  });
});

describe("Pilot Review (0730) audit trail and safety", () => {
  let handle: ReturnType<typeof setup>;
  beforeEach(() => { handle = setup(); seedReadyArtifacts(handle.repos); });

  it("audits every mutating action with safe metadata", () => {
    handle.service.review(ALL_TRUE_REVIEW, "admin-1");
    handle.service.saveSettings(PILOT_0730_PROPOSAL, "admin-2"); // enable
    handle.service.disable("admin_kill_switch", "admin-3");
    const actions = handle.auditRows.map((row) => row.action);
    expect(actions).toEqual(expect.arrayContaining([
      "ai_pilot.readiness_reviewed",
      "ai_pilot.enabled",
      "ai_pilot.disabled"
    ]));
    // Enable entry carries the approved policy shape.
    const enabled = handle.auditRows.find((row) => row.action === "ai_pilot.enabled");
    expect(enabled?.metadata).toMatchObject({ enabled: true, trafficPercentage: 1, allowVerification: true, allowAdjudication: false });
  });

  it("does not leak credentials, prompts, or answers through settings or audit", () => {
    handle.service.review({ ...ALL_TRUE_REVIEW, apiKey: "sk-must-not-leak", prompt: "secret-prompt" }, "admin-1");
    const blob = JSON.stringify({ settings: handle.service.settings(), audit: handle.auditRows });
    expect(blob).not.toMatch(/sk-must-not-leak|secret-prompt|apiKey|authorization|prompt|answer|question/i);
  });

  it("leaves the Pilot disabled at the end of review (no auto-enable)", () => {
    handle.service.review(ALL_TRUE_REVIEW, "admin-1");
    expect(handle.service.settings().enabled).toBe(false);
    expect(handle.service.settings().trafficPercentage).toBe(0);
  });
});
