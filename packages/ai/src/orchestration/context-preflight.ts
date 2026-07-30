/**
 * Context Window Preflight (limit dimension 4: single-request capacity).
 *
 * This is an INDEPENDENT limit from the daily Token Pool (dimension 1) and the
 * model daily cap (dimension 3). The daily pool governs aggregate daily usage;
 * the Context Window governs whether a single request fits in the model's
 * context window at all. A request must pass BOTH.
 *
 * Per the spec (Claude/Anthropic convention): Usage Limit and Length Limit are
 * managed separately. This module only handles Length (Context Window). It does
 * NOT touch daily quota, RPM/TPM, or any rate-limit header.
 */

export type ContextPreflightStrategy = "reject" | "summarize" | "truncate";

export interface ContextPreflightInput {
  /** Estimated input tokens (system + prompt). */
  estimatedInputTokens: number;
  /** Reserved output tokens for the request (logical model's maxOutputTokens). */
  reservedOutputTokens: number;
  /** Reserved thinking/reasoning budget (0 when supportsThinking is false). */
  reservedThinkingTokens: number;
  /** Total context window of the model. */
  contextWindowTokens: number;
  /** Optional stricter input cap (must be <= contextWindowTokens). */
  maxInputTokens?: number | null;
}

export interface ContextPreflightResult {
  ok: boolean;
  reason?: "context_window_exceeded" | "max_input_exceeded";
  /** input + output + thinking token requirement. */
  totalRequired: number;
  contextWindowTokens: number;
  /** contextWindowTokens - totalRequired (negative when exceeded). */
  headroom: number;
}

/**
 * Estimate token count from text. Uses chars/3 as a blend for mixed CJK + latin
 * content (the same heuristic as the rule-based router). This is an ESTIMATE,
 * not a real tokenizer — providers that report actual token counts will settle
 * the authoritative numbers after the call.
 *
 * Note: the gateway's own `estimateTokens` uses 1 char/token deliberately as a
 * pessimistic reservation upper bound; that is appropriate for daily-budget
 * reservation but NOT for context-window preflight, where we want the realistic
 * estimate so we do not reject requests that would actually fit.
 */
export function estimateTokenCount(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 3));
}

/**
 * Check whether a request fits in the model's context window.
 *
 * Formula (spec):
 *   estimatedInputTokens + reservedOutputTokens + reservedThinkingTokens <= contextWindowTokens
 *
 * When maxInputTokens is set (stricter than contextWindowTokens), input alone
 * is checked against it first, producing `max_input_exceeded`.
 */
export function checkContextWindow(input: ContextPreflightInput): ContextPreflightResult {
  const total =
    input.estimatedInputTokens + input.reservedOutputTokens + input.reservedThinkingTokens;
  const headroom = input.contextWindowTokens - total;

  const inputCap = input.maxInputTokens ?? input.contextWindowTokens;
  if (input.estimatedInputTokens > inputCap) {
    return {
      ok: false,
      reason: "max_input_exceeded",
      totalRequired: total,
      contextWindowTokens: input.contextWindowTokens,
      headroom
    };
  }
  if (total > input.contextWindowTokens) {
    return {
      ok: false,
      reason: "context_window_exceeded",
      totalRequired: total,
      contextWindowTokens: input.contextWindowTokens,
      headroom
    };
  }
  return {
    ok: true,
    totalRequired: total,
    contextWindowTokens: input.contextWindowTokens,
    headroom
  };
}

/**
 * Compute a reduced output budget that would make a request fit the context
 * window, when only the output side is over (input fits but input+output does
 * not). Returns 0 when even a minimal output cannot fit (caller must reject).
 */
export function reducedOutputBudget(input: ContextPreflightInput): number {
  const remaining =
    input.contextWindowTokens - input.estimatedInputTokens - input.reservedThinkingTokens;
  return Math.max(0, remaining);
}
