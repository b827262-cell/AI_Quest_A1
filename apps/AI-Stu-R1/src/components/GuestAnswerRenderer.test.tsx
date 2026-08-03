import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { GuestAnswerContent } from "@ai-smartbook/schema";
import {
  normalizeGuestAnswerContent,
  parseMarkdownBlocks,
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
