import type { EvaluationRegression, EvaluationRegressionIssue, EvaluationSummary } from "./evaluation-types";

export interface EvaluationBaseline {
  datasetId: string;
  datasetVersion: number;
  executionMode: EvaluationSummary["executionMode"];
  commitSha?: string;
  createdAt: string;
  summary: EvaluationSummary;
}

export interface EvaluationRegressionThresholds {
  maxPassRateDrop: number;
  maxCategoryPassRateDrop: number;
  maxUnresolvedRateIncrease: number;
  maxAverageModelCallsIncrease: number;
}

export const DEFAULT_EVALUATION_REGRESSION_THRESHOLDS: EvaluationRegressionThresholds = {
  maxPassRateDrop: 0.02,
  maxCategoryPassRateDrop: 0.05,
  maxUnresolvedRateIncrease: 0.05,
  maxAverageModelCallsIncrease: 0.5
};

function unresolvedRate(summary: EvaluationSummary): number {
  return (summary.byOutcome.unresolved?.count ?? 0) / Math.max(summary.totalCases, 1);
}

export function compareEvaluationBaseline(current: EvaluationSummary, baseline: EvaluationBaseline, thresholds = DEFAULT_EVALUATION_REGRESSION_THRESHOLDS): EvaluationRegression {
  if (current.datasetId !== baseline.datasetId || current.datasetVersion !== baseline.datasetVersion || current.executionMode !== baseline.executionMode) {
    return { comparable: false, reason: "dataset_id_version_or_mode_mismatch", passRateDelta: 0, averageScoreDelta: 0, p95LatencyDeltaMs: 0, averageModelCallsDelta: 0, regressions: [] };
  }
  const regressions: EvaluationRegressionIssue[] = [];
  const passRateDelta = current.passRate - baseline.summary.passRate;
  if (passRateDelta < -thresholds.maxPassRateDrop) regressions.push({ code: "pass_rate", severity: "error", message: "overall pass rate regressed beyond threshold" });
  for (const [category, baselineGroup] of Object.entries(baseline.summary.byCategory)) {
    const currentRate = current.byCategory[category]?.passRate ?? 0;
    if (currentRate - baselineGroup.passRate < -thresholds.maxCategoryPassRateDrop) regressions.push({ code: "category_pass_rate", severity: "error", message: `category ${category} pass rate regressed beyond threshold` });
  }
  if (unresolvedRate(current) - unresolvedRate(baseline.summary) > thresholds.maxUnresolvedRateIncrease) regressions.push({ code: "unresolved_rate", severity: "error", message: "unresolved rate increased beyond threshold" });
  const averageModelCallsDelta = current.averageModelCalls - baseline.summary.averageModelCalls;
  if (averageModelCallsDelta > thresholds.maxAverageModelCallsIncrease) regressions.push({ code: "model_calls", severity: "error", message: "average model calls increased beyond threshold" });
  return { comparable: true, passRateDelta, averageScoreDelta: current.averageScore - baseline.summary.averageScore, p95LatencyDeltaMs: current.p95DurationMs - baseline.summary.p95DurationMs, averageModelCallsDelta, totalTokenDelta: current.totalTokens !== undefined && baseline.summary.totalTokens !== undefined ? current.totalTokens - baseline.summary.totalTokens : undefined, regressions };
}
