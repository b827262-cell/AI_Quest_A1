import { createHash, randomBytes } from "node:crypto";
import {
  DEFAULT_EVALUATION_RETENTION_POLICY,
  budgetAlertTypes,
  compareGovernanceRuns,
  retentionCandidates,
  regressionAlertSeverity,
  scheduleWindowKey,
  scheduledWindowIsDue,
  validateRetentionPolicy,
  validateSchedule,
  type EvaluationAlertRecord,
  type EvaluationBudgetAlertPolicy,
  type EvaluationRegressionAlertPolicy,
  type EvaluationRetentionPolicy,
  type EvaluationSchedule,
  type GovernanceRunSnapshot
} from "@ai-smartbook/ai";
import type { Repositories } from "@ai-smartbook/db";
import { EvaluationServiceError, type EvaluationService } from "./evaluation-service";

const DEFAULT_ALERT_POLICY: EvaluationRegressionAlertPolicy = {
  enabled: false,
  minimumSampleSize: 1,
  consecutiveFailuresRequired: 1
};
const DEFAULT_BUDGET_POLICY: EvaluationBudgetAlertPolicy = {};
const RETENTION_PREVIEW_TTL_MS = 10 * 60 * 1000;

export class EvaluationGovernanceError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) { super(message); this.name = "EvaluationGovernanceError"; }
}

function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function parseList(value: string | null): string[] { try { const parsed: unknown = JSON.parse(value ?? "[]"); return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : []; } catch { return []; } }
function safeJson<T extends object>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

function snapshot(row: ReturnType<Repositories["aiEvaluationRuns"]["findById"]>): GovernanceRunSnapshot | undefined {
  if (!row) return undefined;
  return { id: row.id, datasetId: row.datasetId, datasetVersion: row.datasetVersion, executionMode: row.executionMode as "fixture" | "mock_orchestrator" | "live", status: row.status, createdAt: row.createdAt, totalCases: row.totalCases, passRate: row.passRate, averageScore: row.averageScore, unresolvedRate: row.unresolvedRate, conflictRate: row.conflictRate, averageModelCalls: row.averageModelCalls, p95DurationMs: row.p95DurationMs, totalTokens: row.totalTokens, regressionIssueCount: row.regressionIssueCount, baselineRunId: row.baselineRunId, logicalModelIds: parseList(row.logicalModelIdsJson) };
}

function settingsFromRow(row: ReturnType<Repositories["aiEvaluationGovernance"]["getSettings"]>) {
  return {
    retention: { ...DEFAULT_EVALUATION_RETENTION_POLICY, ...(row?.retention ?? {}) } as EvaluationRetentionPolicy,
    regressionAlert: { ...DEFAULT_ALERT_POLICY, ...(row?.regressionAlert ?? {}) } as EvaluationRegressionAlertPolicy,
    budgetAlert: { ...DEFAULT_BUDGET_POLICY, ...(row?.budgetAlert ?? {}) } as EvaluationBudgetAlertPolicy,
    schedulerEnabled: row?.schedulerEnabled ?? false,
    updatedAt: row?.updatedAt ?? ""
  };
}

