import { describe, expect, it } from "vitest";
import { MathematicsVerifier, evaluateSafeExpression, verifyNumericAnswer, type VerificationStrategyContext } from "../../src";

function context(question: string, primaryAnswer: string): VerificationStrategyContext {
  return {
    requestId: "math-test",
    question,
    primaryAnswer,
    logicalModelId: "primary",
    classification: { category: "mathematics", confidence: 0.98, source: "deterministic", reasons: ["numeric_expression"] }
  };
}

describe("safe mathematics verifier", () => {
  const verifier = new MathematicsVerifier();

  it("evaluates integer arithmetic", () => expect(evaluateSafeExpression("2 + 3 * 4")).toBe(14));
  it("respects parentheses", () => expect(evaluateSafeExpression("(2 + 3) * 4")).toBe(20));
  it("evaluates decimals", () => expect(evaluateSafeExpression("0.1 + 0.2")).toBeCloseTo(0.3));
  it("evaluates a percentage", () => expect(evaluateSafeExpression("25%" )).toBe(0.25));
  it("evaluates a simple power", () => expect(evaluateSafeExpression("2 ^ 3")).toBe(8));

  it("checks a percentage-of question", () => {
    expect(verifyNumericAnswer("25% 的 200 是多少？", "答案是 50")).toMatchObject({ expectedValue: 50, matched: true });
  });

  it("checks a linear equation", () => {
    expect(verifyNumericAnswer("解方程式 2x + 3 = 7", "x = 2")).toMatchObject({ expectedValue: 2, answerValue: 2, matched: true });
  });

  it("flags an incorrect result with a high-severity evidence issue", async () => {
    const result = await verifier.verify(context("計算 2 + 3 * 4", "答案是 15"));
    expect(result).toMatchObject({ status: "failed", confidence: 0.98 });
    expect(result.issues).toContainEqual(expect.objectContaining({ category: "numeric_mismatch", severity: "high" }));
  });

  it("checks sign handling", async () => {
    const result = await verifier.verify(context("計算 -2 + 3", "答案是 1"));
    expect(result.status).toBe("passed");
  });

  it("rejects division by zero", async () => {
    const result = await verifier.verify(context("計算 10 / 0", "答案不存在"));
    expect(result.issues).toContainEqual(expect.objectContaining({ category: "division_by_zero", severity: "high" }));
  });

  it("rejects NaN", async () => {
    const result = await verifier.verify(context("計算 1 + 1", "NaN"));
    expect(result.issues).toContainEqual(expect.objectContaining({ category: "non_finite", severity: "high" }));
  });

  it("rejects Infinity", async () => {
    const result = await verifier.verify(context("計算 1 + 1", "Infinity"));
    expect(result.issues).toContainEqual(expect.objectContaining({ category: "non_finite", severity: "high" }));
  });

  it("uses a floating point tolerance", () => {
    expect(verifyNumericAnswer("計算 0.1 + 0.2", "0.30000000001").matched).toBe(true);
  });

  it("reports a unit mismatch without fabricating a conversion", async () => {
    const result = await verifier.verify(context("計算 5 米 + 2 米", "答案是 7 公分"));
    expect(result.issues).toContainEqual(expect.objectContaining({ category: "unit_mismatch", severity: "medium" }));
  });

  it("returns unavailable instead of conflict when parsing is unsupported", async () => {
    const result = await verifier.verify(context("請分析一個無法解析的特殊符號 ∑", "答案需要更多資訊。"));
    expect(result.status).toBe("unavailable");
    expect(result.issues).toHaveLength(0);
  });

  it("does not create a reservation because it has no quota port", async () => {
    const result = await verifier.verify(context("計算 2 + 2", "4"));
    expect(result.status).toBe("passed");
  });

  it("does not confuse 25 percent with the number 25", () => {
    expect(evaluateSafeExpression("25%")).not.toBe(25);
  });

  it("supports only mathematics", () => {
    expect(verifier.supports("mathematics")).toBe(true);
    expect(verifier.supports("knowledge")).toBe(false);
  });
});
