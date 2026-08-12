import { describe, expect, it } from "vitest";
import {
  FakeLlmProvider,
  FakeRetriever,
  RagApplicationService,
  type GroundingValidationInput,
  type GroundingValidationResult,
  type GroundingValidator,
  type RetrievedChunk
} from "../../src/rag/server";

/**
 * R-5 E / R-3 — validator consistency.
 *
 * GroundingValidator.validate() must run EXACTLY ONCE per request. All
 * response fields (grounding, claims, unsupportedClaimCount) derive from that
 * single authoritative result; a non-deterministic validator that returns a
 * different verdict on a second call must never change the response.
 */

const TEST_SCOPE = { studentId: "student-1", bookId: "book-1" } as const;

const chunks: RetrievedChunk[] = [
  { id: "chunk-1", label: "Chapter 1", locator: "page 1", content: "The answer is forty-two." }
];

const ANSWER = "The answer is forty-two.";

function supportedResponse() {
  return {
    answer: ANSWER,
    citations: [{ chunkId: "chunk-1", label: "Chapter 1" }],
    claims: [{
      claimId: "claim-1",
      text: ANSWER,
      answerStart: 0,
      answerEnd: ANSWER.length,
      status: "supported",
      citationChunkIds: ["chunk-1"],
      evidence: [{ quote: ANSWER, chunkId: "chunk-1", start: 0, end: ANSWER.length }]
    }],
    confidence: "high" as const
  };
}

/** Non-deterministic validator: returns results[0] on call 1, results[1] on call 2, ... */
function alternatingValidator(results: GroundingValidationResult[]): { validator: GroundingValidator; callCount: () => number } {
  let calls = 0;
  return {
    validator: {
      validate: async (_input: GroundingValidationInput): Promise<GroundingValidationResult> => {
        const result = results[Math.min(calls, results.length - 1)];
        calls += 1;
        return result;
      }
    },
    callCount: () => calls
  };
}

const RESULT_A_PARTIAL: GroundingValidationResult = {
  verdict: "partial",
  claimSupport: [{ claimId: "claim-1", status: "unsupported", supportedByChunkIds: [], reasonCode: "test_a" }],
  unsupportedClaimCount: 1,
  validatorIdentity: "alternating-A"
};

const RESULT_B_VERIFIED: GroundingValidationResult = {
  verdict: "verified",
  claimSupport: [{ claimId: "claim-1", status: "supported", supportedByChunkIds: ["chunk-1"] }],
  unsupportedClaimCount: 0,
  validatorIdentity: "alternating-B"
};

describe("R-3/R-5 E — GroundingValidator runs exactly once per request", () => {
  it("calls validate() exactly once and uses ONLY the first result (A, not B)", async () => {
    const { validator, callCount } = alternatingValidator([RESULT_A_PARTIAL, RESULT_B_VERIFIED]);
    const application = new RagApplicationService({
      retriever: new FakeRetriever(chunks),
      provider: new FakeLlmProvider({ response: supportedResponse() }),
      groundingValidator: validator
    });
    const response = await application.answer({ query: "q", requestId: "once-a", topK: 5, maxOutputTokens: 100, scope: TEST_SCOPE });

    expect(callCount()).toBe(1);
    // The response must reflect result A (partial) — never the second call's B.
    expect(response.grounding).toBe("unverified");
    expect(response.unsupportedClaimCount).toBe(1);
    expect(response.claims?.[0]?.status).toBe("unsupported");
  });

  it("calls validate() exactly once on the verified path too", async () => {
    const { validator, callCount } = alternatingValidator([RESULT_B_VERIFIED, RESULT_A_PARTIAL]);
    const application = new RagApplicationService({
      retriever: new FakeRetriever(chunks),
      provider: new FakeLlmProvider({ response: supportedResponse() }),
      groundingValidator: validator
    });
    const response = await application.answer({ query: "q", requestId: "once-b", topK: 5, maxOutputTokens: 100, scope: TEST_SCOPE });

    expect(callCount()).toBe(1);
    expect(response.grounding).toBe("verified");
    expect(response.unsupportedClaimCount).toBe(0);
    expect(response.claims?.[0]?.status).toBe("supported");
  });
});

