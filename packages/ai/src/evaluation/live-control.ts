import type { ProviderHealth, ProviderBillingMode, StoredCredentialUsageScope } from "../provider-compliance";

export type TokenPoolTrafficClass = "production" | "development" | "evaluation";

export type LiveEvaluationRunStatus =
  | "pending_confirmation"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "budget_exhausted";

export interface LiveEvaluationSettings {
  enabled: boolean;
  evaluationPoolId?: string;
  allowedDatasetIds: string[];
  allowedLogicalModelIds: string[];
  allowedProviderIds: string[];
  maxCasesPerRun: number;
  maxTokensPerRun: number;
  maxTokensPerDay: number;
  maxConcurrentRuns: number;
  requireDryRun: boolean;
  requireExplicitConfirmation: boolean;
  updatedAt: string;
  updatedByAdminId?: string;
}

export const DEFAULT_LIVE_EVALUATION_SETTINGS: Omit<LiveEvaluationSettings, "updatedAt"> = {
  enabled: false,
  evaluationPoolId: undefined,
  allowedDatasetIds: [],
  allowedLogicalModelIds: [],
  allowedProviderIds: [],
  maxCasesPerRun: 0,
  maxTokensPerRun: 0,
  maxTokensPerDay: 0,
  maxConcurrentRuns: 1,
  requireDryRun: true,
  requireExplicitConfirmation: true
};

export interface LiveCredentialSnapshot {
  providerId: string;
  billingMode: ProviderBillingMode;
  usageScope: StoredCredentialUsageScope;
  providerHealth: ProviderHealth;
  status: "active" | "standby" | "disabled";
  deleted: boolean;
  allowEvaluation: boolean;
  evaluationAuthorized: boolean;
  regionValid: boolean;
  endpointValid: boolean;
}

export type CredentialEvaluationRejection =
  | "personal_plan_forbidden"
  | "development_scope_forbidden"
  | "evaluation_not_authorized"
  | "team_plan_not_authorized"
  | "credential_disabled"
  | "credential_deleted"
  | "region_mismatch"
  | "endpoint_mismatch"
  | "provider_unhealthy"
  | "unknown_billing_mode";

export function evaluateCredentialEligibility(
  credential: LiveCredentialSnapshot
): { allowed: true } | { allowed: false; reason: CredentialEvaluationRejection } {
  if (credential.billingMode === "token_plan_personal") return { allowed: false, reason: "personal_plan_forbidden" };
  if (credential.usageScope === "development_interactive" || credential.usageScope === "unknown") {
    return { allowed: false, reason: "development_scope_forbidden" };
  }
  if (credential.billingMode === "unknown") return { allowed: false, reason: "unknown_billing_mode" };
  if (credential.billingMode === "token_plan_team" && !credential.evaluationAuthorized) {
    return { allowed: false, reason: "team_plan_not_authorized" };
  }
  if (!credential.allowEvaluation || !credential.evaluationAuthorized) return { allowed: false, reason: "evaluation_not_authorized" };
  if (credential.deleted) return { allowed: false, reason: "credential_deleted" };
  if (credential.status === "disabled") return { allowed: false, reason: "credential_disabled" };
  if (!credential.regionValid) return { allowed: false, reason: "region_mismatch" };
  if (!credential.endpointValid) return { allowed: false, reason: "endpoint_mismatch" };
  if (!["healthy", "degraded"].includes(credential.providerHealth)) return { allowed: false, reason: "provider_unhealthy" };
  return { allowed: true };
}

export function validateLiveEvaluationSettings(input: Omit<LiveEvaluationSettings, "updatedAt" | "updatedByAdminId">): string[] {
  const blockers: string[] = [];
  if (!Number.isInteger(input.maxCasesPerRun) || input.maxCasesPerRun <= 0) blockers.push("max_cases_invalid");
  if (!Number.isInteger(input.maxTokensPerRun) || input.maxTokensPerRun <= 0) blockers.push("per_run_budget_invalid");
  if (!Number.isInteger(input.maxTokensPerDay) || input.maxTokensPerDay <= 0) blockers.push("daily_budget_invalid");
  if (!Number.isInteger(input.maxConcurrentRuns) || input.maxConcurrentRuns <= 0) blockers.push("concurrency_invalid");
  if (input.allowedDatasetIds.some((id) => !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id))) blockers.push("dataset_allowlist_invalid");
  if (input.allowedLogicalModelIds.some((id) => !/^[A-Za-z0-9._:-]{1,96}$/.test(id))) blockers.push("model_allowlist_invalid");
  if (input.allowedProviderIds.some((id) => !/^[a-z0-9_-]{1,40}$/.test(id))) blockers.push("provider_allowlist_invalid");
  return blockers;
}

