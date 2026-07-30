import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  AiEvaluationRunRepo,
  EvaluationExecutionMode,
  EvaluationIssueInput,
  EvaluationMetricInput,
  EvaluationRunSummaryInput,
  Repositories
} from "@ai-smartbook/db";
import {
  compareEvaluationBaseline,
  parseEvaluationDataset,
  parseEvaluationFixtures,
  runEvaluation,
  toEvaluationJson,
  toEvaluationMarkdown,
  type EvaluationBaseline,
  type EvaluationCase,
  type EvaluationCaseResult,
  type EvaluationExecutionMode as AiEvaluationExecutionMode,
  type EvaluationReport,
  type EvaluationSummary
} from "@ai-smartbook/ai";
import { safeEvaluationError, safeEvaluationIssueSummary } from "./evaluation-redaction";

const DATASET_ID = "phase-4a-core";
const DATASET_FILE = resolve(new URL("../../../../../packages/ai/evals/datasets/phase-4a-core.json", import.meta.url).pathname);
const FIXTURE_FILE = resolve(new URL("../../../../../packages/ai/evals/fixtures/phase-4a-core.json", import.meta.url).pathname);
const VALID_MODES = new Set<EvaluationExecutionMode>(["fixture", "mock_orchestrator"]);

export class EvaluationServiceError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
    this.name = "EvaluationServiceError";
  }
}

export type EvaluationStartInput = {
  datasetId: string;
  executionMode: "fixture" | "mock_orchestrator" | "live";
  baselineRunId?: string;
  idempotencyKey: string;
  createdByAdminId?: string;
};