export function makeEvaluationGovernanceService(
  repos: Repositories,
  offlineEvaluation: EvaluationService,
  audit: (action: string, targetId: string, metadata: Record<string, unknown>) => void
) {
  const governance = repos.aiEvaluationGovernance;
  const runs = repos.aiEvaluationRuns;

  function getSettings() { return settingsFromRow(governance.getSettings()); }

  function saveSettings(input: { retention: EvaluationRetentionPolicy; regressionAlert: EvaluationRegressionAlertPolicy; budgetAlert: EvaluationBudgetAlertPolicy; schedulerEnabled: boolean }, adminId: string) {
    const retentionErrors = validateRetentionPolicy(input.retention);
    if (retentionErrors.length) throw new EvaluationGovernanceError("invalid_retention_policy", "Retention Policy 不符合安全限制", 400);
    if (!Number.isInteger(input.regressionAlert.minimumSampleSize) || input.regressionAlert.minimumSampleSize <= 0 || input.regressionAlert.consecutiveFailuresRequired <= 0) throw new EvaluationGovernanceError("invalid_alert_policy", "告警 Policy 不符合安全限制", 400);
    const saved = governance.saveSettings({ retention: safeJson(input.retention as unknown as Record<string, unknown>), regressionAlert: safeJson(input.regressionAlert as unknown as Record<string, unknown>), budgetAlert: safeJson(input.budgetAlert as unknown as Record<string, unknown>), schedulerEnabled: input.schedulerEnabled, updatedByAdminId: adminId });
    audit("evaluation.governance.settings_updated", "default", { schedulerEnabled: input.schedulerEnabled, retentionEnabled: input.retention.enabled, alertEnabled: input.regressionAlert.enabled });
    return settingsFromRow(saved);
  }

  function retentionPreview(adminId: string) {
    const policy = getSettings().retention;
    const all = runs.listRuns({ limit: 100 }).rows.map((row) => snapshot(row)).filter((row): row is GovernanceRunSnapshot => Boolean(row));
    const result = retentionCandidates(all, policy);
    const candidates = result.candidates.map((candidate) => {
      const metrics = repos.aiEvaluationMetrics.listByRun(candidate.id).length;
      const issues = repos.aiEvaluationIssues.listByRun(candidate.id).length;
      return { ...candidate, estimatedMetricCount: metrics, estimatedIssueCount: issues };
    });
    const token = randomBytes(24).toString("base64url");
    const row = governance.createRetentionPreview({ candidateIds: candidates.map((candidate) => candidate.id), candidateDigest: digest(token), expiresAt: new Date(Date.now() + RETENTION_PREVIEW_TTL_MS).toISOString(), createdByAdminId: adminId });
    audit("evaluation.retention.previewed", row.id, { candidateCount: candidates.length });
    return { id: row.id, expiresAt: row.expiresAt, confirmationToken: token, candidates, protectedCount: result.protectedCount, estimatedDeletedMetrics: candidates.reduce((sum, candidate) => sum + candidate.estimatedMetricCount, 0), estimatedDeletedIssues: candidates.reduce((sum, candidate) => sum + candidate.estimatedIssueCount, 0) };
  }

  function runAutomaticRetention() {
    if (!getSettings().retention.enabled) return { deleted: 0, skipped: true };
    const preview = retentionPreview("scheduler");
    const result = governance.executeRetentionPreview(preview.id, preview.candidates.map((candidate) => candidate.id), digest(preview.confirmationToken));
    if (result.reason !== "executed") throw new EvaluationGovernanceError("retention_failed", "Retention 清理未完成", 500);
    audit("evaluation.retention.completed", preview.id, { deletedCount: result.deleted });
    return { deleted: result.deleted, skipped: false };
  }

  function executeRetention(input: { previewId: string; confirmationToken: string }, adminId: string) {
    if (!getSettings().retention.enabled) throw new EvaluationGovernanceError("retention_disabled", "Retention 目前停用", 409);
    const preview = governance.findRetentionPreview(input.previewId);
    if (!preview || Date.parse(preview.expiresAt) <= Date.now()) throw new EvaluationGovernanceError("retention_preview_expired", "Retention Preview 已過期", 409);
    const candidateIds = parseList(preview.candidateIdsJson);
    const all = runs.listRuns({ limit: 100 }).rows.map((row) => snapshot(row)).filter((row): row is GovernanceRunSnapshot => Boolean(row));
    const fresh = retentionCandidates(all, getSettings().retention).candidates.map((candidate) => candidate.id);
    if (JSON.stringify(fresh) !== JSON.stringify(candidateIds)) throw new EvaluationGovernanceError("retention_candidate_changed", "Candidate Set 已變更，請重新產生 Preview", 409);
    const result = governance.executeRetentionPreview(input.previewId, candidateIds, digest(input.confirmationToken));
    if (result.reason !== "executed") throw new EvaluationGovernanceError(result.reason, "Retention Preview 無法執行", 409);
    audit("evaluation.retention.executed", input.previewId, { candidateCount: result.deleted, adminIdHash: digest(adminId) });
    return result;
  }

  function listSchedules() { return governance.listSchedules(); }
  function createSchedule(input: Omit<EvaluationSchedule, "id" | "createdAt" | "updatedAt">, adminId: string) {
    const errors = validateSchedule(input);
    if (errors.length) throw new EvaluationGovernanceError("invalid_schedule", "排程設定不符合安全限制", 400);
    if (input.datasetId !== "phase-4a-core") throw new EvaluationGovernanceError("dataset_not_allowed", "Dataset 不在 Server Allowlist", 400);
    if (input.baselinePolicy === "fixed" && input.fixedBaselineRunId) {
      const baseline = runs.findById(input.fixedBaselineRunId);
      if (!baseline || baseline.status !== "completed" || baseline.datasetId !== input.datasetId || baseline.datasetVersion !== input.datasetVersion || baseline.executionMode !== input.executionMode) throw new EvaluationGovernanceError("baseline_not_comparable", "固定 Baseline 不可比較", 409);
    }
    const row = governance.createSchedule(input);
    audit("evaluation.schedule.created", row.id, { datasetId: row.datasetId, datasetVersion: row.datasetVersion, executionMode: row.executionMode, adminIdHash: digest(adminId) });
    return row;
  }
  function updateSchedule(id: string, input: Partial<Omit<EvaluationSchedule, "id" | "createdAt" | "updatedAt">>, adminId: string) {
    const current = governance.findSchedule(id);
    if (!current) throw new EvaluationGovernanceError("schedule_not_found", "排程不存在", 404);
    const next = { ...current, ...input } as Omit<EvaluationSchedule, "id" | "createdAt" | "updatedAt">;
    const errors = validateSchedule(next);
    if (errors.length) throw new EvaluationGovernanceError("invalid_schedule", "排程設定不符合安全限制", 400);
    const row = governance.updateSchedule(id, input)!;
    audit("evaluation.schedule.updated", id, { enabled: row.enabled, datasetId: row.datasetId, executionMode: row.executionMode, adminIdHash: digest(adminId) });
    return row;
  }
  function deleteSchedule(id: string) { const deleted = governance.deleteSchedule(id); audit("evaluation.schedule.deleted", id, { deleted }); return { deleted }; }

  async function runDue(now = new Date(), adminId = "scheduler") {
    const settings = getSettings();
    if (!settings.schedulerEnabled) return [];
    const results: Array<{ scheduleId: string; status: "completed" | "failed" | "skipped"; runId?: string }> = [];
    try {
      runAutomaticRetention();
    } catch {
      governance.createAlert({ type: "retention_failed", severity: "warning", safeSummary: "Retention 自動清理失敗" });
    }
    const liveSettings = repos.aiEvaluationControl.getSettings();
    if (liveSettings?.evaluationPoolId) checkBudgetAlerts(liveSettings.evaluationPoolId, new Date(now).toISOString().slice(0, 10));
    for (const rawSchedule of governance.listSchedules()) {
      const schedule = rawSchedule as unknown as EvaluationSchedule;
      if (!schedule.enabled || !scheduledWindowIsDue(schedule, now)) continue;
      const window = scheduleWindowKey(schedule, now);
      const claim = governance.claimScheduleWindow({ scheduleId: schedule.id, scheduledWindow: window, idempotencyKey: `schedule:${schedule.id}:${window}` });
      if (!claim) { results.push({ scheduleId: schedule.id, status: "skipped" }); continue; }
      try {
        const output = await offlineEvaluation.start({ datasetId: schedule.datasetId, executionMode: schedule.executionMode, baselineRunId: schedule.baselinePolicy === "fixed" ? schedule.fixedBaselineRunId : undefined, idempotencyKey: claim.idempotencyKey, createdByAdminId: adminId });
        governance.completeScheduleWindow(claim.id, output.run.id);
        evaluateRunAlerts(output.run.id);
        audit("evaluation.schedule.run_completed", claim.id, { scheduleId: schedule.id, runId: output.run.id, executionMode: schedule.executionMode });
        results.push({ scheduleId: schedule.id, status: "completed", runId: output.run.id });
      } catch (error) {
        const code = error instanceof EvaluationServiceError ? error.code : "evaluation_failed";
        governance.failScheduleWindow(claim.id, code);
        governance.createAlert({ scheduleId: schedule.id, type: "run_failed", severity: "warning", safeSummary: "排程評測執行失敗" });
        audit("evaluation.schedule.run_failed", claim.id, { scheduleId: schedule.id, errorCode: code });
        results.push({ scheduleId: schedule.id, status: "failed" });
      }
    }
    return results;
  }

  function evaluateRunAlerts(runId: string) {
    const current = snapshot(runs.findById(runId));
    if (!current) throw new EvaluationGovernanceError("run_not_found", "評測 Run 不存在", 404);
    const settings = getSettings();
    const baseline = current.baselineRunId ? snapshot(runs.findById(current.baselineRunId)) : snapshot(runs.findLatestComparableBaseline(current.datasetId, current.datasetVersion, current.executionMode, current.id));
    if (!baseline) return [] as EvaluationAlertRecord[];
    const categoryMetrics = repos.aiEvaluationMetrics.listByRun(runId).filter((metric) => metric.dimension === "category").map((metric) => ({ dimension: metric.dimension, dimensionValue: metric.dimensionValue, passRate: metric.passRate }));
    const baselineCategoryMetrics = repos.aiEvaluationMetrics.listByRun(baseline.id).filter((metric) => metric.dimension === "category").map((metric) => ({ dimension: metric.dimension, dimensionValue: metric.dimensionValue, passRate: metric.passRate }));
    const types = compareGovernanceRuns(current, baseline, settings.regressionAlert, categoryMetrics, baselineCategoryMetrics);
    const openCount = governance.listAlerts("open").length;
    return types.map((type) => governance.createAlert({ runId, type, severity: regressionAlertSeverity(openCount + 1, settings.regressionAlert.consecutiveFailuresRequired), safeSummary: "評測指標相較可比較 Baseline 出現退化" })) as unknown as EvaluationAlertRecord[];
  }
  function checkBudgetAlerts(poolId: string, usageDate: string) {
    const settings = getSettings();
    const live = repos.aiEvaluationControl.getSettings();
    const pool = repos.aiEvaluationControl.poolSnapshot(poolId);
    const daily = live ? repos.aiEvaluationControl.dailySnapshot(usageDate, live.maxTokensPerDay) : undefined;
    return budgetAlertTypes(settings.budgetAlert, pool?.remainingTokens, daily?.remainingTokens).map((type) => governance.createAlert({ type, severity: "warning", safeSummary: "Evaluation 預算或 Pool 已低於管理員設定閾值" }));
  }
  function listAlerts(status?: "open" | "acknowledged" | "resolved") { return governance.listAlerts(status); }
  function acknowledgeAlert(id: string) { return governance.acknowledgeAlert(id); }
  function resolveAlert(id: string) { return governance.resolveAlert(id); }

  return { getSettings, saveSettings, retentionPreview, executeRetention, listSchedules, createSchedule, updateSchedule, deleteSchedule, runDue, evaluateRunAlerts, checkBudgetAlerts, listAlerts, acknowledgeAlert, resolveAlert };
}

export type EvaluationGovernanceService = ReturnType<typeof makeEvaluationGovernanceService>;
