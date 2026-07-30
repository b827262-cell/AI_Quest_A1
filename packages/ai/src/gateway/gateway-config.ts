import type { AiProviderId } from "./ai-types";
import type { GatewayAiProvider } from "./provider.interface";
import { MockGatewayProvider } from "./providers/mock-gateway.provider";
import { GeminiGatewayProvider } from "./providers/gemini.provider";
import { OpenAiGatewayProvider } from "./providers/openai.provider";
import { KimiGatewayProvider } from "./providers/kimi.provider";
import { QwenGatewayProvider } from "./providers/qwen.provider";
import { ZaiGatewayProvider } from "./providers/zai.provider";

/**
 * Gateway runtime config parsed from environment. Real providers remain
 * unavailable without keys; mock fallback is environment-dependent and is
 * disabled by default in production.
 */
export type GatewayEnvConfig = {
  enabled: boolean;
  defaultProvider: AiProviderId;
  routerProvider: AiProviderId;
  requestTimeoutMs: number;
  maxRetries: number;
  maxInputChars: number;
  maxOutputTokens: number;
  dailyCostLimitUsd: number;
  dailyTokenLimit: number;
  budgetWarningPercentage: number;
  allowMockFallback: boolean;
  mockModel: string;
  gemini: { apiKey?: string; model: string };
  openai: { apiKey?: string; model: string; baseUrl: string };
  kimi: { apiKey?: string; model: string; baseUrl: string };
  qwen: { apiKey?: string; model: string; baseUrl: string };
  zai: { apiKey?: string; model: string; baseUrl: string };
};

function num(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function nonNegativeNum(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function loadGatewayConfig(env: NodeJS.ProcessEnv = process.env): GatewayEnvConfig {
  const providerRaw = String(env.AI_DEFAULT_PROVIDER || "mock").toLowerCase();
  const defaultProvider: AiProviderId = isProviderId(providerRaw) ? providerRaw : "mock";
  const routerRaw = String(env.AI_ROUTER_PROVIDER || "mock").toLowerCase();
  const routerProvider: AiProviderId = isProviderRaw(routerRaw) ? routerRaw : "mock";

  return {
    enabled: env.AI_GATEWAY_ENABLED !== "false",
    defaultProvider,
    routerProvider,
    requestTimeoutMs: num(env, "AI_REQUEST_TIMEOUT_MS", 30000),
    maxRetries: nonNegativeNum(env, "AI_MAX_RETRIES", 1),
    maxInputChars: num(env, "AI_MAX_INPUT_CHARS", 10000),
    // A bounded 4k-token ceiling is enough for a normal long-form guest
    // explanation, while the prompt + one continuation still stay under the
    // existing budget reservation and retry controls.
    maxOutputTokens: num(env, "AI_MAX_OUTPUT_TOKENS", 4096),
    dailyCostLimitUsd: num(env, "AI_DAILY_COST_LIMIT_USD", 10),
    dailyTokenLimit: num(env, "AI_DAILY_TOKEN_LIMIT", 1_000_000),
    budgetWarningPercentage: num(env, "AI_BUDGET_WARNING_PERCENTAGE", 80),
    allowMockFallback:
      env.AI_ALLOW_MOCK_FALLBACK === undefined
        ? env.NODE_ENV !== "production"
        : env.AI_ALLOW_MOCK_FALLBACK === "true",
    mockModel: env.AI_MOCK_MODEL || "mock-v1",
    gemini: { apiKey: env.GEMINI_API_KEY || undefined, model: env.GEMINI_MODEL || "gemini-1.5-flash" },
    openai: {
      apiKey: env.OPENAI_API_KEY || undefined,
      model: env.OPENAI_MODEL || "gpt-4o-mini",
      baseUrl: env.OPENAI_BASE_URL || "https://api.openai.com/v1"
    },
    kimi: {
      apiKey: env.KIMI_API_KEY || undefined,
      model: env.KIMI_MODEL || "moonshot-v1-8k",
      baseUrl: env.KIMI_BASE_URL || "https://api.moonshot.cn/v1"
    },
    qwen: {
      apiKey: env.QWEN_API_KEY || undefined,
      model: env.QWEN_MODEL || "qwen-turbo",
      baseUrl: env.QWEN_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1"
    },
    zai: {
      apiKey: env.ZAI_API_KEY || undefined,
      model: env.ZAI_MODEL || "glm-5.1",
      baseUrl: env.ZAI_BASE_URL || "https://api.z.ai/api/paas/v4"
    }
  };
}

/**
 * Guest answer retention in days. Defaults to 7; clamped to [1, 90] so an
 * illegal or extreme configured value is never silently applied. A warning is
 * emitted when clamping occurs so misconfiguration is visible.
 */
export const GUEST_ASK_RETENTION_MIN_DAYS = 1;
export const GUEST_ASK_RETENTION_MAX_DAYS = 90;
export const GUEST_ASK_RETENTION_DEFAULT_DAYS = 7;

export function resolveGuestAskRetentionDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.GUEST_ASK_RETENTION_DAYS;
  if (raw === undefined || raw === "") return GUEST_ASK_RETENTION_DEFAULT_DAYS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    console.warn(
      `[guest-ask] GUEST_ASK_RETENTION_DAYS="${raw}" is invalid; using default ${GUEST_ASK_RETENTION_DEFAULT_DAYS} days.`
    );
    return GUEST_ASK_RETENTION_DEFAULT_DAYS;
  }
  const clamped = Math.min(
    GUEST_ASK_RETENTION_MAX_DAYS,
    Math.max(GUEST_ASK_RETENTION_MIN_DAYS, Math.floor(n))
  );
  if (clamped !== n) {
    console.warn(
      `[guest-ask] GUEST_ASK_RETENTION_DAYS=${n} is out of range [${GUEST_ASK_RETENTION_MIN_DAYS}, ${GUEST_ASK_RETENTION_MAX_DAYS}]; clamped to ${clamped} days.`
    );
  }
  return clamped;
}

