import { describe, expect, it } from "vitest";
import {
  DEFAULT_EVALUATION_REGRESSION_THRESHOLDS,
  MockEvaluationOrchestrator,
  MultiModelOrchestratorEvaluationAdapter,
  aggregateEvaluationMetrics,
  compareEvaluationBaseline,
  parseEvaluationFixtures,
  runEvaluation,
  toEvaluationJson,
  toEvaluationMarkdown,
  type EvaluationCase,
  type EvaluationCaseResult,
  type EvaluationDataset,
  type EvaluationSummary
} from "../../src";

function result(overrides: Partial<EvaluationCaseResult> = {}): EvaluationCaseResult {
  return { caseId: "case-001", datasetVersion: 1, category: "knowledge", difficulty: "easy", passed: true, score: 1, scoringMethod: "exact", modelCallCount: 1, durationMs: 10, issues: [], ...overrides };
}
function summary(overrides: Partial<EvaluationSummary> = {}): EvaluationSummary {
  return aggregateEvaluationMetrics({ datasetId: "dataset", datasetVersion: 1, executionMode: "fixture", results: [result(), result({ caseId: "case-002", passed: false, score: 0, durationMs: 30, outcome: "unresolved", confidenceLevel: "low" })] });
}
const testCase: EvaluationCase = { id: "case-001", version: 1, category: "knowledge", difficulty: "easy", question: "synthetic", expected: { kind: "exact", acceptedAnswers: ["ok"] }, source: "synthetic", enabled: true };

describe("evaluation metrics", () => {
  it("calculates overall pass rate", () => expect(summary().passRate).toBe(0.5));
  it("calculates category breakdown", () => expect(summary().byCategory.knowledge.count).toBe(2));
  it("calculates difficulty breakdown", () => expect(summary().byDifficulty.easy.count).toBe(2));
  it("calculates outcome breakdown", () => expect(summary().byOutcome.unresolved.count).toBe(1));
  it("calculates confidence calibration", () => expect(summary().confidenceCalibration.find((row) => row.confidenceLevel === "low")).toMatchObject({ total: 1, passed: 0, empiricalPassRate: 0 }));
  it("calculates average duration", () => expect(summary().averageDurationMs).toBe(20));
  it("calculates p50 duration", () => expect(summary().p50DurationMs).toBe(10));
  it("calculates p95 duration", () => expect(summary().p95DurationMs).toBe(30));
  it("calculates average model calls", () => expect(summary().averageModelCalls).toBe(1));
  it("calculates token totals", () => expect(aggregateEvaluationMetrics({ datasetId: "dataset", datasetVersion: 1, executionMode: "fixture", results: [result({ inputTokens: 2, outputTokens: 3, totalTokens: 5 })] })).toMatchObject({ totalInputTokens: 2, totalOutputTokens: 3, totalTokens: 5 }));
  it("handles an empty dataset safely", () => expect(aggregateEvaluationMetrics({ datasetId: "empty", datasetVersion: 1, executionMode: "fixture", results: [] })).toMatchObject({ totalCases: 0, passRate: 0, p50DurationMs: 0, p95DurationMs: 0 }));
  it("does not call confidence a real-world probability", () => expect(summary().confidenceCalibration[0]).toHaveProperty("empiricalPassRate"));
});

describe("evaluation baseline regression", () => {
  it("compares the same dataset", () => {
    const current = summary();
    const regression = compareEvaluationBaseline(current, { datasetId: "dataset", datasetVersion: 1, executionMode: "fixture", createdAt: "2026-01-01T00:00:00Z", summary: current });
    expect(regression.comparable).toBe(true);
  });
  it.each([
    ["dataset id", { datasetId: "other", datasetVersion: 1, executionMode: "fixture" as const }],
    ["version", { datasetId: "dataset", datasetVersion: 2, executionMode: "fixture" as const }],
    ["mode", { datasetId: "dataset", datasetVersion: 1, executionMode: "mock_orchestrator" as const }]
  ])("rejects comparison with different %s", (_name, identity) => {
    expect(compareEvaluationBaseline(summary(), { ...identity, createdAt: "2026-01-01T00:00:00Z", summary: summary() }).comparable).toBe(false);
  });
  it("reports pass rate regression", () => {
    const baseline = summary();
    const current = aggregateEvaluationMetrics({ datasetId: "dataset", datasetVersion: 1, executionMode: "fixture", results: [result({ passed: false, score: 0 })] });
    const regression = compareEvaluationBaseline(current, { datasetId: "dataset", datasetVersion: 1, executionMode: "fixture", createdAt: "2026-01-01T00:00:00Z", summary: baseline }, { ...DEFAULT_EVALUATION_REGRESSION_THRESHOLDS, maxPassRateDrop: 0 });
    expect(regression.regressions.some((item) => item.code === "pass_rate")).toBe(true);
  });
  it("reports category regression", () => {
    const baseline = summary();
    const current = aggregateEvaluationMetrics({ datasetId: "dataset", datasetVersion: 1, executionMode: "fixture", results: [result({ passed: false, score: 0 })] });
    expect(compareEvaluationBaseline(current, { datasetId: "dataset", datasetVersion: 1, executionMode: "fixture", createdAt: "2026-01-01T00:00:00Z", summary: baseline }, { ...DEFAULT_EVALUATION_REGRESSION_THRESHOLDS, maxCategoryPassRateDrop: 0 }).regressions.some((item) => item.code === "category_pass_rate")).toBe(true);
  });
  it("does not compare mismatched baselines", () => expect(compareEvaluationBaseline(summary(), { datasetId: "different", datasetVersion: 1, executionMode: "fixture", createdAt: "now", summary: summary() }).regressions).toHaveLength(0));
  it("does not include sensitive fields in the baseline type output", () => expect(JSON.stringify({ datasetId: "dataset", datasetVersion: 1, executionMode: "fixture", summary: summary() })).not.toMatch(/api[_-]?key|authorization|credential/i));
});

