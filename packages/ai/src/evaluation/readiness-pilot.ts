export type PilotTaskCategory = "programming" | "mathematics" | "knowledge";

export interface LiveEvaluationReadiness {
  ready: boolean;
  credentialReady: boolean;
  evaluationPoolReady: boolean;
  budgetReady: boolean;
  allowlistReady: boolean;
  liveEnabled: boolean;
  blockers: string[];
  warnings: string[];
  checkedAt: string;
}

export interface LiveReadinessInputs {
  credentialReady: boolean;
  evaluationPoolReady: boolean;
  budgetReady: boolean;
  allowlistReady: boolean;
  liveEnabled: boolean;
  liveSmokeCompleted?: boolean;
  providerIds?: string[];
  logicalModelIds?: string[];
}

export function buildLiveEvaluationReadiness(input: LiveReadinessInputs, checkedAt = new Date().toISOString()): LiveEvaluationReadiness {
  const blockers: string[] = [];
  if (!input.credentialReady) blockers.push("credential_not_ready");
  if (!input.evaluationPoolReady) blockers.push("evaluation_pool_not_ready");
  if (!input.budgetReady) blockers.push("evaluation_budget_not_ready");
  if (!input.allowlistReady) blockers.push("server_allowlist_not_ready");
  if (!input.liveEnabled) blockers.push("live_evaluation_disabled");
  const warnings: string[] = [];
  if (!input.liveSmokeCompleted) warnings.push("live_smoke_test_not_completed");
  if (!input.providerIds?.length) warnings.push("no_provider_identifiers_available");
  if (!input.logicalModelIds?.length) warnings.push("no_logical_model_identifiers_available");
  return {
    ready: blockers.length === 0,
    credentialReady: input.credentialReady,
    evaluationPoolReady: input.evaluationPoolReady,
    budgetReady: input.budgetReady,
    allowlistReady: input.allowlistReady,
    liveEnabled: input.liveEnabled,
    blockers: [...new Set(blockers)],
    warnings: [...new Set(warnings)],
    checkedAt
  };
}

export interface ProductionReadinessCheck {
  name: string;
  passed: boolean;
  severity: "blocker" | "warning";
  safeSummary: string;
}

export interface ProductionReadinessResult {
  status: "ready_for_pilot" | "blocked" | "ready_with_warnings";
  checks: ProductionReadinessCheck[];
  blockers: string[];
  warnings: string[];
  liveRunId?: string;
  reviewedAt: string;
}

export interface ProductionReadinessInputs {
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
  liveSmokeCompleted: boolean;
  liveSmokeSafe: boolean;
  regressionAlertsConfigured: boolean;
  retentionConfigured: boolean;
  schedulerDisabledByDefault: boolean;
  auditLogReady: boolean;
  pilotFeatureFlagReady: boolean;
  emergencyKillSwitchReady: boolean;
  liveEvaluationEnabled?: boolean;
  warnings?: string[];
  liveRunId?: string;
}

const READINESS_CHECKS: Array<[keyof ProductionReadinessInputs, string, string]> = [
  ["typecheckPassed", "typecheck", "Typecheck 已通過"],
  ["testSuitePassed", "test_suite", "全量測試已通過"],
  ["buildPassed", "build", "Build 已通過"],
  ["diffClean", "diff_check", "Diff Check 已通過"],
  ["securityScansClean", "security_scans", "Skip／Only、Secret、Artifact 掃描已通過"],
  ["credentialPolicyPassed", "credential_policy", "Credential 生產政策檢查已通過"],
  ["evaluationCredentialPassed", "evaluation_credential", "Evaluation Credential Eligibility 已通過"],
  ["evaluationPoolIsolated", "evaluation_pool", "Evaluation Pool 與 Production Pool 隔離"],
  ["reservationIdempotencyPassed", "reservation_idempotency", "Reservation Idempotency 已驗證"],
  ["orchestratorSafetyPassed", "orchestrator_safety", "Context／Verification／Adjudication 安全檢查已通過"],
  ["fixtureBaselinePassed", "fixture_baseline", "Fixture Baseline 已通過"],
  ["mockBaselinePassed", "mock_baseline", "Mock Baseline 已通過"],
  ["liveSmokeCompleted", "live_smoke", "3 題 Live Smoke Test 已完成"],
  ["liveSmokeSafe", "live_smoke_isolation", "Live Smoke 隔離與 Settlement 已通過"],
  ["regressionAlertsConfigured", "regression_alerts", "Regression Alert 已設定"],
  ["retentionConfigured", "retention", "Retention Policy 已設定"],
  ["schedulerDisabledByDefault", "scheduler", "Live Scheduler 預設停用"],
  ["auditLogReady", "audit_log", "安全 Audit Log 已就緒"],
  ["pilotFeatureFlagReady", "pilot_flag", "Pilot Feature Flag 已就緒"],
  ["emergencyKillSwitchReady", "kill_switch", "Emergency Kill Switch 已就緒"]
];

