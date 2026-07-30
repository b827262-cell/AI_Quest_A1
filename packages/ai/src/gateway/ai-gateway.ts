import { randomUUID } from "node:crypto";
import {
  AiGatewayError,
  isRetryable,
  type AiGenerateRequest,
  type AiGenerateResult,
  type AiFallbackReason,
  type AiProviderId,
  type AiRequestSource,
  type RoutingDecision
} from "./ai-types";
import type { GatewayAiProvider } from "./provider.interface";
import { routePrompt, type RouterConfig } from "./ai-router";
import { validateResult, type AnswerValidatorOptions } from "./answer-validator";
import {
  computeCostBreakdown,
  pricingSnapshotFor,
  estimateCostMicroUsd
} from "./pricing";
import { redactSensitiveText } from "./secret-redaction";
import { assessAnswerCompleteness } from "./answer-completeness";
import { buildContinuationPrompt, mergeContinuation } from "./continuation";
import type { AiGenerationDiagnostics } from "./ai-types";

/**
 * Port interfaces for the governance layer (implemented against the DB in
 * Phase 2B). The gateway depends on these abstractions, never on a concrete
 * repository — keeping the gateway unit-testable in isolation.
 */

export type BudgetCheckInput = {
  requestId?: string;
  provider: AiProviderId;
  model: string;
  inputTokens: number;
  estimatedOutputTokens: number;
  estimatedCostMicroUsd: number;
  scopeType: AiRequestSource;
  scopeKey: string;
};

export type BudgetCheckResult = {
  allowed: boolean;
  /** Current spend ratio in the relevant scope (0..1+). */
  utilisation: number;
  reason?: string;
  reservation?: BudgetReservation;
};

export type BudgetReservation = {
  id: string;
  provider: AiProviderId;
  model: string;
  estimatedTokens: number;
  estimatedCostMicroUsd: number;
};

export type BudgetRecordInput = {
  provider: AiProviderId;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostMicroUsd: number;
  actualCostMicroUsd: number;
  scopeType: AiRequestSource;
  scopeKey: string;
};

export interface BudgetManager {
  preCheck(input: BudgetCheckInput): Promise<BudgetCheckResult>;
  recordUsage(input: BudgetRecordInput): Promise<void>;
  /** Optional atomic reservation lifecycle for hard daily limits. */
  reserve?(input: BudgetCheckInput): Promise<BudgetCheckResult>;
  settleReservation?(reservation: BudgetReservation, input: BudgetRecordInput): Promise<void>;
  releaseReservation?(reservation: BudgetReservation): Promise<void>;
}

/** No-op budget manager for environments without persistence (always allows). */
export class AllowAllBudgetManager implements BudgetManager {
  async preCheck(): Promise<BudgetCheckResult> {
    return { allowed: true, utilisation: 0 };
  }
  async recordUsage(): Promise<void> {}
}

export type GatewayLogContext = {
  requestId: string;
  visitorId?: string;
  visitorIpHash?: string;
  requestSource: AiRequestSource;
  scopeKey: string;
  question: string;
};

export type GatewayLogEntry = {
  requestId: string;
  visitorId?: string;
  visitorIpHash?: string;
  requestSource: AiRequestSource;
  question: string;
  questionLength: number;
  decision: RoutingDecision;
  /** Provider IDs attempted in order; contains no upstream error bodies. */
  providerAttempts: AiProviderId[];
  status: "success" | "failed" | "fallback" | "rejected" | "timeout";
  errorCode?: string;
  failedProviders?: AiProviderId[];
  startedAt: string;
  completedAt: string;
  latencyMs: number;
  result?: AiGenerateResult;
  diagnostics?: AiGenerationDiagnostics;
  fallbackReason?: AiFallbackReason;
  estimatedCostMicroUsd: number;
};

export interface PromptLogger {
  log(entry: GatewayLogEntry): Promise<void>;
}

/** No-op logger used before the DB-backed logger is wired. */
export class NoopPromptLogger implements PromptLogger {
  async log(): Promise<void> {}
}

