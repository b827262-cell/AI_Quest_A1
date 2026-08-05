import type { RagCitation } from "./contracts";
import type { RetrievedChunk } from "./ports";

export type CitationFailureCode =
  | "missing"
  | "format_error"
  | "unknown_chunk"
  | "out_of_bounds"
  | "duplicate";

export type CitationValidationResult =
  | { valid: true; citations: RagCitation[] }
  | { valid: false; code: CitationFailureCode };

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * Validate provider citations against the exact retrieved chunk set.
 * Unknown, duplicate, malformed and out-of-range citations all fail closed.
 */
export function validateCitations(
  citations: unknown,
  retrievedChunks: readonly RetrievedChunk[]
): CitationValidationResult {
  if (!Array.isArray(citations)) return { valid: false, code: "format_error" };
  if (citations.length === 0) return { valid: false, code: "missing" };
  if (citations.length > 20) return { valid: false, code: "format_error" };

  const chunks = new Map(retrievedChunks.map((chunk) => [chunk.id, chunk]));
  const seen = new Set<string>();
  const parsed: RagCitation[] = [];

  for (const value of citations) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return { valid: false, code: "format_error" };
    const object = value as Record<string, unknown>;
    if (typeof object.chunkId !== "string" || !ID_PATTERN.test(object.chunkId)
      || typeof object.label !== "string" || object.label.trim().length === 0
      || object.label.length > 240) return { valid: false, code: "format_error" };
    const chunk = chunks.get(object.chunkId);
    if (!chunk) return { valid: false, code: "unknown_chunk" };
    if (seen.has(object.chunkId)) return { valid: false, code: "duplicate" };
    seen.add(object.chunkId);
    if (object.label.trim() !== chunk.label.trim()) return { valid: false, code: "format_error" };

    const hasStart = object.start !== undefined;
    const hasEnd = object.end !== undefined;
    if ((hasStart && (typeof object.start !== "number" || !Number.isInteger(object.start) || object.start < 0))
      || (hasEnd && (typeof object.end !== "number" || !Number.isInteger(object.end) || object.end < 0))) {
      return { valid: false, code: "format_error" };
    }
    if (hasStart !== hasEnd) return { valid: false, code: "format_error" };
    const start = hasStart ? object.start as number : undefined;
    const end = hasEnd ? object.end as number : undefined;
    if (start !== undefined && end !== undefined
      && (start >= end || end > chunk.content.length)) return { valid: false, code: "out_of_bounds" };
    if (object.locator !== undefined && (typeof object.locator !== "string" || object.locator.length > 240
      || object.locator !== chunk.locator)) {
      return { valid: false, code: "format_error" };
    }
    parsed.push({
      chunkId: object.chunkId,
      label: object.label.trim(),
      locator: object.locator as string | undefined,
      start: start as number | undefined,
      end: end as number | undefined
    });
  }
  return { valid: true, citations: parsed };
}

export function citationFailureReason(code: CitationFailureCode): string {
  return `CITATION_${code.toUpperCase()}`;
}
