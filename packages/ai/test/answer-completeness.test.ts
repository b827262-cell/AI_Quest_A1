import { describe, expect, it } from "vitest";
import { assessAnswerCompleteness } from "../src";

describe("lightweight answer completeness checks", () => {
  const fourSorts = "請詳述：\n1. Bubble Sort\n2. Insertion Sort\n3. Merge Sort\n4. Quick Sort";

  it("detects length stops and missing numbered items", () => {
    const result = assessAnswerCompleteness(fourSorts, "1. Bubble Sort\n2. Insertion Sort", {
      finishReason: "length"
    });
    expect(result.complete).toBe(false);
    expect(result.reasons).toContain("finish_reason_length");
    expect(result.reasons).toContain("missing_requested_items");
  });

  it("does not reject an ordinary short answer", () => {
    const result = assessAnswerCompleteness("什麼是排序？", "排序是整理資料順序的方法。", {
      finishReason: "stop"
    });
    expect(result.complete).toBe(true);
  });

  it("detects an unclosed Markdown code fence", () => {
    const result = assessAnswerCompleteness("請給一段程式", "```ts\nconst answer = true;", {
      finishReason: "stop"
    });
    expect(result.complete).toBe(false);
    expect(result.reasons).toContain("unclosed_code_fence");
  });
});
