import type { Repositories } from "@ai-smartbook/db";
import {
  GeminiGatewayProvider,
  KimiGatewayProvider,
  OpenAiGatewayProvider,
  QwenGatewayProvider,
  ZaiGatewayProvider,
  evaluateCredentialEligibility,
  validateQwenEndpoint,
  type AiGenerateRequest,
  type AiGenerateResult,
  type AiProviderId,
  type GatewayAiProvider
} from "@ai-smartbook/ai";
import { decryptCredential } from "./credential-crypto";

type ManagedProviderId = Exclude<AiProviderId, "mock">;

/**
 * Direct provider adapter for evaluation traffic. It deliberately does not
 * use CredentialBackedProvider: that production adapter updates formal quota,
 * cooldown and Provider Health state, all of which are out of scope for Live
 * Evaluation. Credential selection remains server-side and allowlisted.
 */
export function createEvaluationProvider(
  repos: Repositories,
  providerId: ManagedProviderId,
  logicalModelId: string
): GatewayAiProvider {
  const mapping = repos.aiLogicalModels.findEnabled(logicalModelId);
  if (!mapping || mapping.providerId !== providerId) throw new Error("evaluation_model_mapping_unavailable");
  const config = mapping.providerConfigId
    ? repos.aiProviders.findConfig(mapping.providerConfigId)
    : repos.aiProviders.findConfigByProvider(providerId);
  if (!config?.enabled) throw new Error("evaluation_provider_disabled");
  const candidates = repos.aiProviders.listCredentials(config.id).filter((credential) => {
    const endpoint = providerId === "qwen"
      ? validateQwenEndpoint({
        baseUrl: credential.baseUrl ?? config.baseUrl,
        region: credential.region ?? undefined,
        endpointProfile: credential.endpointProfile ?? undefined
      })
      : { ok: true as const };
    const eligibility = evaluateCredentialEligibility({
      providerId,
      billingMode: credential.billingMode as "pay_as_you_go" | "token_plan_personal" | "token_plan_team" | "unknown",
      usageScope: (credential.usageScope ?? "unknown") as "development_interactive" | "staging" | "production" | "unknown",
      providerHealth: credential.providerHealth as "healthy" | "authentication_error" | "access_denied" | "quota_exhausted" | "rate_limited" | "degraded" | "unavailable" | "unknown",
      status: credential.status as "active" | "standby" | "disabled",
      deleted: Boolean(credential.deletedAt),
      allowEvaluation: credential.allowEvaluation,
      evaluationAuthorized: Boolean(credential.evaluationAuthorizedAt),
      regionValid: endpoint.ok,
      endpointValid: endpoint.ok
    });
    if (!eligibility.allowed) return false;
    return repos.aiCredentialModelQuotas.modelsForCredential(credential.id).some((row) => row.enabled && row.model === mapping.providerModelName);
  });
  const credential = candidates.sort((a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt))[0];
  if (!credential) throw new Error("evaluation_credential_unavailable");
  const apiKey = decryptCredential(credential.encryptedApiKey);
  const model = mapping.providerModelName;
  const adapter = providerId === "gemini"
    ? new GeminiGatewayProvider({
        apiKey,
        baseUrl: credential.baseUrl ?? config.baseUrl ?? undefined,
        model,
        endpointProfile: credential.endpointProfile === "gemini_openai_compatible" ? credential.endpointProfile : "gemini_native"
      })
    : providerId === "kimi"
      ? new KimiGatewayProvider({ apiKey, baseUrl: credential.baseUrl ?? config.baseUrl ?? undefined, model })
      : providerId === "qwen"
        ? new QwenGatewayProvider({ apiKey, baseUrl: credential.baseUrl ?? config.baseUrl ?? undefined, model })
        : providerId === "zai"
          ? new ZaiGatewayProvider({ apiKey, baseUrl: credential.baseUrl ?? config.baseUrl ?? undefined, model })
          : new OpenAiGatewayProvider({ apiKey, baseUrl: credential.baseUrl ?? config.baseUrl ?? undefined, model });
  return {
    providerId,
    defaultModel: model,
    async isAvailable() { return true; },
    async generate(request: AiGenerateRequest): Promise<AiGenerateResult> {
      return adapter.generate({ ...request, model: request.model ?? model });
    }
  };
}
