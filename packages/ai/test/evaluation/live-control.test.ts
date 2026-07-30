import { describe, expect, it } from "vitest";
import {
  DEFAULT_LIVE_EVALUATION_SETTINGS,
  canTransitionLiveRun,
  evaluateCredentialEligibility,
  evaluateLivePreflight,
  validateLiveEvaluationSettings,
  type LiveCredentialSnapshot,
  type LiveEvaluationSettings
} from "../../src/evaluation/live-control";

const settings: LiveEvaluationSettings = {
  ...DEFAULT_LIVE_EVALUATION_SETTINGS,
  enabled: true,
  evaluationPoolId: "eval-pool",
  allowedDatasetIds: ["phase-4a-core"],
  allowedLogicalModelIds: ["primary", "verify", "adjudicate"],
  allowedProviderIds: ["openai"],
  maxCasesPerRun: 5,
  maxTokensPerRun: 1_000,
  maxTokensPerDay: 2_000,
  maxConcurrentRuns: 1,
  updatedAt: "2026-07-27T00:00:00.000Z"
};

const credential: LiveCredentialSnapshot = {
  providerId: "openai", billingMode: "pay_as_you_go", usageScope: "production", providerHealth: "healthy",
  status: "active", deleted: false, allowEvaluation: true, evaluationAuthorized: true, regionValid: true, endpointValid: true
};

function preflight(overrides: Partial<Parameters<typeof evaluateLivePreflight>[0]> = {}) {
  return evaluateLivePreflight({ settings, datasetId: "phase-4a-core", datasetVersion: 1, enabledCaseCount: 5, requestedCaseCount: 2, logicalModelIds: ["primary"], modelMaxOutputTokens: [100], providerIds: ["openai"], evaluationPoolRemainingTokens: 1_000, dailyRemainingTokens: 1_000, concurrentRuns: 0, contextWindowAvailable: true, credentialEligible: true, ...overrides });
}

