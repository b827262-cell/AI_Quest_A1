import { z } from "zod";

/**
 * Phase 2 AI Gateway schemas. These back both persistence (repo rows) and the
 * admin Analytics API responses. Money is integer micro-USD (spec §13.10).
 */

// ---- Enums --------------------------------------------------------------

export const aiSubjectSchema = z.enum([
  "math",
  "science",
  "programming",
  "language",
  "humanities",
  "general",
  "unknown"
]);
export type AiSubject = z.infer<typeof aiSubjectSchema>;

export const aiTaskTypeSchema = z.enum([
  "explanation",
  "calculation",
  "translation",
  "summarization",
  "writing",
  "coding",
  "question_answering",
  "unknown"
]);
export type AiTaskType = z.infer<typeof aiTaskTypeSchema>;

export const aiComplexitySchema = z.enum(["low", "medium", "high"]);
export type AiComplexity = z.infer<typeof aiComplexitySchema>;

export const aiProviderIdSchema = z.enum(["mock", "gemini", "openai", "kimi", "qwen", "zai"]);
export type AiProviderId = z.infer<typeof aiProviderIdSchema>;

export const aiRequestSourceSchema = z.enum(["guest", "student", "book_qa", "admin", "internal"]);
export type AiRequestSource = z.infer<typeof aiRequestSourceSchema>;

export const aiRequestStatusSchema = z.enum([
  "pending",
  "success",
  "failed",
  "fallback",
  "rejected",
  "timeout"
]);
export type AiRequestStatus = z.infer<typeof aiRequestStatusSchema>;

export const aiBudgetScopeTypeSchema = z.enum([
  "global",
  "provider",
  "model",
  "guest",
  "student"
]);
export type AiBudgetScopeType = z.infer<typeof aiBudgetScopeTypeSchema>;

// ---- Request log --------------------------------------------------------

export const aiRequestLogSchema = z.object({
  id: z.string(),
  requestId: z.string(),
  visitorId: z.string().nullable(),
  visitorIpHash: z.string().nullable(),
  requestSource: aiRequestSourceSchema,
  question: z.string(),
  questionLength: z.number().int().nonnegative(),
  subject: aiSubjectSchema,
  taskType: aiTaskTypeSchema,
  complexity: aiComplexitySchema,
  routingProvider: aiProviderIdSchema,
  routingModel: z.string().nullable(),
  routingReason: z.string(),
  providerAttempts: aiProviderIdSchema.array().max(10),
  status: aiRequestStatusSchema,
  errorCode: z.string().nullable(),
  diagnosticsJson: z.string().nullable().optional(),
  createdAt: z.string(),
  completedAt: z.string(),
  latencyMs: z.number().int().nonnegative()
});
export type AiRequestLog = z.infer<typeof aiRequestLogSchema>;

export const createAiRequestLogInputSchema = z.object({
  requestId: z.string().trim().min(1).max(200),
  visitorId: z.string().nullable().optional(),
  visitorIpHash: z.string().nullable().optional(),
  requestSource: aiRequestSourceSchema,
  question: z.string().max(10_000),
  subject: aiSubjectSchema,
  taskType: aiTaskTypeSchema,
  complexity: aiComplexitySchema,
  routingProvider: aiProviderIdSchema,
  routingModel: z.string().nullable().optional(),
  routingReason: z.string(),
  providerAttempts: aiProviderIdSchema.array().max(10).default([]),
  status: aiRequestStatusSchema,
  errorCode: z.string().nullable().optional(),
  diagnosticsJson: z.string().max(20_000).nullable().optional(),
  latencyMs: z.number().int().nonnegative()
});
export type CreateAiRequestLogInput = z.infer<typeof createAiRequestLogInputSchema>;

// ---- Usage log ----------------------------------------------------------