export function evaluateProductionReadiness(input: ProductionReadinessInputs, reviewedAt = new Date().toISOString()): ProductionReadinessResult {
  const checks = READINESS_CHECKS.map(([field, name, summary]) => ({
    name,
    passed: Boolean(input[field]),
    severity: "blocker" as const,
    safeSummary: Boolean(input[field]) ? summary : `${summary}：尚未通過`
  }));
  const warnings = [...new Set((input.warnings ?? []).map((warning) => warning.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80)).filter(Boolean))];
  const warningChecks = warnings.map((warning) => ({ name: `warning:${warning}`, passed: false, severity: "warning" as const, safeSummary: `注意事項：${warning}` }));
  const liveCheck = input.liveEvaluationEnabled === false ? [{ name: "live_evaluation_enabled", passed: false, severity: "blocker" as const, safeSummary: "Live Evaluation 必須由管理員明確啟用" }] : [];
  const allChecks = [...checks, ...liveCheck, ...warningChecks];
  const blockers = allChecks.filter((check) => !check.passed && check.severity === "blocker").map((check) => check.name);
  return {
    status: blockers.length > 0 ? "blocked" : warnings.length > 0 ? "ready_with_warnings" : "ready_for_pilot",
    checks: allChecks,
    blockers,
    warnings,
    ...(input.liveRunId ? { liveRunId: input.liveRunId } : {}),
    reviewedAt
  };
}

export interface MultiModelPilotSettings {
  enabled: boolean;
  trafficPercentage: number;
  allowedTaskCategories: PilotTaskCategory[];
  allowVerification: boolean;
  allowAdjudication: boolean;
  maxModelCallsPerRequest: number;
  pilotVersion: string;
  stopPolicy: PilotStopPolicy;
  updatedAt: string;
  updatedByAdminId?: string;
  autoStoppedAt?: string;
  autoStopReason?: string;
}

export const DEFAULT_MULTI_MODEL_PILOT_SETTINGS: Omit<MultiModelPilotSettings, "updatedAt"> = {
  enabled: false,
  trafficPercentage: 0,
  allowedTaskCategories: [],
  allowVerification: true,
  allowAdjudication: false,
  maxModelCallsPerRequest: 2,
  pilotVersion: "phase-5a-default",
  stopPolicy: { minimumRequestCount: 100, consecutiveWindows: 2 }
};

export function validatePilotSettings(input: Omit<MultiModelPilotSettings, "updatedAt" | "updatedByAdminId" | "autoStoppedAt" | "autoStopReason">): string[] {
  const errors: string[] = [];
  if (!Number.isInteger(input.trafficPercentage) || input.trafficPercentage < 0 || input.trafficPercentage > 100) errors.push("traffic_percentage_invalid");
  if (!Number.isInteger(input.maxModelCallsPerRequest) || input.maxModelCallsPerRequest < 1 || input.maxModelCallsPerRequest > 3) errors.push("max_model_calls_invalid");
  if (!/^[A-Za-z0-9._:-]{1,64}$/.test(input.pilotVersion)) errors.push("pilot_version_invalid");
  if (input.allowedTaskCategories.some((category) => !["programming", "mathematics", "knowledge"].includes(category))) errors.push("task_category_not_allowed");
  if (input.enabled && input.trafficPercentage === 0) errors.push("enabled_requires_traffic");
  if (input.enabled && input.allowedTaskCategories.length === 0) errors.push("enabled_requires_category");
  if (!input.allowVerification && input.allowAdjudication) errors.push("adjudication_requires_verification");
  errors.push(...validatePilotStopPolicy(input.stopPolicy));
  return [...new Set(errors)];
}

