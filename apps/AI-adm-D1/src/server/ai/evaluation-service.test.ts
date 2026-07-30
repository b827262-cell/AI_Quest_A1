import { beforeEach, describe, expect, it } from "vitest";
import type { Repositories } from "@ai-smartbook/db";
import { makeEvaluationService, EvaluationServiceError } from "./evaluation-service";
import { redactEvaluationText, safeEvaluationError, safeEvaluationIssueSummary } from "./evaluation-redaction";

function setup() {
  type FakeRun = {
    id: string; datasetId: string; datasetVersion: number; executionMode: string; status: "running" | "completed" | "failed" | "cancelled";
    idempotencyKey: string | null; startedAt: string; completedAt: string | null; totalCases: number; passedCases: number; failedCases: number;
    passRate: number; averageScore: number; averageDurationMs: number; p50DurationMs: number; p95DurationMs: number; totalModelCalls: number;
    averageModelCalls: number; totalInputTokens: number | null; totalOutputTokens: number | null; totalTokens: number | null; conflictRate: number;
    unresolvedRate: number; baselineRunId: string | null; regressionIssueCount: number; createdByAdminId: string | null; createdAt: string;
  };
  type FakeMetric = { id: string; runId: string; dimension: string; dimensionValue: string; count: number; passed: number; passRate: number; averageScore: number };
  type FakeIssue = { id: string; runId: string; caseId: string; category: string; expectedKind: string; score: number; code: string; severity: "low" | "medium" | "high"; safeSummary: string | null };
  const runs: FakeRun[] = []; const metrics: FakeMetric[] = []; const issues: FakeIssue[] = [];
  let nextId = 0;
  const now = () => `2026-07-27T00:00:0${nextId}.000Z`;
  const runRepo = {
    createRun(input: { id?: string; datasetId: string; datasetVersion: number; executionMode: string; idempotencyKey?: string; createdByAdminId?: string }) {
      const existing = input.idempotencyKey ? runs.find((run) => run.idempotencyKey === input.idempotencyKey) : undefined;
      if (existing) return existing;
      nextId += 1;
      const row: FakeRun = { id: input.id ?? `aiev-${nextId}`, datasetId: input.datasetId, datasetVersion: input.datasetVersion, executionMode: input.executionMode, status: "running", idempotencyKey: input.idempotencyKey ?? null, startedAt: now(), completedAt: null, totalCases: 0, passedCases: 0, failedCases: 0, passRate: 0, averageScore: 0, averageDurationMs: 0, p50DurationMs: 0, p95DurationMs: 0, totalModelCalls: 0, averageModelCalls: 0, totalInputTokens: null, totalOutputTokens: null, totalTokens: null, conflictRate: 0, unresolvedRate: 0, baselineRunId: null, regressionIssueCount: 0, createdByAdminId: input.createdByAdminId ?? null, createdAt: now() };
      runs.push(row); return row;
    },
    findById(id: string) { return runs.find((run) => run.id === id); },
    findByIdempotencyKey(key: string) { return runs.find((run) => run.idempotencyKey === key); },
    findRunning(datasetId: string, datasetVersion: number, executionMode: string) { return runs.find((run) => run.datasetId === datasetId && run.datasetVersion === datasetVersion && run.executionMode === executionMode && run.status === "running"); },
    completeRun(id: string, input: Record<string, unknown>) { const row = runs.find((run) => run.id === id); if (!row || row.status !== "running") return row; Object.assign(row, input, { status: "completed", completedAt: now() }); return row; },
    failRun(id: string) { const row = runs.find((run) => run.id === id); if (row?.status === "running") Object.assign(row, { status: "failed", completedAt: now() }); return row; },
    finalizeRun(id: string, input: Record<string, unknown>, metricRows: Array<Record<string, unknown>>, issueRows: Array<Record<string, unknown>>) { const row = runs.find((item) => item.id === id); if (!row || row.status !== "running") return row; Object.assign(row, input, { status: "completed", completedAt: now() }); for (const metric of metricRows) metrics.push({ id: `metric-${++nextId}`, runId: id, ...metric } as FakeMetric); for (const issue of issueRows) issues.push({ id: `issue-${++nextId}`, runId: id, ...issue } as FakeIssue); return row; },
    findLatestComparableBaseline(datasetId: string, datasetVersion: number, executionMode: string, excludeRunId?: string) { return runs.filter((run) => run.id !== excludeRunId && run.datasetId === datasetId && run.datasetVersion === datasetVersion && run.executionMode === executionMode && run.status === "completed").at(-1); },
    listRuns() { return { rows: runs, total: runs.length, limit: 50, offset: 0 }; },
    deleteRun(id: string) { const index = runs.findIndex((run) => run.id === id); if (index < 0) return { deleted: false, alreadyDeleted: true }; runs.splice(index, 1); for (let i = metrics.length - 1; i >= 0; i -= 1) if (metrics[i]?.runId === id) metrics.splice(i, 1); for (let i = issues.length - 1; i >= 0; i -= 1) if (issues[i]?.runId === id) issues.splice(i, 1); return { deleted: true, alreadyDeleted: false }; }
  };
  const metricRepo = { listByRun: (runId: string) => metrics.filter((metric) => metric.runId === runId) };
  const issueRepo = { listByRun: (runId: string) => issues.filter((issue) => issue.runId === runId) };
  const repos = { aiEvaluationRuns: runRepo, aiEvaluationMetrics: metricRepo, aiEvaluationIssues: issueRepo, aiUsageLogs: { dailyAggregate: () => [] }, aiTokenPoolReservations: { list: () => [] }, aiProviders: { listConfigs: () => [] } } as unknown as Repositories;
  const auditRows: Array<{ action: string; targetId: string; metadata: Record<string, unknown> }> = [];
  const service = makeEvaluationService(repos, (action, targetId, metadata) => auditRows.push({ action, targetId, metadata }));
  return { repos, service, auditRows };
}

