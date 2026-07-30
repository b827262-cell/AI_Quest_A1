import { describe, expect, it } from "vitest";
import { ProgrammingStaticVerifier, type VerificationStrategyContext } from "../../src";

function context(question: string, primaryAnswer: string): VerificationStrategyContext {
  return {
    requestId: "programming-test",
    question,
    primaryAnswer,
    logicalModelId: "primary",
    classification: { category: "programming", confidence: 0.98, source: "deterministic", reasons: ["code_fence"] }
  };
}

describe("safe programming static verifier", () => {
  const verifier = new ProgrammingStaticVerifier();

  it("flags an answer that references an undeclared variable", async () => {
    const result = await verifier.verify(context("```c\nint a = 1;\n```", "變數 x 未宣告，因此 x 是 2。"));
    expect(result.status).toBe("failed");
    expect(result.issues).toContainEqual(expect.objectContaining({ category: "undefined_variable", severity: "high" }));
  });

  it("flags undefined behavior claimed as a fixed output", async () => {
    const result = await verifier.verify(context("```c\nint a[2]; a[2] is undefined behavior\n```", "這段程式一定固定輸出 0。"));
    expect(result.issues).toContainEqual(expect.objectContaining({ category: "undefined_behavior", severity: "high" }));
  });

  it("does not call runtime and reports unavailable without a sandbox", async () => {
    const result = await verifier.verify(context("```python\nprint(1)\n```", "這段程式會輸出 1。"));
    expect(result.runtimeVerification).toBe("unavailable");
  });

  it("accepts a careful pointer one-past-end explanation as partial", async () => {
    const result = await verifier.verify(context(
      "```c\nint a[5] = {1,2,3,4,5}; int *p = (int *)(&a + 1);\n```",
      "&a + 1 指向整個陣列之後；p - 1 才能指向最後一個元素，直接解參考 p 有風險。"
    ));
    expect(result.issues.filter((issue) => issue.severity === "high")).toHaveLength(0);
    expect(result.runtimeVerification).toBe("unavailable");
  });

  it("flags the difference between dereferencing before and after subtraction", async () => {
    const result = await verifier.verify(context(
      "```c\nint a[5]; int *p = (int *)(&a + 1);\n```",
      "*p - 1 和 *(p - 1) 完全等價。"
    ));
    expect(result.issues).toContainEqual(expect.objectContaining({ category: "pointer_array", severity: "high" }));
  });

  it("flags a language mismatch", async () => {
    const result = await verifier.verify(context("請用 Python 解釋這個 function。", "Java 的 class 會在編譯期處理。"));
    expect(result.issues).toContainEqual(expect.objectContaining({ category: "language_mismatch", severity: "high" }));
  });

  it("flags compile-time and runtime confusion", async () => {
    const result = await verifier.verify(context("這是 compile-time error 還是什麼？", "這是 runtime 執行時才會發生。"));
    expect(result.issues).toContainEqual(expect.objectContaining({ category: "compile_runtime", severity: "medium" }));
  });

  it("flags an answer that ignores a supplied program", async () => {
    const result = await verifier.verify(context("```c\nint answer = 42;\n```", "答案是很好。"));
    expect(result.issues).toContainEqual(expect.objectContaining({ category: "missing_code_analysis", severity: "high" }));
  });

  it("keeps evidence free of source text and control characters", async () => {
    const result = await verifier.verify(context("```c\nint a = 1;\n```", "變數 x 未宣告。\u0000"));
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("int a = 1");
    expect(serialized).not.toContain("\\u0000");
  });

  it("supports the strategy only for programming", () => {
    expect(verifier.supports("programming")).toBe(true);
    expect(verifier.supports("mathematics")).toBe(false);
  });
});
