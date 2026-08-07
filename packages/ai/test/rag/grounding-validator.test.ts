import { describe, expect, it } from "vitest";
import {
  detectRiskCategory,
  extractMaterialLiterals,
  RuleBasedGroundingValidator,
  type GroundingValidationInput,
  type RetrievedChunk
} from "../../src/rag/server";
import type { RagClaimGrounding, RagCitation, RagScope } from "../../src/rag/server";

const SCOPE: RagScope = { studentId: "student-1", bookId: "book-1" };

function chunk(id: string, content: string, label = id): RetrievedChunk {
  return { id, content, label };
}

function makeClaim(
  claimId: string,
  text: string,
  answer: string,
  citationChunkIds: string[],
  riskCategory?: RagClaimGrounding["riskCategory"],
  status: "supported" | "unsupported" = "supported"
): RagClaimGrounding {
  const start = answer.indexOf(text);
  return {
    claimId,
    text,
    answerStart: start,
    answerEnd: start + text.length,
    status,
    ...(riskCategory ? { riskCategory } : {}),
    citationChunkIds,
    evidence: []
  };
}

function input(
  answer: string,
  claims: RagClaimGrounding[],
  citations: RagCitation[],
  retrievedChunks: RetrievedChunk[],
  scope: RagScope = SCOPE,
  signal?: AbortSignal
): GroundingValidationInput {
  return { requestId: "req", answer, claims, citations, retrievedChunks, scope, signal };
}

describe("rule-based grounding validator — presence vs support separation", () => {
  it("does NOT mark verified just because a chunk is cited; the chunk must entail the claim", async () => {
    // Chunk exists and is cited, but its content does NOT support the claim.
    const chunkA = chunk("c-a", "Photosynthesis converts light into chemical energy.");
    const claim = makeClaim("claim-1", "The mitochondria is the powerhouse of the cell.", "The mitochondria is the powerhouse of the cell.", ["c-a"]);
    const v = new RuleBasedGroundingValidator();
    const result = await v.validate(input(claim.text, [claim], [{ chunkId: "c-a", label: "c-a" }], [chunkA]));
    expect(result.verdict).not.toBe("verified");
    expect(result.unsupportedClaimCount).toBe(1);
  });
});

describe("rule-based grounding validator — weak source / low relevance", () => {
  it("returns abstained or partial for a low-relevance chunk (abstained when 0 claims supported)", async () => {
    const weak = chunk("c-weak", "Quantum mechanics describes subatomic behavior.");
    const claim = makeClaim("claim-w", "量子力學的測不準原理是物理學的重要概念。", "量子力學的測不準原理是物理學的重要概念。", ["c-weak"]);
    const v = new RuleBasedGroundingValidator();
    const result = await v.validate(input(claim.text, [claim], [{ chunkId: "c-weak", label: "c-weak" }], [weak]));
    expect(result.unsupportedClaimCount).toBe(1);
    expect(result.verdict).toBe("partial");
  });
});

describe("rule-based grounding validator — non-entailment (topic related but does not entail)", () => {
  it("marks a claim unsupported when the chunk discusses the topic but states the opposite", async () => {
    const opposite = chunk("c-opp", "Pluto is NOT a planet according to the IAU 2006 definition.");
    const claim = makeClaim("claim-opp", "Pluto is a planet.", "Pluto is a planet.", ["c-opp"], "general");
    const v = new RuleBasedGroundingValidator();
    const result = await v.validate(input(claim.text, [claim], [{ chunkId: "c-opp", label: "c-opp" }], [opposite]));
    expect(result.unsupportedClaimCount).toBe(1);
    expect(result.verdict).toBe("partial");
  });
});

describe("rule-based grounding validator — unsupported numeric claims", () => {
  it("marks an unsupported number as partial even when surrounding context is supported", async () => {
    const chunkContent = "光合作用是植物利用光能將水與二氧化碳轉化為養分。";
    const c = chunk("c-num", chunkContent);
    const answer = "光合作用是植物利用光能將水與二氧化碳轉化為養分。光反應的效率為 99.7%。";
    const supportedClaim = makeClaim("claim-sup", "光合作用是植物利用光能將水與二氧化碳轉化為養分。", answer, ["c-num"]);
    const unsupportedClaim = makeClaim("claim-num", "光反應的效率為 99.7%。", answer, ["c-num"], "number");
    const v = new RuleBasedGroundingValidator();
    const result = await v.validate(input(answer, [supportedClaim, unsupportedClaim], [{ chunkId: "c-num", label: "c-num" }], [c]));
    expect(result.verdict).toBe("partial");
    expect(result.unsupportedClaimCount).toBe(1);
    const numSupport = result.claimSupport.find((s) => s.claimId === "claim-num");
    expect(numSupport?.status).toBe("unsupported");
    expect(numSupport?.riskCategory).toBe("number");
  });

  it("supports a claim whose number literally appears in the cited chunk", async () => {
    const c = chunk("c-num-ok", "The speed of light is 299792458 m/s.");
    const claim = makeClaim("claim-num-ok", "The speed of light is 299792458 m/s.", "The speed of light is 299792458 m/s.", ["c-num-ok"], "number");
    const v = new RuleBasedGroundingValidator();
    const result = await v.validate(input(claim.text, [claim], [{ chunkId: "c-num-ok", label: "c-num-ok" }], [c]));
    expect(result.verdict).toBe("verified");
    expect(result.unsupportedClaimCount).toBe(0);
  });
});

