import { describe, expect, it } from "vitest";
import {
  assignPilot,
  buildLiveEvaluationReadiness,
  DEFAULT_MULTI_MODEL_PILOT_SETTINGS,
  evaluatePilotAutoStop,
  evaluateProductionReadiness,
  validatePilotSettings,
  validatePilotStopPolicy,
  type MultiModelPilotSettings,
  type ProductionReadinessInputs
} from "../../src/evaluation/readiness-pilot";

const readyInput = {
  credentialReady: true, evaluationPoolReady: true, budgetReady: true,
  allowlistReady: true, liveEnabled: true, providerIds: ["openai"], logicalModelIds: ["model"]
};

const productionInput: ProductionReadinessInputs = {
  testSuitePassed: true, typecheckPassed: true, buildPassed: true, diffClean: true, securityScansClean: true,
  credentialPolicyPassed: true, evaluationCredentialPassed: true, evaluationPoolIsolated: true,
  reservationIdempotencyPassed: true, orchestratorSafetyPassed: true, fixtureBaselinePassed: true,
  mockBaselinePassed: true, liveSmokeCompleted: true, liveSmokeSafe: true, regressionAlertsConfigured: true,
  retentionConfigured: true, schedulerDisabledByDefault: true, auditLogReady: true, pilotFeatureFlagReady: true,
  emergencyKillSwitchReady: true, liveRunId: "run-safe"
};

const pilot: MultiModelPilotSettings = {
  ...DEFAULT_MULTI_MODEL_PILOT_SETTINGS,
  enabled: true,
  trafficPercentage: 50,
  allowedTaskCategories: ["mathematics"],
  updatedAt: "2026-07-27T00:00:00.000Z"
};

describe("Phase 5A readiness gate", () => {
  it("reports a complete readiness snapshot", () => expect(buildLiveEvaluationReadiness(readyInput, "fixed")).toMatchObject({ ready: true, blockers: [], checkedAt: "fixed" }));
  it("blocks without a credential", () => expect(buildLiveEvaluationReadiness({ ...readyInput, credentialReady: false }).blockers).toContain("credential_not_ready"));
  it("blocks without an evaluation pool", () => expect(buildLiveEvaluationReadiness({ ...readyInput, evaluationPoolReady: false }).blockers).toContain("evaluation_pool_not_ready"));
  it("blocks without a budget", () => expect(buildLiveEvaluationReadiness({ ...readyInput, budgetReady: false }).blockers).toContain("evaluation_budget_not_ready"));
  it("blocks an incomplete allowlist", () => expect(buildLiveEvaluationReadiness({ ...readyInput, allowlistReady: false }).blockers).toContain("server_allowlist_not_ready"));
  it("blocks when live is disabled", () => expect(buildLiveEvaluationReadiness({ ...readyInput, liveEnabled: false }).blockers).toContain("live_evaluation_disabled"));
  it("warns before a live smoke test exists", () => expect(buildLiveEvaluationReadiness(readyInput).warnings).toContain("live_smoke_test_not_completed"));
  it("does not expose credential fields", () => expect(JSON.stringify(buildLiveEvaluationReadiness(readyInput))).not.toMatch(/apiKey|credentialId|authorization|secret/i));
});

