import { describe, expect, it } from "vitest";
import {
  createRagHttpHandler,
  FakeLlmProvider,
  FakeRetriever,
  hashEvidenceSpan,
  parseRagResponse,
  RagApplicationService,
  type RetrievedChunk
} from "../../src/rag/server";
import type { RagClaimGrounding } from "../../src/rag/server";

/**
 * R-5 D/F — claim-evidence tamper matrix and contract property tests.
 *
 * Every integrity violation must fail closed through the citation boundary
 * (HTTP 502, RAG_CITATION_INVALID) with a deterministic reason code. No
 * silent drops, no clamping, no 200 + evidence: [] fallbacks. Every success
 * response must satisfy the client-verifiable invariants.
 */

const TEST_SCOPE = { studentId: "student-1", bookId: "book-1" } as const;

// The quote is deliberately NOT at offset 0 so span-tamper cases are
// distinguishable from the server-authoritative location.
const CHUNK_CONTENT = "Chapter 3 explains that photosynthesis converts sunlight into chemical energy inside chloroplasts.";
const QUOTE = "photosynthesis converts sunlight into chemical energy";
const QUOTE_START = CHUNK_CONTENT.indexOf(QUOTE);
const QUOTE_END = QUOTE_START + QUOTE.length;

const chunks: RetrievedChunk[] = [
  { id: "chunk-1", label: "Chapter 3", locator: "p.12", content: CHUNK_CONTENT },
  { id: "chunk-2", label: "Chapter 4", locator: "p.13", content: "Cellular respiration releases energy from glucose in mitochondria." }
];

const ANSWER = QUOTE;

type EvidenceOverride = Partial<{ quote: string; contentHash: string; hashAlgorithm: "sha256"; chunkId: string; start: number; end: number }>;

function modelResponse(evidence: EvidenceOverride[] | "omit", citationChunkIds: string[] = ["chunk-1"], answer = ANSWER) {
  const claimText = answer;
  const evidenceArray = evidence === "omit"
    ? [{ quote: QUOTE, chunkId: "chunk-1", start: QUOTE_START, end: QUOTE_END }]
    : evidence.map((ev) => ({
        quote: QUOTE,
        chunkId: "chunk-1",
        start: QUOTE_START,
        end: QUOTE_END,
        ...ev
      }));
  const claims: RagClaimGrounding[] = [{
    claimId: "claim-tamper",
    text: claimText,
    answerStart: 0,
    answerEnd: claimText.length,
    status: "supported",
    citationChunkIds,
    evidence: evidenceArray as RagClaimGrounding["evidence"]
  }];
  return {
    answer,
    citations: [{ chunkId: "chunk-1", label: "Chapter 3", locator: "p.12" }],
    claims,
    confidence: "high" as const
  };
}

function appWith(evidence: EvidenceOverride[] | "omit", options: { citationChunkIds?: string[]; answer?: string } = {}) {
  return new RagApplicationService({
    retriever: new FakeRetriever(chunks),
    provider: new FakeLlmProvider({ response: modelResponse(evidence, options.citationChunkIds ?? ["chunk-1"], options.answer ?? ANSWER) })
  });
}

async function expectTamperFailure(promise: Promise<unknown>, reasonCode: string) {
  await expect(promise).rejects.toMatchObject({ code: "RAG_CITATION_INVALID", reasonCode });
}

