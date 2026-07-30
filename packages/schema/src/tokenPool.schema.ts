import { z } from "zod";

/**
 * Token Pool schemas (spec: OpenAI daily token pool + multi-model routing).
 *
 * Four INDEPENDENT limit dimensions — a request must pass ALL of them:
 *   (1) Daily Token Pool        — aiTokenPools
 *   (2) Provider RPM/TPM/RPD    — aiCredentialModelQuotas (separate schema)
 *   (3) Model Daily Limit       — aiModelDailyLimits
 *   (4) Context Window          — aiLogicalModels (single-request, not daily)
 *
 * Context Window columns describe single-request capacity and are deliberately
 * separate from the per-day dailyLimit. maxOutputTokens lives on the logical
 * model (single-request output ceiling), NOT on the daily limit row.
 *
 * Thresholds are stored as integer percentages (0-100) in the DB/API; the
 * domain converts to a 0..1 ratio on read.
 */

// ---- Token Pool Type --------------------------------------------------------

export const aiTokenPoolTypeSchema = z.enum(["shared", "sol"]);
export type AiTokenPoolType = z.infer<typeof aiTokenPoolTypeSchema>;

// ---- Logical Model Registry -------------------------------------------------

export const aiLogicalModelSchema = z.object({
  id: z.string(),
  logicalModelId: z.string().trim().min(1).max(128),
  providerId: z.string().trim().min(1).max(64),
  providerConfigId: z.string().trim().min(1).max(200).nullable(),
  providerModelName: z.string().trim().min(1).max(200),
  // Context Window spec (dimension 4: single-request capacity).
  contextWindowTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  maxInputTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
  maxOutputTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  supportsThinking: z.boolean(),
  tokenizerType: z.string().trim().min(1).max(64).nullable(),
  tokenizerVersion: z.string().trim().min(1).max(64).nullable(),
  enabled: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string()
});
export type AiLogicalModel = z.infer<typeof aiLogicalModelSchema>;

export const upsertAiLogicalModelInputSchema = z.object({
  logicalModelId: z.string().trim().min(1).max(128),
  providerId: z.string().trim().min(1).max(64),
  providerConfigId: z.string().trim().min(1).max(200).nullable().optional(),
  providerModelName: z.string().trim().min(1).max(200),
  contextWindowTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  maxInputTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  maxOutputTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  supportsThinking: z.boolean().optional(),
  tokenizerType: z.string().trim().min(1).max(64).nullable().optional(),
  tokenizerVersion: z.string().trim().min(1).max(64).nullable().optional(),
  enabled: z.boolean().optional()
}).refine(
  (d) => d.maxInputTokens === undefined || d.maxInputTokens === null || d.maxInputTokens <= d.contextWindowTokens,
  { message: "maxInputTokens must be <= contextWindowTokens" }
);
export type UpsertAiLogicalModelInput = z.infer<typeof upsertAiLogicalModelInputSchema>;

export const updateAiLogicalModelInputSchema = z.object({
  providerId: z.string().trim().min(1).max(64).optional(),
  providerConfigId: z.string().trim().min(1).max(200).nullable().optional(),
  providerModelName: z.string().trim().min(1).max(200).optional(),
  contextWindowTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  maxInputTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  maxOutputTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  supportsThinking: z.boolean().optional(),
  tokenizerType: z.string().trim().min(1).max(64).nullable().optional(),
  tokenizerVersion: z.string().trim().min(1).max(64).nullable().optional(),
  enabled: z.boolean().optional()
});
export type UpdateAiLogicalModelInput = z.infer<typeof updateAiLogicalModelInputSchema>;

// ---- Token Pool -------------------------------------------------------------