function isProviderId(value: string): value is AiProviderId {
  return ["mock", "gemini", "openai", "kimi", "qwen", "zai"].includes(value);
}
// Router provider accepts the same set as provider ids; alias for clarity.
function isProviderRaw(value: string): value is AiProviderId {
  return isProviderId(value);
}

/**
 * Build the provider registry. Every provider is always instantiated (with
 * whatever config exists); availability is determined at call time via
 * `isAvailable()`, so unset keys yield unavailable providers rather than
 * construction errors (spec §13.2, §13.3, §13.15).
 */
export function buildProviderRegistry(config: GatewayEnvConfig): Map<AiProviderId, GatewayAiProvider> {
  const registry = new Map<AiProviderId, GatewayAiProvider>();
  registry.set("mock", new MockGatewayProvider(config.mockModel));
  registry.set(
    "gemini",
    new GeminiGatewayProvider({ apiKey: config.gemini.apiKey, model: config.gemini.model })
  );
  registry.set(
    "openai",
    new OpenAiGatewayProvider({
      apiKey: config.openai.apiKey,
      model: config.openai.model,
      baseUrl: config.openai.baseUrl
    })
  );
  registry.set(
    "kimi",
    new KimiGatewayProvider({
      apiKey: config.kimi.apiKey,
      model: config.kimi.model,
      baseUrl: config.kimi.baseUrl
    })
  );
  registry.set(
    "qwen",
    new QwenGatewayProvider({
      apiKey: config.qwen.apiKey,
      model: config.qwen.model,
      baseUrl: config.qwen.baseUrl
    })
  );
  registry.set(
    "zai",
    new ZaiGatewayProvider({
      apiKey: config.zai.apiKey,
      model: config.zai.model,
      baseUrl: config.zai.baseUrl
    })
  );
  return registry;
}