describe("R-2/R-5 D — claim evidence tamper matrix fails closed", () => {
  it("wrong quote (not a chunk substring) fails closed", async () => {
    const application = appWith([{ quote: "THIS_QUOTE_DOES_NOT_EXIST_IN_CHUNK" }]);
    await expectTamperFailure(
      application.answer({ query: "q", requestId: "tamper-quote", topK: 5, maxOutputTokens: 100, scope: TEST_SCOPE }),
      "CLAIM_EVIDENCE_QUOTE_MISMATCH"
    );
  });

  it("modified quote (single character altered) fails closed", async () => {
    const application = appWith([{ quote: QUOTE.replace("sunlight", "moonlight") }]);
    await expectTamperFailure(
      application.answer({ query: "q", requestId: "tamper-quote-mod", topK: 5, maxOutputTokens: 100, scope: TEST_SCOPE }),
      "CLAIM_EVIDENCE_QUOTE_MISMATCH"
    );
  });

  it("wrong contentHash fails closed", async () => {
    const application = appWith([{ contentHash: "f".repeat(64) }]);
    await expectTamperFailure(
      application.answer({ query: "q", requestId: "tamper-hash", topK: 5, maxOutputTokens: 100, scope: TEST_SCOPE }),
      "CLAIM_EVIDENCE_HASH_MISMATCH"
    );
  });

  it("wrong start (shifted forward) fails closed and is never clamped", async () => {
    const application = appWith([{ start: QUOTE_START + 3 }]);
    await expectTamperFailure(
      application.answer({ query: "q", requestId: "tamper-start", topK: 5, maxOutputTokens: 100, scope: TEST_SCOPE }),
      "CLAIM_EVIDENCE_SPAN_MISMATCH"
    );
  });

  it("wrong end (truncated) fails closed and is never clamped", async () => {
    const application = appWith([{ end: QUOTE_END - 2 }]);
    await expectTamperFailure(
      application.answer({ query: "q", requestId: "tamper-end", topK: 5, maxOutputTokens: 100, scope: TEST_SCOPE }),
      "CLAIM_EVIDENCE_SPAN_MISMATCH"
    );
  });

  it("out-of-range start fails closed", async () => {
    const application = appWith([{ start: CHUNK_CONTENT.length + 100, end: CHUNK_CONTENT.length + 100 + QUOTE.length }]);
    await expectTamperFailure(
      application.answer({ query: "q", requestId: "tamper-start-oob", topK: 5, maxOutputTokens: 100, scope: TEST_SCOPE }),
      "CLAIM_EVIDENCE_SPAN_MISMATCH"
    );
  });

  it("out-of-range end fails closed", async () => {
    const application = appWith([{ end: CHUNK_CONTENT.length + 50 }]);
    await expectTamperFailure(
      application.answer({ query: "q", requestId: "tamper-end-oob", topK: 5, maxOutputTokens: 100, scope: TEST_SCOPE }),
      "CLAIM_EVIDENCE_SPAN_MISMATCH"
    );
  });

  it("start > end fails closed", async () => {
    const application = appWith([{ start: QUOTE_END, end: QUOTE_START }]);
    await expectTamperFailure(
      application.answer({ query: "q", requestId: "tamper-inverted", topK: 5, maxOutputTokens: 100, scope: TEST_SCOPE }),
      "CLAIM_EVIDENCE_SPAN_MISMATCH"
    );
  });

  it("span/quote disagreement (valid quote, offsets point elsewhere) fails closed", async () => {
    const application = appWith([{ start: 0, end: QUOTE.length }]);
    await expectTamperFailure(
      application.answer({ query: "q", requestId: "tamper-span-disagree", topK: 5, maxOutputTokens: 100, scope: TEST_SCOPE }),
      "CLAIM_EVIDENCE_SPAN_MISMATCH"
    );
  });

  it("negative offsets fail closed", async () => {
    const application = appWith([{ start: -5, end: QUOTE.length - 5 }]);
    await expectTamperFailure(
      application.answer({ query: "q", requestId: "tamper-negative", topK: 5, maxOutputTokens: 100, scope: TEST_SCOPE }),
      "CLAIM_EVIDENCE_SPAN_MISMATCH"
    );
  });

  it("non-integer offsets fail closed", async () => {
    const application = appWith([{ start: QUOTE_START + 0.5 }]);
    await expectTamperFailure(
      application.answer({ query: "q", requestId: "tamper-float", topK: 5, maxOutputTokens: 100, scope: TEST_SCOPE }),
      "CLAIM_EVIDENCE_SPAN_MISMATCH"
    );
  });

  it("unknown evidence chunk fails closed", async () => {
    const application = appWith([{ chunkId: "chunk-ghost" }]);
    await expectTamperFailure(
      application.answer({ query: "q", requestId: "tamper-unknown-chunk", topK: 5, maxOutputTokens: 100, scope: TEST_SCOPE }),
      "CLAIM_EVIDENCE_CHUNK_UNKNOWN"
    );
  });

  it("evidence chunk retrieved but not cited (scope mismatch) fails closed", async () => {
    const application = appWith([{ chunkId: "chunk-2", quote: "Cellular respiration releases energy", start: 0, end: "Cellular respiration releases energy".length }]);
    await expectTamperFailure(
      application.answer({ query: "q", requestId: "tamper-scope", topK: 5, maxOutputTokens: 100, scope: TEST_SCOPE }),
      "CLAIM_EVIDENCE_SCOPE_MISMATCH"
    );
  });

  it("claim text absent from the answer fails closed", async () => {
    const application = new RagApplicationService({
      retriever: new FakeRetriever(chunks),
      provider: new FakeLlmProvider({ response: {
        answer: ANSWER,
        citations: [{ chunkId: "chunk-1", label: "Chapter 3", locator: "p.12" }],
        claims: [{
          claimId: "claim-ghost",
          text: "This sentence never appears in the answer.",
          answerStart: 0,
          answerEnd: "This sentence never appears in the answer.".length,
          status: "supported",
          citationChunkIds: ["chunk-1"],
          evidence: []
        }],
        confidence: "high" as const
      } })
    });
    await expectTamperFailure(
      application.answer({ query: "q", requestId: "tamper-claim-text", topK: 5, maxOutputTokens: 100, scope: TEST_SCOPE }),
      "CLAIM_TEXT_NOT_IN_ANSWER"
    );
  });

  it("malformed evidence entry fails closed", async () => {
    const application = new RagApplicationService({
      retriever: new FakeRetriever(chunks),
      provider: new FakeLlmProvider({ response: {
        answer: ANSWER,
        citations: [{ chunkId: "chunk-1", label: "Chapter 3", locator: "p.12" }],
        claims: [{
          claimId: "claim-bad-ev",
          text: ANSWER,
          answerStart: 0,
          answerEnd: ANSWER.length,
          status: "supported",
          citationChunkIds: ["chunk-1"],
          evidence: [{ chunkId: "chunk-1", start: 0, end: 5 }] // missing quote
        }],
        confidence: "high" as const
      } })
    });
    await expectTamperFailure(
      application.answer({ query: "q", requestId: "tamper-format", topK: 5, maxOutputTokens: 100, scope: TEST_SCOPE }),
      "CLAIM_EVIDENCE_FORMAT_INVALID"
    );
  });

  it("tamper failures surface as HTTP 502 RAG_CITATION_INVALID at the boundary", async () => {
    const handler = createRagHttpHandler(appWith([{ quote: "FORGED_QUOTE" }]));
    const result = await handler({
      method: "POST",
      body: { requestId: "tamper-http", query: "q", topK: 5, maxOutputTokens: 100, scope: TEST_SCOPE }
    });
    expect(result.status).toBe(502);
    expect(result.body).toMatchObject({ error: { code: "RAG_CITATION_INVALID" } });
    expect(JSON.stringify(result.body)).not.toContain("FORGED_QUOTE");
  });
});

