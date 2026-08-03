import { describe, expect, it } from "vitest";
import {
  armstrongNumbersInRange,
  armstrongOutputForRange,
  buildStudentAnswer,
  firstProseLineFromMarkdown,
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

describe("expanded section heading normalization", () => {
  const EXPANDED_LABELS = [
    "解題重點", "核心結論", "解法摘要", "解題思路",
    "關鍵觀察", "核心概念", "解法說明", "演算法說明",
    "重點整理", "解題方向", "問題分析", "思路分析",
    "答案", "結論"
  ];

  it("matches all expanded heading labels as standalone lines", () => {
    for (const label of EXPANDED_LABELS) {
      expect(SECTION_HEADING_PATTERN.test(label)).toBe(true);
      expect(SECTION_HEADING_PATTERN.test(`## ${label}`)).toBe(true);
      expect(SECTION_HEADING_PATTERN.test(`### ${label}：`)).toBe(true);
      expect(SECTION_HEADING_PATTERN.test(`${label}:`)).toBe(true);
    }
  });

  it("does not match these labels when embedded in a sentence", () => {
    for (const label of EXPANDED_LABELS) {
      expect(SECTION_HEADING_PATTERN.test(`這是${label}的一部分`)).toBe(false);
      expect(SECTION_HEADING_PATTERN.test(`請參考${label}中的重要資訊`)).toBe(false);
    }
  });

  it("removes consecutive headings leaving only content", () => {
    const text = "## 解題重點\n### 核心結論\n解法摘要\n\n這是實際內容";
    expect(removeSectionHeading(text)).toBe("這是實際內容");
  });

  it("removes Markdown-formatted new heading variants", () => {
    expect(removeSectionHeading("# 解題思路\n找出 pattern")).toBe("找出 pattern");
    expect(removeSectionHeading("#### 關鍵觀察：\n列出前幾項")).toBe("列出前幾項");
    expect(removeSectionHeading("演算法說明:\n使用 BFS")).toBe("使用 BFS");
  });

  it("does not remove lines with heading text mid-sentence", () => {
    const text = "本題的核心概念在於遞迴分治。";
    expect(removeSectionHeading(text)).toBe(text);
  });

  it("handles colon-suffixed headings in both full-width and half-width forms", () => {
    expect(SECTION_HEADING_PATTERN.test("解題方向：")).toBe(true);
    expect(SECTION_HEADING_PATTERN.test("解題方向:")).toBe(true);
    expect(SECTION_HEADING_PATTERN.test("## 思路分析：")).toBe(true);
  });
});

describe("summary fallback from markdownText", () => {
  it("extracts a meaningful line from markdownText when summary is heading-only", () => {
    const answer = buildStudentAnswer("什麼是遞迴？", [
      "解法摘要",
      "遞迴是函數呼叫自己的技巧。",
      "",
      "解題步驟",
      "1. 確認基底條件。",
      "2. 縮小問題規模。",
      "3. 遞迴呼叫。"
    ].join("\n"));

    expect(answer.summary).toContain("遞迴");
    expect(answer.summary).not.toBe("解法摘要");
  });

  it("firstProseLineFromMarkdown skips headings and finds real prose", () => {
    const md = "## 題意摘要\n### 解題重點\n核心概念\n\n真正的摘要內容在這裡。";
    expect(firstProseLineFromMarkdown(md)).toBe("真正的摘要內容在這裡。");
  });

  it("firstProseLineFromMarkdown returns empty string on heading-only input", () => {
    expect(firstProseLineFromMarkdown("題意摘要\n解題步驟")).toBe("");
  });

  it("firstProseLineFromMarkdown strips markdown formatting", () => {
    const md = "解法摘要\n\n**粗體摘要文字**";
    expect(firstProseLineFromMarkdown(md)).toBe("粗體摘要文字");
  });

  it("firstProseLineFromMarkdown skips numbered steps", () => {
    const md = "解題步驟\n1. 第一步。\n2. 第二步。";
    expect(firstProseLineFromMarkdown(md)).toBe("");
  });
});

describe("steps section heading budget protection", () => {
  it("heading-only steps are removed and do not consume the six-step budget", () => {
    const answer = buildStudentAnswer("解釋排序演算法", [
      "題意摘要",
      "排序演算法比較。",
      "",
      "解題步驟",
      "1. 了解 Bubble Sort。",
      "2. 了解 Insertion Sort。",
      "3. 了解 Merge Sort。",
      "4. 了解 Quick Sort。",
      "5. 了解 Heap Sort。",
      "6. 了解 Radix Sort。",
      "## 解題重點",
      "7. 比較時間複雜度。"
    ].join("\n"));

    // "## 解題重點" should be consumed as a section heading, not a step.
    // The six step slots should contain actual content steps, not label lines.
    expect(answer.steps.length).toBeLessThanOrEqual(6);
    expect(answer.steps.every((s) => !SECTION_HEADING_PATTERN.test(s))).toBe(true);
  });

  it("does not count pure section labels towards the step limit", () => {
    const answer = buildStudentAnswer(RECTANGLE_QUESTION, [
      "題意摘要",
      "計算面積。",
      "",
      "解題步驟",
      "解題重點",
      "1. Step A。",
      "核心結論",
      "2. Step B。",
      "結論",
      "3. Step C。"
    ].join("\n"));

    // Steps should contain only "Step A", "Step B", "Step C" — no label lines.
    expect(answer.steps.every((s) => s.startsWith("Step"))).toBe(true);
  });
});
