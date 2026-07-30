import {
  assignPilot,
  DEFAULT_MULTI_MODEL_PILOT_SETTINGS,
  evaluatePilotAutoStop,
  evaluateProductionReadiness,
  validatePilotSettings,
  validatePilotStopPolicy,
  type MultiModelPilotSettings,
  type PilotStopPolicy,
  type ProductionReadinessResult
} from "@ai-smartbook/ai";
import type { Repositories } from "@ai-smartbook/db";

const DEFAULT_STOP_POLICY: PilotStopPolicy = { minimumRequestCount: 100, consecutiveWindows: 2 };

export class PilotServiceError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); this.name = "PilotServiceError"; }
}

type ReadinessReviewFields = {
  testSuitePassed: boolean;
  typecheckPassed: boolean;
  buildPassed: boolean;
  diffClean: boolean;
  securityScansClean: boolean;
  credentialPolicyPassed: boolean;
  evaluationCredentialPassed: boolean;
  evaluationPoolIsolated: boolean;
  reservationIdempotencyPassed: boolean;
  orchestratorSafetyPassed: boolean;
  fixtureBaselinePassed: boolean;
  mockBaselinePassed: boolean;
  regressionAlertsConfigured: boolean;
  retentionConfigured: boolean;
  schedulerDisabledByDefault: boolean;
  auditLogReady: boolean;
  pilotFeatureFlagReady: boolean;
  emergencyKillSwitchReady: boolean;
};

function safeReview(row: Record<string, unknown> | undefined): ReadinessReviewFields {
  const keys = Object.keys({ testSuitePassed: true, typecheckPassed: true, buildPassed: true, diffClean: true, securityScansClean: true, credentialPolicyPassed: true, evaluationCredentialPassed: true, evaluationPoolIsolated: true, reservationIdempotencyPassed: true, orchestratorSafetyPassed: true, fixtureBaselinePassed: true, mockBaselinePassed: true, regressionAlertsConfigured: true, retentionConfigured: true, schedulerDisabledByDefault: true, auditLogReady: true, pilotFeatureFlagReady: true, emergencyKillSwitchReady: true }) as Array<keyof ReadinessReviewFields>;
  return Object.fromEntries(keys.map((key) => [key, row?.[key] === true])) as ReadinessReviewFields;
}