describe("evaluation redaction", () => {
  it("redacts email", () => expect(redactEvaluationText("admin@example.com").value).not.toContain("admin@example.com"));
  it("reports email match type", () => expect(redactEvaluationText("admin@example.com").matchedTypes).toContain("email"));
  it("redacts session UUID", () => expect(redactEvaluationText("session 123e4567-e89b-12d3-a456-426614174000").value).toContain("[REDACTED_SESSION]"));
  it("redacts Authorization bearer", () => expect(redactEvaluationText("Authorization: Bearer abcdefghijklmnop").value).toContain("[REDACTED]"));
  it("redacts API key style", () => expect(redactEvaluationText("sk-abcdefghijklmnop").value).toContain("[REDACTED_API_KEY]"));
  it("redacts AQ. opaque provider key style", () => expect(redactEvaluationText("AQ.abcdefghijklmnopqrstuvwxyz123456").value).toContain("[REDACTED_API_KEY]"));
  it("does not redact a short AQ. phrase", () => expect(redactEvaluationText("AQ.short").value).toBe("AQ.short"));
  it("redacts credential secret assignment", () => expect(redactEvaluationText("credential_secret=private-value").value).toContain("[REDACTED]"));
  it("redacts home path", () => expect(redactEvaluationText("/home/alice/project/report").value).toContain("[REDACTED_PATH]"));
  it("redacts workspace path", () => expect(redactEvaluationText("/workspace/app/report").value).toContain("[REDACTED_PATH]"));
  it("does not redact case id", () => expect(redactEvaluationText("math-basic-001").value).toBe("math-basic-001"));
  it("does not redact dataset id", () => expect(redactEvaluationText("phase-4a-core").value).toBe("phase-4a-core"));
  it("returns matched types", () => expect(redactEvaluationText("x@example.com sk-abcdefghijklmnop").matchedTypes).toEqual(expect.arrayContaining(["email", "api_key"])));
  it("does not return original email", () => expect(redactEvaluationText("x@example.com").value).not.toContain("@example.com"));
  it("does not return original bearer", () => expect(redactEvaluationText("Authorization: Bearer abcdefghijklmnop").value).not.toContain("abcdefghijklmnop"));
  it("provider raw errors become safe reason", () => expect(safeEvaluationError(new Error("provider body api_key=secret"))).toBe("evaluation_failed"));
  it("safe issue summary is bounded", () => expect(safeEvaluationIssueSummary("x".repeat(500)).length).toBeLessThanOrEqual(240));
  it("safe issue summary redacts sensitive content", () => expect(safeEvaluationIssueSummary("token for admin@example.com")).not.toContain("admin@example.com"));
});

