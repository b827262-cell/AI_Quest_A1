/**
 * Provider compliance and quota-observation primitives.
 *
 * This module deliberately does not turn provider credits into tokens. It is
 * also intentionally independent from the daily Token Pool so a future
 * rolling provider quota cannot change today's accounting semantics.
 */

export type CredentialUsageScope =
  | "development_interactive"
  | "staging"
  | "production";

/** Storage-only value for legacy rows whose purpose was never recorded. */
export type StoredCredentialUsageScope = CredentialUsageScope | "unknown";

export type ProviderBillingMode =
  | "pay_as_you_go"
  | "token_plan_personal"
  | "token_plan_team"
  | "unknown";

export type ProviderHealth =
  | "healthy"
  | "authentication_error"
  | "access_denied"
  | "quota_exhausted"
  | "rate_limited"
  | "degraded"
  | "unavailable"
  | "unknown";

export type CredentialVerificationReason =
  | "valid"
  | "missing_api_key"
  | "invalid_api_key"
  | "wrong_key_type"
  | "wrong_base_url"
  | "subscription_inactive"
  | "region_mismatch"
  | "access_denied"
  | "rate_limited"
  | "quota_exhausted"
  | "provider_unavailable"
  | "unknown";

export type CapabilityEvidence =
  | "official_documentation"
  | "provider_runtime"
  | "admin_verified"
  | "community_report"
  | "unknown";

export interface QwenCredentialMetadata {
  billingMode: ProviderBillingMode;
  region?: string;
  endpointProfile?: string;
  usageScope: StoredCredentialUsageScope;
  /** Explicit administrator confirmation of applicable Team Plan terms. */
  productionAuthorized?: boolean;
}

export interface ProviderQuotaObservation {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  creditsConsumed?: number;
  creditsRemaining?: number;
  fiveHourCreditsRemaining?: number;
  sevenDayCreditsRemaining?: number;
  observedAt: string;
  source: "provider_response" | "admin_entry" | "estimated";
  /** Required for estimated observations; never inferred for provider data. */
  estimated?: boolean;
}

export interface RollingQuotaWindow {
  kind: "five_hour" | "seven_day";
  capacityCredits: number;
  consumedCredits: number;
  windowStartedAt: string;
  resetsAt: string;
}

export interface ProviderPromotion {
  providerId: string;
  logicalModelId?: string;
  startsAt: string;
  endsAt: string;
  timezone: string;
  creditMultiplier?: number;
  evidence: CapabilityEvidence;
  enabled: boolean;
}

export type QwenEndpointProfile = {
  id: "dashscope_beijing_compatible";
  region: "beijing";
  baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1";
};

/** Only an explicitly reviewed endpoint is accepted by the current adapter. */
export const QWEN_ENDPOINT_PROFILES: readonly QwenEndpointProfile[] = [
  {
    id: "dashscope_beijing_compatible",
    region: "beijing",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1"
  }
];

export type CredentialActivationResult =
  | { allowed: true }
  | {
      allowed: false;
      reason: "token_plan_personal_production_forbidden" | "token_plan_team_production_not_authorized";
      message: "Personal Token Plan 不得啟用於 production Credential" | "Team Token Plan 尚未取得 production 授權";
    };

export function validateCredentialActivation(input: {
  provider: string;
  billingMode: ProviderBillingMode;
  usageScope: StoredCredentialUsageScope;
  productionAuthorized?: boolean;
}): CredentialActivationResult {
  if (input.billingMode === "token_plan_personal" && input.usageScope === "production") {
    return {
      allowed: false,
      reason: "token_plan_personal_production_forbidden",
      message: "Personal Token Plan 不得啟用於 production Credential"
    };
  }
  if (input.billingMode === "token_plan_team" && input.usageScope === "production" && input.productionAuthorized !== true) {
    return {
      allowed: false,
      reason: "token_plan_team_production_not_authorized",
      message: "Team Token Plan 尚未取得 production 授權"
    };
  }
  return { allowed: true };
}

export function credentialMayServeScope(
  metadata: QwenCredentialMetadata,
  requestedScope: StoredCredentialUsageScope
): boolean {
  if (
    metadata.billingMode === "token_plan_personal"
    && requestedScope === "production"
  ) return false;
  if (
    metadata.billingMode === "token_plan_team"
    && requestedScope === "production"
    && metadata.productionAuthorized !== true
  ) return false;
  return true;
}