function stableBucket(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 100;
}

export function assignPilot(subjectId: string | undefined, settings: MultiModelPilotSettings, category: string): boolean {
  if (!subjectId || !settings.enabled || settings.trafficPercentage <= 0) return false;
  if (!settings.allowedTaskCategories.includes(category as PilotTaskCategory)) return false;
  return stableBucket(`${subjectId}:${settings.pilotVersion}`) < settings.trafficPercentage;
}

export interface PilotWindowMetrics {
  windowKey: string;
  requestCount: number;
  providerFailureRate: number;
  unresolvedRate: number;
  budgetRejectionRate: number;
  p95LatencyMs: number;
}

export interface PilotStopPolicy {
  providerFailureRateThreshold?: number;
  unresolvedRateThreshold?: number;
  budgetRejectionRateThreshold?: number;
  p95LatencyThresholdMs?: number;
  minimumRequestCount: number;
  consecutiveWindows: number;
}

export interface PilotAutoStopResult {
  shouldStop: boolean;
  consecutiveWindows: number;
  reasons: string[];
}

export function validatePilotStopPolicy(policy: PilotStopPolicy): string[] {
  const errors: string[] = [];
  for (const value of [policy.providerFailureRateThreshold, policy.unresolvedRateThreshold, policy.budgetRejectionRateThreshold]) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0 || value > 1)) errors.push("rate_threshold_invalid");
  }
  if (policy.p95LatencyThresholdMs !== undefined && (!Number.isFinite(policy.p95LatencyThresholdMs) || policy.p95LatencyThresholdMs < 0)) errors.push("latency_threshold_invalid");
  if (!Number.isInteger(policy.minimumRequestCount) || policy.minimumRequestCount <= 0) errors.push("minimum_sample_invalid");
  if (!Number.isInteger(policy.consecutiveWindows) || policy.consecutiveWindows <= 0) errors.push("consecutive_windows_invalid");
  return [...new Set(errors)];
}

export function evaluatePilotAutoStop(windows: PilotWindowMetrics[], policy: PilotStopPolicy): PilotAutoStopResult {
  if (validatePilotStopPolicy(policy).length > 0) return { shouldStop: false, consecutiveWindows: 0, reasons: ["invalid_stop_policy"] };
  let consecutiveWindows = 0;
  const reasons: string[] = [];
  for (const window of [...windows].reverse()) {
    if (window.requestCount < policy.minimumRequestCount) break;
    const windowReasons: string[] = [];
    if (policy.providerFailureRateThreshold !== undefined && window.providerFailureRate >= policy.providerFailureRateThreshold) windowReasons.push("provider_failure_rate");
    if (policy.unresolvedRateThreshold !== undefined && window.unresolvedRate >= policy.unresolvedRateThreshold) windowReasons.push("unresolved_rate");
    if (policy.budgetRejectionRateThreshold !== undefined && window.budgetRejectionRate >= policy.budgetRejectionRateThreshold) windowReasons.push("budget_rejection_rate");
    if (policy.p95LatencyThresholdMs !== undefined && window.p95LatencyMs >= policy.p95LatencyThresholdMs) windowReasons.push("p95_latency");
    if (windowReasons.length === 0) break;
    consecutiveWindows += 1;
    reasons.push(...windowReasons);
  }
  return { shouldStop: consecutiveWindows >= policy.consecutiveWindows, consecutiveWindows, reasons: [...new Set(reasons)] };
}