export type AiGatewayConfig = {
  /** Registered providers, keyed by id. */
  providers: Map<AiProviderId, GatewayAiProvider>;
  /** Router config (defaults to DEFAULT_ROUTER_CONFIG if omitted). */
  routerConfig?: RouterConfig;
  /** Per-call timeout applied to every provider call (spec §13.9). */
  requestTimeoutMs: number;
  /** Max retries per provider before moving to the next fallback. */
  maxRetries: number;
  /** Max output tokens handed to providers. */
  maxOutputTokens: number;
  /** Automatically make at most one continuation request after a token stop. */
  autoContinueOnLength?: boolean;
  /** Max input characters accepted (longer prompts are rejected). */
  maxInputChars: number;
  budgetManager?: BudgetManager;
  logger?: PromptLogger;
  answerValidatorOptions?: AnswerValidatorOptions;
  /** Allow forcing a single provider (e.g. AI_DEFAULT_PROVIDER). */
  forceProvider?: AiProviderId;
  /** Production must explicitly opt in before using the deterministic mock. */
  allowMockFallback?: boolean;
};

export type GatewayRunInput = {
  requestId?: string;
  prompt: string;
  systemPrompt?: string;
  requestSource?: AiRequestSource;
  scopeKey?: string;
  visitorId?: string;
  visitorIpHash?: string;
  temperature?: number;
  /** Optional per-request cap; it can never exceed the gateway cap. */
  maxOutputTokens?: number;
  /** Request-owned signal; a client abort must stop retries and fallback. */
  clientSignal?: AbortSignal;
  subjectOverride?: RoutingDecision["subject"];
  preferredProvider?: AiProviderId;
  preferredModel?: string;
};

export type GatewayRunOutput = {
  result: AiGenerateResult;
  decision: RoutingDecision;
  fallbackUsed: boolean;
  failedProviders: AiProviderId[];
  fallbackReason?: AiFallbackReason;
};

function nowIso(): string {
  return new Date().toISOString();
}

function estimateTokens(text: string): number {
  if (!text) return 0;
  // This is deliberately an upper-bound reservation estimate. A tokenizer is
  // provider-specific; reserving by characters prevents concurrent requests
  // from consuming more than the configured daily reservation.
  return Math.max(1, text.length);
}

/**
 * The gateway. Orchestrates validation → routing → budget pre-check →
 * provider call (with timeout + retry) → fallback → answer validation →
 * budget record → prompt log.
 */
export class AiGateway {
  readonly config: AiGatewayConfig;
  private readonly budget: BudgetManager;
  private readonly logger: PromptLogger;

  constructor(config: AiGatewayConfig) {
    this.config = config;
    this.budget = config.budgetManager ?? new AllowAllBudgetManager();
    this.logger = config.logger ?? new NoopPromptLogger();
  }

  /** Providers currently registered + available, in arbitrary order. */
  async availableProviders(requestedModel?: string): Promise<AiProviderId[]> {
    return [...(await this.providerAvailability(requestedModel)).entries()]
      .filter(([, detail]) => detail.available)
      .map(([id]) => id);
  }

  private async providerAvailability(requestedModel?: string): Promise<Map<AiProviderId, { available: boolean; model?: string; reason?: AiFallbackReason }>> {
    const diagnostics = new Map<AiProviderId, { available: boolean; model?: string; reason?: AiFallbackReason }>();
    const ids: AiProviderId[] = [];
    for (const [id, provider] of this.config.providers) {
      try {
        const detail = provider.diagnoseAvailability
          ? await provider.diagnoseAvailability(requestedModel)
          : { available: await provider.isAvailable() };
        diagnostics.set(id, detail);
        if (detail.available) ids.push(id);
      } catch {
        // a provider throwing on availability check is treated as unavailable
        diagnostics.set(id, { available: false, reason: "provider_request_failed" });
      }
    }
    return diagnostics;
  }

