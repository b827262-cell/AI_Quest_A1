import type {
  AiFallbackReason,
  AiGenerateRequest,
  AiGenerateResult,
  AiProviderId
} from "./ai-types";

/**
 * Gateway-facing provider contract. Every provider (mock + real) implements
 * this surface so the gateway never depends on a vendor SDK (spec §13.12).
 *
 * Unlike the legacy `AiProvider.generateText → string`, this returns a full
 * `AiGenerateResult` with token usage, latency and cost so the budget manager
 * and prompt logger can record them.
 */
export interface GatewayAiProvider {
  /** Stable identifier used in routing rules and logs. */
  readonly providerId: AiProviderId;

  /** Default model name used when the request does not override it. */
  readonly defaultModel: string;

  /** Managed providers resolve a credential's default model at call time. */
  readonly resolveModelAtCallTime?: boolean;

  /** Optional safe availability detail used for fallback diagnostics. */
  diagnoseAvailability?(requestedModel?: string): Promise<{
    available: boolean;
    model?: string;
    reason?: AiFallbackReason;
  }>;

  /**
   * Whether this provider can serve requests right now. Real providers return
   * false when their API key is unset, so the server still boots key-less
   * (spec §13.2, §13.3). Mock is always available.
   */
  isAvailable(): Promise<boolean>;

  /**
   * Generate an answer. Implementations MUST:
   *  - enforce a timeout (AbortController) so a hung upstream cannot stall the
   *    gateway (spec §13.9),
   *  - return provider-agnostic types only,
   *  - throw `AiGatewayError` on failure so the gateway can classify + fallback.
   */
  generate(request: AiGenerateRequest): Promise<AiGenerateResult>;
}