export const aiTokenPoolSchema = z.object({
  id: z.string(),
  name: z.string().trim().min(1).max(128),
  poolType: aiTokenPoolTypeSchema,
  timezone: z.string().trim().min(1).max(100),
  dailyLimit: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  usedTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  reservedTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  warningThreshold: z.number().int().min(0).max(100),
  throttleThreshold: z.number().int().min(0).max(100),
  criticalThreshold: z.number().int().min(0).max(100),
  resetAt: z.string(),
  enabled: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string()
});
export type AiTokenPool = z.infer<typeof aiTokenPoolSchema>;

export const createAiTokenPoolInputSchema = z.object({
  name: z.string().trim().min(1).max(128),
  poolType: aiTokenPoolTypeSchema,
  timezone: z.string().trim().min(1).max(100).default("Asia/Taipei"),
  dailyLimit: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  warningThreshold: z.number().int().min(0).max(100).default(60),
  throttleThreshold: z.number().int().min(0).max(100).default(80),
  criticalThreshold: z.number().int().min(0).max(100).default(90),
  enabled: z.boolean().default(true)
}).refine((d) => d.warningThreshold < d.throttleThreshold && d.throttleThreshold < d.criticalThreshold, {
  message: "thresholds must be strictly increasing: warning < throttle < critical"
});
export type CreateAiTokenPoolInput = z.infer<typeof createAiTokenPoolInputSchema>;

export const updateAiTokenPoolInputSchema = z.object({
  name: z.string().trim().min(1).max(128).optional(),
  timezone: z.string().trim().min(1).max(100).optional(),
  dailyLimit: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  warningThreshold: z.number().int().min(0).max(100).optional(),
  throttleThreshold: z.number().int().min(0).max(100).optional(),
  criticalThreshold: z.number().int().min(0).max(100).optional(),
  enabled: z.boolean().optional()
});
export type UpdateAiTokenPoolInput = z.infer<typeof updateAiTokenPoolInputSchema>;

// ---- Model Daily Limit ------------------------------------------------------

export const aiModelDailyLimitSchema = z.object({
  id: z.string(),
  logicalModelId: z.string().trim().min(1).max(128),
  poolId: z.string().trim().min(1).max(128),
  dailyLimit: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  usedTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  reservedTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  priority: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  fallbackLogicalModelId: z.string().trim().min(1).max(128).nullable(),
  enabled: z.boolean(),
  allowSecondModelVerification: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string()
});
export type AiModelDailyLimit = z.infer<typeof aiModelDailyLimitSchema>;

export const updateAiModelDailyLimitInputSchema = z.object({
  poolId: z.string().trim().min(1).max(128).optional(),
  dailyLimit: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  priority: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  fallbackLogicalModelId: z.string().trim().min(1).max(128).nullable().optional(),
  enabled: z.boolean().optional(),
  allowSecondModelVerification: z.boolean().optional()
}).refine(
  // fallbackLogicalModelId must not point at the model itself (cycle of length 1).
  (d) => d.fallbackLogicalModelId === undefined || d.fallbackLogicalModelId === null || d.fallbackLogicalModelId.length > 0,
  { message: "fallbackLogicalModelId must be a non-empty logical model id or null" }
);
export type UpdateAiModelDailyLimitInput = z.infer<typeof updateAiModelDailyLimitInputSchema>;

// ---- Token Pool Reservation (read-only view) --------------------------------

export const aiTokenPoolReservationStatusSchema = z.enum(["pending", "settled", "released"]);
export type AiTokenPoolReservationStatus = z.infer<typeof aiTokenPoolReservationStatusSchema>;

export const aiTokenPoolReservationSchema = z.object({
  id: z.string(),
  reservationKey: z.string(),
  requestId: z.string(),
  attemptId: z.string(),
  poolId: z.string(),
  logicalModelId: z.string(),
  estimatedTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  actualTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  overage: z.boolean(),
  status: aiTokenPoolReservationStatusSchema,
  settledAt: z.string().nullable(),
  releasedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string()
});
export type AiTokenPoolReservation = z.infer<typeof aiTokenPoolReservationSchema>;
