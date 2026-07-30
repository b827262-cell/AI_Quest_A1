import type { SafeAiDiagnostics } from "./diagnostics-allowlist";

/**
 * Phase 2 AI Gateway — shared types.
 *
 * These types are the single contract between the Student API, the AI Gateway,
 * the Router, every Provider and the persistence layer. Provider-specific SDK
 * shapes never leak past this boundary (spec §13.12).
 *
 * Money is represented as integer **micro-USD** (1 USD = 1_000_000 micro-USD)
 * to avoid floating-point accumulation drift in aggregates (spec §13.10).
 */

/** Coarse subject classification produced by the router. */
export type AiSubject =
  | "math"
  | "science"
  | "programming"
  | "language"
  | "humanities"
  | "general"
  | "unknown";

/** Task shape inferred from the question. */
export type AiTaskType =
  | "explanation"
  | "calculation"
  | "translation"
  | "summarization"
  | "writing"
  | "coding"
  | "question_answering"
  | "unknown";

/** Estimated reasoning complexity, used to pick a stronger/weaker model. */
export type AiComplexity = "low" | "medium" | "high";

/** Stable provider identifiers (never a vendor SDK name). */
export type AiProviderId = "mock" | "gemini" | "openai" | "kimi" | "qwen" | "zai";

/** Safe, stable reasons why a formal provider/model candidate was skipped. */
export type AiFallbackReason =
  | "no_active_credential"
  | "no_default_model"
  | "model_not_enabled"
  | "quota_exhausted"
  | "credential_cooldown"
  | "provider_disabled"
  | "provider_request_failed";

/** Where a request originated; drives quota scope. */
export type AiRequestSource = "guest" | "student" | "book_qa" | "admin" | "internal";

/** Lifecycle status written to ai_request_logs. */
export type AiRequestStatus =
  | "pending"
  | "success"
  | "failed"
  | "fallback"
  | "rejected"
  | "timeout";

/** Normalised, provider-agnostic input handed to a provider. */
export type AiGenerateRequest = {
  /** Correlation id reused across request + usage logs. */
  requestId: string;
  prompt: string;
  systemPrompt?: string;
  subject?: AiSubject;
  taskType?: AiTaskType;
  /** Optional per-call model override; otherwise the provider default applies. */
  model?: string;
  maxOutputTokens?: number;
  temperature?: number;
  /** Per-attempt cancellation signal owned by the gateway. */
  signal?: AbortSignal;
};

/** Per-component micro-USD cost breakdown attached to a result (spec §6). */
export type AiCostBreakdown = {
  inputCostMicroUsd: number;
  cachedInputCostMicroUsd: number;
  outputCostMicroUsd: number;
  totalCostMicroUsd: number;
};

/** Normalised, provider-agnostic output returned by a provider. */
export type AiGenerateResult = {
  provider: AiProviderId;
  model: string;
  answer: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  /**
   * Cached input tokens reported by the provider (e.g. Gemini
   * `cachedContentTokenCount`). These are a subset of `inputTokens`, never
   * additional to it (spec §6.1).
   */
  cachedInputTokens?: number;
  /**
   * Reasoning/thinking tokens reported by the provider (e.g. Gemini
   * `thoughtsTokenCount`). These are a subset of `outputTokens`, never
   * additional to it (spec §6.3).
   */
  thinkingTokens?: number;
  /** Whether token usage came from the provider response or local estimation. */
  usageSource?: "provider_response" | "system_estimated";
  latencyMs: number;
  /** Micro-USD (integer). Mock is always 0. */
  estimatedCostMicroUsd?: number;
  /** Observed/estimated settlement amount kept separate for accounting. */
  actualCostMicroUsd?: number;
  /** Per-component cost breakdown computed from observed usage (spec §6). */
  costBreakdown?: AiCostBreakdown;
  /** Provenance of the pricing used (e.g. "google-ai-studio-2026-07"). */
  pricingSource?: string;
  /** Stable version of the pricing snapshot captured at request time. */
  pricingVersion?: string;
  finishReason?: string;
  /** True when the answer validator had to cut an oversized provider result. */
  answerTruncated?: boolean;
  /** Lightweight internal completeness assessment; never contains secrets. */
  completion?: {
    complete: boolean;
    reasons: string[];
    requestedItems: string[];
    coveredItems: string[];
  };
  /** Safe operational fields for logs and diagnostics; no headers or keys. */
  diagnostics?: AiGenerationDiagnostics;
  /** Server-side credential identifier for accounting; never sent as key material. */
  credentialId?: string;
  /**
   * OpenAI Credential daily-ledger reservation key. Set by CredentialBackedProvider
   * for providerId="openai" after a successful daily reserve, so the gateway can
   * settle the per-key daily usage (tokens + actual cost) once actualCostMicroUsd
   * is known. Undefined for non-OpenAI providers and unconfigured credentials.
   * Never contains key material.
   */
  credentialDailyReservationKey?: string;
  /**
   * DB-backed pricing config fields from the resolved credential/model quota row
   * (spec §5.1). Captured at request time by the credential provider and consumed
   * by the gateway's {@link computeCostBreakdown} and {@link pricingSnapshotFor}
   * so the authoritative DB prices are used rather than the seed fallback.
   * Historical rows are never affected by later price edits because the snapshot
   * is frozen at request time (spec §5.3).
   */
  pricingConfig?: {
    currency: string | null;
    serviceTier: string | null;
    inputPriceUsdPerMillion: number | null;
    outputPriceUsdPerMillion: number | null;
    cachedInputPriceUsdPerMillion: number | null;
    cacheStorageUsdPerMillionTokenHour: number | null;
    pricingEffectiveAt: string | null;
    pricingSource: string | null;
    pricingUnavailable: boolean | null;
  };
};

