export interface LiveEvaluationPolicyInput {
  allowLiveFlag: boolean;
  environmentAllowLive: string | undefined;
  credentialUsageScope: "development_interactive" | "staging" | "production";
  billingMode: "pay_as_you_go" | "token_plan_personal" | "token_plan_team" | "unknown";
  providerHealth: "healthy" | "authentication_error" | "access_denied" | "quota_exhausted" | "rate_limited" | "degraded" | "unavailable" | "unknown";
  adminApproved: boolean;
  maxCases?: number;
  maxTokenBudget?: number;
}

export type LiveEvaluationRejectionReason = "flag_required" | "environment_required" | "production_credential" | "personal_plan_production" | "provider_unhealthy" | "admin_approval_required" | "max_cases_required" | "token_budget_required" | "invalid_limit";

export interface LiveEvaluationPolicyResult {
  allowed: boolean;
  reason?: LiveEvaluationRejectionReason;
}

/** Live is an explicit, bounded interface only; this module never calls a provider. */
export function validateLiveEvaluationPolicy(input: LiveEvaluationPolicyInput): LiveEvaluationPolicyResult {
  if (!input.allowLiveFlag) return { allowed: false, reason: "flag_required" };
  if (input.environmentAllowLive !== "true") return { allowed: false, reason: "environment_required" };
  if (input.billingMode === "token_plan_personal" && input.credentialUsageScope === "production") return { allowed: false, reason: "personal_plan_production" };
  if (input.providerHealth !== "healthy") return { allowed: false, reason: "provider_unhealthy" };
  if (!input.adminApproved) return { allowed: false, reason: "admin_approval_required" };
  if (!Number.isInteger(input.maxCases) || (input.maxCases as number) <= 0) return { allowed: false, reason: "max_cases_required" };
  if (!Number.isFinite(input.maxTokenBudget) || (input.maxTokenBudget as number) <= 0) return { allowed: false, reason: "token_budget_required" };
  return { allowed: true };
}