describe("evaluation persistence service", () => {
  let handle: ReturnType<typeof setup>;
  beforeEach(() => { handle = setup(); });

  it("runs a fixture evaluation", async () => { const result = await handle.service.start({ datasetId: "phase-4a-core", executionMode: "fixture", idempotencyKey: "service-fixture-001" }); expect(result.run.status).toBe("completed"); expect(result.run.totalCases).toBe(40); });
  it("stores all metric dimensions", async () => { const result = await handle.service.start({ datasetId: "phase-4a-core", executionMode: "fixture", idempotencyKey: "service-metric-001" }); const detail = handle.service.detail(result.run.id); expect(new Set(detail.metrics.map((metric) => metric.dimension))).toEqual(new Set(["category", "difficulty", "outcome", "confidence"])); });
  it("stores no failed issues for the fixed passing fixture", async () => { const result = await handle.service.start({ datasetId: "phase-4a-core", executionMode: "fixture", idempotencyKey: "service-issue-001" }); expect(handle.service.detail(result.run.id).issues).toHaveLength(0); });
  it("runs mock mode without a Provider", async () => { const result = await handle.service.start({ datasetId: "phase-4a-core", executionMode: "mock_orchestrator", idempotencyKey: "service-mock-001" }); expect(result.run.executionMode).toBe("mock_orchestrator"); expect(handle.repos.aiUsageLogs.dailyAggregate("2026-01-01", "2026-12-31")).toHaveLength(0); });
  it("rejects live mode", async () => { await expect(handle.service.start({ datasetId: "phase-4a-core", executionMode: "live", idempotencyKey: "service-live-001" })).rejects.toMatchObject({ code: "live_evaluation_disabled" }); });
  it("rejects an unknown dataset", async () => { await expect(handle.service.start({ datasetId: "arbitrary-path", executionMode: "fixture", idempotencyKey: "service-dataset-001" })).rejects.toMatchObject({ code: "dataset_not_allowed" }); });
  it("rejects a short idempotency key", async () => { await expect(handle.service.start({ datasetId: "phase-4a-core", executionMode: "fixture", idempotencyKey: "short" })).rejects.toMatchObject({ code: "invalid_idempotency_key" }); });
  it("reuses an idempotent completed run", async () => { const input = { datasetId: "phase-4a-core", executionMode: "fixture" as const, idempotencyKey: "service-reuse-001" }; const first = await handle.service.start(input); const second = await handle.service.start(input); expect(second.reused).toBe(true); expect(second.run.id).toBe(first.run.id); });
  it("rejects a second running same dataset and mode", async () => { handle.repos.aiEvaluationRuns.createRun({ id: "running-eval", datasetId: "phase-4a-core", datasetVersion: 1, executionMode: "fixture" }); await expect(handle.service.start({ datasetId: "phase-4a-core", executionMode: "fixture", idempotencyKey: "service-running-001" })).rejects.toMatchObject({ code: "evaluation_already_running" }); });
  it("records started audit metadata safely", async () => { const result = await handle.service.start({ datasetId: "phase-4a-core", executionMode: "fixture", idempotencyKey: "service-audit-001" }); expect(handle.auditRows[0]).toMatchObject({ action: "evaluation.run.started", targetId: result.run.id }); expect(handle.auditRows[0]?.metadata).not.toHaveProperty("question"); });
  it("records completed audit metadata", async () => { await handle.service.start({ datasetId: "phase-4a-core", executionMode: "fixture", idempotencyKey: "service-audit-002" }); expect(handle.auditRows.map((row) => row.action)).toContain("evaluation.run.completed"); });
  it("does not write formal Token Pool reservations", async () => { await handle.service.start({ datasetId: "phase-4a-core", executionMode: "fixture", idempotencyKey: "service-pool-001" }); expect(handle.repos.aiTokenPoolReservations.list()).toHaveLength(0); });
  it("does not modify Provider health", async () => { await handle.service.start({ datasetId: "phase-4a-core", executionMode: "fixture", idempotencyKey: "service-health-001" }); expect(handle.repos.aiProviders.listConfigs()).toHaveLength(0); });
  it("does not store question or answer in run detail", async () => { const result = await handle.service.start({ datasetId: "phase-4a-core", executionMode: "fixture", idempotencyKey: "service-safe-001" }); const detail = handle.service.detail(result.run.id); expect(JSON.stringify(detail)).not.toMatch(/question|answer|prompt/i); });
  it("does not expose fixture file paths", async () => { const result = await handle.service.start({ datasetId: "phase-4a-core", executionMode: "fixture", idempotencyKey: "service-safe-002" }); expect(JSON.stringify(result)).not.toMatch(/packages\/ai|\/home\//); });
  it("returns JSON report without answer payload", async () => { const result = await handle.service.start({ datasetId: "phase-4a-core", executionMode: "fixture", idempotencyKey: "service-report-001" }); const report = handle.service.report(result.run.id, "json"); expect(report).toContain('"datasetId": "phase-4a-core"'); expect(report).not.toContain("Primary answer stays available"); });
  it("returns Markdown report with summary", async () => { const result = await handle.service.start({ datasetId: "phase-4a-core", executionMode: "fixture", idempotencyKey: "service-report-002" }); const report = handle.service.report(result.run.id, "markdown"); expect(report).toContain("# Evaluation Summary"); expect(report).not.toContain("question"); });
  it("returns a 404 domain error for missing detail", () => { expect(() => handle.service.detail("missing")).toThrowError(new EvaluationServiceError("evaluation_not_found", "評測紀錄不存在", 404)); });
  it("rejects an incompatible baseline", async () => { handle.repos.aiEvaluationRuns.createRun({ id: "wrong-baseline", datasetId: "other", datasetVersion: 1, executionMode: "fixture" }); handle.repos.aiEvaluationRuns.completeRun("wrong-baseline", { totalCases: 0, passedCases: 0, failedCases: 0, passRate: 0, averageScore: 0, averageDurationMs: 0, p50DurationMs: 0, p95DurationMs: 0, totalModelCalls: 0, averageModelCalls: 0, conflictRate: 0, unresolvedRate: 0, regressionIssueCount: 0 }); await expect(handle.service.start({ datasetId: "phase-4a-core", executionMode: "fixture", baselineRunId: "wrong-baseline", idempotencyKey: "service-baseline-001" })).rejects.toMatchObject({ code: "baseline_not_comparable" }); });
  it("uses a comparable completed baseline", async () => { const first = await handle.service.start({ datasetId: "phase-4a-core", executionMode: "fixture", idempotencyKey: "service-baseline-002" }); const second = await handle.service.start({ datasetId: "phase-4a-core", executionMode: "fixture", baselineRunId: first.run.id, idempotencyKey: "service-baseline-003" }); expect(second.run.baselineRunId).toBe(first.run.id); });
  it("deletes a completed run", async () => { const result = await handle.service.start({ datasetId: "phase-4a-core", executionMode: "fixture", idempotencyKey: "service-delete-001" }); expect(handle.service.delete(result.run.id).deleted).toBe(true); expect(() => handle.service.detail(result.run.id)).toThrow(); });
  it("repeated delete is safe", async () => { const result = await handle.service.start({ datasetId: "phase-4a-core", executionMode: "fixture", idempotencyKey: "service-delete-002" }); handle.service.delete(result.run.id); expect(handle.service.delete(result.run.id)).toEqual({ deleted: false, alreadyDeleted: true }); });
  it("records delete audit metadata only", async () => { const result = await handle.service.start({ datasetId: "phase-4a-core", executionMode: "fixture", idempotencyKey: "service-delete-003" }); handle.service.delete(result.run.id); const deleted = handle.auditRows.find((row) => row.action === "evaluation.run.deleted"); expect(deleted?.metadata).not.toHaveProperty("answer"); });
  it("exposes baseline regression deltas", async () => { const first = await handle.service.start({ datasetId: "phase-4a-core", executionMode: "fixture", idempotencyKey: "service-regression-001" }); const second = await handle.service.start({ datasetId: "phase-4a-core", executionMode: "fixture", baselineRunId: first.run.id, idempotencyKey: "service-regression-002" }); expect(handle.service.detail(second.run.id).regression?.comparable).toBe(true); });
  it("returns retention candidates without deleting them", async () => { await handle.service.start({ datasetId: "phase-4a-core", executionMode: "fixture", idempotencyKey: "service-retention-001" }); await handle.service.start({ datasetId: "phase-4a-core", executionMode: "fixture", idempotencyKey: "service-retention-002" }); expect(handle.service.retentionCandidates({ maxRunsPerDatasetMode: 1 })).toHaveLength(1); });
});