export const aiUsageLogSchema = z.object({
  id: z.string(),
  requestId: z.string(),
  provider: aiProviderIdSchema,
  credentialId: z.string().nullable(),
  model: z.string(),
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  totalTokens: z.number().int().nonnegative().nullable(),
  // Q&A detail (spec §2): redacted, bounded; nullable for legacy rows.
  questionText: z.string().nullable(),
  answerText: z.string().nullable(),
  // Token breakdown (spec §6): subsets of input/output, never additive.
  cachedInputTokens: z.number().int().nonnegative().nullable(),
  thinkingTokens: z.number().int().nonnegative().nullable(),
  // Cost breakdown (spec §6): integer micro-USD.
  inputCostMicrousd: z.number().int().nonnegative(),
  cachedInputCostMicrousd: z.number().int().nonnegative(),
  outputCostMicrousd: z.number().int().nonnegative(),
  totalCostMicrousd: z.number().int().nonnegative(),
  // Pricing provenance (spec §5.3): immutable snapshot per request.
  pricingSource: z.string().nullable(),
  pricingVersion: z.string().nullable(),
  pricingSnapshotJson: z.string().nullable(),
  usageSource: z.enum(["provider_response", "system_estimated"]).nullable(),
  estimatedCostMicroUsd: z.number().int().nonnegative(),
  actualCostMicroUsd: z.number().int().nonnegative(),
  finishReason: z.string().nullable(),
  createdAt: z.string()
});
export type AiUsageLog = z.infer<typeof aiUsageLogSchema>;

export const createAiUsageLogInputSchema = z.object({
  requestId: z.string().trim().min(1).max(200),
  provider: aiProviderIdSchema,
  credentialId: z.string().trim().min(1).max(200).nullable().optional(),
  model: z.string().trim().min(1).max(200),
  inputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  outputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  totalTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  // Q&A detail (spec §2): redacted + bounded by the caller before persistence.
  questionText: z.string().max(10_000).nullable().optional(),
  answerText: z.string().max(20_000).nullable().optional(),
  cachedInputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  thinkingTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  inputCostMicrousd: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
  cachedInputCostMicrousd: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
  outputCostMicrousd: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
  totalCostMicrousd: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
  pricingSource: z.string().max(200).nullable().optional(),
  pricingVersion: z.string().max(200).nullable().optional(),
  pricingSnapshotJson: z.string().max(20_000).nullable().optional(),
  usageSource: z.enum(["provider_response", "system_estimated"]).nullable().optional(),
  estimatedCostMicroUsd: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
  actualCostMicroUsd: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
  finishReason: z.string().nullable().optional(),
  // Token Pool provenance (spec §6): sourced from the composite reservation,
  // never guessed from pricing config. NULL on legacy rows / passthrough models.
  poolId: z.string().trim().max(200).nullable().optional(),
  logicalModelId: z.string().trim().max(200).nullable().optional(),
  estimated: z.boolean().nullable().optional(),
  overageTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  // OpenAI Credential daily ledger provenance. NULL on legacy / passthrough rows.
  credentialDailyReservationKey: z.string().trim().max(300).nullable().optional(),
  usageAttempt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  costStatus: z.enum(["priced", "unconfigured", "unattributed"]).nullable().optional()
});
export type CreateAiUsageLogInput = z.infer<typeof createAiUsageLogInputSchema>;

// ---- Budget policy ------------------------------------------------------

export const aiBudgetPolicySchema = z.object({
  id: z.string(),
  scopeType: aiBudgetScopeTypeSchema,
  scopeKey: z.string().min(1).max(128),
  dailyTokenLimit: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  dailyCostLimitUsd: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER / 1_000_000),
  warningPercentage: z.number().int().min(0).max(100),
  enabled: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string()
});
export type AiBudgetPolicy = z.infer<typeof aiBudgetPolicySchema>;

export const createAiBudgetPolicyInputSchema = z.object({
  scopeType: aiBudgetScopeTypeSchema,
  scopeKey: z.string().trim().min(1).max(128),
  dailyTokenLimit: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(1_000_000),
  dailyCostLimitUsd: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER / 1_000_000).default(10),
  warningPercentage: z.number().int().min(0).max(100).default(80),
  enabled: z.boolean().default(true)
});
export type CreateAiBudgetPolicyInput = z.infer<typeof createAiBudgetPolicyInputSchema>;

