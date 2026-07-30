import { describe, expect, it } from "vitest";
import { classifyProblem, requiresGraphAnalysis } from "../src/orchestration/classification/task-classifier";

describe("problem module gate", () => {
  it("does not activate graph analysis for ordinary programming questions", () => {
    const result = classifyProblem("請用 Python 找出範圍內所有 Armstrong numbers，輸入 100 999。");
    expect(result.problemType).toBe("programming");
    expect(result.topic).toBe("number-theory");
    expect(result.requiresGraphAnalysis).toBe(false);
    expect(requiresGraphAnalysis("請用 Python 找出範圍內所有 Armstrong numbers")).toBe(false);
  });

  it("activates graph analysis only for explicit graph vocabulary", () => {
    const result = classifyProblem("給定頂點與邊，請用 BFS 找最短路並判斷割點。");
    expect(result).toEqual({
      problemType: "graph",
      topic: "graph-algorithm",
      requiresGraphAnalysis: true
    });
  });
});
