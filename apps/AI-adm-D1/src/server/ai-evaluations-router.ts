import { Router, type Request, type Response } from "express";
import type { AdminAppDependencies } from "./app";
import { adminActorId } from "./admin-route-boundary";
import { EvaluationServiceError } from "./ai/evaluation-service";
import { LiveEvaluationServiceError } from "./ai/live-evaluation-service";
import { EvaluationGovernanceError } from "./ai/evaluation-governance-service";

type Dependencies = Pick<AdminAppDependencies, "repos" | "evaluationService" | "liveEvaluationService" | "evaluationGovernanceService"> & {
  requireAdminAccess: (req: Request, res: Response) => boolean;
  fail: (res: Response, status: number, message: string) => void;
};

function publicEvaluationRun(row: {
  id: string;
  datasetId: string;
  datasetVersion: number;
  executionMode: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  totalCases: number;
  passedCases: number;
  failedCases: number;
  passRate: number;
  averageScore: number;
  averageDurationMs: number;
  p50DurationMs: number;
  p95DurationMs: number;
  totalModelCalls: number;
  averageModelCalls: number;
  totalInputTokens: number | null;
  totalOutputTokens: number | null;
  totalTokens: number | null;
  conflictRate: number;
  unresolvedRate: number;
  baselineRunId: string | null;
  regressionIssueCount: number;
  trafficClass?: string;
  maxTokenBudget?: number | null;
  consumedTokens?: number;
  dailyBudgetSnapshot?: number | null;
  evaluationPoolId?: string | null;
  cancelRequestedAt?: string | null;
  cancelledAt?: string | null;
  preflightId?: string | null;
  logicalModelIdsJson?: string | null;
  providerIdsJson?: string | null;
  createdAt: string;
}) {
  return {
    id: row.id, datasetId: row.datasetId, datasetVersion: row.datasetVersion, executionMode: row.executionMode, status: row.status,
    startedAt: row.startedAt, completedAt: row.completedAt, totalCases: row.totalCases, passedCases: row.passedCases, failedCases: row.failedCases,
    passRate: row.passRate, averageScore: row.averageScore, averageDurationMs: row.averageDurationMs, p50DurationMs: row.p50DurationMs, p95DurationMs: row.p95DurationMs,
    totalModelCalls: row.totalModelCalls, averageModelCalls: row.averageModelCalls, totalInputTokens: row.totalInputTokens, totalOutputTokens: row.totalOutputTokens, totalTokens: row.totalTokens,
    conflictRate: row.conflictRate, unresolvedRate: row.unresolvedRate, baselineRunId: row.baselineRunId, regressionIssueCount: row.regressionIssueCount,
    trafficClass: row.trafficClass, maxTokenBudget: row.maxTokenBudget, consumedTokens: row.consumedTokens, dailyBudgetSnapshot: row.dailyBudgetSnapshot,
    evaluationPoolId: row.evaluationPoolId, cancelRequestedAt: row.cancelRequestedAt, cancelledAt: row.cancelledAt, preflightId: row.preflightId,
    logicalModelIds: row.logicalModelIdsJson ? JSON.parse(row.logicalModelIdsJson) : [], providerIds: row.providerIdsJson ? JSON.parse(row.providerIdsJson) : [], createdAt: row.createdAt
  };
}

function evaluationError(res: Response, error: unknown) {
  if (error instanceof EvaluationServiceError) return res.status(error.status).json({ error: error.message, code: error.code });
  return res.status(500).json({ error: "evaluation request failed", code: "evaluation_failed" });
}

function liveEvaluationError(res: Response, error: unknown) {
  if (error instanceof LiveEvaluationServiceError) return res.status(error.status).json({ error: error.message, code: error.code });
  return res.status(500).json({ error: "live evaluation request failed", code: "live_evaluation_failed" });
}

function evaluationGovernanceError(res: Response, error: unknown) {
  if (error instanceof EvaluationGovernanceError) return res.status(error.status).json({ error: error.message, code: error.code });
  return res.status(500).json({ error: "evaluation governance request failed", code: "evaluation_governance_failed" });
}


