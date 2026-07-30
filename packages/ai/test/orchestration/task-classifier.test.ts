import { describe, expect, it } from "vitest";
import { classifyTaskCategory } from "../../src";

describe("deterministic task classification", () => {
  it("classifies a C pointer question as programming", () => {
    expect(classifyTaskCategory("```c int a[5]; int *p = (int *)(&a + 1); ```").category).toBe("programming");
  });

  it("classifies Python syntax as programming", () => {
    expect(classifyTaskCategory("請 debug Python 的 list function。表現為何？").category).toBe("programming");
  });

  it("classifies SQL as programming", () => {
    expect(classifyTaskCategory("請說明 SQL SELECT 與 JOIN 的差異。").category).toBe("programming");
  });

  it("classifies a four-operation expression as mathematics", () => {
    expect(classifyTaskCategory("計算 2 + 3 * 4 的結果。").category).toBe("mathematics");
  });

  it("classifies a percentage question as mathematics", () => {
    expect(classifyTaskCategory("25% 的 200 是多少？").category).toBe("mathematics");
  });

  it("classifies a linear equation as mathematics", () => {
    expect(classifyTaskCategory("解方程式 2x + 3 = 7。").category).toBe("mathematics");
  });

  it("classifies a definition question as knowledge", () => {
    expect(classifyTaskCategory("什麼是供應鏈管理？").category).toBe("knowledge");
  });

  it("classifies a comparison question as knowledge", () => {
    expect(classifyTaskCategory("比較民主與共和制度的差異。").category).toBe("knowledge");
  });

  it("falls back to unknown when no reliable signal exists", () => {
    expect(classifyTaskCategory("請給我一個適合今天的回答。").category).toBe("unknown");
  });

  it("uses deterministic source for a high-confidence match", () => {
    const result = classifyTaskCategory("請 debug 這段 TypeScript function。");
    expect(result).toMatchObject({ category: "programming", source: "deterministic" });
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("returns bounded confidence and safe reason codes", () => {
    const result = classifyTaskCategory("模糊內容");
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
    expect(result.reasons).toEqual(["no_reliable_signal"]);
    expect(JSON.stringify(result)).not.toContain("模糊內容");
  });

  it("does not require a model call for deterministic classification", () => {
    const result = classifyTaskCategory("SQL API compiler runtime error");
    expect(result.source).toBe("deterministic");
  });
});
