import { describe, expect, it } from "vitest";
import {
  localizedWindowSimilarity,
  RuleBasedGroundingValidator,
  tokenize,
  type GroundingValidationInput,
  type RetrievedChunk
} from "../../src/rag/server";
import type { RagClaimGrounding, RagCitation, RagScope } from "../../src/rag/server";

/**
 * R-5 / R-1 adversarial regression matrix: localized-window grounding must be
 * invariant to realistic chunk length and evidence position, stay calibrated
 * (verbatim/paraphrase supported; overlap/adjacent/contradiction not), and
 * keep high-risk literals verbatim-only.
 */

const SCOPE: RagScope = { studentId: "student-1", bookId: "book-1" };

// Filler on a deliberately unrelated topic (geology/hydrology). None of the
// photosynthesis claim tokens appear here, so any support must come from the
// embedded evidence sentence alone.
const FILLER_SENTENCES = [
  "Rivers carve wide valleys over immense geological timescales.",
  "Sediment accumulates in deltas wherever currents slow down.",
  "Mountain ranges rise gradually where tectonic plates converge.",
  "Wind erosion sculpts desert stone into arches and pillars.",
  "Glaciers grind bedrock into fine powder as they advance.",
  "Coastal cliffs retreat slowly under persistent wave action.",
  "Aquifers store groundwater between layers of porous rock.",
  "Volcanic soil weathers quickly under heavy seasonal rainfall.",
  "Canyons deepen as downstream channels cut through strata.",
  "Moraines mark the furthest advance of ancient glaciers."
];

