import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseMarkdownBlocks } from "./GuestAnswerRenderer";

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
});
