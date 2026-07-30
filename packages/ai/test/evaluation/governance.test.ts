import { describe, expect, it } from "vitest";
import {
  budgetAlertTypes,
  compareGovernanceRuns,
  DEFAULT_EVALUATION_RETENTION_POLICY,
  retentionCandidates,
  regressionAlertSeverity,
  scheduleWindowKey,
  scheduledWindowIsDue,
  validateRetentionPolicy,
  validateSchedule,
  type EvaluationRegressionAlertPolicy,
  type GovernanceRunSnapshot
} from "../../src/evaluation/governance";

function run(overrides: Partial<GovernanceRunSnapshot> = {}): GovernanceRunSnapshot {
  return { id: "run-1", datasetId: "phase-4a-core", datasetVersion: 1, executionMode: "fixture", status: "completed", createdAt: "2026-07-20T00:00:00.000Z", totalCases: 10, passRate: 0.9, averageScore: 0.9, unresolvedRate: 0, conflictRate: 0, averageModelCalls: 1, p95DurationMs: 10, totalTokens: 100, regressionIssueCount: 0, baselineRunId: null, ...overrides };
}
const alertPolicy: EvaluationRegressionAlertPolicy = { enabled: true, minimumSampleSize: 5, passRateDropPercentagePoints: 5, categoryPassRateDropPercentagePoints: 5, unresolvedRateIncreasePercentagePoints: 5, conflictRateIncreasePercentagePoints: 5, averageModelCallsIncrease: 1, p95LatencyIncreaseMs: 20, consecutiveFailuresRequired: 2 };