export const updateAiBudgetPolicyInputSchema = z.object({
  dailyTokenLimit: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  dailyCostLimitUsd: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER / 1_000_000).optional(),
  warningPercentage: z.number().int().min(0).max(100).optional(),
  enabled: z.boolean().optional()
});
export type UpdateAiBudgetPolicyInput = z.infer<typeof updateAiBudgetPolicyInputSchema>;

// ---- Provider / credential administration (keys are write-only) ----------
export const managedAiProviderSchema = z.enum(["openai", "gemini", "kimi", "qwen", "zai"]);
export const aiCredentialStatusSchema = z.enum(["active", "standby", "disabled"]);
export const credentialUsageScopeSchema = z.enum(["development_interactive", "staging", "production", "unknown"]);
export const providerBillingModeSchema = z.enum(["pay_as_you_go", "token_plan_personal", "token_plan_team", "unknown"]);
export const providerHealthSchema = z.enum([
  "healthy", "authentication_error", "access_denied", "quota_exhausted",
  "rate_limited", "degraded", "unavailable", "unknown"
]);

const providerBaseUrlSchema = z.preprocess(
  (value) => typeof value === "string" && value.trim() === "" ? null : value,
  z.string().trim().url().max(500).refine((value) => {
    // Provider endpoints are server-to-server HTTPS URLs. In particular, the
    // Admin SPA origin must never be accepted as an upstream endpoint.
    return /^https:\/\//i.test(value)
      && !/^https:\/\/(?:localhost|127\.0\.0\.1)(?::5174)?(?:\/admin)?(?:\/|$)/i.test(value)
      && !/\/admin(?:\/|$)/i.test(value.replace(/^https?:\/\/[^/]+/i, ""));
  }, "Base URL 必須是有效的 HTTPS Provider URL，不可使用前端網址").nullable().optional()
);

const optionalProviderModelSchema = z.preprocess(
  (value) => typeof value === "string" && value.trim() === "" ? null : value,
  z.string().trim().min(1).max(200).refine((value) => {
    return !/^https?:\/\//i.test(value);
  }, "Model 不可使用 URL 格式").nullable().optional()
);

const optionalProviderSlugSchema = z.preprocess(
  (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().trim().min(1).max(64).regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i, "Slug 只能使用英數字與連字號").optional()
);

export const upsertAiProviderConfigInputSchema = z.object({
  id: z.string().trim().min(1).max(200).optional(),
  provider: z.preprocess(
    (value) => typeof value === "string" ? value.trim().toLowerCase() : value,
    managedAiProviderSchema
  ),
  slug: optionalProviderSlugSchema,
  displayName: z.string().trim().min(1).max(80),
  baseUrl: providerBaseUrlSchema,
  model: optionalProviderModelSchema,
  enabled: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  isRouterProvider: z.boolean().optional(),
  priority: z.number().int().min(0).max(10_000).optional()
});