describe("R-3/R-5 E — response invariant: grounding === verified IFF unsupportedClaimCount === 0", () => {
  it("a lying validator (verdict=verified but claims unsupported) cannot produce a contradictory response", async () => {
    const lyingVerified: GroundingValidationResult = {
      verdict: "verified",
      claimSupport: [{ claimId: "claim-1", status: "unsupported", supportedByChunkIds: [], reasonCode: "lying" }],
      unsupportedClaimCount: 1,
      validatorIdentity: "lying-verified"
    };
    const { validator, callCount } = alternatingValidator([lyingVerified]);
    const application = new RagApplicationService({
      retriever: new FakeRetriever(chunks),
      provider: new FakeLlmProvider({ response: supportedResponse() }),
      groundingValidator: validator
    });
    const response = await application.answer({ query: "q", requestId: "invariant-lie", topK: 5, maxOutputTokens: 100, scope: TEST_SCOPE });

    expect(callCount()).toBe(1);
    // Never: grounding=verified + unsupportedClaimCount>0 (or unsupported claims).
    expect(response.grounding).not.toBe("verified");
    expect(response.grounding).toBe("unverified");
    expect(response.unsupportedClaimCount).toBe(1);
    expect(response.grounding === "verified").toBe(response.unsupportedClaimCount === 0);
  });

  it("a mislabeled verdict (partial but all claims supported) stays internally consistent", async () => {
    const mislabeledPartial: GroundingValidationResult = {
      verdict: "partial",
      claimSupport: [{ claimId: "claim-1", status: "supported", supportedByChunkIds: ["chunk-1"] }],
      unsupportedClaimCount: 0,
      validatorIdentity: "mislabeled-partial"
    };
    const { validator } = alternatingValidator([mislabeledPartial]);
    const application = new RagApplicationService({
      retriever: new FakeRetriever(chunks),
      provider: new FakeLlmProvider({ response: supportedResponse() }),
      groundingValidator: validator
    });
    const response = await application.answer({ query: "q", requestId: "invariant-mislabeled", topK: 5, maxOutputTokens: 100, scope: TEST_SCOPE });

    // Invariant holds in both directions: zero unsupported claims => verified.
    expect(response.unsupportedClaimCount).toBe(0);
    expect(response.grounding).toBe("verified");
    expect(response.claims?.every((c) => c.status === "supported")).toBe(true);
  });

  it("an empty claimSupport list from a partial verdict fails every claim closed", async () => {
    const emptySupport: GroundingValidationResult = {
      verdict: "partial",
      claimSupport: [],
      unsupportedClaimCount: 1,
      validatorIdentity: "empty-support"
    };
    const { validator } = alternatingValidator([emptySupport]);
    const application = new RagApplicationService({
      retriever: new FakeRetriever(chunks),
      provider: new FakeLlmProvider({ response: supportedResponse() }),
      groundingValidator: validator
    });
    const response = await application.answer({ query: "q", requestId: "invariant-empty", topK: 5, maxOutputTokens: 100, scope: TEST_SCOPE });

    expect(response.grounding).toBe("unverified");
    expect(response.unsupportedClaimCount).toBe(1);
    expect(response.claims?.[0]?.status).toBe("unsupported");
  });

  it("never produces grounding=unverified/partial with unsupportedClaimCount=0 and all claims supported=false", async () => {
    // Exhaustive sweep over alternating verdict combinations.
    for (const first of [RESULT_A_PARTIAL, RESULT_B_VERIFIED]) {
      for (const second of [RESULT_A_PARTIAL, RESULT_B_VERIFIED]) {
        const { validator, callCount } = alternatingValidator([first, second]);
        const application = new RagApplicationService({
          retriever: new FakeRetriever(chunks),
          provider: new FakeLlmProvider({ response: supportedResponse() }),
          groundingValidator: validator
        });
        const response = await application.answer({ query: "q", requestId: `sweep-${first.validatorIdentity}-${second.validatorIdentity}`, topK: 5, maxOutputTokens: 100, scope: TEST_SCOPE });
        expect(callCount()).toBe(1);
        const claims = response.claims ?? [];
        const unsupported = claims.filter((c) => c.status === "unsupported").length;
        expect(response.unsupportedClaimCount).toBe(unsupported);
        expect(response.grounding === "verified").toBe(response.unsupportedClaimCount === 0);
      }
    }
  });
});
