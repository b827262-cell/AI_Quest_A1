import { describe, expect, it } from "vitest";
import golden from "./test-fixtures/book-prompts.golden.json";
import { bookPromptBuilders } from "./book-core-ai";

describe("injected book prompts match unchanged main goldens", () => {
  for (const testCase of golden.cases) {
    it(testCase.name, () => {
      let actual;
      if (testCase.builder === "buildSplitBookPrompt") {
        actual = bookPromptBuilders.buildSplitBookPrompt(testCase.input as { bookTitle: string; contentText: string });
      } else if (testCase.builder === "buildSummarizeChapterPrompt") {
        actual = bookPromptBuilders.buildSummarizeChapterPrompt(testCase.input as { chapterTitle: string; contentText: string });
      } else {
        actual = bookPromptBuilders.buildBookQaPrompt(testCase.input as { bookTitle: string; question: string; contextChunks: string[] });
      }
      expect(actual).toEqual(testCase.expected);
      expect(Buffer.from(JSON.stringify(actual))).toEqual(Buffer.from(JSON.stringify(testCase.expected)));
    });
  }
});