export interface LivePreflightInput {
  settings: LiveEvaluationSettings;
  datasetId: string;
  datasetVersion: number;
  enabledCaseCount: number;
  requestedCaseCount: number;
  logicalModelIds: string[];
  modelMaxOutputTokens: number[];
  providerIds: string[];
  evaluationPoolRemainingTokens: number;
  dailyRemainingTokens: number;
  concurrentRuns: number;
  contextWindowAvailable: boolean;
  credentialEligible: boolean;
}

export interface LiveEvaluationPreflightResult {
  allowed: boolean;
  datasetId: string;
  datasetVersion: number;
  selectedCaseCount: number;
  estimatedMinimumModelCalls: number;
  estimatedMaximumModelCalls: number;
  estimatedMaximumTokens: number;
  evaluationPoolRemainingTokens: number;
  dailyRemainingTokens: number;
  blockers: string[];
  warnings: string[];
}

/** Pure preflight calculation. It never touches a provider or creates a reservation. */
export function evaluateLivePreflight(input: LivePreflightInput): LiveEvaluationPreflightResult {
  const selectedCaseCount = Math.max(0, Math.min(input.enabledCaseCount, input.requestedCaseCount));
  const maxCallsPerCase = 3;
  const estimatedMaximumTokens = selectedCaseCount * Math.max(1, input.modelMaxOutputTokens.reduce((sum, value) => sum + Math.max(0, value), 0));
  const blockers: string[] = [];
  const settingsErrors = validateLiveEvaluationSettings(input.settings);
  blockers.push(...settingsErrors);
  if (!input.settings.enabled) blockers.push("live_evaluation_disabled");
  if (!input.settings.allowedDatasetIds.includes(input.datasetId)) blockers.push("dataset_not_allowed");
  if (input.requestedCaseCount <= 0 || input.requestedCaseCount > input.settings.maxCasesPerRun) blockers.push("case_count_not_allowed");
  if (selectedCaseCount !== input.requestedCaseCount) blockers.push("case_count_exceeds_dataset");
  if (input.logicalModelIds.some((id) => !input.settings.allowedLogicalModelIds.includes(id))) blockers.push("logical_model_not_allowed");
  if (input.providerIds.some((id) => !input.settings.allowedProviderIds.includes(id))) blockers.push("provider_not_allowed");
  if (!input.credentialEligible) blockers.push("credential_not_eligible");
  if (!input.contextWindowAvailable) blockers.push("context_window_unavailable");
  if (input.concurrentRuns >= input.settings.maxConcurrentRuns) blockers.push("concurrent_run_limit");
  if (estimatedMaximumTokens > input.settings.maxTokensPerRun) blockers.push("per_run_budget_exceeded");
  if (estimatedMaximumTokens > input.settings.maxTokensPerDay || estimatedMaximumTokens > input.dailyRemainingTokens) blockers.push("daily_budget_exceeded");
  if (estimatedMaximumTokens > input.evaluationPoolRemainingTokens) blockers.push("evaluation_pool_exhausted");
  const warnings = ["Estimated maximum includes primary, verification and adjudication calls; actual calls may be lower."];
  return {
    allowed: blockers.length === 0,
    datasetId: input.datasetId,
    datasetVersion: input.datasetVersion,
    selectedCaseCount,
    estimatedMinimumModelCalls: selectedCaseCount,
    estimatedMaximumModelCalls: selectedCaseCount * maxCallsPerCase,
    estimatedMaximumTokens,
    evaluationPoolRemainingTokens: Math.max(0, input.evaluationPoolRemainingTokens),
    dailyRemainingTokens: Math.max(0, input.dailyRemainingTokens),
    blockers: [...new Set(blockers)],
    warnings
  };
}

export type LiveStatusTransitionResult = { allowed: true } | { allowed: false; reason: "invalid_transition" };

const LIVE_TRANSITIONS: Record<LiveEvaluationRunStatus, readonly LiveEvaluationRunStatus[]> = {
  pending_confirmation: ["running", "cancelled"],
  running: ["completed", "failed", "cancelled", "budget_exhausted"],
  completed: [],
  failed: [],
  cancelled: [],
  budget_exhausted: []
};

export function canTransitionLiveRun(from: LiveEvaluationRunStatus, to: LiveEvaluationRunStatus): LiveStatusTransitionResult {
  return LIVE_TRANSITIONS[from].includes(to) ? { allowed: true } : { allowed: false, reason: "invalid_transition" };
}
