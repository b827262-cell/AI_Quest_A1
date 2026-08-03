import { describe, expect, it } from "vitest";
import {
  armstrongNumbersInRange,
  armstrongOutputForRange,
  buildStudentAnswer,
  removeSectionHeading,
  SECTION_HEADING_PATTERN,
  validateStudentAnswer
} from "../src/gateway/student-answer";
import { classifyProblem } from "../src/orchestration/classification/task-classifier";

const ARMSTRONG_QUESTION = "如何把一個複雜的程式問題拆成小步驟？所謂 Armstrong number 指的是一個 n 位數的整數，它的所有位數的 n 次方和恰好等於自己。請依題目需求在一定範圍內找出該範圍內的所有 Armstrong numbers。輸入：100 999";
const RECTANGLE_QUESTION = "Night i 有兩個守衛負責的矩形區域，請計算兩矩形交集、恰好被一個矩形覆蓋，以及未被覆蓋的面積。";

describe("student answer contract", () => {
  it("removes section headings from structured field text", () => {
    expect(SECTION_HEADING_PATTERN.test("## 題意摘要")).toBe(true);
    expect(removeSectionHeading("## 題意摘要\n題意摘要\n\n解題步驟\n實際內容")).toBe("實際內容");
  });

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

  it("keeps rectangle formulas, output and complexity after removing headings and definitions from the six-step budget", () => {
    const answer = buildStudentAnswer(RECTANGLE_QUESTION, [
      "題意摘要",
      "題意摘要",
      "",
      "解題步驟",
      "1. 計算 x 方向的重疊長度 overlapX。",
      "2. 同時計算 y 方向的重疊長度 overlapY。",
      "3. strong = overlapX × overlapY。",
      "4. weak = areaA + areaB − 2 × strong。",
      "5. unsecured = 10000 − (areaA + areaB − strong)。",
      "6. 按照 Night i: strong weak unsecured 輸出。",
      "7. 時間複雜度 O(N)、空間複雜度 O(1)。"
    ].join("\n"));

    expect(answer.summary).toBe("給定兩個守衛負責的矩形區域，計算兩矩形交集面積、恰好被一個矩形覆蓋的面積，以及整塊土地未被覆蓋的面積。");
    expect(answer.summary).not.toContain("題意摘要");
    expect(answer.steps).toEqual([
      "計算 x 方向的重疊長度 overlapX。",
      "同時計算 y 方向的重疊長度 overlapY。",
      "按照 Night i: strong weak unsecured 輸出。"
    ]);
    expect(answer.explanation).toContain("strong = overlapX × overlapY。");
    expect(answer.explanation).toContain("weak = areaA + areaB − 2 × strong。");
    expect(answer.explanation).toContain("unsecured = 10000 − (areaA + areaB − strong)。");
    expect(answer.complexity).toBe("時間複雜度 O(N)、空間複雜度 O(1)。");
  });
});