export type AiFailureKind =
  | "provider_timeout"
  | "gateway_timeout"
  | "client_abort"
  | "token_length"
  | "provider_rate_limit"
  | "provider_server_error"
  | "stream_format"
  | "answer_save"
  | "unknown";

/** Structured, secret-free runtime diagnostics retained for internal logs. */
export type AiGenerationDiagnostics = {
  provider?: AiProviderId;
  model?: string;
  transport: "json" | "sse";
  promptTokens?: number;
  completionTokens?: number;
  configuredMaxOutputTokens?: number;
  finishReason?: string | null;
  initialFinishReason?: string | null;
  requestDurationMs: number;
  streamEndedNormally: boolean;
  clientAborted?: boolean;
  gatewayTimeout?: boolean;
  providerTimeout?: boolean;
  fallbackTriggered?: boolean;
  continuationAttempts?: number;
  continuationCompleted?: boolean;
  /** JSON transport has no individual chunk; SSE adapters may fill this. */
  lastChunk?: string | null;
  failureKind?: AiFailureKind;
  fallbackReason?: AiFallbackReason;
};

/** Router decision consumed by the gateway to pick + rank providers. */
export type RoutingDecision = {
  subject: AiSubject;
  taskType: AiTaskType;
  complexity: AiComplexity;
  preferredProvider: AiProviderId;
  preferredModel?: string;
  fallbackProviders: AiProviderId[];
  reason: string;
  /**
   * Logical model id preferred for this request (e.g. "gpt-5.6-terra"). When
   * set, the orchestrator maps it to a provider model name before the call.
   * Optional and unused by the legacy gateway path.
   */
  preferredLogicalModel?: string;
  /**
   * Whether a second-model verification pass is eligible for this request.
   * Set by the router based on complexity/task; the orchestrator additionally
   * gates on pool utilization before actually issuing the second call.
   */
  secondModelEligible?: boolean;
  /** Human-readable reason a second model was deemed eligible (or not). */
  secondModelReason?: string;
};

/** A provider registry entry describing availability + ordering. */
export type ProviderRegistration = {
  id: AiProviderId;
  enabled: boolean;
  priority: number;
};

// ---------------------------------------------------------------------------
// Error model
// ---------------------------------------------------------------------------

/** Machine-readable error codes surfaced (sanitised) to clients. */
export type AiErrorCode =
  | "AI_INVALID_INPUT"
  | "AI_RATE_LIMITED"
  | "AI_BUDGET_EXCEEDED"
  | "AI_PROVIDER_UNAVAILABLE"
  | "AI_ANSWER_INVALID"
  | "AI_INTERNAL";

/** HTTP status that corresponds to each public error code. */
export const AI_ERROR_HTTP_STATUS: Record<AiErrorCode, number> = {
  AI_INVALID_INPUT: 400,
  AI_RATE_LIMITED: 429,
  AI_BUDGET_EXCEEDED: 429,
  AI_PROVIDER_UNAVAILABLE: 503,
  AI_ANSWER_INVALID: 503,
  AI_INTERNAL: 500
};

/**
 * Unified gateway error. The `cause` may hold a provider SDK error but it is
 * NEVER serialised to the client — only `code` + `publicMessage` leave the
 * gateway (spec §13.13, §5 sensitive-data rules).
 */
export class AiGatewayError extends Error {
  readonly code: AiErrorCode;
  readonly httpStatus: number;
  readonly publicMessage: string;
  /** Provider id that failed, when relevant (used for routing/fallback logs). */
  readonly failedProvider?: AiProviderId;
  /** Whether retrying the same upstream attempt is appropriate. */
  readonly retryable: boolean;
  readonly upstreamStatus?: number;
  readonly failureKind: AiFailureKind;
  readonly fallbackReason?: AiFallbackReason;
  /** Safe, allowlisted operational diagnostics for preflight and logging. */
  readonly diagnostics?: SafeAiDiagnostics;

  constructor(
    code: AiErrorCode,
    publicMessage: string,
    options?: {
      cause?: unknown;
      failedProvider?: AiProviderId;
      internalMessage?: string;
      retryable?: boolean;
      upstreamStatus?: number;
      failureKind?: AiFailureKind;
      fallbackReason?: AiFallbackReason;
      diagnostics?: SafeAiDiagnostics;
    }
  ) {
    super(options?.internalMessage ?? publicMessage, { cause: options?.cause });
    this.name = "AiGatewayError";
    this.code = code;
    this.httpStatus = AI_ERROR_HTTP_STATUS[code];
    this.publicMessage = publicMessage;
    this.failedProvider = options?.failedProvider;
    this.retryable = options?.retryable ?? false;
    this.upstreamStatus = options?.upstreamStatus;
    this.failureKind = options?.failureKind ?? "unknown";
    this.fallbackReason = options?.fallbackReason;
    this.diagnostics = options?.diagnostics;
  }
}

/** True for any error thrown by a provider that should trigger fallback. */
export function isFallbackEligible(error: unknown): boolean {
  if (error instanceof AiGatewayError) {
    return (
      error.code === "AI_PROVIDER_UNAVAILABLE" ||
      error.code === "AI_ANSWER_INVALID" ||
      // Timeouts surface as provider-unavailable from the gateway.
      error.code === "AI_INTERNAL"
    );
  }
  return true;
}

/** Retry the same upstream only for transient failures. */
export function isRetryable(error: unknown): boolean {
  if (error instanceof AiGatewayError) return error.retryable;
  return true;
}
