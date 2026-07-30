import {
  AiGateway,
  buildProviderRegistry,
  loadGatewayConfig,
  DEFAULT_ROUTER_CONFIG,
  TokenPoolBudgetManager,
  type GatewayEnvConfig,
  type AiProviderId
} from "@ai-smartbook/ai";
import type { Repositories } from "@ai-smartbook/db";
import { DbBudgetManager } from "./db-budget-manager";
import { DbPromptLogger } from "./db-prompt-logger";
import { assertCredentialEncryptionConfigured } from "./credential-crypto";
import { CredentialBackedProvider } from "./credential-provider";
import { createTokenPoolPort } from "./token-pool-adapter";

/**
 * Build the process-wide AiGateway singleton. The gateway is constructed once
 * at server boot from env config + DB-backed budget/logger adapters.
 *
 * Providers are registered without constructor-time key validation. In
 * production, mock fallback is opt-in and an empty provider registry is
 * allowed to return a safe 503 rather than a synthetic answer.
 */
export function buildGateway(repos: Repositories): {
  gateway: AiGateway;
  config: GatewayEnvConfig;
} {
  const config = loadGatewayConfig();
  assertCredentialEncryptionConfigured();

  // Ensure a default global budget policy exists so admin UI has a row to edit.
  repos.aiBudgetPolicies.ensureDefaultGlobals({
    dailyTokenLimit: config.dailyTokenLimit,
    dailyCostLimitUsd: config.dailyCostLimitUsd,
    warningPercentage: config.budgetWarningPercentage
  });

  const providers = config.enabled ? buildProviderRegistry(config) : new Map();
  // Managed providers always resolve credentials from the vault at request
  // time. This is intentional: adding/enabling/disabling a provider or key is
  // effective on the next request, without a process restart. A missing DB
  // config or eligible credential simply reports unavailable.
  if (config.enabled) {
    for (const providerId of ["openai", "gemini", "kimi", "qwen", "zai"] as const) {
      const providerConfig = repos.aiProviders.findConfigByProvider(providerId);
      providers.set(providerId, new CredentialBackedProvider(
        providerId, repos, providerConfig?.model || providers.get(providerId)?.defaultModel || "default"
      ));
    }
  }
  const persistedConfigs = repos.aiProviders.listConfigs();
  const asProviderId = (value: string | undefined): AiProviderId | undefined =>
    value && ["openai", "gemini", "kimi", "qwen", "zai", "mock"].includes(value) ? value as AiProviderId : undefined;
  const defaultProvider = asProviderId(persistedConfigs.find((row) => row.isDefault && row.enabled)?.provider);
  const routerProvider = asProviderId(persistedConfigs.find((row) => row.isRouterProvider && row.enabled)?.provider);
  const routerConfig = {
    ...DEFAULT_ROUTER_CONFIG,
    defaultPreferred: (defaultProvider ?? config.defaultProvider),
    defaultFallbacks: [routerProvider ?? config.routerProvider, "gemini", "kimi", "qwen", "zai", "openai", "mock"] as AiProviderId[],
    backstopProvider: routerProvider ?? config.routerProvider
  };

  const gateway = new AiGateway({
    providers,
    routerConfig,
    requestTimeoutMs: config.requestTimeoutMs,
    maxRetries: config.maxRetries,
    maxOutputTokens: config.maxOutputTokens,
    maxInputChars: config.maxInputChars,
    // Token Pool decorator wraps the inner global/source budget manager. The
    // pool check is an ADDITIONAL gate (dimension 1) layered on top of the
    // existing global daily budget; providers without a logical-model mapping
    // pass through unchanged. The gateway code itself is not modified.
    budgetManager: new TokenPoolBudgetManager(
      new DbBudgetManager(repos, {
        dailyTokenLimit: config.dailyTokenLimit,
        dailyCostLimitUsd: config.dailyCostLimitUsd,
        warningPercentage: config.budgetWarningPercentage
      }),
      createTokenPoolPort(repos)
    ),
    logger: new DbPromptLogger(repos),
    allowMockFallback: config.allowMockFallback
  });

  return { gateway, config };
}