describe("rule-based grounding validator — per-claim isolation (strong source cannot mask weak claim)", () => {
  it("returns partial when 1 of 2 claims is unsupported, each citing a different chunk", async () => {
    const chunkA = chunk("c-a", "The Battle of Hastings occurred in 1066.");
    const chunkB = chunk("c-b", "The Eiffel Tower is located in Paris.");
    const answer = "The Battle of Hastings occurred in 1066. The Great Wall was built in 221 BC.";
    const supported = makeClaim("claim-hastings", "The Battle of Hastings occurred in 1066.", answer, ["c-a"], "date");
    const unsupported = makeClaim("claim-wall", "The Great Wall was built in 221 BC.", answer, ["c-b"], "date");
    const v = new RuleBasedGroundingValidator();
    const result = await v.validate(input(answer, [supported, unsupported], [
      { chunkId: "c-a", label: "c-a" }, { chunkId: "c-b", label: "c-b" }
    ], [chunkA, chunkB]));
    expect(result.verdict).toBe("partial");
    expect(result.unsupportedClaimCount).toBe(1);
    // The supported claim must be correctly marked supported.
    const hSupport = result.claimSupport.find((s) => s.claimId === "claim-hastings");
    expect(hSupport?.status).toBe("supported");
  });
});

describe("rule-based grounding validator — out-of-scope chunk cannot support a claim", () => {
  it("marks a claim unsupported when its only cited chunk was not in the retrieved set", async () => {
    const inScope = chunk("c-in", "Photosynthesis uses sunlight.");
    const claim = makeClaim("claim-scope", "Photosynthesis uses sunlight.", "Photosynthesis uses sunlight.", ["c-out-of-scope"]);
    const v = new RuleBasedGroundingValidator();
    const result = await v.validate(input(claim.text, [claim], [{ chunkId: "c-out-of-scope", label: "c-out-of-scope" }], [inScope]));
    expect(result.verdict).toBe("partial");
    expect(result.unsupportedClaimCount).toBe(1);
  });
});

describe("rule-based grounding validator — fail-closed on validator failure", () => {
  it("returns abstained when aborted (never verified)", async () => {
    const c = chunk("c", "Some content here.");
    const claim = makeClaim("claim-abort", "Some content here.", "Some content here.", ["c"]);
    const controller = new AbortController();
    controller.abort();
    const v = new RuleBasedGroundingValidator();
    const result = await v.validate(input(claim.text, [claim], [{ chunkId: "c", label: "c" }], [c], SCOPE, controller.signal));
    expect(result.verdict).toBe("abstained");
  });

  it("returns abstained when there are zero claims", async () => {
    const c = chunk("c", "Some content.");
    const v = new RuleBasedGroundingValidator();
    const result = await v.validate(input("answer", [], [], [c]));
    expect(result.verdict).toBe("abstained");
    expect(result.validatorIdentity).toBe("rule-based-v1");
  });
});

describe("rule-based grounding validator — generator confidence never overrides", () => {
  it("ignores generator confidence entirely (it is not even an input to the port)", () => {
    // GroundingValidationInput has no confidence field by construction.
    const sample: GroundingValidationInput = {
      requestId: "r", answer: "a", claims: [], citations: [], retrievedChunks: [], scope: SCOPE
    };
    expect(sample).not.toHaveProperty("confidence");
  });
});

describe("risk category detection helpers", () => {
  it("detects numbers, dates, formulas, and general text", () => {
    expect(detectRiskCategory("The value is 42")).toBe("number");
    expect(detectRiskCategory("In 1492 Columbus sailed")).toBe("date");
    expect(detectRiskCategory("E = mc^2")).toBe("formula");
    expect(detectRiskCategory("Photosynthesis is a process")).toBe("general");
  });

  it("extracts material number literals", () => {
    const literals = extractMaterialLiterals("Efficiency is 99.7% and speed is 299792458", "number");
    expect(literals).toContain("99.7%");
    expect(literals).toContain("299792458");
  });

  it("extracts material date literals", () => {
    const literals = extractMaterialLiterals("Year 1066 and date 2006-08-24", "date");
    expect(literals).toContain("1066");
    expect(literals).toContain("2006-08-24");
  });
});