describe("Production Readiness Review", () => {
  it("allows pilot only when every blocker passes", () => expect(evaluateProductionReadiness(productionInput, "fixed")).toMatchObject({ status: "ready_for_pilot", liveRunId: "run-safe" }));
  it("keeps the reviewed smoke run id safe", () => expect(evaluateProductionReadiness(productionInput).liveRunId).toBe("run-safe"));
  it("returns all checks for the review", () => expect(evaluateProductionReadiness(productionInput).checks.length).toBe(20));
  it("never calls a provider while reviewing", () => expect(evaluateProductionReadiness(productionInput).status).toBe("ready_for_pilot"));
  it("blocks when the smoke test is missing", () => expect(evaluateProductionReadiness({ ...productionInput, liveSmokeCompleted: false }).status).toBe("blocked"));
  it("blocks when smoke isolation is unsafe", () => expect(evaluateProductionReadiness({ ...productionInput, liveSmokeSafe: false }).status).toBe("blocked"));
  it("blocks when tests fail", () => expect(evaluateProductionReadiness({ ...productionInput, testSuitePassed: false }).status).toBe("blocked"));
  it("blocks when typecheck fails", () => expect(evaluateProductionReadiness({ ...productionInput, typecheckPassed: false }).status).toBe("blocked"));
  it("blocks when build fails", () => expect(evaluateProductionReadiness({ ...productionInput, buildPassed: false }).status).toBe("blocked"));
  it("blocks when diff is dirty", () => expect(evaluateProductionReadiness({ ...productionInput, diffClean: false }).status).toBe("blocked"));
  it("blocks when security scans fail", () => expect(evaluateProductionReadiness({ ...productionInput, securityScansClean: false }).status).toBe("blocked"));
  it("blocks an invalid production credential policy", () => expect(evaluateProductionReadiness({ ...productionInput, credentialPolicyPassed: false }).status).toBe("blocked"));
  it("blocks an invalid evaluation credential policy", () => expect(evaluateProductionReadiness({ ...productionInput, evaluationCredentialPassed: false }).status).toBe("blocked"));
  it("blocks a shared pool", () => expect(evaluateProductionReadiness({ ...productionInput, evaluationPoolIsolated: false }).status).toBe("blocked"));
  it("blocks broken reservation idempotency", () => expect(evaluateProductionReadiness({ ...productionInput, reservationIdempotencyPassed: false }).status).toBe("blocked"));
  it("blocks an unsafe orchestrator", () => expect(evaluateProductionReadiness({ ...productionInput, orchestratorSafetyPassed: false }).status).toBe("blocked"));
  it("blocks without a fixture baseline", () => expect(evaluateProductionReadiness({ ...productionInput, fixtureBaselinePassed: false }).status).toBe("blocked"));
  it("blocks without a mock baseline", () => expect(evaluateProductionReadiness({ ...productionInput, mockBaselinePassed: false }).status).toBe("blocked"));
  it("blocks without regression alerts", () => expect(evaluateProductionReadiness({ ...productionInput, regressionAlertsConfigured: false }).status).toBe("blocked"));
  it("blocks without retention", () => expect(evaluateProductionReadiness({ ...productionInput, retentionConfigured: false }).status).toBe("blocked"));
  it("blocks if the scheduler is not disabled by default", () => expect(evaluateProductionReadiness({ ...productionInput, schedulerDisabledByDefault: false }).status).toBe("blocked"));
  it("blocks without audit logging", () => expect(evaluateProductionReadiness({ ...productionInput, auditLogReady: false }).status).toBe("blocked"));
  it("blocks without a pilot flag", () => expect(evaluateProductionReadiness({ ...productionInput, pilotFeatureFlagReady: false }).status).toBe("blocked"));
  it("blocks without a kill switch", () => expect(evaluateProductionReadiness({ ...productionInput, emergencyKillSwitchReady: false }).status).toBe("blocked"));
});