describe("evaluation runner and reports", () => {
  const dataset: EvaluationDataset = { id: "runner-dataset", version: 1, cases: [testCase, { ...testCase, id: "disabled-001", enabled: false }] };
  const fixtures = parseEvaluationFixtures({ "case-001": { answer: "ok", primaryAnswer: "ok", modelCallCount: 1, durationMs: 2, safeDiagnostics: { outcome: "verified", answer: "must not be emitted" } } });
  it("fixture mode does not call a provider", async () => {
    const output = await runEvaluation(dataset, { mode: "fixture", fixtures });
    expect(output.results).toHaveLength(1);
    expect(output.results[0]?.passed).toBe(true);
  });
  it("mock mode uses the mock orchestrator", async () => {
    const mock = new MockEvaluationOrchestrator(fixtures);
    await runEvaluation(dataset, { mode: "mock_orchestrator", fixtures, orchestrator: mock });
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]?.requestId).toBe("eval:runner-dataset:case-001:primary");
  });
  it("adapts the existing Orchestrator without exposing raw model text", async () => {
    const adapter = new MultiModelOrchestratorEvaluationAdapter({
      async runWithFusion(request) {
        return {
          finalAnswer: "safe final",
          primary: {
            output: {
              result: { provider: "mock", model: "mock", answer: "primary", inputTokens: 2, outputTokens: 3, totalTokens: 5, latencyMs: 0 },
              decision: { subject: "general", taskType: "question_answering", complexity: "low", preferredProvider: "mock", fallbackProviders: [], reason: "evaluation" },
              fallbackUsed: false,
              failedProviders: []
            },
            utilizationRatio: 0
          },
          diagnostics: { outcome: "verified", verificationAttempted: true, adjudicationAttempted: false, conflictDetected: false, modelCallCount: 2 },
          confidence: { level: "high", basis: "model_verified" }
        };
      }
    });
    const result = await adapter.run({ requestId: "eval:adapter:case-001:primary", testCase });
    expect(result).toMatchObject({ answer: "safe final", primaryAnswer: "primary", modelCallCount: 2 });
    expect(result.safeDiagnostics).not.toHaveProperty("answer");
  });
  it("filters by category and difficulty", async () => {
    expect((await runEvaluation(dataset, { fixtures, category: "knowledge", difficulty: "easy" })).results).toHaveLength(1);
  });
  it("default mode is fixture", async () => expect((await runEvaluation(dataset, { fixtures })).report.executionMode).toBe("fixture"));
  it("live mode is not silently enabled", async () => await expect(runEvaluation(dataset, { mode: "live", fixtures })).rejects.toThrow());
  it("uses evaluation-only request namespace in mock mode", async () => {
    const mock = new MockEvaluationOrchestrator(fixtures);
    await runEvaluation(dataset, { mode: "mock_orchestrator", fixtures, orchestrator: mock });
    expect(mock.calls.every((call) => call.requestId.startsWith("eval:"))).toBe(true);
  });
  it("JSON report is serializable", async () => {
    const report = (await runEvaluation(dataset, { fixtures })).report;
    expect(() => JSON.parse(toEvaluationJson(report))).not.toThrow();
  });
  it("Markdown contains summary", async () => expect(toEvaluationMarkdown((await runEvaluation(dataset, { fixtures })).report, dataset.cases)).toContain("# Evaluation Summary"));
  it("Markdown contains failed case table", async () => {
    const output = await runEvaluation({ ...dataset, cases: [{ ...testCase, id: "failed-001" }] }, { fixtures: {} });
    expect(toEvaluationMarkdown(output.report, dataset.cases)).toContain("## Failed Cases");
  });
  it("report does not contain the complete answer", async () => {
    const report = toEvaluationJson((await runEvaluation(dataset, { fixtures })).report);
    expect(report).not.toContain("must not be emitted");
  });
  it("missing fixture is a safe failed result", async () => expect((await runEvaluation({ ...dataset, cases: [testCase] }, { fixtures: {} })).results[0]?.issues[0]?.code).toBe("exact_mismatch"));
  it("limits maximum cases", async () => expect((await runEvaluation({ ...dataset, cases: [testCase, { ...testCase, id: "case-002" }] }, { fixtures, maxCases: 1 })).results).toHaveLength(1));
  it("does not write a formal usage log", async () => expect((await runEvaluation(dataset, { fixtures })).report).not.toHaveProperty("usageLog"));
});