describe("R-4/R-5 F — success responses are client-verifiable (property tests)", () => {
  it("a correct model answer satisfies every client-verifiable invariant", async () => {
    const application = appWith("omit");
    const response = await application.answer({ query: "q", requestId: "props-ok", topK: 5, maxOutputTokens: 100, scope: TEST_SCOPE });
    expect(response.grounding).toBe("verified");

    // Contract round-trip: the wire schema itself re-checks offset invariants.
    expect(() => parseRagResponse(JSON.parse(JSON.stringify(response)))).not.toThrow();

    const claims = response.claims ?? [];
    expect(claims.length).toBeGreaterThan(0);
    for (const claim of claims) {
      // Claim offsets slice to the claim text.
      expect(response.answer.slice(claim.answerStart, claim.answerEnd)).toBe(claim.text);
      for (const evidence of claim.evidence) {
        // Hash derives from the quote alone; chunk slice reproduces the quote.
        expect(hashEvidenceSpan(evidence.quote)).toBe(evidence.contentHash);
        const chunk = chunks.find((c) => c.id === evidence.chunkId)!;
        expect(chunk.content.slice(evidence.start, evidence.end)).toBe(evidence.quote);
        expect(evidence.end - evidence.start).toBe(evidence.quote.length);
      }
    }
    // Cross-field consistency: verified IFF zero unsupported.
    const unsupported = claims.filter((c) => c.status === "unsupported").length;
    expect(response.unsupportedClaimCount).toBe(unsupported);
    expect(response.grounding === "verified").toBe(response.unsupportedClaimCount === 0);
  });

  it("a partially supported answer keeps every invariant while downgraded", async () => {
    const application = new RagApplicationService({
      retriever: new FakeRetriever(chunks),
      provider: new FakeLlmProvider({ response: {
        answer: `${QUOTE} Quantum tunneling explains stellar fusion rates.`,
        citations: [{ chunkId: "chunk-1", label: "Chapter 3", locator: "p.12" }],
        claims: [
          {
            claimId: "claim-ok",
            text: QUOTE,
            answerStart: 0,
            answerEnd: QUOTE.length,
            status: "supported",
            citationChunkIds: ["chunk-1"],
            evidence: [{ quote: QUOTE, chunkId: "chunk-1", start: QUOTE_START, end: QUOTE_END }]
          },
          {
            claimId: "claim-unsupported",
            text: "Quantum tunneling explains stellar fusion rates.",
            answerStart: QUOTE.length + 1,
            answerEnd: QUOTE.length + 1 + "Quantum tunneling explains stellar fusion rates.".length,
            status: "supported",
            citationChunkIds: ["chunk-1"],
            evidence: [{ quote: QUOTE, chunkId: "chunk-1", start: QUOTE_START, end: QUOTE_END }]
          }
        ],
        confidence: "high" as const
      } })
    });
    const response = await application.answer({ query: "q", requestId: "props-partial", topK: 5, maxOutputTokens: 100, scope: TEST_SCOPE });
    expect(response.grounding).toBe("unverified");
    expect(response.unsupportedClaimCount).toBe(1);
    expect(() => parseRagResponse(JSON.parse(JSON.stringify(response)))).not.toThrow();
    for (const claim of response.claims ?? []) {
      expect(response.answer.slice(claim.answerStart, claim.answerEnd)).toBe(claim.text);
      for (const evidence of claim.evidence) {
        expect(hashEvidenceSpan(evidence.quote)).toBe(evidence.contentHash);
        expect(chunks.find((c) => c.id === evidence.chunkId)!.content.slice(evidence.start, evidence.end)).toBe(evidence.quote);
      }
    }
    // No internal contradiction: unverified must carry a positive count.
    expect(response.grounding === "verified").toBe(response.unsupportedClaimCount === 0);
  });

  it("a model-supplied hash that MATCHES the quote is accepted and stays verifiable", async () => {
    const application = appWith([{ contentHash: hashEvidenceSpan(QUOTE) }]);
    const response = await application.answer({ query: "q", requestId: "props-hash-match", topK: 5, maxOutputTokens: 100, scope: TEST_SCOPE });
    expect(response.grounding).toBe("verified");
    const evidence = response.claims?.[0]?.evidence?.[0];
    expect(hashEvidenceSpan(evidence!.quote)).toBe(evidence!.contentHash);
  });
});
