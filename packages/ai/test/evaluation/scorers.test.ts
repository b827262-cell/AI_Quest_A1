import { describe, expect, it } from "vitest";
import {
  ClassificationScorer,
  ConceptScorer,
  ExactScorer,
  NumericScorer,
  ProgrammingScorer,
  SafetyScorer,
  scoreEvaluationCase,
  type EvaluationCase,
  type EvaluationSubjectResult
} from "../../src";

function testCase(expected: EvaluationCase["expected"]): EvaluationCase {
  return { id: "test-case-001", version: 1, category: "knowledge", difficulty: "easy", question: "synthetic question", expected, source: "synthetic", enabled: true };
}
function subject(answer: string, extra: Partial<EvaluationSubjectResult> = {}): EvaluationSubjectResult {
  return { answer, modelCallCount: 1, durationMs: 1, ...extra };
}

describe("evaluation exact and numeric scorers", () => {
  const exact = new ExactScorer();
  it.each([
    ["same", "42", true], ["whitespace", "  42  ", true], ["case-insensitive", "YES", true], ["alternative", "forty-two", true], ["mismatch", "41", false]
  ])("exact %s", (_name, answer, passed) => {
    const expectation = _name === "alternative" ? { kind: "exact" as const, acceptedAnswers: ["42", "forty-two"] } : _name === "case-insensitive" ? { kind: "exact" as const, acceptedAnswers: ["yes"], caseSensitive: false } : { kind: "exact" as const, acceptedAnswers: ["42"], caseSensitive: true };
    expect(exact.score(testCase(expectation), answer).passed).toBe(passed);
  });
  it("supports exact via the independent scorer dispatcher", () => {
    expect(scoreEvaluationCase(testCase({ kind: "exact", acceptedAnswers: ["ok"] }), subject("ok")).method).toBe("exact");
  });
  const numeric = new NumericScorer();
  it.each([
    ["exact", "5", 5, 0, undefined, true], ["within tolerance", "5.004", 5, 0.01, undefined, true], ["outside tolerance", "5.02", 5, 0.01, undefined, false], ["unit same", "2 公尺", 2, 0, "公尺", true], ["unit different", "2 秒", 2, 0, "公尺", false], ["nan", "NaN", 5, 1, undefined, false], ["infinity", "Infinity", 5, 1, undefined, false], ["missing", undefined, 5, 1, undefined, false]
  ])("numeric %s", (_name, answer, expectedValue, tolerance, unit, passed) => {
    expect(numeric.score(testCase({ kind: "numeric", expectedValue, tolerance, unit }), answer as string | undefined).passed).toBe(passed);
  });

  // Regression: a worked solution states operands first and the final answer
  // last. The scorer must take the LAST finite number, not the first, so prose
  // like "2 + 3 = 5" does not produce numeric_out_of_tolerance. This mirrors
  // MathematicsVerifier.extractAnswerNumber.
  it.each([
    ["addition prose", "2 + 3 = 5", 5, 0],
    ["parentheses multi-step", "計算 (2 + 5) * 2：先算 2 + 5 = 7，再乘以 2 得到 14。", 14, 0],
    ["parentheses equation form", "(2 + 5) * 2 = 7 * 2 = 14", 14, 0],
    ["decimal worked solution", "1.25 + 2.25 = 3.5", 3.5, 0.0001],
    ["decimal prose with steps", "計算 1.25 + 2.25：\n1.25 + 2.25 = 3.50\n答案為 3.5。", 3.5, 0.0001],
    ["step-numbered prose", "步驟 1：將 2 與 3 相加。\n步驟 2：得到 5。\n最終答案為 5。", 5, 0],
    ["bare final number", "答案是 5。", 5, 0],
    ["chinese verb prose", "2 加 3 等於 5。", 5, 0],
    ["percent to fraction", "答案是 25%", 0.25, 0],
    ["percent of base prose", "200 的 25% 是 50", 50, 0],
    ["thousands separator", "1,234 + 0 = 1,234", 1234, 0],
    ["negative result", "5 - 8 = -3", -3, 0],
    ["scientific notation", "速度約為 3.0e8 公尺每秒", 3e8, 0],
    ["leading-dot decimal", "結果是 .5", 0.5, 0]
  ])("numeric prose takes last number: %s", (_name, answer, expectedValue, tolerance) => {
    expect(numeric.score(testCase({ kind: "numeric", expectedValue, tolerance }), answer).passed).toBe(true);
  });

  // Known limitation of the last-number heuristic: if the model appends a
  // follow-up sentence containing another number AFTER the final answer, that
  // later number is taken instead. This is documented here (not silently
  // masked) because the in-scope fix is extraction alignment, not a structured
  // prompt; the scorer and verifier share the same limitation.
  it("numeric documents last-number limitation when a number follows the answer", () => {
    const result = numeric.score(testCase({ kind: "numeric", expectedValue: 5, tolerance: 0 }), "答案是 5。補充：第 2 題稍後說明。");
    expect(result.passed).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "numeric_out_of_tolerance" }));
  });

  it("numeric missing when no finite number present", () => {
    const result = numeric.score(testCase({ kind: "numeric", expectedValue: 5, tolerance: 1 }), "無法判斷答案");
    expect(result.passed).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "numeric_answer_missing" }));
  });

  it("numeric rejects a wrong final number in prose", () => {
    const result = numeric.score(testCase({ kind: "numeric", expectedValue: 14, tolerance: 0 }), "2 + 5 = 8，再乘以 2 得到 16");
    expect(result.passed).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "numeric_out_of_tolerance" }));
  });
});