describe("controlled live evaluation policy", () => {
  it("defaults disabled", () => expect(DEFAULT_LIVE_EVALUATION_SETTINGS.enabled).toBe(false));
  it("defaults to one concurrent run", () => expect(DEFAULT_LIVE_EVALUATION_SETTINGS.maxConcurrentRuns).toBe(1));
  it("defaults to required dry run", () => expect(DEFAULT_LIVE_EVALUATION_SETTINGS.requireDryRun).toBe(true));
  it("defaults to explicit confirmation", () => expect(DEFAULT_LIVE_EVALUATION_SETTINGS.requireExplicitConfirmation).toBe(true));
  it("accepts positive bounded settings", () => expect(validateLiveEvaluationSettings(settings)).toEqual([]));
  it("rejects zero max cases", () => expect(validateLiveEvaluationSettings({ ...settings, maxCasesPerRun: 0 })).toContain("max_cases_invalid"));
  it("rejects negative per-run budget", () => expect(validateLiveEvaluationSettings({ ...settings, maxTokensPerRun: -1 })).toContain("per_run_budget_invalid"));
  it("rejects zero daily budget", () => expect(validateLiveEvaluationSettings({ ...settings, maxTokensPerDay: 0 })).toContain("daily_budget_invalid"));
  it("rejects zero concurrency", () => expect(validateLiveEvaluationSettings({ ...settings, maxConcurrentRuns: 0 })).toContain("concurrency_invalid"));
  it("rejects unsafe dataset ids", () => expect(validateLiveEvaluationSettings({ ...settings, allowedDatasetIds: ["../secret"] })).toContain("dataset_allowlist_invalid"));
  it("rejects unsafe model ids", () => expect(validateLiveEvaluationSettings({ ...settings, allowedLogicalModelIds: ["model with spaces"] })).toContain("model_allowlist_invalid"));
  it("rejects unsafe provider ids", () => expect(validateLiveEvaluationSettings({ ...settings, allowedProviderIds: ["Provider/evil"] })).toContain("provider_allowlist_invalid"));
  it("allows an explicitly authorized pay-as-you-go credential", () => expect(evaluateCredentialEligibility(credential)).toEqual({ allowed: true }));
  it("rejects Personal Token Plan regardless of authorization", () => expect(evaluateCredentialEligibility({ ...credential, billingMode: "token_plan_personal" })).toEqual({ allowed: false, reason: "personal_plan_forbidden" }));
  it("rejects development interactive scope", () => expect(evaluateCredentialEligibility({ ...credential, usageScope: "development_interactive" })).toEqual({ allowed: false, reason: "development_scope_forbidden" }));
  it("rejects unknown scope", () => expect(evaluateCredentialEligibility({ ...credential, usageScope: "unknown" })).toEqual({ allowed: false, reason: "development_scope_forbidden" }));
  it("rejects unknown billing mode", () => expect(evaluateCredentialEligibility({ ...credential, billingMode: "unknown" })).toEqual({ allowed: false, reason: "unknown_billing_mode" }));
  it("requires explicit evaluation authorization", () => expect(evaluateCredentialEligibility({ ...credential, allowEvaluation: false })).toEqual({ allowed: false, reason: "evaluation_not_authorized" }));
  it("requires the authorization timestamp", () => expect(evaluateCredentialEligibility({ ...credential, evaluationAuthorized: false })).toEqual({ allowed: false, reason: "evaluation_not_authorized" }));
  it("rejects an unauthorized Team Plan", () => expect(evaluateCredentialEligibility({ ...credential, billingMode: "token_plan_team", evaluationAuthorized: false })).toEqual({ allowed: false, reason: "team_plan_not_authorized" }));
  it("rejects disabled credentials", () => expect(evaluateCredentialEligibility({ ...credential, status: "disabled" })).toEqual({ allowed: false, reason: "credential_disabled" }));
  it("rejects deleted credentials", () => expect(evaluateCredentialEligibility({ ...credential, deleted: true })).toEqual({ allowed: false, reason: "credential_deleted" }));
  it("rejects wrong region", () => expect(evaluateCredentialEligibility({ ...credential, regionValid: false })).toEqual({ allowed: false, reason: "region_mismatch" }));
  it("rejects wrong endpoint", () => expect(evaluateCredentialEligibility({ ...credential, endpointValid: false })).toEqual({ allowed: false, reason: "endpoint_mismatch" }));
  it("rejects authentication health", () => expect(evaluateCredentialEligibility({ ...credential, providerHealth: "authentication_error" })).toEqual({ allowed: false, reason: "provider_unhealthy" }));
  it("rejects quota exhausted health", () => expect(evaluateCredentialEligibility({ ...credential, providerHealth: "quota_exhausted" })).toEqual({ allowed: false, reason: "provider_unhealthy" }));
  it("permits degraded health for an explicitly bounded run", () => expect(evaluateCredentialEligibility({ ...credential, providerHealth: "degraded" })).toEqual({ allowed: true }));
  it("passes a complete preflight", () => expect(preflight().allowed).toBe(true));
  it("reports disabled live evaluation", () => expect(preflight({ settings: { ...settings, enabled: false } }).blockers).toContain("live_evaluation_disabled"));
  it("reports dataset allowlist failure", () => expect(preflight({ datasetId: "other-dataset" }).blockers).toContain("dataset_not_allowed"));
  it("reports model allowlist failure", () => expect(preflight({ logicalModelIds: ["not-allowed"] }).blockers).toContain("logical_model_not_allowed"));
  it("reports provider allowlist failure", () => expect(preflight({ providerIds: ["qwen"] }).blockers).toContain("provider_not_allowed"));
  it("reports credential failure", () => expect(preflight({ credentialEligible: false }).blockers).toContain("credential_not_eligible"));
  it("reports context failure", () => expect(preflight({ contextWindowAvailable: false }).blockers).toContain("context_window_unavailable"));
  it("reports concurrent run failure", () => expect(preflight({ concurrentRuns: 1 }).blockers).toContain("concurrent_run_limit"));
  it("reports per-run budget failure", () => expect(preflight({ modelMaxOutputTokens: [1_000] }).blockers).toContain("per_run_budget_exceeded"));
  it("reports daily budget failure", () => expect(preflight({ dailyRemainingTokens: 1 }).blockers).toContain("daily_budget_exceeded"));
  it("reports evaluation pool failure", () => expect(preflight({ evaluationPoolRemainingTokens: 1 }).blockers).toContain("evaluation_pool_exhausted"));
  it("returns minimum model call estimate", () => expect(preflight().estimatedMinimumModelCalls).toBe(2));
  it("returns worst-case three-stage call estimate", () => expect(preflight().estimatedMaximumModelCalls).toBe(6));
  it("returns a deterministic token estimate", () => expect(preflight().estimatedMaximumTokens).toBe(200));
  it("does not call a provider during pure preflight", () => expect(preflight().warnings).toHaveLength(1));
  it("allows pending confirmation to start", () => expect(canTransitionLiveRun("pending_confirmation", "running")).toEqual({ allowed: true }));
  it("allows pending confirmation cancellation", () => expect(canTransitionLiveRun("pending_confirmation", "cancelled")).toEqual({ allowed: true }));
  it("allows running completion", () => expect(canTransitionLiveRun("running", "completed")).toEqual({ allowed: true }));
  it("allows running failure", () => expect(canTransitionLiveRun("running", "failed")).toEqual({ allowed: true }));
  it("allows running cancellation", () => expect(canTransitionLiveRun("running", "cancelled")).toEqual({ allowed: true }));
  it("allows running budget exhaustion", () => expect(canTransitionLiveRun("running", "budget_exhausted")).toEqual({ allowed: true }));
  it("prevents completed restart", () => expect(canTransitionLiveRun("completed", "running")).toEqual({ allowed: false, reason: "invalid_transition" }));
  it("prevents cancelled continuation", () => expect(canTransitionLiveRun("cancelled", "completed")).toEqual({ allowed: false, reason: "invalid_transition" }));
  it("prevents budget-exhausted provider continuation", () => expect(canTransitionLiveRun("budget_exhausted", "running")).toEqual({ allowed: false, reason: "invalid_transition" }));
});