  async run(input: GatewayRunInput): Promise<GatewayRunOutput> {
    const startedAtIso = nowIso();
    const startedAtMs = Date.now();
    const requestSource: AiRequestSource = input.requestSource ?? "guest";
    const scopeKey = input.scopeKey ?? input.visitorId ?? "anonymous";
    const requestId = input.requestId?.trim() || randomUUID();
    if (requestId.length > 200) {
      throw new AiGatewayError("AI_INVALID_INPUT", "請求格式不正確。");
    }

    // 1. Request validation -------------------------------------------------
    const trimmed = input.prompt?.trim() ?? "";
    if (trimmed.length === 0) {
      throw new AiGatewayError("AI_INVALID_INPUT", "請輸入問題內容。");
    }
    if (trimmed.length > this.config.maxInputChars) {
      throw new AiGatewayError(
        "AI_INVALID_INPUT",
        "問題長度超過上限，請精簡後再送出。",
        { internalMessage: `prompt length ${trimmed.length} > ${this.config.maxInputChars}` }
      );
    }

    // 2. Routing ------------------------------------------------------------
    const availability = await this.providerAvailability(input.preferredModel);
    const available = [...availability.entries()].filter(([, detail]) => detail.available).map(([id]) => id);
    const explicitPreferred = input.preferredProvider ?? this.config.forceProvider;
    // Run the router WITHOUT availability filtering so we keep the full intended
    // chain (preferred + fallbacks + backstop); availability is applied below.
    const decision = routePrompt(trimmed, {
      config: this.config.routerConfig,
      preferredModel: input.preferredModel
    });

    // Build the ordered chain (override → router preferred → fallbacks → backstop),
    // filtered to currently-available providers. This guarantees a failing forced
    // provider still falls back through the router-chosen candidates to mock.
    const chainCandidates: AiProviderId[] = [];
    if (explicitPreferred) chainCandidates.push(explicitPreferred);
    chainCandidates.push(decision.preferredProvider);
    for (const f of decision.fallbackProviders) chainCandidates.push(f);
    if (this.config.allowMockFallback !== false) chainCandidates.push("mock");
    const chain = this.dedupeFilter(chainCandidates, available);
    const loggedQuestion = redactSensitiveText(trimmed);

    // 3. Attempt providers in order (with retry + timeout) ------------------
    const failedProviders: AiProviderId[] = [];
    let fallbackReason: AiFallbackReason | undefined;
    const markFailed = (providerId: AiProviderId, reason?: AiFallbackReason) => {
      if (!failedProviders.includes(providerId)) failedProviders.push(providerId);
      if (!fallbackReason && providerId !== "mock") {
        fallbackReason = reason ?? availability.get(providerId)?.reason;
      }
    };
    for (const candidate of this.dedupeFilter(chainCandidates, chainCandidates)) {
      if (candidate !== "mock" && this.config.providers.has(candidate) && !availability.get(candidate)?.available) {
        markFailed(candidate, availability.get(candidate)?.reason);
      }
    }
    const providerAttempts: AiProviderId[] = [];
    let lastError: unknown = null;
    let result: AiGenerateResult | null = null;
    let activeReservation: BudgetReservation | undefined;

    for (let i = 0; i < chain.length; i++) {
      const providerId = chain[i];
      const provider = this.config.providers.get(providerId);
      if (!provider) {
        markFailed(providerId, "provider_request_failed");
        continue;
      }
      providerAttempts.push(providerId);
      try {
        const detail = provider.diagnoseAvailability
          ? await provider.diagnoseAvailability(input.preferredModel)
          : { available: await provider.isAvailable() };
        if (!detail.available) {
          markFailed(providerId, detail.reason);
          continue;
        }

        // Budget pre-check (per provider/model estimate).
        const model = input.preferredModel ?? provider.defaultModel;
        const inputTokens =
          estimateTokens(input.systemPrompt ?? "") + estimateTokens(trimmed);
        const effectiveMaxOutputTokens = Math.max(
          1,
          Math.floor(Math.min(this.config.maxOutputTokens, input.maxOutputTokens ?? this.config.maxOutputTokens))
        );
        // Reserve for the one bounded continuation as well. This keeps the
        // length-recovery path inside the existing budget/cooldown controls.
        const estimatedOutputTokens =
          effectiveMaxOutputTokens * (this.config.autoContinueOnLength === false ? 1 : 2);
        const estimatedCostMicroUsd = estimateCostMicroUsd(
          providerId,
          model,
          inputTokens,
          estimatedOutputTokens
        );
        const budgetInput = {
          requestId,
          provider: providerId,
          model,
          inputTokens,
          estimatedOutputTokens,
          estimatedCostMicroUsd,
          scopeType: requestSource,
          scopeKey
        } satisfies BudgetCheckInput;
        const budgetCheck = this.budget.reserve
          ? await this.budget.reserve(budgetInput)
          : await this.budget.preCheck(budgetInput);
        if (!budgetCheck.allowed) {
          throw new AiGatewayError(
            "AI_BUDGET_EXCEEDED",
            "今日 AI 額度已達上限，請稍後再試。",
            { internalMessage: `budget pre-check denied: ${budgetCheck.reason ?? ""}` }
          );
        }
        activeReservation = budgetCheck.reservation;

        const request: AiGenerateRequest = {
          requestId,
          prompt: trimmed,
          systemPrompt: input.systemPrompt,
          subject: decision.subject,
          taskType: decision.taskType,
          model: input.preferredModel ?? (provider.resolveModelAtCallTime ? undefined : provider.defaultModel),
          maxOutputTokens: effectiveMaxOutputTokens,
          temperature: input.temperature
        };

        try {
          result = await this.callWithRetry(provider, request, input.clientSignal);
        } catch (providerError) {
          if (activeReservation && this.budget.releaseReservation) {
            await this.budget.releaseReservation(activeReservation).catch(() => undefined);
            activeReservation = undefined;
          }
          throw providerError;
        }
        result = validateResult(result, this.config.answerValidatorOptions);
        if (result.provider !== providerId) {
          throw new AiGatewayError(
            "AI_PROVIDER_UNAVAILABLE",
            "AI 服務目前暫時無法使用，請稍後再試。",
            {
              internalMessage: `provider identity mismatch: expected ${providerId}`,
              failedProvider: providerId,
              retryable: false
            }
          );
        }

        const firstCompletion = assessAnswerCompleteness(trimmed, result.answer, {
          finishReason: result.finishReason,
          streamEndedNormally: result.diagnostics?.streamEndedNormally,
          answerTruncated: result.answerTruncated
        });
        result.completion = firstCompletion;

        // A provider token stop is not a successful complete answer. Make one
        // continuation request on the same provider, then stop regardless of
        // the second finish reason. Any continuation failure falls through the
        // normal provider fallback path instead of returning half an answer as
        // a normal success.
        if (
          this.config.autoContinueOnLength !== false &&
          this.shouldContinue(result, firstCompletion)
        ) {
          const continuation = await this.callWithRetry(provider, {
            ...request,
            prompt: buildContinuationPrompt(trimmed, result.answer)
          }, input.clientSignal);
          const validatedContinuation = validateResult(
            continuation,
            this.config.answerValidatorOptions
          );
          if (validatedContinuation.provider !== providerId) {
            throw new AiGatewayError(
              "AI_PROVIDER_UNAVAILABLE",
              "AI 服務目前暫時無法使用，請稍後再試。",
              {
                internalMessage: `continuation provider identity mismatch: expected ${providerId}`,
                failedProvider: providerId,
                retryable: false
              }
            );
          }
          const mergedAnswer = mergeContinuation(result.answer, validatedContinuation.answer);
          const firstInputTokens = result.inputTokens ?? inputTokens;
          const secondInputTokens = validatedContinuation.inputTokens ?? 0;
          const firstOutputTokens = result.outputTokens ?? estimateTokens(result.answer);
          const secondOutputTokens =
            validatedContinuation.outputTokens ?? estimateTokens(validatedContinuation.answer);
            const continuationDiagnostics: AiGenerationDiagnostics = {
            ...(validatedContinuation.diagnostics ?? result.diagnostics ?? {
              transport: "json",
              requestDurationMs: validatedContinuation.latencyMs,
              streamEndedNormally: true,
              lastChunk: null
            }),
            promptTokens: firstInputTokens + secondInputTokens,
            completionTokens: firstOutputTokens + secondOutputTokens,
            configuredMaxOutputTokens: effectiveMaxOutputTokens,
            finishReason: validatedContinuation.finishReason ?? null,
            initialFinishReason: result.finishReason ?? null,
            requestDurationMs: result.latencyMs + validatedContinuation.latencyMs,
            continuationAttempts: 1,
            continuationCompleted: true,
            failureKind: "token_length"
            };
          result = {
            ...result,
            answer: mergedAnswer,
            inputTokens: firstInputTokens + secondInputTokens,
            outputTokens: firstOutputTokens + secondOutputTokens,
            cachedInputTokens: (result.cachedInputTokens ?? 0) + (validatedContinuation.cachedInputTokens ?? 0),
            thinkingTokens: (result.thinkingTokens ?? 0) + (validatedContinuation.thinkingTokens ?? 0),
            totalTokens:
              (result.totalTokens ?? firstInputTokens + firstOutputTokens + (result.thinkingTokens ?? 0)) +
              (validatedContinuation.totalTokens ?? secondInputTokens + secondOutputTokens + (validatedContinuation.thinkingTokens ?? 0)),
            latencyMs: result.latencyMs + validatedContinuation.latencyMs,
            finishReason: validatedContinuation.finishReason,
            answerTruncated: Boolean(result.answerTruncated || validatedContinuation.answerTruncated),
            diagnostics: continuationDiagnostics
          };
          result.completion = assessAnswerCompleteness(trimmed, result.answer, {
            finishReason: result.finishReason,
            streamEndedNormally: result.diagnostics?.streamEndedNormally,
            answerTruncated: result.answerTruncated
          });
        }

        result.diagnostics = {
          ...(result.diagnostics ?? {
            transport: "json",
            requestDurationMs: result.latencyMs,
            streamEndedNormally: true,
            lastChunk: null
          }),
          promptTokens: result.inputTokens ?? inputTokens,
          completionTokens: result.outputTokens ?? estimateTokens(result.answer),
          configuredMaxOutputTokens: effectiveMaxOutputTokens,
          finishReason: result.finishReason ?? null,
          failureKind:
            result.diagnostics?.failureKind ??
            (result.answerTruncated || ["length", "max_tokens", "token_limit"].includes(result.finishReason?.trim().toLowerCase() ?? "")
              ? "token_length"
              : undefined)
        };
        result.diagnostics.provider = result.provider;
        result.diagnostics.model = result.model;

        // Recompute actual cost from observed usage (spec §6).
        const settledInputTokens = result.inputTokens ?? inputTokens;
        const settledOutputTokens = result.outputTokens ?? estimatedOutputTokens;
        const settledCachedInputTokens = result.cachedInputTokens ?? 0;
        const settledThinkingTokens = result.thinkingTokens ?? 0;
        // totalTokens = provider-reported total OR input + output + thinking.
        // The provider total (e.g. Gemini totalTokenCount) already includes
        // thinking; our fallback explicitly adds thinking so the accounting
        // is consistent regardless of provider support (spec §4.1).
        const settledTotalTokens = result.totalTokens ?? settledInputTokens + settledOutputTokens + settledThinkingTokens;

        // Capture the immutable pricing snapshot at request time, preferring the
        // DB-backed config from the credential provider when available (spec §5.1,
        // §5.3). When the credential provider does not supply a config row, the
        // seed/fallback table in pricing.ts is used instead.
        const snapshot = pricingSnapshotFor(result.provider, result.model, result.pricingConfig);
        const { pricing, cost } = computeCostBreakdown(
          result.provider,
          result.model,
          {
            promptTokens: settledInputTokens,
            cachedInputTokens: settledCachedInputTokens,
            candidatesTokens: settledOutputTokens,
            thinkingTokens: settledThinkingTokens
          },
          result.pricingConfig
        );
        const actualCostMicroUsd = cost.totalCostMicroUsd;
        const pricingSource =
          result.usageSource === "provider_response" ? pricing.pricingSource : "system_estimated";
        result = {
          ...result,
          estimatedCostMicroUsd:
            result.estimatedCostMicroUsd ?? estimatedCostMicroUsd,
          actualCostMicroUsd,
          costBreakdown: cost,
          pricingSource,
          pricingVersion: snapshot.pricingVersion,
          // keep cost conservative: use max(estimate, actual-derived)
        };
        if (actualCostMicroUsd > (result.estimatedCostMicroUsd ?? 0)) {
          result.estimatedCostMicroUsd = actualCostMicroUsd;
        }

        // Record usage post-call.
        const usageInput: BudgetRecordInput = {
          provider: result.provider,
          model: result.model,
          inputTokens: settledInputTokens,
          outputTokens: settledOutputTokens,
          totalTokens: settledTotalTokens,
          estimatedCostMicroUsd: result.estimatedCostMicroUsd ?? estimatedCostMicroUsd,
          actualCostMicroUsd,
          scopeType: requestSource,
          scopeKey
        };
        if (activeReservation && this.budget.settleReservation) {
          await this.budget.settleReservation(activeReservation, usageInput);
          activeReservation = undefined;
        } else {
          await this.budget.recordUsage(usageInput);
        }

        break; // success
      } catch (err) {
        if (activeReservation && this.budget.releaseReservation) {
          await this.budget.releaseReservation(activeReservation).catch(() => undefined);
          activeReservation = undefined;
        }
        // A provider may have produced a first segment before its required
        // continuation failed. Never let that stale partial result escape as
        // a success while the chain moves to a fallback provider.
        result = null;
        lastError = err;
        markFailed(providerId, err instanceof AiGatewayError ? err.fallbackReason : "provider_request_failed");
        if (err instanceof AiGatewayError && err.failureKind === "client_abort") {
          // A caller cancellation is not a provider failure. Do not spend a
          // fallback request after the browser has gone away.
          break;
        }
        const isLast = i === chain.length - 1;
        if (err instanceof AiGatewayError && err.code === "AI_BUDGET_EXCEEDED" && !isLast) {
          // Budget rejection for this provider — try a cheaper fallback.
          continue;
        }
        if (isLast) break;
        // otherwise fall through to next provider
      }
    }

    const completedAtMs = Date.now();
    const latencyMs = completedAtMs - startedAtMs;
    // A deliberately configured mock-only gateway is normal success; Mock is
    // labelled as fallback only when a formal candidate was skipped/failed.
    const fallbackUsed = failedProviders.length > 0 && result !== null;
    if (fallbackUsed && !fallbackReason && result?.provider === "mock") {
      fallbackReason = "provider_request_failed";
    }

    // 4. Handle total failure ----------------------------------------------
    if (!result) {
      const code = lastError instanceof AiGatewayError ? lastError.code : "AI_PROVIDER_UNAVAILABLE";
      const publicMessage =
        code === "AI_BUDGET_EXCEEDED"
          ? "今日 AI 額度已達上限，請稍後再試。"
          : "AI 服務目前暫時無法使用，請稍後再試。";
      const status: GatewayLogEntry["status"] =
        code === "AI_BUDGET_EXCEEDED" ? "rejected" : "failed";

      const logEntry: GatewayLogEntry = {
        requestId,
        visitorId: input.visitorId,
        visitorIpHash: input.visitorIpHash,
        requestSource,
        question: loggedQuestion,
        questionLength: trimmed.length,
        decision,
        providerAttempts,
        status,
        errorCode: code,
        failedProviders,
        startedAt: startedAtIso,
        completedAt: nowIso(),
        latencyMs,
        diagnostics: {
          provider: failedProviders[failedProviders.length - 1],
          model: failedProviders.length > 0
            ? this.config.providers.get(failedProviders[failedProviders.length - 1])?.defaultModel
            : decision.preferredModel,
          transport: "json",
          promptTokens: estimateTokens(input.systemPrompt ?? "") + estimateTokens(trimmed),
          completionTokens: 0,
          configuredMaxOutputTokens: this.config.maxOutputTokens,
          finishReason: null,
          requestDurationMs: latencyMs,
          streamEndedNormally: false,
          gatewayTimeout: lastError instanceof AiGatewayError && lastError.failureKind === "gateway_timeout",
          providerTimeout: lastError instanceof AiGatewayError && lastError.failureKind === "provider_timeout",
          clientAborted: lastError instanceof AiGatewayError && lastError.failureKind === "client_abort",
          failureKind: lastError instanceof AiGatewayError ? lastError.failureKind : "unknown",
          fallbackReason,
          lastChunk: null
        },
        estimatedCostMicroUsd: 0
      };
      await this.logger.log(logEntry);

      throw new AiGatewayError(code, publicMessage, {
        cause: lastError,
        failedProvider: failedProviders[failedProviders.length - 1],
        failureKind: lastError instanceof AiGatewayError ? lastError.failureKind : "unknown",
        fallbackReason
      });
    }

    // 5. Success log --------------------------------------------------------
    const logEntry: GatewayLogEntry = {
      requestId,
      visitorId: input.visitorId,
      visitorIpHash: input.visitorIpHash,
      requestSource,
      question: loggedQuestion,
      questionLength: trimmed.length,
      decision,
      providerAttempts,
      status: fallbackUsed ? "fallback" : "success",
      failedProviders: fallbackUsed ? failedProviders : undefined,
      startedAt: startedAtIso,
      completedAt: nowIso(),
      latencyMs,
      diagnostics: result.diagnostics
        ? { ...result.diagnostics, fallbackTriggered: fallbackUsed, fallbackReason }
        : undefined,
      fallbackReason,
      result,
      estimatedCostMicroUsd: result.estimatedCostMicroUsd ?? 0
    };
    await this.logger.log(logEntry);

    return { result, decision, fallbackUsed, failedProviders, fallbackReason };
  }