// A blank quota limit means unknown / not configured. Zero is deliberately
// rejected so an administrator cannot confuse "no limit" with "no quota".
const optionalPositiveQuota = z.preprocess(
  (value) => typeof value === "string" && value.trim() === "" ? null : value,
  z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable().optional()
);
const quotaTimezone = z.preprocess(
  (value) => typeof value === "string" && value.trim() === "" ? "Asia/Taipei" : value,
  z.string().trim().min(1).max(100).default("Asia/Taipei")
);
const credentialBaseUrl = z.preprocess(
  (value) => typeof value === "string" && value.trim() === "" ? null : value,
  z.string().trim().url().max(500).nullable().optional()
);
const credentialModel = z.preprocess(
  (value) => typeof value === "string" && value.trim() === "" ? null : value,
  z.string().trim().min(1).max(200)
    .refine((value) => !/^https?:\/\//i.test(value), "Model 不可使用 URL 格式")
    .nullable().optional()
);

export const createAiCredentialInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  apiKey: z.string().trim().min(8).max(4096),
  baseUrl: credentialBaseUrl,
  model: credentialModel,
  rpmLimit: optionalPositiveQuota,
  tpmLimit: optionalPositiveQuota,
  rpdLimit: optionalPositiveQuota,
  resetTimezone: quotaTimezone,
  isDefaultModel: z.boolean().default(true),
  status: aiCredentialStatusSchema.default("active"),
  billingMode: providerBillingModeSchema.default("unknown"),
  region: z.string().trim().min(1).max(80).optional(),
  endpointProfile: z.string().trim().min(1).max(120).nullable().optional(),
  usageScope: credentialUsageScopeSchema.default("unknown"),
  productionAuthorized: z.boolean().default(false),
  allowEvaluation: z.boolean().default(false),
  priority: z.number().int().min(0).max(10_000).default(100),
  weight: z.number().int().min(1).max(20).default(1)
});
export const updateAiCredentialInputSchema = createAiCredentialInputSchema.partial().omit({ apiKey: true }).extend({
  // An empty write-only field means "keep the existing key" when editing.
  // The server still rejects masked values and never treats them as secrets.
  apiKey: z.preprocess(
    (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
    z.string().trim().min(8).max(4096).optional()
  )
});

// Pricing fields shared by create/update quota inputs (spec §5.1). All
// optional — a quota row may carry no pricing, in which case the seed/fallback
// table applies. Prices are USD per 1,000,000 tokens (float), stored and
// billed as integer micro-USD at compute time (spec §6.5).
const pricingInputFields = {
  currency: z.string().trim().max(10).optional(),
  serviceTier: z.enum(["standard", "free", "unavailable"]).optional(),
  inputPriceUsdPerMillion: z.number().finite().nonnegative().max(1_000_000).optional(),
  outputPriceUsdPerMillion: z.number().finite().nonnegative().max(1_000_000).optional(),
  cachedInputPriceUsdPerMillion: z.number().finite().nonnegative().max(1_000_000).optional(),
  cacheStorageUsdPerMillionTokenHour: z.number().finite().nonnegative().max(1_000_000).optional(),
  pricingEffectiveAt: z.string().trim().max(40).optional(),
  pricingSource: z.string().trim().max(200).optional(),
  pricingUnavailable: z.boolean().optional()
};

export const createAiCredentialModelQuotaInputSchema = z.object({
  model: z.string().trim().min(1).max(200),
  rpmLimit: optionalPositiveQuota,
  tpmLimit: optionalPositiveQuota,
  rpdLimit: optionalPositiveQuota,
  resetTimezone: quotaTimezone,
  enabled: z.boolean().default(true),
  isDefault: z.boolean().default(false),
  ...pricingInputFields
});
export const updateAiCredentialModelQuotaInputSchema = createAiCredentialModelQuotaInputSchema.partial();
export const aiCredentialModelQuotaSchema = z.object({
  id: z.string(),
  credentialId: z.string(),
  model: z.string().min(1),
  rpmLimit: z.number().int().positive().nullable(),
  tpmLimit: z.number().int().positive().nullable(),
  rpdLimit: z.number().int().positive().nullable(),
  requestsThisMinute: z.number().int().nonnegative(),
  tokensThisMinute: z.number().int().nonnegative(),
  requestsToday: z.number().int().nonnegative(),
  minuteResetAt: z.string(),
  dailyResetAt: z.string(),
  resetTimezone: z.string(),
  usageSource: z.enum(["provider_response", "system_estimated"]),
  // Pricing config (spec §5.1).
  currency: z.string().nullable(),
  serviceTier: z.string().nullable(),
  inputPriceUsdPerMillion: z.number().nullable(),
  outputPriceUsdPerMillion: z.number().nullable(),
  cachedInputPriceUsdPerMillion: z.number().nullable(),
  cacheStorageUsdPerMillionTokenHour: z.number().nullable(),
  pricingEffectiveAt: z.string().nullable(),
  pricingSource: z.string().nullable(),
  pricingUnavailable: z.boolean(),
  enabled: z.boolean(),
  isDefault: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string()
});
export type AiCredentialModelQuota = z.infer<typeof aiCredentialModelQuotaSchema>;

// ---- Daily usage --------------------------------------------------------

export const aiDailyUsageSchema = z.object({
  date: z.string(),
  scopeType: aiBudgetScopeTypeSchema,
  scopeKey: z.string(),
  requestCount: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  estimatedCostMicroUsd: z.number().int().nonnegative(),
  actualCostMicroUsd: z.number().int().nonnegative()
});
export type AiDailyUsage = z.infer<typeof aiDailyUsageSchema>;

// ---- Analytics API response shapes --------------------------------------

export const aiAnalyticsSummarySchema = z.object({
  date: z.string(),
  totalRequests: z.number().int().nonnegative(),
  successCount: z.number().int().nonnegative(),
  failedCount: z.number().int().nonnegative(),
  fallbackCount: z.number().int().nonnegative(),
  avgLatencyMs: z.number().nonnegative(),
  totalInputTokens: z.number().int().nonnegative(),
  totalOutputTokens: z.number().int().nonnegative(),
  totalEstimatedCostMicroUsd: z.number().int().nonnegative(),
  topProvider: z.string().nullable(),
  topSubject: z.string().nullable(),
  budgetUtilisationPercentage: z.number().nonnegative()
});
export type AiAnalyticsSummary = z.infer<typeof aiAnalyticsSummarySchema>;

export const aiAnalyticsDailyRowSchema = z.object({
  date: z.string(),
  requestCount: z.number().int().nonnegative(),
  successCount: z.number().int().nonnegative(),
  failedCount: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  estimatedCostMicroUsd: z.number().int().nonnegative(),
  avgLatencyMs: z.number().nonnegative()
});
export type AiAnalyticsDailyRow = z.infer<typeof aiAnalyticsDailyRowSchema>;

export const aiAnalyticsProviderRowSchema = z.object({
  provider: z.string(),
  requestCount: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  estimatedCostMicroUsd: z.number().int().nonnegative(),
  avgLatencyMs: z.number().nonnegative()
});
export type AiAnalyticsProviderRow = z.infer<typeof aiAnalyticsProviderRowSchema>;

export const aiAnalyticsSubjectRowSchema = z.object({
  subject: z.string(),
  requestCount: z.number().int().nonnegative()
});
export type AiAnalyticsSubjectRow = z.infer<typeof aiAnalyticsSubjectRowSchema>;

export const guestAskQuotaSchema = z.object({
  used: z.number().int().nonnegative(),
  limit: z.number().int().nonnegative(),
  remaining: z.number().int().nonnegative()
});
export type GuestAskQuota = z.infer<typeof guestAskQuotaSchema>;

// ---- student answer allowlist ------------------------------------------
// Provider responses, routing decisions and verification objects never cross
// the public boundary. The browser receives only these learning fields.
export const guestAnswerExampleSchema = z.object({
  input: z.string().max(500),
  output: z.string().max(2_000),
  explanation: z.string().max(1_000).optional()
});
export type GuestAnswerExample = z.infer<typeof guestAnswerExampleSchema>;

export const guestAnswerContentSchema = z.object({
  summary: z.string().min(1).max(4_000),
  steps: z.string().array().max(6),
  explanation: z.string().max(6_000).optional(),
  codeLanguage: z.string().max(24).optional(),
  code: z.string().max(20_000).optional(),
  examples: guestAnswerExampleSchema.array().max(4),
  complexity: z.string().max(500).optional(),
  markdownText: z.string().max(24_000)
});
export type GuestAnswerContent = z.infer<typeof guestAnswerContentSchema>;