describe("Pilot settings and assignment", () => {
  it("defaults disabled with zero traffic", () => expect(DEFAULT_MULTI_MODEL_PILOT_SETTINGS).toMatchObject({ enabled: false, trafficPercentage: 0, allowVerification: true, allowAdjudication: false, maxModelCallsPerRequest: 2 }));
  it("accepts the recommended mathematics-only policy", () => expect(validatePilotSettings(pilot)).toEqual([]));
  it("rejects traffic below zero", () => expect(validatePilotSettings({ ...pilot, trafficPercentage: -1 }).join()).toContain("traffic_percentage_invalid"));
  it("rejects traffic above one hundred", () => expect(validatePilotSettings({ ...pilot, trafficPercentage: 101 }).join()).toContain("traffic_percentage_invalid"));
  it("rejects fractional traffic", () => expect(validatePilotSettings({ ...pilot, trafficPercentage: 1.5 }).join()).toContain("traffic_percentage_invalid"));
  it("rejects zero model calls", () => expect(validatePilotSettings({ ...pilot, maxModelCallsPerRequest: 0 }).join()).toContain("max_model_calls_invalid"));
  it("rejects more than three model calls", () => expect(validatePilotSettings({ ...pilot, maxModelCallsPerRequest: 4 }).join()).toContain("max_model_calls_invalid"));
  it("rejects an invalid pilot version", () => expect(validatePilotSettings({ ...pilot, pilotVersion: "bad version" }).join()).toContain("pilot_version_invalid"));
  it("rejects an empty enabled category set", () => expect(validatePilotSettings({ ...pilot, allowedTaskCategories: [] }).join()).toContain("enabled_requires_category"));
  it("rejects enabled zero traffic", () => expect(validatePilotSettings({ ...pilot, trafficPercentage: 0 }).join()).toContain("enabled_requires_traffic"));
  it("rejects adjudication without verification", () => expect(validatePilotSettings({ ...pilot, allowVerification: false, allowAdjudication: true }).join()).toContain("adjudication_requires_verification"));
  it("rejects an invalid stop policy", () => expect(validatePilotSettings({ ...pilot, stopPolicy: { minimumRequestCount: 0, consecutiveWindows: 1 } }).join()).toContain("minimum_sample_invalid"));
  it("assigns the same student deterministically", () => expect(assignPilot("student-1", pilot, "mathematics")).toBe(assignPilot("student-1", pilot, "mathematics")));
  it("does not assign an absent student id", () => expect(assignPilot(undefined, pilot, "mathematics")).toBe(false));
  it("does not assign a disabled pilot", () => expect(assignPilot("student-1", { ...pilot, enabled: false }, "mathematics")).toBe(false));
  it("does not assign zero traffic", () => expect(assignPilot("student-1", { ...pilot, trafficPercentage: 0 }, "mathematics")).toBe(false));
  it("does not assign a disallowed category", () => expect(assignPilot("student-1", pilot, "programming")).toBe(false));
  it("assigns every user at one hundred percent", () => expect(assignPilot("student-1", { ...pilot, trafficPercentage: 100 }, "mathematics")).toBe(true));
  it("uses a new pilot version as a new deterministic cohort", () => expect(assignPilot("student-1", { ...pilot, pilotVersion: "phase-5a-v2" }, "mathematics")).toBeTypeOf("boolean"));
  it("does not use an IP address as a diagnostic", () => expect(assignPilot("student-1", pilot, "mathematics")).not.toHaveProperty("ip"));
});

