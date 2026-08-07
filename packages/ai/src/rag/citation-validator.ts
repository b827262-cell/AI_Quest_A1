import type { RagCitation } from "./contracts";
import type { RetrievedChunk } from "./ports";
import { hashEvidenceSpan, verifyEvidenceHash } from "./evidence-hash";

export type CitationFailureCode =
  | "missing"
  | "format_error"
  | "unknown_chunk"
  | "out_of_bounds"
  | "duplicate"
  | "evidence_quote_mismatch"
  | "evidence_hash_mismatch"
  | "evidence_span_mismatch";

export type CitationValidationResult =
  | { valid: true; citations: RagCitation[] }
  | { valid: false; code: CitationFailureCode };

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * Validate provider citations against the exact retrieved chunk set.
 *
 * Two classes of failure:
 *   - Structural (missing/format/unknown/duplicate/out_of_bounds): the
 *     citation coordinates are invalid relative to the retrieved set.
 *   - Integrity (evidence_quote_mismatch / evidence_hash_mismatch /
 *     evidence_span_mismatch): the evidence quote or hash does not match the
 *     actual chunk content. This is treated as a tampering attack and fails
 *     closed just like a structural failure — it is NOT a soft grounding gap.
 *
 * The server re-derives hashes from the canonicalized chunk span and never
 * trusts a model-supplied hash; a mismatch is always rejected.
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

    // Evidence integrity: if a quote/hash is present it must match the chunk.
    const hasEvidenceQuote = object.evidenceQuote !== undefined;
    const hasContentHash = object.contentHash !== undefined;
    if (hasEvidenceQuote) {
      if (typeof object.evidenceQuote !== "string" || object.evidenceQuote.trim().length === 0
        || object.evidenceQuote.length > 800) {
        return { valid: false, code: "format_error" };
      }
      // The quote must be an actual substring of the cited chunk content
      // (after canonicalization). A fabricated/altered quote is tampering.
      const canonicalChunk = chunk.content.normalize("NFC");
      if (!canonicalChunk.includes(object.evidenceQuote.normalize("NFC"))) {
        return { valid: false, code: "evidence_quote_mismatch" };
      }
    }
    if (hasContentHash) {
      if (typeof object.contentHash !== "string" || !/^[a-f0-9]{64}$/.test(object.contentHash)) {
        return { valid: false, code: "format_error" };
      }
      // Re-derive the hash from the evidence quote when present (the quote is
      // the user-visible anchor); otherwise from the [start,end) span; else
      // from the whole chunk. Any mismatch is a tampering failure.
      const hashSource = object.evidenceQuote !== undefined && typeof object.evidenceQuote === "string"
        ? object.evidenceQuote
        : (start !== undefined && end !== undefined
          ? chunk.content.slice(start, end)
          : chunk.content);
      if (!verifyEvidenceHash(hashSource, object.contentHash)) {
        return { valid: false, code: "evidence_hash_mismatch" };
      }
    }
    // When both start/end and a quote are present, they must agree: the
    // span at [start,end) must produce the same canonical hash as the quote.
    if (start !== undefined && end !== undefined && hasContentHash
      && hasEvidenceQuote && typeof object.evidenceQuote === "string") {
      const spanHash = hashEvidenceSpan(chunk.content.slice(start, end));
      const quoteHash = hashEvidenceSpan(object.evidenceQuote);
      if (spanHash !== quoteHash) {
        return { valid: false, code: "evidence_span_mismatch" };
      }
    }

    parsed.push({
      chunkId: object.chunkId,
      label: object.label.trim(),
      locator: object.locator as string | undefined,
      start: start as number | undefined,
      end: end as number | undefined,
      ...(hasEvidenceQuote && typeof object.evidenceQuote === "string" ? { evidenceQuote: object.evidenceQuote } : {}),
      ...(hasContentHash && typeof object.contentHash === "string" ? { contentHash: object.contentHash } : {}),
      ...(object.hashAlgorithm === "sha256" ? { hashAlgorithm: "sha256" as const } : {})
    });
  }
  return { valid: true, citations: parsed };
}

export function citationFailureReason(code: CitationFailureCode): string {
  return `CITATION_${code.toUpperCase()}`;
}