export interface EvaluationRetentionPolicy {
  maxRunsPerDatasetMode: number;
  maxAgeDays?: number;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function sameLiveModelSet(left: string | null, right: string | null): boolean {
  const parse = (value: string | null) => {
    try { const parsed: unknown = JSON.parse(value ?? "[]"); return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? [...new Set(parsed)].sort() : []; } catch { return []; }
  };
  return JSON.stringify(parse(left)) === JSON.stringify(parse(right));
}

function loadDataset() {
  return parseEvaluationDataset(readJson(DATASET_FILE));
}

function loadFixtures() {
  return parseEvaluationFixtures(readJson(FIXTURE_FILE));
}

function clampRate(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

function summaryInput(summary: EvaluationSummary, baselineRunId: string | null, regressionIssueCount: number): EvaluationRunSummaryInput {
  const conflictCount = (summary.byOutcome.conflict_detected?.count ?? 0) + (summary.byOutcome.adjudicated?.count ?? 0);
  const unresolvedCount = summary.byOutcome.unresolved?.count ?? 0;
  return {
    totalCases: summary.totalCases,
    passedCases: summary.passedCases,
    failedCases: summary.failedCases,
    passRate: clampRate(summary.passRate),
    averageScore: clampRate(summary.averageScore),
    averageDurationMs: Math.max(0, summary.averageDurationMs),
    p50DurationMs: Math.max(0, summary.p50DurationMs),
    p95DurationMs: Math.max(0, summary.p95DurationMs),
    totalModelCalls: Math.max(0, summary.totalModelCalls),
    averageModelCalls: Math.max(0, summary.averageModelCalls),
    totalInputTokens: summary.totalInputTokens,
    totalOutputTokens: summary.totalOutputTokens,
    totalTokens: summary.totalTokens,
    conflictRate: summary.totalCases ? conflictCount / summary.totalCases : 0,
    unresolvedRate: summary.totalCases ? unresolvedCount / summary.totalCases : 0,
    baselineRunId,
    regressionIssueCount
  };
}

function metricInputs(summary: EvaluationSummary): EvaluationMetricInput[] {
  const dimensions: Array<[EvaluationMetricInput["dimension"], Record<string, { count: number; passed: number; passRate: number; averageScore: number }>]> = [
    ["category", summary.byCategory],
    ["difficulty", summary.byDifficulty],
    ["outcome", summary.byOutcome],
    ["confidence", summary.byConfidence]
  ];
  return dimensions.flatMap(([dimension, groups]) => Object.entries(groups).map(([dimensionValue, group]) => ({ dimension, dimensionValue, ...group })));
}

function issueInputs(dataset: { cases: EvaluationCase[] }, results: EvaluationCaseResult[]): EvaluationIssueInput[] {
  const cases = new Map(dataset.cases.map((testCase) => [testCase.id, testCase]));
  return results.filter((result) => !result.passed).flatMap((result) => result.issues.slice(0, 8).map((issue) => ({
    caseId: result.caseId,
    category: result.category,
    expectedKind: cases.get(result.caseId)?.expected.kind ?? "unknown",
    score: clampRate(result.score),
    code: issue.code.replace(/[^a-z0-9_.-]/gi, "_").slice(0, 80) || "evaluation_issue",
    severity: issue.severity,
    safeSummary: safeEvaluationIssueSummary(issue.message)
  })));
}

function metricSummary(row: Awaited<ReturnType<AiEvaluationRunRepo["findById"]>>, metrics: ReturnType<Repositories["aiEvaluationMetrics"]["listByRun"]>): EvaluationSummary {
  const groups = (dimension: string) => Object.fromEntries(metrics.filter((metric) => metric.dimension === dimension).map((metric) => [metric.dimensionValue, {
    count: metric.count,
    passed: metric.passed,
    passRate: metric.passRate,
    averageScore: metric.averageScore
  }]));
  const confidence = metrics.filter((metric) => metric.dimension === "confidence").map((metric) => ({
    confidenceLevel: metric.dimensionValue as "high" | "medium" | "low" | "unverified",
    total: metric.count,
    passed: metric.passed,
    empiricalPassRate: metric.passRate
  }));
  return {
    datasetId: row?.datasetId ?? "",
    datasetVersion: row?.datasetVersion ?? 0,
    executionMode: (row?.executionMode ?? "fixture") as AiEvaluationExecutionMode,
    totalCases: row?.totalCases ?? 0,
    passedCases: row?.passedCases ?? 0,
    failedCases: row?.failedCases ?? 0,
    passRate: row?.passRate ?? 0,
    averageScore: row?.averageScore ?? 0,
    byCategory: groups("category"),
    byDifficulty: groups("difficulty"),
    byOutcome: groups("outcome"),
    byConfidence: groups("confidence"),
    confidenceCalibration: confidence,
    averageDurationMs: row?.averageDurationMs ?? 0,
    p50DurationMs: row?.p50DurationMs ?? 0,
    p95DurationMs: row?.p95DurationMs ?? 0,
    totalModelCalls: row?.totalModelCalls ?? 0,
    averageModelCalls: row?.averageModelCalls ?? 0,
    totalInputTokens: row?.totalInputTokens ?? undefined,
    totalOutputTokens: row?.totalOutputTokens ?? undefined,
    totalTokens: row?.totalTokens ?? undefined
  };
}

function safeReport(
  row: NonNullable<Awaited<ReturnType<AiEvaluationRunRepo["findById"]>>>,
  metrics: ReturnType<Repositories["aiEvaluationMetrics"]["listByRun"]>,
  issues: ReturnType<Repositories["aiEvaluationIssues"]["listByRun"]>,
  regression?: EvaluationReport["regression"]
): EvaluationReport {
  const summary = metricSummary(row, metrics);
  const results: EvaluationCaseResult[] = issues.reduce<EvaluationCaseResult[]>((acc, issue) => {
    const existing = acc.find((result) => result.caseId === issue.caseId);
    const safeIssue = { code: issue.code, severity: issue.severity as "low" | "medium" | "high", message: issue.safeSummary ?? "evaluation issue" };
    if (existing) existing.issues.push(safeIssue);
    else acc.push({ caseId: issue.caseId, datasetVersion: row.datasetVersion, category: issue.category as EvaluationCaseResult["category"], difficulty: "medium", passed: false, score: issue.score, scoringMethod: "safety", modelCallCount: 0, durationMs: 0, issues: [safeIssue] });
    return acc;
  }, []);
  const report: EvaluationReport = {
    dataset: { id: row.datasetId, version: row.datasetVersion },
    executionMode: row.executionMode as EvaluationReport["executionMode"],
    summary,
    results,
    regression,
    warnings: [row.executionMode === "live"
      ? "Live 結果僅代表指定評測資料集，不代表全部學生問題的真實世界準確率。"
      : "此結果來自固定離線評測資料與模擬回應，僅用於回歸檢查，不代表正式模型的真實世界準確率。"]
  };
  return report;
}

export function makeEvaluationService(repos: Repositories, audit: (action: string, targetId: string, metadata: Record<string, unknown>) => void) {
  const runs = repos.aiEvaluationRuns;

  function regressionFor(row: NonNullable<ReturnType<typeof runs.findById>>) {
    if (!row.baselineRunId) return undefined;
    const baseline = runs.findById(row.baselineRunId);
    if (!baseline || baseline.status !== "completed") return undefined;
    if (row.executionMode === "live" && (!sameLiveModelSet(row.logicalModelIdsJson, baseline.logicalModelIdsJson))) return { comparable: false, reason: "live baseline logical model set differs", passRateDelta: 0, averageScoreDelta: 0, p95LatencyDeltaMs: 0, averageModelCallsDelta: 0, regressions: [] };
    return compareEvaluationBaseline(metricSummary(row, repos.aiEvaluationMetrics.listByRun(row.id)), {
      datasetId: baseline.datasetId,
      datasetVersion: baseline.datasetVersion,
      executionMode: baseline.executionMode as AiEvaluationExecutionMode,
      createdAt: baseline.createdAt,
      summary: metricSummary(baseline, repos.aiEvaluationMetrics.listByRun(baseline.id))
    });
  }

  function ensureMode(mode: EvaluationStartInput["executionMode"]): asserts mode is "fixture" | "mock_orchestrator" {
    if (!VALID_MODES.has(mode as EvaluationExecutionMode)) throw new EvaluationServiceError("live_evaluation_disabled", "本階段只允許 Fixture 或 Mock 評測", 403);
  }

  function getRunDetail(id: string) {
    const row = runs.findById(id);
    if (!row) throw new EvaluationServiceError("evaluation_not_found", "評測紀錄不存在", 404);
    return { run: row, metrics: repos.aiEvaluationMetrics.listByRun(id), issues: repos.aiEvaluationIssues.listByRun(id) };
  }

  return {
    list(query: Parameters<typeof runs.listRuns>[0] = {}) {
      return runs.listRuns(query);
    },

    detail(id: string) {
      const detail = getRunDetail(id);
      return { run: detail.run, metrics: detail.metrics, issues: detail.issues.map((issue) => ({ ...issue, safeSummary: issue.safeSummary ?? undefined })), regression: regressionFor(detail.run) };
    },

    /** Returns candidates only; deletion remains an explicit Admin action. */
    retentionCandidates(policy: EvaluationRetentionPolicy, now = new Date()) {
      const maxRuns = Math.max(1, Math.floor(policy.maxRunsPerDatasetMode));
      const cutoff = policy.maxAgeDays === undefined ? undefined : new Date(now.getTime() - Math.max(0, policy.maxAgeDays) * 86_400_000).toISOString();
      const rows = runs.listRuns({ limit: 100 }).rows;
      const groups = new Map<string, typeof rows>();
      for (const row of rows) {
        const key = `${row.datasetId}:${row.datasetVersion}:${row.executionMode}`;
        groups.set(key, [...(groups.get(key) ?? []), row]);
      }
      return [...groups.values()].flatMap((group) => group.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).filter((row, index) => index >= maxRuns || (cutoff !== undefined && row.createdAt < cutoff)));
    },

    async start(input: EvaluationStartInput) {
      if (input.datasetId !== DATASET_ID) throw new EvaluationServiceError("dataset_not_allowed", "Dataset 不在 Server Allowlist", 400);
      ensureMode(input.executionMode);
      if (!/^[A-Za-z0-9._:-]{8,128}$/.test(input.idempotencyKey)) throw new EvaluationServiceError("invalid_idempotency_key", "Idempotency Key 格式不合法", 400);
      const existing = runs.findByIdempotencyKey(input.idempotencyKey);
      if (existing) return { run: existing, reused: true };
      const dataset = loadDataset();
      const running = runs.findRunning(dataset.id, dataset.version, input.executionMode);
      if (running) throw new EvaluationServiceError("evaluation_already_running", "相同 Dataset／Mode 已有評測執行中", 409);
      let baselineId: string | null = null;
      if (input.baselineRunId) {
        const baseline = runs.findById(input.baselineRunId);
        if (!baseline || baseline.status !== "completed" || baseline.datasetId !== dataset.id || baseline.datasetVersion !== dataset.version || baseline.executionMode !== input.executionMode) {
          throw new EvaluationServiceError("baseline_not_comparable", "此 Baseline 與目前 Dataset、Version 或 Mode 不可比較", 409);
        }
        baselineId = baseline.id;
      } else {
        baselineId = runs.findLatestComparableBaseline(dataset.id, dataset.version, input.executionMode)?.id ?? null;
      }
      const row = runs.createRun({ datasetId: dataset.id, datasetVersion: dataset.version, executionMode: input.executionMode, idempotencyKey: input.idempotencyKey, createdByAdminId: input.createdByAdminId });
      if (baselineId) audit("evaluation.baseline.selected", row.id, { datasetId: row.datasetId, datasetVersion: row.datasetVersion, executionMode: row.executionMode, status: "completed" });
      audit("evaluation.run.started", row.id, { datasetId: row.datasetId, datasetVersion: row.datasetVersion, executionMode: row.executionMode, status: row.status });
      try {
        const output = await runEvaluation(dataset, { mode: input.executionMode, fixtures: loadFixtures() });
        const baselineRow = baselineId ? runs.findById(baselineId) : undefined;
        const baseline = baselineRow ? {
          datasetId: baselineRow.datasetId,
          datasetVersion: baselineRow.datasetVersion,
          executionMode: baselineRow.executionMode as AiEvaluationExecutionMode,
          createdAt: baselineRow.createdAt,
          summary: metricSummary(baselineRow, repos.aiEvaluationMetrics.listByRun(baselineRow.id))
        } satisfies EvaluationBaseline : undefined;
        const regression = baseline ? compareEvaluationBaseline(output.report.summary, baseline) : undefined;
        const saved = runs.finalizeRun(row.id, summaryInput(output.report.summary, baselineId, regression?.regressions.length ?? 0), metricInputs(output.report.summary), issueInputs(dataset, output.results));
        if (!saved) throw new Error("evaluation finalize failed");
        audit("evaluation.run.completed", row.id, { datasetId: saved.datasetId, datasetVersion: saved.datasetVersion, executionMode: saved.executionMode, status: saved.status });
        return { run: saved, reused: false };
      } catch (error) {
        runs.failRun(row.id);
        audit("evaluation.run.failed", row.id, { datasetId: row.datasetId, datasetVersion: row.datasetVersion, executionMode: row.executionMode, status: "failed" });
        throw new EvaluationServiceError("evaluation_failed", safeEvaluationError(error), 500);
      }
    },

    report(id: string, format: "json" | "markdown") {
      const detail = getRunDetail(id);
      const report = safeReport(detail.run, detail.metrics, detail.issues, regressionFor(detail.run));
      return format === "json" ? toEvaluationJson(report) : toEvaluationMarkdown(report, detail.issues.map((issue) => ({ id: issue.caseId, version: detail.run.datasetVersion, category: issue.category as EvaluationCase["category"], difficulty: "medium", question: "", expected: { kind: issue.expectedKind } as EvaluationCase["expected"], source: "regression", enabled: true })));
    },

    delete(id: string) {
      const detail = runs.findById(id);
      if (!detail) return runs.deleteRun(id);
      const result = runs.deleteRun(id);
      if (result.deleted) audit("evaluation.run.deleted", id, { datasetId: detail.datasetId, datasetVersion: detail.datasetVersion, executionMode: detail.executionMode, status: detail.status });
      return result;
    }
  };
}

export type EvaluationService = ReturnType<typeof makeEvaluationService>;