export function makePilotService(
  repos: Repositories,
  liveEvaluationService: { readiness: () => Record<string, unknown> },
  audit: (action: string, targetId: string, metadata: Record<string, unknown>) => void
) {
  function settings(): MultiModelPilotSettings {
    const row = repos.aiMultiModelPilot.getSettings();
    if (!row) return { ...DEFAULT_MULTI_MODEL_PILOT_SETTINGS, stopPolicy: DEFAULT_STOP_POLICY, updatedAt: "" };
    return {
      enabled: row.enabled, trafficPercentage: row.trafficPercentage, allowedTaskCategories: row.allowedTaskCategories,
      allowVerification: row.allowVerification, allowAdjudication: row.allowAdjudication,
      maxModelCallsPerRequest: row.maxModelCallsPerRequest, pilotVersion: row.pilotVersion,
      stopPolicy: row.stopPolicy,
      updatedAt: row.updatedAt, updatedByAdminId: row.updatedByAdminId ?? undefined,
      autoStoppedAt: row.autoStoppedAt ?? undefined, autoStopReason: row.autoStopReason ?? undefined
    };
  }

  function readiness() { return liveEvaluationService.readiness(); }

  function latestSmokeRun() {
    return repos.aiEvaluationRuns.listRuns({ executionMode: "live", status: "completed", limit: 100 }).rows
      .find((run) => run.totalCases === 3 && run.trafficClass === "evaluation");
  }

  function productionReadiness(): ProductionReadinessResult {
    const liveGate = liveEvaluationService.readiness();
    const review = safeReview(repos.aiMultiModelPilot.getSettings()?.readinessReview);
    const smoke = latestSmokeRun();
    const smokeCompleted = Boolean(smoke);
    const smokeSafe = Boolean(smoke && smoke.totalTokens !== null && smoke.maxTokenBudget !== null && smoke.totalTokens <= smoke.maxTokenBudget
      && smoke.evaluationPoolId && smoke.trafficClass === "evaluation" && repos.aiEvaluationControl.pendingReservations(smoke.id).length === 0);
    const fixture = repos.aiEvaluationRuns.listRuns({ executionMode: "fixture", status: "completed", limit: 1 }).total > 0;
    const mock = repos.aiEvaluationRuns.listRuns({ executionMode: "mock_orchestrator", status: "completed", limit: 1 }).total > 0;
    return evaluateProductionReadiness({
      ...review,
      credentialPolicyPassed: review.credentialPolicyPassed && liveGate.credentialReady === true,
      evaluationCredentialPassed: review.evaluationCredentialPassed && liveGate.credentialReady === true,
      evaluationPoolIsolated: review.evaluationPoolIsolated && liveGate.evaluationPoolReady === true,
      reservationIdempotencyPassed: review.reservationIdempotencyPassed && liveGate.budgetReady === true,
      pilotFeatureFlagReady: review.pilotFeatureFlagReady && liveGate.allowlistReady === true,
      fixtureBaselinePassed: review.fixtureBaselinePassed || fixture,
      mockBaselinePassed: review.mockBaselinePassed || mock,
      liveEvaluationEnabled: liveGate.liveEnabled === true,
      liveSmokeCompleted: smokeCompleted,
      liveSmokeSafe: smokeSafe,
      liveRunId: smoke?.id
    });
  }

  function review(input: Record<string, unknown>, adminId: string) {
    const allowed = safeReview(input);
    repos.aiMultiModelPilot.saveReadinessReview(allowed, adminId);
    audit("ai_pilot.readiness_reviewed", "default", { status: productionReadiness().status });
    return productionReadiness();
  }

  function saveSettings(input: Omit<MultiModelPilotSettings, "updatedAt" | "updatedByAdminId" | "autoStoppedAt" | "autoStopReason">, adminId: string) {
    const errors = validatePilotSettings(input);
    if (errors.length) throw new PilotServiceError("invalid_pilot_settings", "Pilot 設定不符合安全限制", 400);
    if (input.allowAdjudication && input.maxModelCallsPerRequest < 3) throw new PilotServiceError("adjudication_call_limit_invalid", "啟用裁決時模型呼叫上限至少需要 3", 400);
    if (input.enabled && productionReadiness().status !== "ready_for_pilot") throw new PilotServiceError("production_readiness_required", "Production Readiness Review 尚未允許 Pilot", 409);
    // Preserve the existing readiness review: settings updates must never wipe
    // the review that enabling the Pilot depends on, and the request body must
    // not be allowed to forge one (only review() may file a review).
    const existingReview = repos.aiMultiModelPilot.getSettings()?.readinessReview ?? {};
    const row = repos.aiMultiModelPilot.saveSettings({ ...input, stopPolicy: input.stopPolicy, readinessReview: existingReview, updatedByAdminId: adminId });
    audit(input.enabled ? "ai_pilot.enabled" : "ai_pilot.settings_updated", "default", { enabled: input.enabled, trafficPercentage: input.trafficPercentage, pilotVersion: input.pilotVersion, allowVerification: input.allowVerification, allowAdjudication: input.allowAdjudication });
    return { ...settings(), autoStoppedAt: row.autoStoppedAt ?? undefined, autoStopReason: row.autoStopReason ?? undefined };
  }

  function disable(reason: string, adminId: string) {
    const current = repos.aiMultiModelPilot.getSettings();
    if (!current) {
      repos.aiMultiModelPilot.saveSettings({ ...DEFAULT_MULTI_MODEL_PILOT_SETTINGS, stopPolicy: DEFAULT_STOP_POLICY, updatedByAdminId: adminId });
    }
    repos.aiMultiModelPilot.markAutoStopped(reason);
    audit("ai_pilot.disabled", "default", { reason: reason.slice(0, 120), enabled: false });
    return settings();
  }

  function assignment(subjectId: string | undefined, category: string) {
    const current = settings();
    const allowed = productionReadiness().status === "ready_for_pilot";
    return { pilot: allowed && assignPilot(subjectId, current, category), trafficClass: allowed ? "pilot" : "production", pilotVersion: allowed ? current.pilotVersion : undefined };
  }

  function metrics() {
    return repos.aiMultiModelPilot.listMetrics(200).map((row) => ({
      ...row,
      providerFailureRate: row.requestCount ? row.providerFailureCount / row.requestCount : 0,
      unresolvedRate: row.requestCount ? row.unresolvedCount / row.requestCount : 0,
      budgetRejectionRate: row.requestCount ? row.budgetRejectionCount / row.requestCount : 0
    }));
  }

  function recordWindow(input: Parameters<Repositories["aiMultiModelPilot"]["recordWindow"]>[0], adminId = "system") {
    const row = repos.aiMultiModelPilot.recordWindow(input);
    const stop = evaluatePilotAutoStop(metrics().filter((metric) => metric.trafficClass === "pilot").map((metric) => ({ windowKey: metric.windowKey, requestCount: metric.requestCount, providerFailureRate: metric.providerFailureRate, unresolvedRate: metric.unresolvedRate, budgetRejectionRate: metric.budgetRejectionRate, p95LatencyMs: metric.p95LatencyMs })), settings().stopPolicy as PilotStopPolicy);
    if (stop.shouldStop && settings().enabled) {
      disable(`auto_stop:${stop.reasons.join(",")}`, adminId);
      repos.aiEvaluationGovernance.createAlert({ type: "pilot_auto_stop", severity: "critical", safeSummary: "Pilot 因連續品質或營運指標超過管理員門檻而自動停用" });
      audit("ai_pilot.auto_stopped", "default", { reason: "threshold_exceeded", consecutiveWindows: stop.consecutiveWindows });
    }
    return { row, stop };
  }

  function validateStopPolicy(input: PilotStopPolicy) {
    const errors = validatePilotStopPolicy(input);
    if (errors.length) throw new PilotServiceError("invalid_pilot_stop_policy", "Pilot 自動停止策略不符合安全限制", 400);
    return input;
  }

  return { settings, readiness, productionReadiness, review, saveSettings, disable, assignment, metrics, recordWindow, validateStopPolicy };
}

export type PilotService = ReturnType<typeof makePilotService>;
