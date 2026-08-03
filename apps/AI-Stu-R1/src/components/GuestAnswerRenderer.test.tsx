import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { GuestAnswerContent } from "@ai-smartbook/schema";
import {
  normalizeGuestAnswerContent,
  parseMarkdownBlocks,
  STRUCTURED_SECTION_HEADING_PATTERN,
  StructuredStudentAnswer
} from "./GuestAnswerRenderer";

const CURRENT_CONTENT: GuestAnswerContent = {
  summary: "計算兩矩形覆蓋面積。",
  steps: ["計算 overlapX。", "計算 overlapY。"],
  examples: [],
  markdownText: "計算兩矩形覆蓋面積。"
};

describe("guest answer Markdown fallback", () => {
  it("parses headings, emphasis, code fences, lists and GFM tables", () => {
    const blocks = parseMarkdownBlocks([
      "#### 解法",
      "這是 **重點** 與 `code`。",
      "",
      "- 讀取輸入",
      "- 計算結果",
      "",
      "| 輸入 | 輸出 |",
      "| --- | --- |",
      "| 100 999 | 153 370 371 407 |",
      "",
      "```python",
      "print('ok')",
      "```"
    ].join("\n"));

    expect(blocks.map((block) => block.kind)).toEqual([
      "heading",
      "paragraph",
      "unordered-list",
      "table",
      "code"
    ]);
    expect(blocks[0]).toMatchObject({ level: 4, text: "解法" });
    expect(blocks[2]).toMatchObject({ items: ["讀取輸入", "計算結果"] });
    expect(blocks[3]).toMatchObject({ headers: ["輸入", "輸出"], rows: [["100 999", "153 370 371 407"]] });
    expect(blocks[4]).toMatchObject({ language: "python", code: "print('ok')" });
  });

  it("keeps model text as React text instead of raw HTML", () => {
    const source = readFileSync(new URL("./GuestAnswerRenderer.tsx", import.meta.url), "utf8");
    // This source-level assertion protects the public answer boundary from
    // being changed to unsanitised dangerouslySetInnerHTML later.
    expect(source).not.toContain("dangerouslySetInnerHTML");
    expect(source).toContain("<pre className=\"answer-code-block\">");
  });

  it("keeps current structured payload content unchanged", () => {
    expect(normalizeGuestAnswerContent(CURRENT_CONTENT)).toEqual(CURRENT_CONTENT);
  });

  it("normalizes legacy summary and step section headings before rendering", () => {
    const legacy: GuestAnswerContent = {
      ...CURRENT_CONTENT,
      summary: "## 題意摘要\n計算兩矩形覆蓋面積。",
      steps: ["解題步驟", "計算 overlapX。", "### 複雜度分析", "計算 overlapY。"]
    };
    const normalized = normalizeGuestAnswerContent(legacy);

    expect(normalized.summary).toBe("計算兩矩形覆蓋面積。");
    expect(normalized.steps).toEqual(["計算 overlapX。", "計算 overlapY。"]);
    const markup = renderToStaticMarkup(<StructuredStudentAnswer content={legacy} />);
    expect(markup.match(/題意摘要/g)).toHaveLength(1);
    expect(markup.match(/解題步驟/g)).toHaveLength(1);
    expect(markup).not.toContain("複雜度分析");
  });

  it("uses meaningful markdown text when a legacy summary is only a heading", () => {
    const normalized = normalizeGuestAnswerContent({
      ...CURRENT_CONTENT,
      summary: "題意摘要",
      markdownText: "題意摘要\n\n實際題目摘要。"
    });

    expect(normalized.summary).toBe("實際題目摘要。");
  });
});

describe("expanded section heading normalization in renderer", () => {
  const EXPANDED_LABELS = [
    "解題重點", "核心結論", "解法摘要", "解題思路",
    "關鍵觀察", "核心概念", "解法說明", "演算法說明",
    "重點整理", "解題方向", "問題分析", "思路分析",
    "答案", "結論"
  ];

  it("frontend pattern matches all expanded heading labels", () => {
    for (const label of EXPANDED_LABELS) {
      expect(STRUCTURED_SECTION_HEADING_PATTERN.test(label)).toBe(true);
      expect(STRUCTURED_SECTION_HEADING_PATTERN.test(`## ${label}`)).toBe(true);
      expect(STRUCTURED_SECTION_HEADING_PATTERN.test(`${label}：`)).toBe(true);
    }
  });

  it("normalizes legacy content with new heading labels in summary", () => {
    const legacy: GuestAnswerContent = {
      ...CURRENT_CONTENT,
      summary: "## 解法摘要\n這是真正的摘要。",
      steps: ["核心結論", "第一步。", "### 解題思路", "第二步。"]
    };
    const normalized = normalizeGuestAnswerContent(legacy);

    expect(normalized.summary).toBe("這是真正的摘要。");
    expect(normalized.steps).toEqual(["第一步。", "第二步。"]);
  });

  it("normalizes steps that are only new-type headings", () => {
    const normalized = normalizeGuestAnswerContent({
      ...CURRENT_CONTENT,
      steps: ["解題重點", "關鍵觀察", "實際步驟內容。", "重點整理"]
    });
    expect(normalized.steps).toEqual(["實際步驟內容。"]);
  });

  it("does not strip heading text when embedded in a sentence", () => {
    const normalized = normalizeGuestAnswerContent({
      ...CURRENT_CONTENT,
      summary: "本題的核心概念是遞迴分治策略。",
      steps: ["運用解題思路找到突破口。", "根據關鍵觀察進行推導。"]
    });
    expect(normalized.summary).toBe("本題的核心概念是遞迴分治策略。");
    expect(normalized.steps).toEqual(["運用解題思路找到突破口。", "根據關鍵觀察進行推導。"]);
  });

  it("uses markdownText fallback when summary is only an expanded heading", () => {
    const normalized = normalizeGuestAnswerContent({
      ...CURRENT_CONTENT,
      summary: "核心結論",
      markdownText: "核心結論\n\n真正的結論在這裡。"
    });
    expect(normalized.summary).toBe("真正的結論在這裡。");
  });

  it("falls back to default when markdownText has only headings and steps", () => {
    const normalized = normalizeGuestAnswerContent({
      ...CURRENT_CONTENT,
      summary: "解法摘要",
      markdownText: "解法摘要\n1. 步驟一。\n2. 步驟二。"
    });
    // With only headings + numbered steps, summaryFallbackFromMarkdown returns the default.
    expect(normalized.summary).toBe("請依題目條件與輸出要求完成解題。");
  });

  it("preserves rendering with exactly one UI heading for each section", () => {
    const legacy: GuestAnswerContent = {
      ...CURRENT_CONTENT,
      summary: "### 解題重點\n計算面積。",
      steps: ["演算法說明", "步驟一。", "步驟二。"]
    };
    const markup = renderToStaticMarkup(<StructuredStudentAnswer content={legacy} />);
    // The UI adds its own "題意摘要" and "解題步驟" headings;
    // "解題重點" and "演算法說明" from the data must not duplicate them.
    expect(markup).not.toContain("解題重點");
    expect(markup).not.toContain("演算法說明");
    expect(markup.match(/題意摘要/g)).toHaveLength(1);
    expect(markup.match(/解題步驟/g)).toHaveLength(1);
  });
});
