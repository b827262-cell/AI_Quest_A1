import { describe, expect, it } from "vitest";
import { hashEvidenceSpan, validateCitations } from "../../src/rag/server";
import type { RetrievedChunk } from "../../src/rag/server";

const chunks: RetrievedChunk[] = [
  { id: "chunk-1", label: "Chapter 1", content: "abcdef" },
  { id: "chunk-2", label: "Chapter 2", content: "second chunk" }
];

describe("RAG citation validator", () => {
  it.each([
    [[], "missing"],
    [{ chunkId: "chunk-1", label: "Chapter 1" }, "format_error"],
    [[{ chunkId: "unknown", label: "Unknown" }], "unknown_chunk"],
    [[{ chunkId: "chunk-1", label: "Not Chapter 1" }], "format_error"],
    [[{ chunkId: "chunk-1", label: "Chapter 1", start: 2, end: 99 }], "out_of_bounds"],
    [[{ chunkId: "chunk-1", label: "Chapter 1" }, { chunkId: "chunk-1", label: "Chapter 1" }], "duplicate"],
    [[{ chunkId: "chunk-1", label: "Chapter 1", start: 4 }], "format_error"]
  ])("rejects %s as %s", (value, code) => {
    expect(validateCitations(value, chunks)).toEqual({ valid: false, code });
  });

  it("accepts only a known, bounded chunk citation", () => {
    expect(validateCitations([{ chunkId: "chunk-1", label: "Chapter 1", start: 1, end: 4 }], chunks))
      .toEqual({ valid: true, citations: [{ chunkId: "chunk-1", label: "Chapter 1", start: 1, end: 4, locator: undefined }] });
  });
});

describe("RAG citation evidence integrity (tamper = hard fail)", () => {
  const evidenceChunk: RetrievedChunk[] = [
    { id: "ec-1", label: "Evidence", content: "The speed of light is 299792458 m/s." }
  ];

  it("accepts a citation with a correct evidence quote and matching hash", () => {
    const quote = "The speed of light is 299792458 m/s.";
    const hash = hashEvidenceSpan(quote);
    const result = validateCitations([{
      chunkId: "ec-1", label: "Evidence",
      evidenceQuote: quote, contentHash: hash, hashAlgorithm: "sha256"
    }], evidenceChunk);
    expect(result.valid).toBe(true);
  });

  it("rejects a fabricated evidence quote that is not a chunk substring (quote mismatch)", () => {
    const result = validateCitations([{
      chunkId: "ec-1", label: "Evidence",
      evidenceQuote: "THIS_DOES_NOT_APPEAR_ANYWHERE"
    }], evidenceChunk);
    expect(result).toEqual({ valid: false, code: "evidence_quote_mismatch" });
  });

  it("rejects a tampered content hash that does not match the span (hash mismatch)", () => {
    const result = validateCitations([{
      chunkId: "ec-1", label: "Evidence", start: 0, end: 10,
      contentHash: "a".repeat(64), hashAlgorithm: "sha256"
    }], evidenceChunk);
    expect(result).toEqual({ valid: false, code: "evidence_hash_mismatch" });
  });

  it("rejects when start/end span hash disagrees with evidence quote hash (span mismatch)", () => {
    const quote = "The speed of light is 299792458 m/s.";
    const result = validateCitations([{
      chunkId: "ec-1", label: "Evidence", start: 0, end: 10,
      evidenceQuote: quote,
      contentHash: hashEvidenceSpan(quote),
      hashAlgorithm: "sha256"
    }], evidenceChunk);
    expect(result).toEqual({ valid: false, code: "evidence_span_mismatch" });
  });

  it("rejects a malformed content hash (format_error, not a soft gap)", () => {
    const result = validateCitations([{
      chunkId: "ec-1", label: "Evidence",
      contentHash: "not-a-real-hash"
    }], evidenceChunk);
    expect(result.valid).toBe(false);
  });
});
