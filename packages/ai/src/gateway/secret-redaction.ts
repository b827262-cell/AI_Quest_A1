/** Redact common credentials before text can enter a prompt/request log. */
export function redactSensitiveText(value: string, maxChars = 4_000): string {
  const bounded = value.slice(0, maxChars);
  return bounded
    .replace(/\b(?:sk|xai)-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED_SECRET]")
    .replace(/\bAIza[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_SECRET]")
    .replace(/\bAQ\.[A-Za-z0-9_-]{16,}\b/g, "[REDACTED_SECRET]")
    .replace(/(authorization\s*:\s*bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|token|secret)\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]");
}
