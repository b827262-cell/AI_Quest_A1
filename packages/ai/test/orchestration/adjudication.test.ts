import { describe, expect, it } from "vitest";
import { buildAdjudicationPrompt, parseAdjudicationResult } from "../../src";

describe("adjudication contract", () => {
  it("parses all supported adjudication decisions", () => {
    for (const decision of [
      "primary_correct",
      "verification_correct",
      "merged_answer",
      "insufficient_information"
    ] as const) {
      const result = parseAdjudicationResult(
        JSON.stringify({ decision, finalAnswer: "安全結果", confidence: 0.9, reasonCategory: "logic" })
      );
      expect(result).toMatchObject({ ok: true });
    }
  });

  it("rejects malformed adjudication output without retaining raw text", () => {
    const result = parseAdjudicationResult('{"decision":"primary_correct","finalAnswer":""}');
    expect(result).toEqual({ ok: false, reason: "invalid_answer" });
    expect(JSON.stringify(result)).not.toContain("primary_correct");
  });

  it("builds an adjudication prompt from only question, answers, and structured issues", () => {
    const prompt = buildAdjudicationPrompt("問題", "Primary", [
      { category: "logic", severity: "high", description: "兩個結論不同" }
    ]);
    expect(prompt).toContain("問題");
    expect(prompt).toContain("Primary");
    expect(prompt).toContain("兩個結論不同");
    expect(prompt).not.toContain("apiKey");
    expect(prompt).not.toContain("credential");
  });
});