  private shouldContinue(
    result: AiGenerateResult,
    completion: ReturnType<typeof assessAnswerCompleteness>
  ): boolean {
    const finishReason = result.finishReason?.trim().toLowerCase();
    if (finishReason === "length" || finishReason === "max_tokens" || finishReason === "token_limit") {
      return true;
    }
    if (result.answerTruncated) return true;
    if (result.diagnostics?.streamEndedNormally === false) return true;
    if (completion.reasons.includes("unclosed_code_fence")) return true;
    // A provider can occasionally report stop after answering only the first
    // part of a numbered question. One bounded continuation also repairs that
    // case, but only when there is enough output to be meaningful; short normal
    // answers are never retried merely for being short.
    return completion.reasons.includes("missing_requested_items") && result.answer.trim().length >= 120;
  }

  /** Dedupe a candidate list preserving order, then keep only available ids. */
  private dedupeFilter(candidates: AiProviderId[], available: AiProviderId[]): AiProviderId[] {
    const availableSet = new Set(available);
    const seen = new Set<AiProviderId>();
    const out: AiProviderId[] = [];
    for (const id of candidates) {
      if (seen.has(id)) continue;
      seen.add(id);
      if (id === "mock" && this.config.allowMockFallback === false) continue;
      if (availableSet.has(id)) out.push(id);
    }
    return out;
  }

