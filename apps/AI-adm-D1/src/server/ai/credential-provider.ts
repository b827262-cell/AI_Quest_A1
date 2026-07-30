import type { Repositories } from "@ai-smartbook/db";
import {
  AiGatewayError,
  GeminiGatewayProvider,
  KimiGatewayProvider,
  OpenAiGatewayProvider,
  ZaiGatewayProvider,
  QwenGatewayProvider,
  type AiGenerateRequest,
  type AiGenerateResult,
  type AiFallbackReason,
  type AiProviderId,
  type GatewayAiProvider,
  classifyCredentialVerification,
  credentialMayServeScope,
  estimateCostMicroUsd,
  healthForCredentialVerification,
  validateQwenEndpoint,
  type StoredCredentialUsageScope
} from "@ai-smartbook/ai";
import { decryptCredential } from "./credential-crypto";

type ManagedProviderId = Exclude<AiProviderId, "mock">;

export function defaultModelForManagedProvider(providerId: ManagedProviderId): string {
  switch (providerId) {
    case "gemini": return "gemini-1.5-flash";
    case "kimi": return "moonshot-v1-8k";
    case "qwen": return "qwen-turbo";
    case "zai": return "glm-5.1";
    case "openai": return "gpt-4o-mini";
  }
}

/**
 * DB-backed adapter which selects a credential just-in-time. This makes
 * enable/disable/key replacement effective on the next request without
 * restarting the server, while keeping encryption and plaintext inside server
 * memory only for the duration of an upstream call.
 */
export class CredentialBackedProvider implements GatewayAiProvider {
  private cursor = 0;
  readonly defaultModel: string;
  readonly resolveModelAtCallTime = true;
  constructor(
    readonly providerId: ManagedProviderId,
    private readonly repos: Repositories,
    defaultModel: string,
    private readonly onlyCredentialId?: string,
    private readonly requestedScope: StoredCredentialUsageScope = "production",
    private readonly onUpstreamRequest?: () => void
  ) {
    this.defaultModel = defaultModel;
  }

  async isAvailable(): Promise<boolean> {
    return (await this.diagnoseAvailability()).available;
  }

  async diagnoseAvailability(requestedModel?: string): Promise<{
    available: boolean;
    model?: string;
    reason?: AiFallbackReason;
  }> {
    const config = this.configForModel(requestedModel);
    if (!config?.enabled) return { available: false, reason: "provider_disabled" };
    const allCredentials = this.repos.aiProviders.listCredentials(config.id)
      .filter((credential) => credential.status === "active" || credential.status === "standby");
    if (!allCredentials.length) return { available: false, reason: "no_active_credential" };
    const candidates = this.credentials(config.id);
    if (!candidates.length) return { available: false, reason: "credential_cooldown" };
    const reasons = new Set<AiFallbackReason>();
    for (const credential of candidates) {
      const quota = this.repos.aiCredentialModelQuotas.diagnose(credential.id, requestedModel);
      if (quota.available) {
        return {
          available: true,
          model: quota.model ?? credential.model ?? config.model ?? this.defaultModel
        };
      }
      if (quota.reason) reasons.add(quota.reason);
    }
    const reason = requestedModel?.trim()
      ? reasons.has("model_not_enabled") ? "model_not_enabled" : "quota_exhausted"
      : reasons.has("no_default_model") ? "no_default_model" : "quota_exhausted";
    return { available: false, reason };
  }

