export type ProviderId = "openai" | "gemini" | "kimi" | "qwen" | "zai";
export type CredentialStatus = "active" | "standby" | "disabled";
export type CredentialActionKind = "enable" | "disable" | "delete";

export type Provider = {
  id: string;
  provider: ProviderId;
  slug: string;
  displayName: string;
  baseUrl: string | null;
  model: string | null;
  enabled: boolean;
  isDefault: boolean;
  isRouterProvider: boolean;
  priority: number;
  createdAt: string;
  updatedAt: string;
};

export type Credential = {
  id: string;
  name: string;
  maskedApiKey: string;
  baseUrl: string | null;
  model: string | null;
  status: CredentialStatus;
  priority: number;
  weight: number;
  failureCount: number;
  cooldownUntil: string | null;
  lastTestedAt: string | null;
  lastTestStatus: string | null;
  lastTestLatencyMs: number | null;
  disabledAt: string | null;
  endpointProfile: string | null;
  modelQuotas: ModelQuota[];
};

export type ModelQuota = {
  id: string;
  credentialId: string;
  model: string;
  rpmLimit: number | null;
  tpmLimit: number | null;
  rpdLimit: number | null;
  requestsThisMinute: number;
  tokensThisMinute: number;
  requestsToday: number;
  minuteResetAt: string;
  dailyResetAt: string;
  resetTimezone: string;
  usageSource: "provider_response" | "system_estimated";
  enabled: boolean;
  isDefault: boolean;
  currency: string | null;
  serviceTier: string | null;
  inputPriceUsdPerMillion: number | null;
  outputPriceUsdPerMillion: number | null;
  cachedInputPriceUsdPerMillion: number | null;
  cacheStorageUsdPerMillionTokenHour: number | null;
  pricingEffectiveAt: string | null;
  pricingSource: string | null;
  pricingUnavailable: boolean | null;
  remaining: { rpm: number | null; tpm: number | null; rpd: number | null };
  createdAt: string;
  updatedAt: string;
};

export type ProviderForm = {
  provider: ProviderId;
  slug: string;
  displayName: string;
  baseUrl: string;
  model: string;
  enabled: boolean;
  isDefault: boolean;
  isRouterProvider: boolean;
  priority: number;
};

export type CredentialForm = {
  name: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  endpointProfile: string;
  status: CredentialStatus;
  priority: number;
  weight: number;
};

export type QuotaForm = {
  model: string;
  rpmLimit: string;
  tpmLimit: string;
  rpdLimit: string;
  resetTimezone: string;
  enabled: boolean;
  isDefault: boolean;
  currency: string;
  serviceTier: string;
  inputPriceUsdPerMillion: string;
  outputPriceUsdPerMillion: string;
  cachedInputPriceUsdPerMillion: string;
  cacheStorageUsdPerMillionTokenHour: string;
  pricingEffectiveAt: string;
  pricingSource: string;
  pricingUnavailable: boolean;
};

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  openai: "OpenAI",
  gemini: "Gemini",
  kimi: "Kimi",
  qwen: "Qwen",
  zai: "Z.AI"
};

export const PROVIDER_BASE_URL_DEFAULTS: Partial<Record<ProviderId, string>> = {
  gemini: "https://generativelanguage.googleapis.com/v1beta",
  zai: "https://api.z.ai/api/paas/v4"
};

export const PROVIDER_MODEL_DEFAULTS: Partial<Record<ProviderId, string>> = { zai: "glm-5.1" };

export const EMPTY_PROVIDER: ProviderForm = {
  provider: "openai",
  slug: "",
  displayName: "OpenAI",
  baseUrl: "",
  model: "",
  enabled: true,
  isDefault: false,
  isRouterProvider: false,
  priority: 100
};

export const EMPTY_CREDENTIAL: CredentialForm = {
  name: "",
  apiKey: "",
  baseUrl: "",
  model: "",
  endpointProfile: "",
  status: "active",
  priority: 100,
  weight: 1
};

export const EMPTY_QUOTA: QuotaForm = {
  model: "",
  rpmLimit: "",
  tpmLimit: "",
  rpdLimit: "",
  resetTimezone: "Asia/Taipei",
  enabled: true,
  isDefault: true,
  currency: "",
  serviceTier: "",
  inputPriceUsdPerMillion: "",
  outputPriceUsdPerMillion: "",
  cachedInputPriceUsdPerMillion: "",
  cacheStorageUsdPerMillionTokenHour: "",
  pricingEffectiveAt: "",
  pricingSource: "",
  pricingUnavailable: false
};

export function providerFormFrom(row: Provider): ProviderForm {
  return {
    provider: row.provider,
    slug: row.slug,
    displayName: row.displayName,
    baseUrl: row.baseUrl ?? "",
    model: row.model ?? "",
    enabled: row.enabled,
    isDefault: row.isDefault,
    isRouterProvider: row.isRouterProvider,
    priority: row.priority
  };
}

export function quotaFormFrom(row: ModelQuota, isDefault = row.isDefault): QuotaForm {
  return {
    model: row.model,
    rpmLimit: row.rpmLimit === null ? "" : String(row.rpmLimit),
    tpmLimit: row.tpmLimit === null ? "" : String(row.tpmLimit),
    rpdLimit: row.rpdLimit === null ? "" : String(row.rpdLimit),
    resetTimezone: row.resetTimezone,
    enabled: row.enabled,
    isDefault,
    currency: row.currency ?? "",
    serviceTier: row.serviceTier ?? "",
    inputPriceUsdPerMillion: row.inputPriceUsdPerMillion === null ? "" : String(row.inputPriceUsdPerMillion),
    outputPriceUsdPerMillion: row.outputPriceUsdPerMillion === null ? "" : String(row.outputPriceUsdPerMillion),
    cachedInputPriceUsdPerMillion: row.cachedInputPriceUsdPerMillion === null ? "" : String(row.cachedInputPriceUsdPerMillion),
    cacheStorageUsdPerMillionTokenHour: row.cacheStorageUsdPerMillionTokenHour === null ? "" : String(row.cacheStorageUsdPerMillionTokenHour),
    pricingEffectiveAt: row.pricingEffectiveAt ?? "",
    pricingSource: row.pricingSource ?? "",
    pricingUnavailable: row.pricingUnavailable ?? false
  };
}

export function numberOrNull(value: string): number | null {
  const normalized = value.trim();
  return normalized ? Number(normalized) : null;
}

export function floatOrNull(value: string): number | null {
  const trimmed = value.trim();
  return trimmed ? Number(trimmed) : null;
}