  /** Call a provider with timeout + bounded retry. */
  private async callWithRetry(
    provider: GatewayAiProvider,
    request: AiGenerateRequest,
    clientSignal?: AbortSignal
  ): Promise<AiGenerateResult> {
    let lastError: unknown = null;
    const attempts = Math.max(1, this.config.maxRetries + 1);
    for (let attempt = 0; attempt < attempts; attempt++) {
      const controller = new AbortController();
      let rejectGatewayTimeout: (() => void) | undefined;
      const gatewayTimeout = new Promise<never>((_, reject) => {
        rejectGatewayTimeout = () => reject(new AiGatewayError(
          "AI_PROVIDER_UNAVAILABLE",
          "AI 服務目前暫時無法使用，請稍後再試。",
          {
            internalMessage: `provider ${provider.providerId} timed out after ${this.config.requestTimeoutMs}ms`,
            failedProvider: provider.providerId,
            retryable: true,
            failureKind: "gateway_timeout"
          }
        ));
      });
      const timer = setTimeout(() => {
        rejectGatewayTimeout?.();
        controller.abort();
      }, this.config.requestTimeoutMs);
      let onClientAbort: (() => void) | undefined;
      try {
        if (clientSignal?.aborted) {
          throw new AiGatewayError(
            "AI_INTERNAL",
            "AI 服務目前暫時無法使用，請稍後再試。",
            {
              internalMessage: "client aborted AI request",
              failedProvider: provider.providerId,
              retryable: false,
              failureKind: "client_abort"
            }
          );
        }
        // Providers read the AbortSignal from a per-request context; we emulate
        // the timeout here by racing against the timer so even providers that
        // ignore signals cannot hang the gateway (spec §13.9).
        const clientAbort = clientSignal
          ? new Promise<never>((_, reject) => {
              onClientAbort = () => {
                controller.abort();
                reject(new AiGatewayError(
                  "AI_INTERNAL",
                  "AI 服務目前暫時無法使用，請稍後再試。",
                  {
                    internalMessage: "client aborted AI request",
                    failedProvider: provider.providerId,
                    retryable: false,
                    failureKind: "client_abort"
                  }
                ));
              };
              clientSignal.addEventListener("abort", onClientAbort, { once: true });
            })
          : null;
        const result = await Promise.race([
          provider.generate({ ...request, signal: controller.signal }),
          gatewayTimeout,
          ...(clientAbort ? [clientAbort] : [])
        ]);
        clearTimeout(timer);
        if (clientSignal && onClientAbort) clientSignal.removeEventListener("abort", onClientAbort);
        return result;
      } catch (err) {
        clearTimeout(timer);
        if (clientSignal && onClientAbort) clientSignal.removeEventListener("abort", onClientAbort);
        lastError = err;
        // Retry only transient/retryable errors; auth, validation and other
        // permanent failures move directly to the next fallback provider.
        if (!isRetryable(err)) throw err;
        if (attempt === attempts - 1) break;
      }
    }
    throw lastError ?? new Error("provider call failed with no error captured");
  }
}