export function createAiEvaluationsRouter(deps: Dependencies, phase: "live" | "governance"): Router {
  const { repos, evaluationService, liveEvaluationService, evaluationGovernanceService, requireAdminAccess, fail } = deps;
  const app = Router();
  if (phase === "live") {
app.get("/api/admin/ai-evaluations/settings", (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  res.json({ settings: liveEvaluationService.getSettings() });
});

app.put("/api/admin/ai-evaluations/settings", (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  const body = req.body as Record<string, unknown>;
  const allowed = ["enabled", "evaluationPoolId", "allowedDatasetIds", "allowedLogicalModelIds", "allowedProviderIds", "maxCasesPerRun", "maxTokensPerRun", "maxTokensPerDay", "maxConcurrentRuns", "requireDryRun", "requireExplicitConfirmation"];
  if (Object.keys(body).some((key) => !allowed.includes(key))) return res.status(400).json({ error: "unsupported live setting", code: "invalid_live_settings" });
  const arrays = [body.allowedDatasetIds, body.allowedLogicalModelIds, body.allowedProviderIds];
  if (arrays.some((value) => !Array.isArray(value) || value.some((item) => typeof item !== "string"))) return res.status(400).json({ error: "allowlist fields must be string arrays", code: "invalid_live_settings" });
  try {
    const settings = liveEvaluationService.saveSettings({
      enabled: body.enabled === true,
      evaluationPoolId: typeof body.evaluationPoolId === "string" ? body.evaluationPoolId : undefined,
      allowedDatasetIds: body.allowedDatasetIds as string[],
      allowedLogicalModelIds: body.allowedLogicalModelIds as string[],
      allowedProviderIds: body.allowedProviderIds as string[],
      maxCasesPerRun: Number(body.maxCasesPerRun), maxTokensPerRun: Number(body.maxTokensPerRun), maxTokensPerDay: Number(body.maxTokensPerDay), maxConcurrentRuns: Number(body.maxConcurrentRuns),
      requireDryRun: body.requireDryRun !== false, requireExplicitConfirmation: body.requireExplicitConfirmation !== false,
      updatedAt: new Date().toISOString()
    }, adminActorId(req));
    res.json({ settings });
  } catch (error) { liveEvaluationError(res, error); }
});

app.post("/api/admin/ai-evaluations/live-preflight", (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  const body = req.body as Record<string, unknown>;
  const logicalModelIds = Array.isArray(body.logicalModelIds) && body.logicalModelIds.every((value) => typeof value === "string") ? body.logicalModelIds as string[] : [];
  try {
    const result = liveEvaluationService.preflight({ adminId: adminActorId(req), datasetId: typeof body.datasetId === "string" ? body.datasetId : "", maxCases: Number(body.maxCases), maxTokenBudget: Number(body.maxTokenBudget), logicalModelIds });
    res.status(result.allowed ? 200 : 409).json(result);
  } catch (error) { liveEvaluationError(res, error); }
});

app.get("/api/admin/ai-evaluations/live-readiness", (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  res.json(liveEvaluationService.readiness());
});


  } else {
app.post("/api/admin/ai-evaluations/:id/cancel", (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  try { res.json(liveEvaluationService.cancel(req.params.id)); }
  catch (error) { liveEvaluationError(res, error); }
});

// ---- Phase 4D evaluation governance -------------------------------------
// These routes govern only offline Fixture/Mock schedules and safe summaries.
// The scheduler is disabled by default and has no Live execution branch.
app.get("/api/admin/ai-evaluations/retention", (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  res.json({ policy: evaluationGovernanceService.getSettings().retention });
});

app.put("/api/admin/ai-evaluations/retention", (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  try {
    const body = req.body as Record<string, unknown>;
    const policy = body as unknown as Parameters<typeof evaluationGovernanceService.saveSettings>[0]["retention"];
    const current = evaluationGovernanceService.getSettings();
    const saved = evaluationGovernanceService.saveSettings({ retention: policy, regressionAlert: current.regressionAlert, budgetAlert: current.budgetAlert, schedulerEnabled: current.schedulerEnabled }, adminActorId(req));
    repos.aiProviders.audit("evaluation.retention.policy_updated", "ai_evaluation_governance", "default", { enabled: saved.retention.enabled, maxRunsPerDatasetMode: saved.retention.maxRunsPerDatasetMode });
    res.json({ policy: saved.retention });
  } catch (error) { evaluationGovernanceError(res, error); }
});

app.get("/api/admin/ai-evaluations/governance", (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  res.json(evaluationGovernanceService.getSettings());
});

app.put("/api/admin/ai-evaluations/governance", (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  const body = req.body as Record<string, unknown>;
  if (Object.keys(body).some((key) => key !== "schedulerEnabled") || typeof body.schedulerEnabled !== "boolean") return res.status(400).json({ error: "schedulerEnabled is required", code: "invalid_governance_settings" });
  try {
    const current = evaluationGovernanceService.getSettings();
    res.json(evaluationGovernanceService.saveSettings({ retention: current.retention, regressionAlert: current.regressionAlert, budgetAlert: current.budgetAlert, schedulerEnabled: body.schedulerEnabled }, adminActorId(req)));
  } catch (error) { evaluationGovernanceError(res, error); }
});

app.post("/api/admin/ai-evaluations/retention/preview", (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  try { res.json(evaluationGovernanceService.retentionPreview(adminActorId(req))); }
  catch (error) { evaluationGovernanceError(res, error); }
});

app.post("/api/admin/ai-evaluations/retention/run", (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  const body = req.body as Record<string, unknown>;
  if (typeof body.previewId !== "string" || typeof body.confirmationToken !== "string") return res.status(400).json({ error: "previewId and confirmationToken are required", code: "invalid_retention_request" });
  try { res.json(evaluationGovernanceService.executeRetention({ previewId: body.previewId, confirmationToken: body.confirmationToken }, adminActorId(req))); }
  catch (error) { evaluationGovernanceError(res, error); }
});

app.get("/api/admin/ai-evaluation-schedules", (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  res.json({ schedulerEnabled: evaluationGovernanceService.getSettings().schedulerEnabled, schedules: evaluationGovernanceService.listSchedules() });
});

app.post("/api/admin/ai-evaluation-schedules", (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  const body = req.body as Record<string, unknown>;
  try {
    const row = evaluationGovernanceService.createSchedule({ enabled: body.enabled === true, datasetId: String(body.datasetId ?? ""), datasetVersion: Number(body.datasetVersion), executionMode: body.executionMode as "fixture" | "mock_orchestrator", cadence: body.cadence as "daily" | "weekly", scheduledTime: String(body.scheduledTime ?? ""), timezone: String(body.timezone ?? ""), baselinePolicy: body.baselinePolicy as "latest_comparable" | "fixed", fixedBaselineRunId: typeof body.fixedBaselineRunId === "string" ? body.fixedBaselineRunId : undefined }, adminActorId(req));
    res.status(201).json({ schedule: row });
  } catch (error) { evaluationGovernanceError(res, error); }
});

app.put("/api/admin/ai-evaluation-schedules/:id", (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  const body = req.body as Record<string, unknown>;
  try {
    const allowed = ["enabled", "datasetId", "datasetVersion", "executionMode", "cadence", "scheduledTime", "timezone", "baselinePolicy", "fixedBaselineRunId"];
    if (Object.keys(body).some((key) => !allowed.includes(key))) return res.status(400).json({ error: "unsupported schedule field", code: "invalid_schedule" });
    const row = evaluationGovernanceService.updateSchedule(req.params.id, body as never, adminActorId(req));
    res.json({ schedule: row });
  } catch (error) { evaluationGovernanceError(res, error); }
});

app.delete("/api/admin/ai-evaluation-schedules/:id", (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  try { res.json(evaluationGovernanceService.deleteSchedule(req.params.id)); }
  catch (error) { evaluationGovernanceError(res, error); }
});

app.post("/api/admin/ai-evaluation-schedules/run-due", async (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  try { res.json({ results: await evaluationGovernanceService.runDue(new Date(), adminActorId(req)) }); }
  catch (error) { evaluationGovernanceError(res, error); }
});

app.get("/api/admin/ai-evaluation-alert-policy", (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  res.json({ policy: evaluationGovernanceService.getSettings().regressionAlert, budgetPolicy: evaluationGovernanceService.getSettings().budgetAlert, schedulerEnabled: evaluationGovernanceService.getSettings().schedulerEnabled });
});

app.put("/api/admin/ai-evaluation-alert-policy", (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  try {
    const body = req.body as Record<string, unknown>;
    const current = evaluationGovernanceService.getSettings();
    const policy = body as unknown as Parameters<typeof evaluationGovernanceService.saveSettings>[0]["regressionAlert"];
    const saved = evaluationGovernanceService.saveSettings({ retention: current.retention, regressionAlert: policy, budgetAlert: current.budgetAlert, schedulerEnabled: current.schedulerEnabled }, adminActorId(req));
    res.json({ policy: saved.regressionAlert, budgetPolicy: saved.budgetAlert });
  } catch (error) { evaluationGovernanceError(res, error); }
});

app.get("/api/admin/ai-evaluation-alerts", (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  const status = req.query.status === "open" || req.query.status === "acknowledged" || req.query.status === "resolved" ? req.query.status : undefined;
  res.json({ alerts: evaluationGovernanceService.listAlerts(status) });
});

app.post("/api/admin/ai-evaluation-alerts/:id/acknowledge", (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  const alert = evaluationGovernanceService.acknowledgeAlert(req.params.id);
  if (!alert) return res.status(404).json({ error: "alert not found", code: "alert_not_found" });
  repos.aiProviders.audit("evaluation.alert.acknowledged", "ai_evaluation_alert", req.params.id, { status: alert.status });
  res.json({ alert });
});

app.post("/api/admin/ai-evaluation-alerts/:id/resolve", (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  const alert = evaluationGovernanceService.resolveAlert(req.params.id);
  if (!alert) return res.status(404).json({ error: "alert not found", code: "alert_not_found" });
  repos.aiProviders.audit("evaluation.alert.resolved", "ai_evaluation_alert", req.params.id, { status: alert.status });
  res.json({ alert });
});

// ---- Offline AI evaluation quality centre -------------------------------
// Dataset and fixture selection is server-owned. These routes never accept a
// filesystem path, prompt, provider credential, API key, or shell command.
app.get("/api/admin/ai-evaluations", (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  if (typeof req.query.executionMode === "string" && !["fixture", "mock_orchestrator", "live"].includes(req.query.executionMode)) return fail(res, 400, "executionMode is not supported");
  if (typeof req.query.status === "string" && !["pending_confirmation", "running", "completed", "failed", "cancelled", "budget_exhausted"].includes(req.query.status)) return fail(res, 400, "status is not supported");
  if (req.query.sort !== undefined && req.query.sort !== "newest") return fail(res, 400, "sort is not supported");
  if (typeof req.query.datasetId === "string" && !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(req.query.datasetId)) return fail(res, 400, "datasetId is invalid");
  const mode = typeof req.query.executionMode === "string" ? req.query.executionMode as "fixture" | "mock_orchestrator" | "live" : undefined;
  const status = typeof req.query.status === "string" ? req.query.status as "pending_confirmation" | "running" | "completed" | "failed" | "cancelled" | "budget_exhausted" : undefined;
  const datasetId = typeof req.query.datasetId === "string" && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(req.query.datasetId)
    ? req.query.datasetId : undefined;
  const parseNumber = (value: unknown, fallback: number) => {
    if (typeof value !== "string" || !/^\d+$/.test(value)) return fallback;
    return Number(value);
  };
  const limit = Math.min(100, Math.max(1, parseNumber(req.query.limit, 50)));
  const offset = Math.max(0, parseNumber(req.query.offset, 0));
  if (typeof req.query.dateFrom === "string" && !/^\d{4}-\d{2}-\d{2}/.test(req.query.dateFrom)) return fail(res, 400, "dateFrom is invalid");
  if (typeof req.query.dateTo === "string" && !/^\d{4}-\d{2}-\d{2}/.test(req.query.dateTo)) return fail(res, 400, "dateTo is invalid");
  try {
    const page = evaluationService.list({ datasetId, executionMode: mode, status, dateFrom: typeof req.query.dateFrom === "string" ? req.query.dateFrom : undefined, dateTo: typeof req.query.dateTo === "string" ? req.query.dateTo : undefined, limit, offset });
    res.json({ runs: page.rows.map(publicEvaluationRun), total: page.total, limit: page.limit, offset: page.offset });
  } catch (error) {
    evaluationError(res, error);
  }
});

app.get("/api/admin/ai-evaluations/:id/report", (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  const format = req.query.format === "markdown" ? "markdown" : req.query.format === "json" ? "json" : undefined;
  if (!format) return res.status(400).json({ error: "report format must be json or markdown", code: "invalid_report_format" });
  try {
    const content = evaluationService.report(req.params.id, format);
    repos.aiProviders.audit("evaluation.report.downloaded", "ai_evaluation_run", req.params.id, { format });
    const filename = `ai-evaluation-${req.params.id.replace(/[^a-zA-Z0-9_-]/g, "_")}.${format === "json" ? "json" : "md"}`;
    res.type(format === "json" ? "application/json" : "text/markdown; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(content);
  } catch (error) {
    evaluationError(res, error);
  }
});

app.get("/api/admin/ai-evaluations/:id", (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  try {
    const detail = evaluationService.detail(req.params.id);
    res.json({ run: publicEvaluationRun(detail.run), metrics: detail.metrics, issues: detail.issues, regression: detail.regression });
  } catch (error) {
    evaluationError(res, error);
  }
});

app.post("/api/admin/ai-evaluations/run", async (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  const body = req.body as Record<string, unknown>;
  if (body.executionMode === "live") {
    const liveAllowed = ["datasetId", "executionMode", "maxCases", "maxTokenBudget", "logicalModelIds", "dryRunId", "confirmationToken", "baselineRunId"];
    if (Object.keys(body).some((key) => !liveAllowed.includes(key))) return res.status(400).json({ error: "invalid live evaluation request", code: "invalid_live_evaluation_request" });
    const idempotencyKey = req.header("Idempotency-Key")?.trim() ?? "";
    const logicalModelIds = Array.isArray(body.logicalModelIds) && body.logicalModelIds.every((value) => typeof value === "string") ? body.logicalModelIds as string[] : [];
    try {
      const result = await liveEvaluationService.start({ adminId: adminActorId(req), datasetId: typeof body.datasetId === "string" ? body.datasetId : "", maxCases: Number(body.maxCases), maxTokenBudget: Number(body.maxTokenBudget), logicalModelIds, dryRunId: typeof body.dryRunId === "string" ? body.dryRunId : "", confirmationToken: typeof body.confirmationToken === "string" ? body.confirmationToken : "", baselineRunId: typeof body.baselineRunId === "string" ? body.baselineRunId : undefined, idempotencyKey });
      return res.status(result.reused ? 200 : 201).json({ run: publicEvaluationRun(result.run), report: result.report, reused: result.reused, cancelled: result.cancelled ?? false });
    } catch (error) { return liveEvaluationError(res, error); }
  }
  if (Object.keys(body).some((key) => !["datasetId", "executionMode", "baselineRunId"].includes(key))) {
    return res.status(400).json({ error: "only datasetId, executionMode and baselineRunId are accepted", code: "invalid_evaluation_request" });
  }
  const datasetId = typeof body.datasetId === "string" ? body.datasetId : "";
  const executionMode = body.executionMode;
  const baselineRunId = typeof body.baselineRunId === "string" ? body.baselineRunId : undefined;
  const idempotencyKey = req.header("Idempotency-Key")?.trim() ?? "";
  if (!/^[a-z0-9][a-z0-9._:-]{7,127}$/i.test(idempotencyKey)) return res.status(400).json({ error: "Idempotency-Key is required", code: "missing_idempotency_key" });
  if (typeof executionMode !== "string" || !["fixture", "mock_orchestrator", "live"].includes(executionMode)) return res.status(400).json({ error: "executionMode is invalid", code: "invalid_execution_mode" });
  try {
    const result = await evaluationService.start({ datasetId, executionMode: executionMode as "fixture" | "mock_orchestrator" | "live", baselineRunId, idempotencyKey });
    if (executionMode !== "live" && !result.reused) evaluationGovernanceService.evaluateRunAlerts(result.run.id);
    res.status(result.reused ? 200 : 201).json({ run: publicEvaluationRun(result.run), reused: result.reused });
  } catch (error) {
    evaluationError(res, error);
  }
});

app.delete("/api/admin/ai-evaluations/:id", (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  if (req.header("x-confirm-delete") !== "true") return res.status(400).json({ error: "delete confirmation required", code: "delete_confirmation_required" });
  try {
    const result = evaluationService.delete(req.params.id);
    res.json(result);
  } catch (error) {
    evaluationError(res, error);
  }
});


  }
  return app;
}
