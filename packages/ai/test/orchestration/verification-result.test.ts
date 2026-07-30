import { describe, expect, it } from "vitest";
import { parseVerificationResult } from "../../src";

describe("verification result parser", () => {
  it.each([
    ["agree", { decision: "agree", confidence: 0.93, issues: [] }],
    ["supplement", { decision: "supplement", confidence: 0.8, issues: [], supplementalContent: "補充一個必要條件。" }],
    ["conflict", { decision: "conflict", confidence: 0.7, issues: [{ category: "calculation", severity: "high", description: "計算結果不同。" }], proposedAnswer: "不可直接採用" }],
    ["uncertain", { decision: "uncertain", confidence: 0.2, issues: [{ category: "other", severity: "medium", description: "資訊不足。" }] }]
  ] as const)("parses %s", (_name, value) => {
    const result = parseVerificationResult(JSON.stringify(value));
    expect(result).toMatchObject({ ok: true });
  });

  it("falls back safely for non-JSON output", () => {
    expect(parseVerificationResult("not json")).toEqual({ ok: false, reason: "invalid_json" });
  });

  it("rejects a decision outside the allowlist", () => {
    expect(parseVerificationResult('{"decision":"rewrite","issues":[]}')).toEqual({
      ok: false,
      reason: "invalid_decision"
    });
  });

  it.each([-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects confidence %s",
    (confidence) => {
      const raw = JSON.stringify({ decision: "agree", confidence, issues: [] });
      expect(parseVerificationResult(raw)).toEqual({ ok: false, reason: "invalid_confidence" });
    }
  );

  it("rejects malformed issues instead of weakening the schema", () => {
    expect(
      parseVerificationResult(
        JSON.stringify({ decision: "conflict", issues: [{ category: "factual", severity: "high" }] })
      )
    ).toEqual({ ok: false, reason: "invalid_issues" });
  });

  it("never copies a provider error into parser diagnostics", () => {
    const result = parseVerificationResult(
      JSON.stringify({ error: "provider-error-details", decision: "agree", issues: [] })
    );
    expect(result).toEqual({ ok: false, reason: "unknown_field" });
    expect(JSON.stringify(result)).not.toContain("provider-error-details");
  });
});
