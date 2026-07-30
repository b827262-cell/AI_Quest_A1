import { describe, expect, it } from "vitest";
import {
  applyPromotionMultiplier,
  capabilityEnabled,
  classifyCredentialVerification,
  credentialMayServeScope,
  formalContextWindow,
  healthForCredentialVerification,
  isPromotionActive,
  isRollingQuotaAvailable,
  normalizeQuotaObservation,
  observedTokenUsage,
  validateCredentialActivation,
  validateQwenEndpoint,
  type ProviderPromotion,
  type RollingQuotaWindow
} from "@ai-smartbook/ai";

describe("provider compliance domain", () => {
  it("blocks Personal Plan activation in production", () => {
    expect(validateCredentialActivation({
      provider: "qwen",
      billingMode: "token_plan_personal",
      usageScope: "production"
    })).toMatchObject({ allowed: false, reason: "token_plan_personal_production_forbidden" });
  });

  it("allows Personal Plan for development interactive use", () => {
    expect(validateCredentialActivation({
      provider: "qwen",
      billingMode: "token_plan_personal",
      usageScope: "development_interactive"
    })).toEqual({ allowed: true });
  });

  it("does not infer unknown billing mode as Personal Plan", () => {
    expect(validateCredentialActivation({
      provider: "qwen",
      billingMode: "unknown",
      usageScope: "production"
    })).toEqual({ allowed: true });
    expect(credentialMayServeScope({ billingMode: "unknown", usageScope: "unknown" }, "production")).toBe(true);
  });

  it("requires explicit administrator authorization for a Team Plan in production", () => {
    expect(validateCredentialActivation({
      provider: "qwen",
      billingMode: "token_plan_team",
      usageScope: "production",
      productionAuthorized: false
    })).toMatchObject({ allowed: false, reason: "token_plan_team_production_not_authorized" });
    expect(validateCredentialActivation({
      provider: "qwen",
      billingMode: "token_plan_team",
      usageScope: "production",
      productionAuthorized: true
    })).toEqual({ allowed: true });
  });

  it("keeps credits separate from Token Pool usage", () => {
    const observation = normalizeQuotaObservation({
      inputTokens: 12,
      outputTokens: 8,
      creditsConsumed: 3,
      observedAt: "2026-07-27T00:00:00.000Z",
      source: "provider_response"
    });
    expect(observedTokenUsage(observation)).toBe(20);
    expect(observedTokenUsage(observation)).not.toBe(observation.creditsConsumed);
    expect(observation.estimated).toBe(false);
  });

  it("keeps five-hour and seven-day windows independent", () => {
    const windows: RollingQuotaWindow[] = [
      { kind: "five_hour", capacityCredits: 10, consumedCredits: 9, windowStartedAt: "2026-07-27T00:00:00Z", resetsAt: "2026-07-27T05:00:00Z" },
      { kind: "seven_day", capacityCredits: 100, consumedCredits: 1, windowStartedAt: "2026-07-21T00:00:00Z", resetsAt: "2026-07-28T00:00:00Z" }
    ];
    expect(isRollingQuotaAvailable(windows)).toBe(true);
    expect(isRollingQuotaAvailable([{ ...windows[0], consumedCredits: 10 }, windows[1]])).toBe(false);
    expect(windows[0].resetsAt).not.toBe(windows[1].resetsAt);
  });

  it("rejects use when either rolling window is exhausted", () => {
    const base: RollingQuotaWindow = {
      kind: "five_hour", capacityCredits: 10, consumedCredits: 1,
      windowStartedAt: "2026-07-27T00:00:00Z", resetsAt: "2026-07-27T05:00:00Z"
    };
    expect(isRollingQuotaAvailable([base, { ...base, kind: "seven_day", consumedCredits: 10 }])).toBe(false);
  });

  it("classifies 401 wrong key type without exposing a response body", () => {
    const reason = classifyCredentialVerification({ status: 401, apiKeyPresent: true, keyTypeMatches: false });
    expect(reason).toBe("wrong_key_type");
    expect(JSON.stringify({ reason })).not.toContain("Authorization");
  });

  it("classifies 401 wrong base URL", () => {
    expect(classifyCredentialVerification({ status: 401, apiKeyPresent: true, endpointMatches: false }))
      .toBe("wrong_base_url");
  });

  it("turns 403 access denied into a non-retry health state", () => {
    expect(classifyCredentialVerification({ status: 403, apiKeyPresent: true })).toBe("access_denied");
    expect(healthForCredentialVerification("access_denied")).toBe("access_denied");
  });

  it("distinguishes 429 rate limiting from quota exhaustion", () => {
    expect(classifyCredentialVerification({ status: 429, apiKeyPresent: true })).toBe("rate_limited");
    expect(classifyCredentialVerification({ status: 429, apiKeyPresent: true, quotaExhausted: true })).toBe("quota_exhausted");
  });

  it("does not send a Qwen request for a region mismatch", () => {
    expect(validateQwenEndpoint({
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      region: "singapore",
      endpointProfile: "dashscope_beijing_compatible"
    })).toEqual({ ok: false, reason: "region_mismatch" });
  });

  it("does not enable a community context-window claim", () => {
    expect(formalContextWindow(1_000_000, "community_report")).toBeUndefined();
    expect(capabilityEnabled("community_report")).toBe(false);
  });

  it("does not enable community image or video capability claims", () => {
    expect(capabilityEnabled("community_report")).toBe(false);
    expect(capabilityEnabled("unknown")).toBe(false);
  });

  it("does not apply an unverified promotion", () => {
    const promotion: ProviderPromotion = {
      providerId: "qwen",
      startsAt: "2026-07-27T00:00:00Z",
      endsAt: "2026-07-28T00:00:00Z",
      timezone: "Asia/Taipei",
      creditMultiplier: 0.1,
      evidence: "community_report",
      enabled: true
    };
    expect(isPromotionActive(promotion, "2026-07-27T01:00:00Z")).toBe(false);
    expect(applyPromotionMultiplier(100, promotion, "2026-07-27T01:00:00Z")).toBe(100);
  });

  it("stops a verified promotion after its expiry", () => {
    const promotion: ProviderPromotion = {
      providerId: "qwen",
      startsAt: "2026-07-27T00:00:00Z",
      endsAt: "2026-07-27T01:00:00Z",
      timezone: "Asia/Taipei",
      creditMultiplier: 0.5,
      evidence: "admin_verified",
      enabled: true
    };
    expect(applyPromotionMultiplier(100, promotion, "2026-07-27T00:30:00Z")).toBe(50);
    expect(applyPromotionMultiplier(100, promotion, "2026-07-27T01:00:00Z")).toBe(100);
  });

  it("keeps diagnostics free of API keys and provider response bodies", () => {
    const result = classifyCredentialVerification({ status: 401, apiKeyPresent: true });
    expect(JSON.stringify({ result })).not.toContain("secret-key");
    expect(JSON.stringify({ result })).not.toContain("provider response");
  });

  it("does not select a Personal credential for production traffic", () => {
    expect(credentialMayServeScope({ billingMode: "token_plan_personal", usageScope: "development_interactive" }, "production"))
      .toBe(false);
    expect(credentialMayServeScope({ billingMode: "token_plan_personal", usageScope: "development_interactive" }, "development_interactive"))
      .toBe(true);
  });

  it("maps an unavailable Qwen health state to safe fallback handling", () => {
    expect(healthForCredentialVerification("provider_unavailable")).toBe("unavailable");
    expect(healthForCredentialVerification("rate_limited")).toBe("rate_limited");
  });

  it("does not change daily reset semantics when rolling windows are modeled", () => {
    const window: RollingQuotaWindow = {
      kind: "five_hour", capacityCredits: 10, consumedCredits: 0,
      windowStartedAt: "2026-07-27T02:00:00Z", resetsAt: "2026-07-27T07:00:00Z"
    };
    expect(window.kind).toBe("five_hour");
    expect(window.resetsAt).not.toBe("2026-07-28T00:00:00Z");
  });

  it("marks estimated observations explicitly", () => {
    const observation = normalizeQuotaObservation({
      inputTokens: 4,
      observedAt: "2026-07-27T00:00:00Z",
      source: "estimated"
    });
    expect(observation.estimated).toBe(true);
    expect(observation.creditsConsumed).toBeUndefined();
  });

  it("rejects negative quota observations rather than fabricating usage", () => {
    expect(() => normalizeQuotaObservation({
      creditsConsumed: -1,
      observedAt: "2026-07-27T00:00:00Z",
      source: "admin_entry"
    })).toThrow();
  });
});
