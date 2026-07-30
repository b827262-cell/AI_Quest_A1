import { describe, expect, it } from "vitest";
import {
  KnowledgeConsistencyVerifier,
  assessKnowledgeClaims,
  buildKnowledgeClaimAssessmentPrompt,
  extractKnowledgeClaims,
  parseKnowledgeClaimAssessments,
  type KnowledgeClaim,
  type VerificationStrategyContext
} from "../../src";

function context(primaryAnswer: string): VerificationStrategyContext {
  return {
    requestId: "knowledge-test",
    question: "請解釋這個知識問題。",
    primaryAnswer,
    logicalModelId: "primary",
    classification: { category: "knowledge", confidence: 0.9, source: "deterministic", reasons: ["definition"] }
  };
}

describe("safe knowledge claim verification", () => {
  const verifier = new KnowledgeConsistencyVerifier();

  it("extracts core claims and supporting claims", () => {
    expect(extractKnowledgeClaims("核心定義。補充背景。")).toEqual([
      { id: "claim-1", text: "核心定義", importance: "core" },
      { id: "claim-2", text: "補充背景", importance: "supporting" }
    ]);
  });

  it("limits claims to eight", () => {
    const answer = Array.from({ length: 10 }, (_, index) => `主張${index + 1}`).join("。");
    expect(extractKnowledgeClaims(answer)).toHaveLength(8);
  });

  it("uses deterministic claim ids", () => {
    const answer = "第一個主張。第二個主張。";
    expect(extractKnowledgeClaims(answer).map((claim) => claim.id)).toEqual(["claim-1", "claim-2"]);
    expect(extractKnowledgeClaims(answer)).toEqual(extractKnowledgeClaims(answer));
  });

  it("passes internally consistent core claims", async () => {
    const result = await verifier.verify(context("水在標準大氣壓下約 100°C 沸騰。這是基本物理知識。"));
    expect(result.status).toBe("passed");
    expect(result.safeSummary).toBe("claims_internally_consistent");
  });

  it("marks contradictory core claims as failed", async () => {
    const result = await verifier.verify(context("太陽是恆星。太陽不是恆星。"));
    expect(result.status).toBe("failed");
    expect(result.issues).toContainEqual(expect.objectContaining({ category: "core_claim", severity: "high" }));
  });

  it("does not force a conflict for contradictory supporting claims", async () => {
    const result = await verifier.verify(context("主要結論成立。補充資料是正確的。補充資料不是正確的。"));
    expect(result.status).toBe("partial");
    expect(result.issues).toContainEqual(expect.objectContaining({ category: "supporting_claim", severity: "medium" }));
  });

  it("returns supported assessments for consistent claims", () => {
    const claims = extractKnowledgeClaims("A 是 B。A 具有性質 C。");
    expect(assessKnowledgeClaims(claims).every((assessment) => assessment.result === "supported")).toBe(true);
  });

  it("allows a supporting claim to remain uncertain", () => {
    const claims: KnowledgeClaim[] = [{ id: "claim-1", text: "補充主張", importance: "supporting" }];
    const parsed = parseKnowledgeClaimAssessments(
      JSON.stringify([{ claimId: "claim-1", result: "uncertain", severity: "low", safeReason: "not_checked" }]),
      claims
    );
    expect(parsed).toMatchObject({ ok: true, value: [{ result: "uncertain", severity: "low" }] });
  });

  it("rejects malformed claim assessment safely", () => {
    const parsed = parseKnowledgeClaimAssessments("provider raw error", [{ id: "claim-1", text: "A", importance: "core" }]);
    expect(parsed).toEqual({ ok: false, reason: "invalid_json" });
    expect(JSON.stringify(parsed)).not.toContain("provider raw error");
  });

  it("rejects unknown claim ids", () => {
    const parsed = parseKnowledgeClaimAssessments(
      JSON.stringify([{ claimId: "claim-9", result: "supported", severity: "low" }]),
      [{ id: "claim-1", text: "A", importance: "core" }]
    );
    expect(parsed).toEqual({ ok: false, reason: "invalid_shape" });
  });

  it("builds an assessment prompt from bounded claim fields", () => {
    const prompt = buildKnowledgeClaimAssessmentPrompt([{ id: "claim-1", text: "A", importance: "core" }]);
    expect(prompt).toContain("claim-1");
    expect(prompt).toContain("只輸出 JSON");
  });

  it("does not expose full claims in evidence", async () => {
    const privateAnswer = "PRIVATE FULL CLAIM TEXT。";
    const result = await verifier.verify(context(privateAnswer));
    expect(JSON.stringify(result)).not.toContain(privateAnswer);
  });

  it("supports only knowledge", () => {
    expect(verifier.supports("knowledge")).toBe(true);
    expect(verifier.supports("programming")).toBe(false);
  });
});
