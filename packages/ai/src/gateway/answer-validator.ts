import { AiGatewayError, type AiGenerateResult } from "./ai-types";

/**
 * Validate a provider answer before it is returned to the caller (spec §8).
 *
 * - must not be empty
 * - must not exceed the configured max length
 * - control characters are stripped (except common whitespace)
 * - must not look like a raw provider JSON envelope (leaked SDK output)
 * - must not contain obvious internal error / secret markers
 *
 * Throws `AiGatewayError(AI_ANSWER_INVALID)` on failure so the gateway can
 * trigger fallback.
 */

// 16k characters is still bounded, while avoiding a second application-level
// cutoff for a normal long-form guest answer. Provider output remains bounded
// by maxOutputTokens before this validator runs.
export const DEFAULT_MAX_ANSWER_CHARS = 16000;

/** Patterns that indicate a leaked raw response rather than a real answer. */
const RAW_JSON_HINTS: RegExp[] = [
  /^\s*[\[{]\s*"(choices|candidates|content|data|object|error)"\s*:/i,
  /^\s*\{\s*"message"\s*:\s*\{[^}]*"content"\s*:/i
];

/** Markers that must never leave the gateway. */
const SECRET_HINTS: RegExp[] = [
  /(?:sk|xai)-[A-Za-z0-9]{16,}/i, // Provider API keys
  /AIza[A-Za-z0-9_-]{30,}/, // Google-style keys
  /AQ\.[A-Za-z0-9_-]{16,}/, // Provider opaque key pattern; never used for validation.
  /api[_-]?key["'\s:=]+[A-Za-z0-9_-]{16,}/i,
  /authorization["'\s:=]+bearer\s+[A-Za-z0-9._-]+/i
];

const INTERNAL_ERROR_HINTS: RegExp[] = [
  /unauthorized|forbidden|invalid api key|rate limit exceeded|quota exceeded/i,
  /internal server error|stack trace|traceback|at\s+[\w.]+\s+\(.+:\d+:\d+\)/i,
  /<\/?(?:!doctype|html|head|body)\b/i,
  /^\s*\{\s*"error"\s*:/i
];

export type AnswerValidatorOptions = {
  maxChars?: number;
};

/** Strip control chars except \n \r \t. */
function stripControlChars(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

export type ValidatedAnswer = {
  answer: string;
  truncated: boolean;
};

/** Sanitise + validate; throws on unrecoverable problems. */
export function validateAnswer(
  raw: string,
  options: AnswerValidatorOptions = {}
): ValidatedAnswer {
  const maxChars = options.maxChars ?? DEFAULT_MAX_ANSWER_CHARS;

  if (typeof raw !== "string") {
    throw new AiGatewayError("AI_ANSWER_INVALID", "AI 服務目前暫時無法使用，請稍後再試。", {
      internalMessage: "provider returned an empty answer"
    });
  }

  // Strip controls before checking emptiness so control-only responses cannot
  // pass validation as an answer.
  let cleaned = stripControlChars(raw);
  if (cleaned.trim().length === 0) {
    throw new AiGatewayError("AI_ANSWER_INVALID", "AI 服務目前暫時無法使用，請稍後再試。", {
      internalMessage: "provider returned only whitespace or control characters"
    });
  }

  if (RAW_JSON_HINTS.some((re) => re.test(cleaned))) {
    throw new AiGatewayError("AI_ANSWER_INVALID", "AI 服務目前暫時無法使用，請稍後再試。", {
      internalMessage: "provider answer looks like a raw JSON envelope"
    });
  }

  if (SECRET_HINTS.some((re) => re.test(cleaned))) {
    throw new AiGatewayError("AI_ANSWER_INVALID", "AI 服務目前暫時無法使用，請稍後再試。", {
      internalMessage: "provider answer appears to contain a secret"
    });
  }

  if (INTERNAL_ERROR_HINTS.some((re) => re.test(cleaned))) {
    throw new AiGatewayError("AI_ANSWER_INVALID", "AI 服務目前暫時無法使用，請稍後再試。", {
      internalMessage: "provider answer contains internal error markers"
    });
  }

  let truncated = false;
  if (cleaned.length > maxChars) {
    cleaned = cleaned.slice(0, maxChars);
    truncated = true;
  }
  return { answer: cleaned, truncated };
}

/** Validate a full result in-place; returns a new result with sanitised text. */
export function validateResult(
  result: AiGenerateResult,
  options: AnswerValidatorOptions = {}
): AiGenerateResult {
  const { answer, truncated } = validateAnswer(result.answer, options);
  return { ...result, answer, answerTruncated: result.answerTruncated || truncated };
}