describe("Phase 4D governance domain", () => {
  it("defaults retention to disabled", () => expect(DEFAULT_EVALUATION_RETENTION_POLICY.enabled).toBe(false));
  it("rejects zero max runs", () => expect(validateRetentionPolicy({ ...DEFAULT_EVALUATION_RETENTION_POLICY, maxRunsPerDatasetMode: 0 })).toContain("max_runs_invalid"));
  it("rejects negative preserved count", () => expect(validateRetentionPolicy({ ...DEFAULT_EVALUATION_RETENTION_POLICY, preserveLatestSuccessful: -1 })).toContain("preserve_latest_invalid"));
  it("rejects non-positive max age", () => expect(validateRetentionPolicy({ ...DEFAULT_EVALUATION_RETENTION_POLICY, maxAgeDays: 0 })).toContain("max_age_invalid"));
  it("accepts a valid retention policy", () => expect(validateRetentionPolicy(DEFAULT_EVALUATION_RETENTION_POLICY)).toEqual([]));
  it("disabled retention makes no candidates", () => expect(retentionCandidates([run()], DEFAULT_EVALUATION_RETENTION_POLICY).candidates).toHaveLength(0));
  it("preserves running runs", () => { const result = retentionCandidates([run({ status: "running" })], { ...DEFAULT_EVALUATION_RETENTION_POLICY, enabled: true, maxRunsPerDatasetMode: 1 }); expect(result.candidates).toHaveLength(0); });
  it("preserves pending confirmation runs", () => { const result = retentionCandidates([run({ status: "pending_confirmation" })], { ...DEFAULT_EVALUATION_RETENTION_POLICY, enabled: true, maxRunsPerDatasetMode: 1 }); expect(result.candidates).toHaveLength(0); });
  it("preserves latest successful run", () => { const result = retentionCandidates([run({ id: "old", createdAt: "2026-07-19T00:00:00.000Z" }), run({ id: "new", createdAt: "2026-07-20T00:00:00.000Z" })], { ...DEFAULT_EVALUATION_RETENTION_POLICY, enabled: true, maxRunsPerDatasetMode: 1 }); expect(result.candidates.map((item) => item.id)).toEqual(["old"]); });
  it("preserves baseline referenced by another run", () => { const result = retentionCandidates([run({ id: "baseline" }), run({ id: "latest", baselineRunId: "baseline", createdAt: "2026-07-21T00:00:00.000Z" })], { ...DEFAULT_EVALUATION_RETENTION_POLICY, enabled: true, maxRunsPerDatasetMode: 1 }); expect(result.candidates.map((item) => item.id)).not.toContain("baseline"); });
  it("preserves runs with regression issues by default", () => { const result = retentionCandidates([run({ id: "regression", regressionIssueCount: 2 }), run({ id: "latest", createdAt: "2026-07-21T00:00:00.000Z" })], { ...DEFAULT_EVALUATION_RETENTION_POLICY, enabled: true, maxRunsPerDatasetMode: 1 }); expect(result.candidates.map((item) => item.id)).not.toContain("regression"); });
  it("selects max-run overflow", () => { const result = retentionCandidates([run({ id: "old", createdAt: "2026-07-19T00:00:00.000Z" }), run({ id: "new", createdAt: "2026-07-20T00:00:00.000Z" })], { ...DEFAULT_EVALUATION_RETENTION_POLICY, enabled: true, maxRunsPerDatasetMode: 1, preserveLatestSuccessful: 0 }); expect(result.candidates[0]?.reason).toBe("max_runs_exceeded"); });
  it("selects max-age overflow", () => { const result = retentionCandidates([run({ id: "old", createdAt: "2026-07-01T00:00:00.000Z" })], { ...DEFAULT_EVALUATION_RETENTION_POLICY, enabled: true, maxRunsPerDatasetMode: 10, preserveLatestSuccessful: 0, maxAgeDays: 7 }, new Date("2026-07-20T00:00:00.000Z")); expect(result.candidates[0]?.reason).toBe("max_age_exceeded"); });
  it("does not mix execution modes", () => { const result = retentionCandidates([run({ id: "fixture" }), run({ id: "mock", executionMode: "mock_orchestrator", createdAt: "2026-07-21T00:00:00.000Z" })], { ...DEFAULT_EVALUATION_RETENTION_POLICY, enabled: true, maxRunsPerDatasetMode: 1, preserveLatestSuccessful: 0, executionModes: ["fixture"] }); expect(result.candidates.map((item) => item.id)).toEqual([]); });
  it("does not mix dataset versions", () => { const result = retentionCandidates([run({ id: "v1" }), run({ id: "v2", datasetVersion: 2, createdAt: "2026-07-21T00:00:00.000Z" })], { ...DEFAULT_EVALUATION_RETENTION_POLICY, enabled: true, maxRunsPerDatasetMode: 1, preserveLatestSuccessful: 0 }); expect(result.candidates).toHaveLength(0); });
  it("rejects live schedule", () => expect(validateSchedule({ enabled: false, datasetId: "phase-4a-core", datasetVersion: 1, executionMode: "live" as never, cadence: "daily", scheduledTime: "03:00", timezone: "Asia/Taipei", baselinePolicy: "latest_comparable" })).toContain("live_schedule_forbidden"));
  it("rejects missing dataset format", () => expect(validateSchedule({ enabled: false, datasetId: "../secret", datasetVersion: 1, executionMode: "fixture", cadence: "daily", scheduledTime: "03:00", timezone: "Asia/Taipei", baselinePolicy: "latest_comparable" })).toContain("dataset_not_allowed"));
  it("rejects zero schedule version", () => expect(validateSchedule({ enabled: false, datasetId: "phase-4a-core", datasetVersion: 0, executionMode: "fixture", cadence: "daily", scheduledTime: "03:00", timezone: "Asia/Taipei", baselinePolicy: "latest_comparable" })).toContain("version_invalid"));
  it("rejects invalid cadence", () => expect(validateSchedule({ enabled: false, datasetId: "phase-4a-core", datasetVersion: 1, executionMode: "fixture", cadence: "hourly" as never, scheduledTime: "03:00", timezone: "Asia/Taipei", baselinePolicy: "latest_comparable" })).toContain("cadence_invalid"));
  it("rejects invalid time", () => expect(validateSchedule({ enabled: false, datasetId: "phase-4a-core", datasetVersion: 1, executionMode: "fixture", cadence: "daily", scheduledTime: "25:00", timezone: "Asia/Taipei", baselinePolicy: "latest_comparable" })).toContain("scheduled_time_invalid"));
  it("requires fixed baseline id", () => expect(validateSchedule({ enabled: false, datasetId: "phase-4a-core", datasetVersion: 1, executionMode: "fixture", cadence: "daily", scheduledTime: "03:00", timezone: "Asia/Taipei", baselinePolicy: "fixed" })).toContain("fixed_baseline_required"));
  it("rejects invalid timezone", () => expect(validateSchedule({ enabled: false, datasetId: "phase-4a-core", datasetVersion: 1, executionMode: "fixture", cadence: "daily", scheduledTime: "03:00", timezone: "Not/AZone", baselinePolicy: "latest_comparable" })).toContain("timezone_invalid"));
  it("accepts daily schedule", () => expect(validateSchedule({ enabled: false, datasetId: "phase-4a-core", datasetVersion: 1, executionMode: "fixture", cadence: "daily", scheduledTime: "03:00", timezone: "Asia/Taipei", baselinePolicy: "latest_comparable" })).toEqual([]));
  it("accepts weekly schedule", () => expect(validateSchedule({ enabled: false, datasetId: "phase-4a-core", datasetVersion: 1, executionMode: "fixture", cadence: "weekly", scheduledTime: "03:00", timezone: "UTC", baselinePolicy: "latest_comparable" })).toEqual([]));
  it("daily window is timezone-specific", () => expect(scheduleWindowKey({ id: "s1", cadence: "daily", timezone: "Asia/Taipei" }, new Date("2026-07-27T19:00:00.000Z"))).toBe("s1:2026-07-28"));
  it("weekly window is stable for same week", () => expect(scheduleWindowKey({ id: "s1", cadence: "weekly", timezone: "UTC" }, new Date("2026-07-29T00:00:00.000Z"))).toBe("s1:2026-07-26"));
  it("due checks explicit timezone time", () => expect(scheduledWindowIsDue({ scheduledTime: "03:00", timezone: "Asia/Taipei" }, new Date("2026-07-26T19:00:00.000Z"))).toBe(true));
  it("not due before scheduled time", () => expect(scheduledWindowIsDue({ scheduledTime: "03:00", timezone: "Asia/Taipei" }, new Date("2026-07-26T18:59:00.000Z"))).toBe(false));
  it("remains due after scheduled time until claimed", () => expect(scheduledWindowIsDue({ scheduledTime: "03:00", timezone: "Asia/Taipei" }, new Date("2026-07-26T19:01:00.000Z"))).toBe(true));
  it("does not compare different datasets", () => expect(compareGovernanceRuns(run({ datasetId: "other" }), run(), alertPolicy)).toEqual([]));
  it("does not compare different versions", () => expect(compareGovernanceRuns(run({ datasetVersion: 2 }), run(), alertPolicy)).toEqual([]));
  it("does not compare different modes", () => expect(compareGovernanceRuns(run({ executionMode: "mock_orchestrator" }), run(), alertPolicy)).toEqual([]));
  it("does not compare undersized samples", () => expect(compareGovernanceRuns(run({ totalCases: 4, passRate: 0 }), run(), alertPolicy)).toEqual([]));
  it("detects pass rate regression", () => expect(compareGovernanceRuns(run({ passRate: 0.8 }), run(), alertPolicy)).toContain("pass_rate_regression"));
  it("detects unresolved increase", () => expect(compareGovernanceRuns(run({ unresolvedRate: 0.1 }), run(), alertPolicy)).toContain("unresolved_rate_increase"));
  it("detects conflict increase", () => expect(compareGovernanceRuns(run({ conflictRate: 0.1 }), run(), alertPolicy)).toContain("conflict_rate_increase"));
  it("detects model call increase", () => expect(compareGovernanceRuns(run({ averageModelCalls: 2.1 }), run(), alertPolicy)).toContain("model_calls_increase"));
  it("detects latency increase", () => expect(compareGovernanceRuns(run({ p95DurationMs: 31 }), run(), alertPolicy)).toContain("latency_increase"));
  it("detects category regression", () => expect(compareGovernanceRuns(run(), run(), alertPolicy, [{ dimension: "category", dimensionValue: "mathematics", passRate: 0.7 }], [{ dimension: "category", dimensionValue: "mathematics", passRate: 0.9 }])).toContain("category_regression"));
  it("does not flag a stable run", () => expect(compareGovernanceRuns(run(), run(), alertPolicy)).toEqual([]));
  it("live comparison requires same model set", () => expect(compareGovernanceRuns(run({ executionMode: "live", logicalModelIds: ["a"] }), run({ executionMode: "live", logicalModelIds: ["b"] }), alertPolicy)).toEqual([]));
  it("live comparison ignores model ordering", () => expect(compareGovernanceRuns(run({ executionMode: "live", logicalModelIds: ["b", "a"] }), run({ executionMode: "live", logicalModelIds: ["a", "b"] }), alertPolicy)).toEqual([]));
  it("disabled alert policy emits no alerts", () => expect(compareGovernanceRuns(run({ passRate: 0 }), run(), { ...alertPolicy, enabled: false })).toEqual([]));
  it("pool threshold creates pool alert", () => expect(budgetAlertTypes({ evaluationPoolRemainingThreshold: 10 }, 10, 100)).toContain("evaluation_pool_low"));
  it("daily threshold creates budget alert", () => expect(budgetAlertTypes({ dailyBudgetRemainingThreshold: 10 }, 100, 10)).toContain("budget_low"));
  it("threshold above remaining is inclusive", () => expect(budgetAlertTypes({ dailyBudgetRemainingThreshold: 11 }, undefined, 10)).toEqual(["budget_low"]));
  it("missing pool observation does not alert", () => expect(budgetAlertTypes({ evaluationPoolRemainingThreshold: 10 }, undefined, 100)).toEqual([]));
  it("missing daily observation does not alert", () => expect(budgetAlertTypes({ dailyBudgetRemainingThreshold: 10 }, 100, undefined)).toEqual([]));
  it("budget policy with no thresholds is silent", () => expect(budgetAlertTypes({}, 0, 0)).toEqual([]));
  it("first regression below required count is warning", () => expect(regressionAlertSeverity(1, 2)).toBe("warning"));
  it("consecutive regression at threshold is critical", () => expect(regressionAlertSeverity(2, 2)).toBe("critical"));
  it("retention candidate count is deterministic", () => { const input = [run({ id: "a" }), run({ id: "b", createdAt: "2026-07-19T00:00:00.000Z" })]; const policy = { ...DEFAULT_EVALUATION_RETENTION_POLICY, enabled: true, maxRunsPerDatasetMode: 1, preserveLatestSuccessful: 0 }; expect(retentionCandidates(input, policy).candidates.map((item) => item.id)).toEqual(retentionCandidates(input, policy).candidates.map((item) => item.id)); });
  it("retention policy can exclude live", () => { const result = retentionCandidates([run({ executionMode: "live" })], { ...DEFAULT_EVALUATION_RETENTION_POLICY, enabled: true, executionModes: ["fixture"] }); expect(result.candidates).toHaveLength(0); });
  it("failed runs are eligible when not protected", () => { const result = retentionCandidates([run({ id: "failed-old", status: "failed" }), run({ id: "failed-new", status: "failed", createdAt: "2026-07-21T00:00:00.000Z" })], { ...DEFAULT_EVALUATION_RETENTION_POLICY, enabled: true, maxRunsPerDatasetMode: 1, preserveLatestSuccessful: 0 }); expect(result.candidates.map((item) => item.id)).toEqual(["failed-old"]); });
  it("retention preserves latest successful count", () => { const result = retentionCandidates([run({ id: "one" }), run({ id: "two", createdAt: "2026-07-21T00:00:00.000Z" }), run({ id: "three", createdAt: "2026-07-22T00:00:00.000Z" })], { ...DEFAULT_EVALUATION_RETENTION_POLICY, enabled: true, maxRunsPerDatasetMode: 1, preserveLatestSuccessful: 2 }); expect(result.candidates.map((item) => item.id)).toEqual(["one"]); });
  it("retention preview fields use safe ids only", () => { const candidate = retentionCandidates([run({ id: "safe-id" }), run({ id: "new", createdAt: "2026-07-21T00:00:00.000Z" })], { ...DEFAULT_EVALUATION_RETENTION_POLICY, enabled: true, maxRunsPerDatasetMode: 1, preserveLatestSuccessful: 0 }).candidates[0]; expect(candidate).toMatchObject({ id: "safe-id", datasetId: "phase-4a-core" }); expect(candidate).not.toHaveProperty("question"); });
});