export function validateQwenEndpoint(input: {
  baseUrl?: string | null;
  region?: string;
  endpointProfile?: string;
}): { ok: true } | { ok: false; reason: "wrong_base_url" | "region_mismatch" } {
  const normalizedUrl = input.baseUrl?.trim().replace(/\/$/, "");
  const profile = QWEN_ENDPOINT_PROFILES.find((candidate) =>
    candidate.id === input.endpointProfile || candidate.baseUrl === normalizedUrl
  );
  if (!profile) return { ok: false, reason: "wrong_base_url" };
  if (input.endpointProfile && input.endpointProfile !== profile.id) {
    return { ok: false, reason: "wrong_base_url" };
  }
  if (input.region && input.region !== profile.region) {
    return { ok: false, reason: "region_mismatch" };
  }
  return { ok: true };
}

export function classifyCredentialVerification(input: {
  status?: number;
  apiKeyPresent: boolean;
  endpointMatches?: boolean;
  keyTypeMatches?: boolean;
  subscriptionActive?: boolean;
  regionMatches?: boolean;
  quotaExhausted?: boolean;
}): CredentialVerificationReason {
  if (!input.apiKeyPresent) return "missing_api_key";
  if (input.regionMatches === false) return "region_mismatch";
  if (input.endpointMatches === false) return "wrong_base_url";
  if (input.keyTypeMatches === false) return "wrong_key_type";
  if (input.subscriptionActive === false) return "subscription_inactive";
  switch (input.status) {
    case undefined:
    case 200:
    case 204:
      return "valid";
    case 401:
      return "invalid_api_key";
    case 403:
      return "access_denied";
    case 429:
      return input.quotaExhausted ? "quota_exhausted" : "rate_limited";
    default:
      return input.status >= 500 ? "provider_unavailable" : "unknown";
  }
}

export function healthForCredentialVerification(
  reason: CredentialVerificationReason
): ProviderHealth {
  switch (reason) {
    case "valid": return "healthy";
    case "invalid_api_key":
    case "missing_api_key":
    case "wrong_key_type": return "authentication_error";
    case "access_denied":
    case "subscription_inactive":
    case "region_mismatch":
    case "wrong_base_url": return "access_denied";
    case "quota_exhausted": return "quota_exhausted";
    case "rate_limited": return "rate_limited";
    case "provider_unavailable": return "unavailable";
    default: return "unknown";
  }
}

export function isRollingQuotaAvailable(windows: readonly RollingQuotaWindow[]): boolean {
  return windows.length > 0 && windows.every((window) =>
    window.capacityCredits >= 0
    && window.consumedCredits >= 0
    && window.consumedCredits < window.capacityCredits
  );
}

/** Token accounting is independent: credits are never accepted as tokens. */
export function observedTokenUsage(observation: ProviderQuotaObservation): number {
  if (observation.totalTokens !== undefined) return observation.totalTokens;
  return (observation.inputTokens ?? 0) + (observation.outputTokens ?? 0);
}

export function normalizeQuotaObservation(
  observation: ProviderQuotaObservation
): ProviderQuotaObservation {
  const numericFields = [
    observation.inputTokens,
    observation.outputTokens,
    observation.totalTokens,
    observation.creditsConsumed,
    observation.creditsRemaining,
    observation.fiveHourCreditsRemaining,
    observation.sevenDayCreditsRemaining
  ];
  if (numericFields.some((value) => value !== undefined && (!Number.isSafeInteger(value) || value < 0))) {
    throw new Error("quota observation values must be non-negative safe integers");
  }
  if (!observation.observedAt.trim()) throw new Error("quota observation requires observedAt");
  return { ...observation, estimated: observation.source === "estimated" };
}

export function isFormalCapabilityEvidence(evidence: CapabilityEvidence): boolean {
  return evidence === "official_documentation"
    || evidence === "provider_runtime"
    || evidence === "admin_verified";
}

export function capabilityEnabled(evidence: CapabilityEvidence): boolean {
  return isFormalCapabilityEvidence(evidence);
}

export function formalContextWindow(
  contextWindowTokens: number,
  evidence: CapabilityEvidence = "unknown"
): number | undefined {
  return evidence === "community_report" ? undefined : contextWindowTokens;
}

export function isPromotionActive(promotion: ProviderPromotion, at: string): boolean {
  if (!promotion.enabled || !isFormalCapabilityEvidence(promotion.evidence)) return false;
  const atMs = Date.parse(at);
  const startMs = Date.parse(promotion.startsAt);
  const endMs = Date.parse(promotion.endsAt);
  return Number.isFinite(atMs) && Number.isFinite(startMs) && Number.isFinite(endMs)
    && startMs <= atMs && atMs < endMs;
}

export function applyPromotionMultiplier(
  credits: number,
  promotion: ProviderPromotion | undefined,
  at: string
): number {
  if (!promotion || !isPromotionActive(promotion, at)) return credits;
  if (promotion.creditMultiplier === undefined || !Number.isFinite(promotion.creditMultiplier) || promotion.creditMultiplier < 0) {
    return credits;
  }
  return credits * promotion.creditMultiplier;
}
