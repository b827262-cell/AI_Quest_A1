import { describe, expect, it } from "vitest";
import { ragErrorResponseSchema, ragRequestSchema, ragResponseSchema } from "../../src/rag";

describe("RAG public contracts", () => {
  it("validates request, response and safe error exports", () => {
    expect(ragRequestSchema.safeParse({ contractVersion: 1, requestId: "r", query: "question" }).success).toBe(true);
    expect(ragResponseSchema.safeParse({
      contractVersion: 1,
      requestId: "r",
      answer: "answer",
      citations: [],
      confidence: "low",
      grounding: "abstained",
      citationStatus: "not_checked",
      abstained: true,
      abstentionReason: "NO_EVIDENCE"
    }).success).toBe(true);
    expect(ragErrorResponseSchema.safeParse({
      contractVersion: 1,
      requestId: "r",
      error: { code: "RAG_PROVIDER_TIMEOUT", message: "The AI provider timed out. Please try again.", retryable: true }
    }).success).toBe(true);
  });

  it("rejects unknown contract versions and malformed public fields", () => {
    expect(ragRequestSchema.safeParse({ contractVersion: 2, requestId: "r", query: "question" }).success).toBe(false);
    expect(ragResponseSchema.safeParse({ contractVersion: 1, requestId: "r", answer: "", citations: "not-array" }).success).toBe(false);
    expect(ragResponseSchema.safeParse({
      contractVersion: 1,
      requestId: "r",
      answer: "answer",
      citations: [{ chunkId: "c", label: "C", apiKey: "should-not-cross-the-contract" }],
      confidence: "low",
      grounding: "unverified",
      citationStatus: "not_checked",
      abstained: false
    }).success).toBe(false);
  });
});
