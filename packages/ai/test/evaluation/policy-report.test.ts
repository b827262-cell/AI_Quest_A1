import { describe, expect, it } from "vitest";
import { toEvaluationMarkdown, validateLiveEvaluationPolicy } from "../../src";

const emptyReport = {
  dataset: { id: "dataset", version: 1 },
  executionMode: "fixture" as const,
  summary: {
    datasetId: "dataset", datasetVersion: 1, executionMode: "fixture" as const,
    totalCases: 0, passedCases: 0, failedCases: 0, passRate: 0, averageScore: 0,
    byCategory: {}, byDifficulty: {}, byOutcome: {}, byConfidence: {}, confidenceCalibration: [],
    averageDurationMs: 0, p50DurationMs: 0, p95DurationMs: 0, totalModelCalls: 0, averageModelCalls: 0
  },
  results: [],
  warnings: []
};

const base = {
  allowLiveFlag: true,
  environmentAllowLive: "true",
  credentialUsageScope: "staging" as const,
  billingMode: "pay_as_you_go" as const,
  providerHealth: "healthy" as const,
  adminApproved: true,
  maxCases: 2,
  maxTokenBudget: 100
};

describe("live evaluation safety policy", () => {
  it("rejects without flag", () => expect(validateLiveEvaluationPolicy({ ...base, allowLiveFlag: false }).allowed).toBe(false));
  it("rejects without environment variable", () => expect(validateLiveEvaluationPolicy({ ...base, environmentAllowLive: "false" }).allowed).toBe(false));
  it("rejects Personal Plan production credential", () => expect(validateLiveEvaluationPolicy({ ...base, credentialUsageScope: "production", billingMode: "token_plan_personal" }).reason).toBe("personal_plan_production"));
  it("allows Personal Plan development interactive", () => expect(validateLiveEvaluationPolicy({ ...base, credentialUsageScope: "development_interactive", billingMode: "token_plan_personal" }).allowed).toBe(true));
  it("rejects unhealthy provider", () => expect(validateLiveEvaluationPolicy({ ...base, providerHealth: "access_denied" }).allowed).toBe(false));
  it("requires admin approval", () => expect(validateLiveEvaluationPolicy({ ...base, adminApproved: false }).allowed).toBe(false));
  it("requires max cases", () => expect(validateLiveEvaluationPolicy({ ...base, maxCases: undefined }).reason).toBe("max_cases_required"));
  it("requires token budget", () => expect(validateLiveEvaluationPolicy({ ...base, maxTokenBudget: undefined }).reason).toBe("token_budget_required"));
});

describe("safe report surface", () => {
  it("does not render question or answer columns", () => expect(toEvaluationMarkdown(emptyReport, []).toLowerCase()).not.toContain("question"));
  it("keeps report warnings explicit", () => expect(toEvaluationMarkdown({ ...emptyReport, warnings: ["offline only"] }, [])).toContain("offline only"));
});
