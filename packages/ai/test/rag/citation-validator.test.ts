import { describe, expect, it } from "vitest";
import { validateCitations } from "../../src/rag/server";
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