function buildChunk(minWords: number, evidenceSentence: string, position: "head" | "middle" | "tail"): string {
  const parts: string[] = [];
  let words = 0;
  let index = 0;
  while (words < minWords) {
    const sentence = FILLER_SENTENCES[index % FILLER_SENTENCES.length];
    parts.push(sentence);
    words += sentence.split(/\s+/).length;
    index += 1;
  }
  if (position === "head") return `${evidenceSentence} ${parts.join(" ")}`;
  if (position === "tail") return `${parts.join(" ")} ${evidenceSentence}`;
  const half = Math.floor(parts.length / 2);
  return `${parts.slice(0, half).join(" ")} ${evidenceSentence} ${parts.slice(half).join(" ")}`;
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function makeClaim(claimId: string, text: string, answer: string, citationChunkIds: string[], riskCategory?: RagClaimGrounding["riskCategory"]): RagClaimGrounding {
  const start = answer.indexOf(text);
  return {
    claimId,
    text,
    answerStart: start,
    answerEnd: start + text.length,
    status: "supported",
    ...(riskCategory ? { riskCategory } : {}),
    citationChunkIds,
    evidence: []
  };
}

function validationInput(answer: string, claims: RagClaimGrounding[], citations: RagCitation[], chunks: RetrievedChunk[]): GroundingValidationInput {
  return { requestId: "req-matrix", answer, claims, citations, retrievedChunks: chunks, scope: SCOPE };
}

async function assessSingle(claimText: string, chunkContent: string, riskCategory?: RagClaimGrounding["riskCategory"]) {
  const chunk: RetrievedChunk = { id: "c-matrix", label: "matrix", content: chunkContent };
  const claim = makeClaim("claim-matrix", claimText, claimText, ["c-matrix"], riskCategory);
  const validator = new RuleBasedGroundingValidator();
  return validator.validate(validationInput(claimText, [claim], [{ chunkId: "c-matrix", label: "matrix" }], [chunk]));
}

const EVIDENCE_SENTENCE = "Photosynthesis converts sunlight into chemical energy that plants store as sugar.";

describe("R-1/R-5 A — realistic chunk lengths never defeat faithful claims", () => {
  const cases: Array<{ minWords: number; position: "head" | "middle" | "tail" }> = [
    { minWords: 40, position: "middle" }, // short chunk baseline
    { minWords: 300, position: "head" },
    { minWords: 300, position: "middle" },
    { minWords: 300, position: "tail" },
    { minWords: 1000, position: "head" },
    { minWords: 1000, position: "middle" },
    { minWords: 1000, position: "tail" },
    { minWords: 2000, position: "head" },
    { minWords: 2000, position: "middle" },
    { minWords: 2000, position: "tail" }
  ];

  for (const { minWords, position } of cases) {
    it(`supports a verbatim claim in a ${minWords}+ word chunk (evidence at ${position})`, async () => {
      const content = buildChunk(minWords, EVIDENCE_SENTENCE, position);
      expect(wordCount(content)).toBeGreaterThanOrEqual(minWords);
      const result = await assessSingle(EVIDENCE_SENTENCE, content);
      expect(result.verdict).toBe("verified");
      expect(result.unsupportedClaimCount).toBe(0);
      expect(result.claimSupport[0].status).toBe("supported");
    });
  }

  it("a verbatim claim inside a 2000+ word chunk scores ~1.0 localized similarity", () => {
    const content = buildChunk(2000, EVIDENCE_SENTENCE, "middle");
    const { similarity } = localizedWindowSimilarity(tokenize(EVIDENCE_SENTENCE), tokenize(content));
    expect(similarity).toBeGreaterThan(0.99);
  });

  it("localized similarity does not degrade as the chunk grows", () => {
    const claimTokens = tokenize(EVIDENCE_SENTENCE);
    const scores = [300, 1000, 2000].map((minWords) =>
      localizedWindowSimilarity(claimTokens, tokenize(buildChunk(minWords, EVIDENCE_SENTENCE, "middle"))).similarity
    );
    for (const score of scores) expect(score).toBeGreaterThan(0.99);
  });
});

describe("R-1/R-5 B — threshold calibration", () => {
  const shortChunk = `${EVIDENCE_SENTENCE} The process happens inside chloroplasts.`;

  it("verbatim support", async () => {
    const result = await assessSingle(EVIDENCE_SENTENCE, shortChunk);
    expect(result.verdict).toBe("verified");
  });

  it("close paraphrase support", async () => {
    const paraphrase = "During photosynthesis plants convert sunlight into chemical energy stored as sugar.";
    const result = await assessSingle(paraphrase, shortChunk);
    expect(result.verdict).toBe("verified");
    expect(result.claimSupport[0].status).toBe("supported");
  });

  it("partial overlap is unsupported", async () => {
    const claim = "Photosynthesis releases oxygen gas during the light reactions of plants.";
    const result = await assessSingle(claim, shortChunk);
    expect(result.verdict).toBe("partial");
    expect(result.claimSupport[0].status).toBe("unsupported");
  });

  it("adjacent-topic overlap is unsupported", async () => {
    const claim = "Mitochondria convert sugar into usable cellular energy during respiration.";
    const result = await assessSingle(claim, shortChunk);
    expect(result.verdict).toBe("partial");
    expect(result.claimSupport[0].status).toBe("unsupported");
  });

  it("contradiction (negated evidence) is unsupported", async () => {
    const chunk = "Pluto is not a planet according to the IAU decision of astronomers.";
    const result = await assessSingle("Pluto is a planet.", chunk);
    expect(result.verdict).toBe("partial");
    expect(result.claimSupport[0].status).toBe("unsupported");
    expect(result.claimSupport[0].reasonCode).toBe("low_window_similarity_or_coverage");
  });

  it("calibration negative: one shared noun never supports (mitochondria/photosynthesis)", async () => {
    const result = await assessSingle(
      "Mitochondria are the primary site of photosynthesis",
      "Mitochondria produce ATP through oxidative phosphorylation"
    );
    expect(result.verdict).toBe("partial");
    expect(result.claimSupport[0].status).toBe("unsupported");
  });

  it("a genuinely supporting sentence elsewhere in the chunk still supports", async () => {
    const chunk = "Pluto is not a planet according to the IAU. Yet older textbooks state Pluto is a planet beyond Neptune.";
    const result = await assessSingle("Pluto is a planet.", chunk);
    expect(result.verdict).toBe("verified");
  });
});

describe("R-1/R-5 C — high-risk factual claims need verbatim literals", () => {
  const longChunk = buildChunk(300, EVIDENCE_SENTENCE, "middle");

  it("unsupported number is rejected even with strong textual overlap", async () => {
    const result = await assessSingle("The efficiency of photosynthesis reaches 42 percent in ideal conditions.", longChunk, "number");
    expect(result.verdict).toBe("partial");
    expect(result.claimSupport[0].reasonCode).toBe("number_literal_not_in_evidence");
  });

  it("unsupported percentage is rejected", async () => {
    const result = await assessSingle("Only 3.5% of incoming sunlight becomes plant biomass.", longChunk, "number");
    expect(result.verdict).toBe("partial");
    expect(result.claimSupport[0].reasonCode).toBe("number_literal_not_in_evidence");
  });

  it("unsupported date is rejected", async () => {
    const result = await assessSingle("Photosynthesis research began in the year 1779.", longChunk, "date");
    expect(result.verdict).toBe("partial");
    expect(result.claimSupport[0].reasonCode).toBe("date_literal_not_in_evidence");
  });

  it("unsupported formula is rejected", async () => {
    const result = await assessSingle("The overall reaction is 6CO2 + 6H2O = C6H12O6 + 6O2.", longChunk, "formula");
    expect(result.verdict).toBe("partial");
    expect(result.claimSupport[0].reasonCode).toBe("formula_literal_not_in_evidence");
  });

  it("unsupported equation value is rejected", async () => {
    const result = await assessSingle("The energy yield equals 38 ATP molecules per glucose.", longChunk, "number");
    expect(result.verdict).toBe("partial");
    expect(result.claimSupport[0].reasonCode).toBe("number_literal_not_in_evidence");
  });

  it("a number claim whose literal appears verbatim is supported", async () => {
    const chunk = `${EVIDENCE_SENTENCE} Measurements show an efficiency of 42 percent.`;
    const result = await assessSingle("The efficiency of photosynthesis reaches 42 percent.", chunk, "number");
    expect(result.verdict).toBe("verified");
  });
});
