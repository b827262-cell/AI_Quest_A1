import type { EvaluationCase, EvaluationCaseResult, EvaluationRegression, EvaluationSummary } from "./evaluation-types";

export interface EvaluationReport {
  dataset: { id: string; version: number };
  executionMode: EvaluationSummary["executionMode"];
  summary: EvaluationSummary;
  results: EvaluationCaseResult[];
  regression?: EvaluationRegression;
  warnings: string[];
}

export function toEvaluationJson(report: EvaluationReport): string {
  return JSON.stringify(report, null, 2);
}

export function toEvaluationMarkdown(report: EvaluationReport, cases: EvaluationCase[]): string {
  const summary = report.summary;
  const caseMap = new Map(cases.map((item) => [item.id, item]));
  const lines = [
    "# Evaluation Summary", "", `- Dataset: ${summary.datasetId}@${summary.datasetVersion}`, `- Execution Mode: ${summary.executionMode}`, `- Total Cases: ${summary.totalCases}`, `- Passed: ${summary.passedCases}`, `- Failed: ${summary.failedCases}`, `- Pass Rate: ${(summary.passRate * 100).toFixed(2)}%`, `- Average Score: ${summary.averageScore.toFixed(4)}`, "", "## Category Breakdown", "", "| Category | Count | Pass Rate | Average Score |", "|---|---:|---:|---:|"
  ];
  for (const [name, metric] of Object.entries(summary.byCategory)) lines.push(`| ${name} | ${metric.count} | ${(metric.passRate * 100).toFixed(2)}% | ${metric.averageScore.toFixed(4)} |`);
  lines.push("", "## Difficulty Breakdown", "", "| Difficulty | Count | Pass Rate | Average Score |", "|---|---:|---:|---:|");
  for (const [name, metric] of Object.entries(summary.byDifficulty)) lines.push(`| ${name} | ${metric.count} | ${(metric.passRate * 100).toFixed(2)}% | ${metric.averageScore.toFixed(4)} |`);
  lines.push("", "## Outcome Breakdown", "", "| Outcome | Count | Pass Rate | Average Score |", "|---|---:|---:|---:|");
  for (const [name, metric] of Object.entries(summary.byOutcome)) lines.push(`| ${name} | ${metric.count} | ${(metric.passRate * 100).toFixed(2)}% | ${metric.averageScore.toFixed(4)} |`);
  lines.push("", "## Confidence Calibration", "", "| Level | Sample Count | Passed | Empirical Pass Rate |", "|---|---:|---:|---:|");
  for (const row of summary.confidenceCalibration) lines.push(`| ${row.confidenceLevel} | ${row.total} | ${row.passed} | ${(row.empiricalPassRate * 100).toFixed(2)}% |`);
  lines.push("", "## Latency", "", `- Average: ${summary.averageDurationMs.toFixed(2)} ms`, `- P50: ${summary.p50DurationMs.toFixed(2)} ms`, `- P95: ${summary.p95DurationMs.toFixed(2)} ms`, "", "## Model Calls", "", `- Total: ${summary.totalModelCalls}`, `- Average: ${summary.averageModelCalls.toFixed(2)}`, "", "## Token Usage", "", `- Input: ${summary.totalInputTokens ?? "not reported"}`, `- Output: ${summary.totalOutputTokens ?? "not reported"}`, `- Total: ${summary.totalTokens ?? "not reported"}`);
  if (report.regression) lines.push("", "## Regression Comparison", "", report.regression.comparable ? `- Pass rate delta: ${(report.regression.passRateDelta * 100).toFixed(2)} percentage points` : `- Not comparable: ${report.regression.reason}`);
  lines.push("", "## Failed Cases", "", "| Case ID | Category | Expected Kind | Score | Issue Codes |", "|---|---|---|---:|---|");
  for (const result of report.results.filter((item) => !item.passed)) {
    const testCase = caseMap.get(result.caseId);
    lines.push(`| ${result.caseId} | ${result.category} | ${testCase?.expected.kind ?? "unknown"} | ${result.score.toFixed(4)} | ${result.issues.map((issue) => issue.code).join(", ") || "none"} |`);
  }
  if (report.warnings.length > 0) lines.push("", "## Warnings", "", ...report.warnings.map((warning) => `- ${warning}`));
  return `${lines.join("\n")}\n`;
}
