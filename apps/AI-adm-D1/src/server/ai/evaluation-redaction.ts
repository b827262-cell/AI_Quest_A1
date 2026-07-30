export type EvaluationSensitiveType =
  | "email"
  | "session_id"
  | "authorization"
  | "api_key"
  | "credential"
  | "workspace_path"
  | "provider_raw_error"
  | "unknown_secret";

export interface EvaluationRedactionResult {
  value: string;
  redacted: boolean;
  matchedTypes: EvaluationSensitiveType[];
}

const patterns: Array<{ type: EvaluationSensitiveType; pattern: RegExp; replacement: string }> = [
  { type: "authorization", pattern: /authorization\s*[:=]\s*bearer\s+[^\s,;]+/gi, replacement: "authorization: [REDACTED]" },
  { type: "api_key", pattern: /\b(?:sk|xai)-[A-Za-z0-9_-]{12,}\b|\bAIza[A-Za-z0-9_-]{20,}\b|\bAQ\.[A-Za-z0-9_-]{16,}\b/g, replacement: "[REDACTED_API_KEY]" },
  { type: "credential", pattern: /\b(?:api[_-]?key|credential(?:[_-]?secret|[_-]?id)?)\s*[:=]\s*[^\s,;]+/gi, replacement: "credential: [REDACTED]" },
  { type: "email", pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, replacement: "[REDACTED_EMAIL]" },
  { type: "session_id", pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, replacement: "[REDACTED_SESSION]" },
  { type: "workspace_path", pattern: /(?:^|\s)(?:\/(?:home|Users|private\/var|workspace)\/[^\s,;]+)/g, replacement: " [REDACTED_PATH]" }
];

/** Converts provider errors into a short allowlisted reason; never preserves raw bodies. */
export function safeEvaluationError(_error: unknown): string {
  return "evaluation_failed";
}

export function redactEvaluationText(input: string): EvaluationRedactionResult {
  let value = input.slice(0, 4000);
  const matched = new Set<EvaluationSensitiveType>();
  for (const entry of patterns) {
    entry.pattern.lastIndex = 0;
    if (entry.pattern.test(value)) {
      matched.add(entry.type);
      entry.pattern.lastIndex = 0;
      value = value.replace(entry.pattern, entry.replacement);
    }
  }
  return { value, redacted: matched.size > 0, matchedTypes: [...matched] };
}

export function safeEvaluationIssueSummary(message: string): string {
  const redacted = redactEvaluationText(message);
  return redacted.value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 240);
}