describe("Pilot stop policy", () => {
  it("accepts a bounded stop policy", () => expect(validatePilotStopPolicy({ minimumRequestCount: 10, consecutiveWindows: 2, unresolvedRateThreshold: 0.2 })).toEqual([]));
  it("rejects a negative rate threshold", () => expect(validatePilotStopPolicy({ minimumRequestCount: 10, consecutiveWindows: 2, unresolvedRateThreshold: -0.1 })).toContain("rate_threshold_invalid"));
  it("rejects a rate threshold above one", () => expect(validatePilotStopPolicy({ minimumRequestCount: 10, consecutiveWindows: 2, unresolvedRateThreshold: 1.1 })).toContain("rate_threshold_invalid"));
  it("rejects a negative latency threshold", () => expect(validatePilotStopPolicy({ minimumRequestCount: 10, consecutiveWindows: 2, p95LatencyThresholdMs: -1 })).toContain("latency_threshold_invalid"));
  it("rejects no minimum sample", () => expect(validatePilotStopPolicy({ minimumRequestCount: 0, consecutiveWindows: 2 })).toContain("minimum_sample_invalid"));
  it("rejects no consecutive window count", () => expect(validatePilotStopPolicy({ minimumRequestCount: 1, consecutiveWindows: 0 })).toContain("consecutive_windows_invalid"));
  it("does not stop with too few samples", () => expect(evaluatePilotAutoStop([{ windowKey: "1", requestCount: 1, providerFailureRate: 1, unresolvedRate: 1, budgetRejectionRate: 1, p95LatencyMs: 999 }], { minimumRequestCount: 10, consecutiveWindows: 1, unresolvedRateThreshold: 0.2 }).shouldStop).toBe(false));
  it("does not stop below a threshold", () => expect(evaluatePilotAutoStop([{ windowKey: "1", requestCount: 10, providerFailureRate: 0, unresolvedRate: 0.1, budgetRejectionRate: 0, p95LatencyMs: 10 }], { minimumRequestCount: 10, consecutiveWindows: 1, unresolvedRateThreshold: 0.2 }).shouldStop).toBe(false));
  it("stops at an unresolved threshold", () => expect(evaluatePilotAutoStop([{ windowKey: "1", requestCount: 10, providerFailureRate: 0, unresolvedRate: 0.2, budgetRejectionRate: 0, p95LatencyMs: 10 }], { minimumRequestCount: 10, consecutiveWindows: 1, unresolvedRateThreshold: 0.2 }).shouldStop).toBe(true));
  it("stops at a provider failure threshold", () => expect(evaluatePilotAutoStop([{ windowKey: "1", requestCount: 10, providerFailureRate: 0.5, unresolvedRate: 0, budgetRejectionRate: 0, p95LatencyMs: 10 }], { minimumRequestCount: 10, consecutiveWindows: 1, providerFailureRateThreshold: 0.5 }).shouldStop).toBe(true));
  it("stops at a budget rejection threshold", () => expect(evaluatePilotAutoStop([{ windowKey: "1", requestCount: 10, providerFailureRate: 0, unresolvedRate: 0, budgetRejectionRate: 0.5, p95LatencyMs: 10 }], { minimumRequestCount: 10, consecutiveWindows: 1, budgetRejectionRateThreshold: 0.5 }).shouldStop).toBe(true));
  it("stops at a latency threshold", () => expect(evaluatePilotAutoStop([{ windowKey: "1", requestCount: 10, providerFailureRate: 0, unresolvedRate: 0, budgetRejectionRate: 0, p95LatencyMs: 100 }], { minimumRequestCount: 10, consecutiveWindows: 1, p95LatencyThresholdMs: 100 }).shouldStop).toBe(true));
  it("requires consecutive windows", () => expect(evaluatePilotAutoStop([{ windowKey: "1", requestCount: 10, providerFailureRate: 0, unresolvedRate: 0.5, budgetRejectionRate: 0, p95LatencyMs: 10 }], { minimumRequestCount: 10, consecutiveWindows: 2, unresolvedRateThreshold: 0.2 }).shouldStop).toBe(false));
  it("stops after consecutive bad windows", () => expect(evaluatePilotAutoStop([{ windowKey: "1", requestCount: 10, providerFailureRate: 0, unresolvedRate: 0.5, budgetRejectionRate: 0, p95LatencyMs: 10 }, { windowKey: "2", requestCount: 10, providerFailureRate: 0, unresolvedRate: 0.5, budgetRejectionRate: 0, p95LatencyMs: 10 }], { minimumRequestCount: 10, consecutiveWindows: 2, unresolvedRateThreshold: 0.2 }).shouldStop).toBe(true));
  it("does not count an older bad window after a good latest window", () => expect(evaluatePilotAutoStop([{ windowKey: "1", requestCount: 10, providerFailureRate: 0, unresolvedRate: 0.5, budgetRejectionRate: 0, p95LatencyMs: 10 }, { windowKey: "2", requestCount: 10, providerFailureRate: 0, unresolvedRate: 0, budgetRejectionRate: 0, p95LatencyMs: 10 }], { minimumRequestCount: 10, consecutiveWindows: 2, unresolvedRateThreshold: 0.2 }).shouldStop).toBe(false));
  it("returns only safe reason categories", () => expect(evaluatePilotAutoStop([{ windowKey: "1", requestCount: 10, providerFailureRate: 0.5, unresolvedRate: 0, budgetRejectionRate: 0, p95LatencyMs: 10 }], { minimumRequestCount: 10, consecutiveWindows: 1, providerFailureRateThreshold: 0.5 }).reasons).toEqual(["provider_failure_rate"]));
});
