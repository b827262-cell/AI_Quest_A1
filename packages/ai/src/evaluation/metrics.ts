import type { ConfidenceCalibrationRow, EvaluationCaseResult, EvaluationExecutionMode, EvaluationMetricGroup, EvaluationSummary } from "./evaluation-types";

function group(results: EvaluationCaseResult[]): EvaluationMetricGroup {
  if (results.length === 0) return { count: 0, passed: 0, passRate: 0, averageScore: 0 };
  return {
    count: results.length,
    passed: results.filter((result) => result.passed).length,
    passRate: results.filter((result) => result.passed).length / results.length,
    averageScore: results.reduce((sum, result) => sum + result.score, 0) / results.length
  };
}

function grouped(results: EvaluationCaseResult[], key: (result: EvaluationCaseResult) => string | undefined): Record<string, EvaluationMetricGroup> {
  const values = new Map<string, EvaluationCaseResult[]>();
  for (const result of results) {
    const name = key(result) ?? "unknown";
    const current = values.get(name) ?? [];
    current.push(result);
    values.set(name, current);
  }
  return Object.fromEntries([...values.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, items]) => [name, group(items)]));
}

function percentile(values: number[], percentileValue: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(percentileValue * sorted.length) - 1));
  return sorted[index] ?? 0;
}

export function aggregateEvaluationMetrics(input: {
  datasetId: string;
  datasetVersion: number;
  executionMode: EvaluationExecutionMode;
  results: EvaluationCaseResult[];
}): EvaluationSummary {
  const { results } = input;
  const totalCases = results.length;
  const passedCases = results.filter((result) => result.passed).length;
  const durations = results.map((result) => result.durationMs);
  const totalInputTokens = results.reduce((sum, result) => sum + (result.inputTokens ?? 0), 0);
  const totalOutputTokens = results.reduce((sum, result) => sum + (result.outputTokens ?? 0), 0);
  const totalTokens = results.reduce((sum, result) => sum + (result.totalTokens ?? 0), 0);
  const confidenceLevels: ConfidenceCalibrationRow["confidenceLevel"][] = ["high", "medium", "low", "unverified"];
  const confidenceCalibration: ConfidenceCalibrationRow[] = confidenceLevels.map((confidenceLevel) => {
    const items = results.filter((result) => result.confidenceLevel === confidenceLevel);
    return { confidenceLevel, total: items.length, passed: items.filter((result) => result.passed).length, empiricalPassRate: items.length === 0 ? 0 : items.filter((result) => result.passed).length / items.length };
  });
  return {
    datasetId: input.datasetId,
    datasetVersion: input.datasetVersion,
    executionMode: input.executionMode,
    totalCases,
    passedCases,
    failedCases: totalCases - passedCases,
    passRate: totalCases === 0 ? 0 : passedCases / totalCases,
    averageScore: totalCases === 0 ? 0 : results.reduce((sum, result) => sum + result.score, 0) / totalCases,
    byCategory: grouped(results, (result) => result.category),
    byDifficulty: grouped(results, (result) => result.difficulty),
    byOutcome: grouped(results, (result) => result.outcome),
    byConfidence: grouped(results, (result) => result.confidenceLevel),
    confidenceCalibration,
    averageDurationMs: totalCases === 0 ? 0 : durations.reduce((sum, value) => sum + value, 0) / totalCases,
    p50DurationMs: percentile(durations, 0.5),
    p95DurationMs: percentile(durations, 0.95),
    totalModelCalls: results.reduce((sum, result) => sum + result.modelCallCount, 0),
    averageModelCalls: totalCases === 0 ? 0 : results.reduce((sum, result) => sum + result.modelCallCount, 0) / totalCases,
    totalInputTokens: results.some((result) => result.inputTokens !== undefined) ? totalInputTokens : undefined,
    totalOutputTokens: results.some((result) => result.outputTokens !== undefined) ? totalOutputTokens : undefined,
    totalTokens: results.some((result) => result.totalTokens !== undefined) ? totalTokens : undefined
  };
}