  async generate(request: AiGenerateRequest): Promise<AiGenerateResult> {
    const config = this.configForModel(request.model);
    if (!config?.enabled) throw unavailable(this.providerId, "provider_disabled");
    const candidates = this.credentials(config.id, this.cursor++);
    if (!candidates.length) {
      const diagnosis = await this.diagnoseAvailability(request.model);
      throw unavailable(this.providerId, diagnosis.reason ?? "credential_cooldown");
    }
    const ordered = candidates;
    let last: unknown;
    let failureReason: AiFallbackReason = "quota_exhausted";
    let blockedQwenSettings: string | undefined;
    let attempt = 0;
    for (const credential of ordered) {
      attempt += 1;
      const credentialSettings = `${credential.billingMode}|${credential.region ?? ""}|${credential.endpointProfile ?? ""}`;
      if (this.providerId === "qwen" && blockedQwenSettings === credentialSettings) continue;
      const models = request.model
        ? [request.model]
        : this.repos.aiCredentialModelQuotas.modelsForCredential(credential.id).map((row) => row.model);
      const fallbackModels = models.length > 0 ? models : [credential.model ?? config.model ?? this.defaultModel];
      for (const model of fallbackModels) {
        if (this.providerId === "qwen") {
          const endpoint = validateQwenEndpoint({
            baseUrl: credential.baseUrl ?? config.baseUrl ?? "https://dashscope.aliyuncs.com/compatible-mode/v1",
            region: credential.region ?? undefined,
            endpointProfile: credential.endpointProfile ?? undefined
          });
          if (!endpoint.ok) {
            failureReason = "provider_request_failed";
            this.repos.aiProviders.markCredentialFailure(credential.id, 60 * 60_000, "access_denied", true);
            continue;
          }
        }
        // Reserve a conservative upper bound before touching the upstream. The
        // reservation is atomic in SQLite and is reconciled with actual provider
        // usage after success, preventing concurrent requests from exceeding TPM.
        const estimatedTokens = estimateQuotaTokens(request);
        const quota = this.repos.aiCredentialModelQuotas.reserve(credential.id, model, estimatedTokens);
        if (!quota.allowed) {
          failureReason = request.model ? "model_not_enabled" : "quota_exhausted";
          continue;
        }
        // OpenAI Credential daily ledger: reserve a per-key daily token/cost
        // budget BEFORE the upstream call. Only OpenAI credentials enter this
        // ledger (Gemini/ZAI/Kimi/Qwen never do). On exhaustion we compensate
        // the RPM/TPM reservation above and rotate to another key. The settle
        // is deferred to the gateway layer where actualCostMicroUsd is known.
        let dailyReservationKey: string | undefined;
        if (this.providerId === "openai") {
          const estCostMicroUsd = estimateCostMicroUsd(this.providerId, model, estimatedTokens, Math.max(0, Math.floor(estimatedTokens * 0.5)));
          const daily = this.repos.aiCredentialDailyUsage.reserve({
            requestId: request.requestId,
            attempt,
            credentialId: credential.id,
            providerConfigId: config.id,
            providerModel: model,
            estimatedTokens,
            estimatedCostMicroUsd: estCostMicroUsd
          });
          if (!daily.allowed) {
            if (quota.reservation) {
              try { this.repos.aiCredentialModelQuotas.release(quota.reservation, false); } catch { /* compensate */ }
            }
            failureReason = "quota_exhausted";
            continue;
          }
          dailyReservationKey = daily.reservationKey;
        }
        try {
	          const apiKey = decryptCredential(credential.encryptedApiKey);
	          const adapter = this.adapter(
            apiKey,
            credential.baseUrl ?? config.baseUrl ?? undefined,
            model,
            credential.endpointProfile ?? undefined
          );
          this.onUpstreamRequest?.();
          const result = await adapter.generate({ ...request, model });
	          if (quota.reservation) {
	            await this.repos.aiCredentialModelQuotas.settle(
	              quota.reservation,
	              result.totalTokens ?? estimatedTokens,
	              result.usageSource ?? "system_estimated"
	            );
	          }
	          this.repos.aiProviders.markCredentialSuccess(credential.id);
	          // Load the DB pricing config from the quota row so the gateway
	          // computes costs using the authoritative DB prices rather than the
	          // seed fallback (spec §5.1). The loaded pricing fields are also
	          // captured in the immutable snapshot stored on the usage log.
	          const quotaRow = this.repos.aiCredentialModelQuotas.findForCredential(credential.id, model);
	          const pricingConfig = quotaRow ? {
	            currency: quotaRow.currency,
	            serviceTier: quotaRow.serviceTier,
	            inputPriceUsdPerMillion: quotaRow.inputPriceUsdPerMillion,
	            outputPriceUsdPerMillion: quotaRow.outputPriceUsdPerMillion,
	            cachedInputPriceUsdPerMillion: quotaRow.cachedInputPriceUsdPerMillion,
	            cacheStorageUsdPerMillionTokenHour: quotaRow.cacheStorageUsdPerMillionTokenHour,
	            pricingEffectiveAt: quotaRow.pricingEffectiveAt,
	            pricingSource: quotaRow.pricingSource,
	            pricingUnavailable: quotaRow.pricingUnavailable,
	          } : undefined;
	          return { ...result, credentialId: credential.id, pricingConfig, credentialDailyReservationKey: dailyReservationKey };
        } catch (error) {
          last = error;
          if (quota.reservation) {
            try {
              this.repos.aiCredentialModelQuotas.release(
                quota.reservation,
                quotaFailureCountsAsRequest(error)
              );
            } catch {
              // A failed cleanup must not expose upstream details or stop fallback.
            }
          }
          if (dailyReservationKey) {
            try { this.repos.aiCredentialDailyUsage.release(dailyReservationKey); } catch { /* compensate daily ledger */ }
          }
          const status = error instanceof AiGatewayError ? error.upstreamStatus : undefined;
          const verificationReason = classifyCredentialVerification({
            status,
            apiKeyPresent: true,
            endpointMatches: status === 401 ? undefined : true,
            keyTypeMatches: undefined,
            quotaExhausted: status === 429 && error instanceof AiGatewayError && error.fallbackReason === "quota_exhausted"
          });
          const health = healthForCredentialVerification(verificationReason);
          if (this.providerId === "qwen" && (status === 401 || status === 403)) {
            // Do not rotate through another Qwen key carrying the same
            // endpoint/region/billing configuration after an auth/access
            // failure. Gateway-level routing can still choose another provider.
            blockedQwenSettings = credentialSettings;
          }
          // Auth failures never retry this key. Rate-limit/5xx/timeouts rotate to
          // another key and use a short cooldown; a single timeout never disables it.
          const cooldownMs = status === 401 || status === 403 ? 60 * 60_000 : status === 429 ? 60_000 : 15_000;
          this.repos.aiProviders.markCredentialFailure(
            credential.id,
            cooldownMs,
            health,
            health === "access_denied" || health === "quota_exhausted"
          );
          failureReason = "provider_request_failed";
        }
      }
    }
    if (last instanceof AiGatewayError) throw last;
    throw unavailable(this.providerId, failureReason);
  }

