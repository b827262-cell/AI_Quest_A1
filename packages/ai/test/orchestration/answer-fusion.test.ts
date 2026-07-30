import { describe, expect, it } from "vitest";
import { fusePrimaryAndVerification, type VerificationResult } from "../../src";

const primary = "答案第一段。\n答案第二段。";

function verification(overrides: Partial<VerificationResult>): VerificationResult {
  return { decision: "agree", issues: [], ...overrides };
}

describe("deterministic answer fusion", () => {
  it("keeps the Primary answer byte-for-byte for agree", () => {
    const result = fusePrimaryAndVerification(
      primary,
      verification({ decision: "agree", proposedAnswer: "不要採用這份改寫" })
    );
    expect(result).toEqual({ outcome: "verified", finalAnswer: primary, conflictDetected: false });
  });

  it("appends a non-conflicting supplement without replacing Primary", () => {
    const result = fusePrimaryAndVerification(
      primary,
      verification({ decision: "supplement", supplementalContent: "補充必要條件。" })
    );
    expect(result.outcome).toBe("supplemented");
    expect(result.finalAnswer).toBe(`${primary}\n\n補充說明：\n補充必要條件。`);
    expect(result.finalAnswer.startsWith(primary)).toBe(true);
  });

  it("does not create an empty supplement heading", () => {
    const result = fusePrimaryAndVerification(
      primary,
      verification({ decision: "supplement", supplementalContent: "   " })
    );
    expect(result.outcome).toBe("supplemented");
    expect(result.finalAnswer).toBe(primary);
    expect(result.finalAnswer).not.toContain("補充說明");
  });

  it("does not duplicate a supplement already present in Primary", () => {
    const result = fusePrimaryAndVerification(
      primary,
      verification({ decision: "supplement", supplementalContent: "答案第一段。" })
    );
    expect(result.finalAnswer).toBe(primary);
    expect(result.finalAnswer.match(/答案第一段。/g)).toHaveLength(1);
  });

  it("routes a high-severity core issue to conflict instead of appending it", () => {
    const result = fusePrimaryAndVerification(
      primary,
      verification({
        decision: "supplement",
        supplementalContent: "會改變計算結論的內容。",
        issues: [{ category: "calculation", severity: "high", description: "核心結果不同" }]
      })
    );
    expect(result.outcome).toBe("conflict_detected");
    expect(result.finalAnswer).toBe(primary);
  });

  it("marks conflicts without accepting Verification proposedAnswer", () => {
    const result = fusePrimaryAndVerification(
      primary,
      verification({ decision: "conflict", proposedAnswer: "未經裁決的替代答案" })
    );
    expect(result).toEqual({
      outcome: "conflict_detected",
      finalAnswer: primary,
      conflictDetected: true
    });
  });

  it("preserves Primary and marks uncertain as unresolved", () => {
    const result = fusePrimaryAndVerification(primary, verification({ decision: "uncertain" }));
    expect(result).toMatchObject({
      outcome: "unresolved",
      finalAnswer: primary,
      conflictDetected: false,
      fallbackReason: "verification_uncertain"
    });
  });
});