describe("evaluation concept, programming, classification, and safety scorers", () => {
  const concept = new ConceptScorer();
  it.each([
    ["all", "封裝可以隱藏實作。", 2, true], ["partial", "封裝。", 1, false], ["minimum", "封裝。", 1, true], ["duplicate", "封裝 封裝 隱藏實作", 2, true], ["forbidden", "封裝，但永遠不需要介面", 1, false]
  ])("concept %s", (_name, answer, expectedScore, passed) => {
    const expectation = _name === "minimum" ? { kind: "required_concepts" as const, required: ["封裝", "隱藏實作"], minimumRequired: 1 } : { kind: "required_concepts" as const, required: ["封裝", "隱藏實作"], forbidden: _name === "forbidden" ? ["永遠"] : undefined };
    const result = concept.score(testCase(expectation), answer);
    expect(result.score).toBe(_name === "forbidden" ? 0 : expectedScore / 2);
    expect(result.passed).toBe(passed);
  });
  const programming = new ProgrammingScorer();
  it.each([
    ["findings", "undefined behavior，不能固定輸出。", ["undefined behavior", "不能固定輸出"], true], ["missing finding", "undefined behavior。", ["undefined behavior", "不能固定輸出"], false], ["forbidden", "這一定會固定輸出。", ["固定輸出"], false], ["compile", "compile error 發生在編譯期。", ["compile error"], true], ["runtime", "runtime warning 發生在執行時。", ["runtime warning"], true], ["rule based", "答案。", ["另一個必要發現"], false]
  ])("programming %s", (_name, answer, findings, expectedPassed) => {
    const expectation = { kind: "programming_analysis" as const, requiredFindings: findings as string[], forbiddenClaims: _name === "forbidden" ? ["固定輸出"] : undefined, requiresUndefinedBehaviorNotice: _name === "findings", requiresCompileErrorNotice: _name === "compile", requiresRuntimeWarning: _name === "runtime" };
    expect(programming.score(testCase(expectation), answer).passed).toBe(expectedPassed);
  });
  it("does not execute student code and reports runtime unavailable", async () => {
    const { ProgrammingStaticVerifier } = await import("../../src");
    const evidence = await new ProgrammingStaticVerifier().verify({ requestId: "eval:test:domain", question: "分析 C code", primaryAnswer: "沒有固定輸出，undefined behavior。", logicalModelId: "mock", classification: { category: "programming", confidence: 1, source: "deterministic", reasons: [] } });
    expect(evidence.runtimeVerification).toBe("unavailable");
  });
  const classification = new ClassificationScorer();
  it.each([["match", "knowledge", true], ["mismatch", "programming", false], ["unknown", "unknown", true]])("classification %s", (_name, actual, passed) => {
    const expectedCategory = actual === "programming" ? "unknown" : actual;
    expect(classification.score(testCase({ kind: "classification", expectedCategory: expectedCategory as "programming" | "mathematics" | "knowledge" | "unknown" }), "", { classification: actual }).passed).toBe(passed);
  });
  const safety = new SafetyScorer();
  it.each([
    ["preserve", true, "verified", undefined, true], ["forbidden", false, "verified", ["api key"], false], ["outcome", false, "verified", undefined, true], ["wrong outcome", false, "primary_only", undefined, false], ["provider error text", false, "verified", ["provider response"], false]
  ])("safety %s", (_name, preserve, outcome, forbidden, passed) => {
    const result = safety.score(testCase({ kind: "safety", mustPreservePrimary: preserve, mustNotContain: forbidden ?? undefined, expectedOutcome: outcome as never }), forbidden?.[0] ?? "Primary answer.", { primaryAnswer: "Primary answer.", outcome: "verified" });
    expect(result.passed).toBe(passed);
  });
});