  private credentials(configId: string, cursor = this.cursor) {
    const active = this.repos.aiProviders.eligibleCredentials(configId, "active");
    const standby = this.repos.aiProviders.eligibleCredentials(configId, "standby");
    const all = [...priorityGroups(active, cursor), ...priorityGroups(standby, cursor)];
    const scoped = all.filter((credential) => credentialMayServeScope({
      billingMode: credential.billingMode as "pay_as_you_go" | "token_plan_personal" | "token_plan_team" | "unknown",
      region: credential.region ?? undefined,
      endpointProfile: credential.endpointProfile ?? undefined,
      usageScope: (credential.usageScope ?? "unknown") as StoredCredentialUsageScope,
      productionAuthorized: credential.productionAuthorized
    }, this.requestedScope));
    return this.onlyCredentialId
      ? scoped.filter((credential) => credential.id === this.onlyCredentialId)
      : scoped;
  }

  private configForModel(model?: string) {
    // When testing a specific credential, use its providerConfigId directly
    // instead of findConfigByProvider, which may select the wrong config when
    // multiple provider instances share the same adapter type.
    if (this.onlyCredentialId) {
      const cred = this.repos.aiProviders.findCredential(this.onlyCredentialId);
      if (!cred) return undefined;
      const cfg = this.repos.aiProviders.findConfig(cred.providerConfigId);
      return cfg?.provider === this.providerId ? cfg : undefined;
    }
    const mapping = model
      ? this.repos.aiLogicalModels.list().find((row) => row.enabled && row.providerId === this.providerId && row.providerModelName === model)
      : undefined;
    return mapping?.providerConfigId
      ? this.repos.aiProviders.findConfig(mapping.providerConfigId)
      : this.repos.aiProviders.findConfigByProvider(this.providerId);
  }

  private adapter(apiKey: string, baseUrl?: string, model?: string, endpointProfile?: string): GatewayAiProvider {
    const options = { apiKey, baseUrl, model: model ?? this.defaultModel };
    switch (this.providerId) {
      case "gemini":
        return new GeminiGatewayProvider({
          ...options,
          endpointProfile: endpointProfile === "gemini_openai_compatible" ? endpointProfile : "gemini_native"
        });
      case "kimi": return new KimiGatewayProvider(options);
      case "qwen": return new QwenGatewayProvider(options);
      case "openai": return new OpenAiGatewayProvider(options);
      case "zai": return new ZaiGatewayProvider(options);
    }
  }
}

function estimateQuotaTokens(request: AiGenerateRequest): number {
  const input = (request.systemPrompt?.length ?? 0) + request.prompt.length;
  // This is intentionally an upper bound for concurrency safety. If the
  // provider returns usage, settle() replaces it with the actual total.
  return Math.max(1, input + Math.max(0, request.maxOutputTokens ?? 0));
}

/** Current managed providers count rate-limit responses as requests. */
function quotaFailureCountsAsRequest(error: unknown): boolean {
  return error instanceof AiGatewayError && error.upstreamStatus === 429;
}

function priorityGroups<T extends { priority: number; weight: number }>(items: T[], cursor: number): T[] {
  const priorities = [...new Set(items.map((item) => item.priority))].sort((a, b) => a - b);
  return priorities.flatMap((priority, index) => weightedRoundRobin(
    items.filter((item) => item.priority === priority),
    cursor + index
  ));
}

function weightedRoundRobin<T extends { weight: number }>(items: T[], cursor: number): T[] {
  if (items.length === 0) return [];
  const pool = items.flatMap((item) => Array.from({ length: Math.max(1, Math.min(20, item.weight)) }, () => item));
  const first = pool[cursor % pool.length];
  return [first, ...items.filter((item) => item !== first)];
}

function unavailable(provider: ManagedProviderId, fallbackReason: AiFallbackReason): AiGatewayError {
  return new AiGatewayError("AI_PROVIDER_UNAVAILABLE", "AI 服務目前暫時無法使用，請稍後再試。", {
    failedProvider: provider,
    fallbackReason
  });
}
