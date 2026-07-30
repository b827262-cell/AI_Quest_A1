import { describe, expect, it } from "vitest";
import {
  armstrongNumbersInRange,
  armstrongOutputForRange,
  buildStudentAnswer,
  validateStudentAnswer
} from "../src/gateway/student-answer";
import { classifyProblem } from "../src/orchestration/classification/task-classifier";

const ARMSTRONG_QUESTION = "如何把一個複雜的程式問題拆成小步驟？所謂 Armstrong number 指的是一個 n 位數的整數，它的所有位數的 n 次方和恰好等於自己。請依題目需求在一定範圍內找出該範圍內的所有 Armstrong numbers。輸入：100 999";

describe("student answer contract", () => {
  it("classifies Armstrong as programming/number-theory without graph analysis", () => {
    expect(classifyProblem(ARMSTRONG_QUESTION)).toEqual({
      problemType: "programming",
      topic: "number-theory",
      requiresGraphAnalysis: false
    });
  });

  it("repairs the Armstrong answer into fixed fields and removes leaked JSON", () => {
    const answer = buildStudentAnswer(ARMSTRONG_QUESTION, [
      "#### 圖論分析",
      "頂點與 Degree 不適用。",
      '{"edges":[],"degrees":{},"articulationPoints":[],"answer":"none"}',
      "**錯誤的自由格式答案**"
    ].join("\n"));

    expect(answer.summary).toContain("Armstrong number");
    expect(answer.steps).toHaveLength(5);
    expect(answer.codeLanguage).toBe("python");
    expect(answer.code).toContain("def is_armstrong");
    expect(answer.examples).toEqual([
      { input: "100 999", output: "153 370 371 407" },
      { input: "10 99", output: "none" }
    ]);
    expect(JSON.stringify(answer)).not.toContain("edges");
    expect(JSON.stringify(answer)).not.toContain("degrees");
    expect(JSON.stringify(answer)).not.toContain("articulationPoints");
    expect(JSON.stringify(answer)).not.toContain('"answer":"none"');
    expect(validateStudentAnswer(ARMSTRONG_QUESTION, answer).valid).toBe(true);
  });

  it("uses a deterministic reference for the required Armstrong ranges", () => {
    expect(armstrongOutputForRange(100, 999)).toBe("153 370 371 407");
    expect(armstrongOutputForRange(10, 99)).toBe("none");
    expect(armstrongOutputForRange(1, 9)).toBe("1 2 3 4 5 6 7 8 9");
    expect(armstrongOutputForRange(407, 408)).toBe("407");
    expect(armstrongNumbersInRange(1, 1_000_000)).toContain(548834);
  });

  it("keeps human graph explanation while removing machine JSON", () => {
    const question = "給定一個圖，請使用 DFS 找出頂點、邊與割點。";
    const answer = buildStudentAnswer(question, [
      "## 圖論分析",
      "移除頂點 2 後連通分量增加，因此 2 是割點。",
      "```json",
      '{"edges":[[1,2]],"degrees":{"1":1},"articulationPoints":[2]}',
      "```"
    ].join("\n"));

    expect(answer.markdownText).toContain("割點");
    expect(answer.markdownText).not.toContain("GRAPH_ANSWER");
    expect(answer.markdownText).not.toContain('"edges"');
    expect(answer.markdownText).not.toContain('"articulationPoints"');
  });
});
