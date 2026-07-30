/**
 * Explicit allowlist mapping for ai_request_logs.diagnostics_json.
 *
 * Only vetted, non-sensitive operational fields may be persisted as
 * diagnostics. This function never spreads its input ({...obj}); it copies a
 * fixed set of keys and drops everything else, so future provider adapters
 * that add fields cannot accidentally leak them into the diagnostics log.
 *
 * Forbidden in diagnostics (enforced by the allowlist): API keys, auth
 * headers, cookies, full prompt/question/answer, full provider response, full
 * error objects, stack traces, credential material, recovery tokens / digests,
 * raw IP, IP HMAC, full user agent.
 */

export type AiErrorCategory =
  | "provider_timeout"
  | "gateway_timeout"
  | "client_abort"
  | "rate_limited"
  | "provider_auth"
  | "provider_5xx"
  | "invalid_response"
  | "token_limit"
  | "persistence_failure"
  // Context Window preflight rejection (dimension 4): input too large for the
  // model's single-request window. Distinct from "token_limit" which is a
  // post-hoc output-truncation signal from the provider.
  | "context_window";

/** Whitelisted diagnostic field names. Keep in sync with tests. */
const ALLOWED_KEYS = [
  "provider",
  "model",
  "finishReason",
  "promptTokens",
  "completionTokens",
  "configuredMaxOutputTokens",
  "durationMs",
  "providerTimeout",
  "gatewayTimeout",
  "clientAborted",
  "streamStarted",
  "streamCompleted",
  "fallbackUsed",
  "continuationAttempted",
  "continuationCompleted",
  "answerComplete",
  "errorCategory",
  "fallbackReason",
  "httpStatusClass",
  // Context Window preflight provenance (token counts only; never prompt text).
  "contextWindowExceeded",
  "contextWindowTotalRequired"
] as const;

type AllowedKey = (typeof ALLOWED_KEYS)[number];

export type SafeAiDiagnostics = Partial<Record<AllowedKey, string | number | boolean | null>>;

/**
 * Map an arbitrary runtime diagnostics object (which may carry sensitive
 * provider response/error fields) down to the vetted allowlist shape.
 * Unknown keys are silently dropped.
 */
export function toSafeAiDiagnostics(input: unknown): SafeAiDiagnostics {
  const out: SafeAiDiagnostics = {};
  if (!input || typeof input !== "object") return out;
  const obj = input as Record<string, unknown>;
  for (const key of ALLOWED_KEYS) {
    if (!(key in obj)) continue;
    const v = obj[key];
    // Only persist primitive, non-sensitive values. Objects/arrays (e.g. a
    // stray headers object) are dropped entirely.
    if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      out[key] = v;
    }
  }
  return out;
}

/**
 * Map a provider failure kind to the internal errorCategory enum used in
 * diagnostics. Unknown kinds map to undefined (omitted) rather than a default.
 */
export function errorCategoryFromFailureKind(failureKind: string | undefined): AiErrorCategory | undefined {
  switch (failureKind) {
    case "provider_timeout":
      return "provider_timeout";
    case "gateway_timeout":
      return "gateway_timeout";
    case "client_abort":
      return "client_abort";
    case "provider_rate_limit":
      return "rate_limited";
    case "provider_auth":
      return "provider_auth";
    case "provider_server_error":
      return "provider_5xx";
    case "stream_format":
      return "invalid_response";
    case "token_length":
      return "token_limit";
    case "answer_save":
      return "persistence_failure";
    default:
      return undefined;
  }
}
