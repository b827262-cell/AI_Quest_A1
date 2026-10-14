import {
  buildBookQaPrompt,
  buildSplitBookPrompt,
  buildSummarizeChapterPrompt
} from "@ai-smartbook/ai";
import type { BookPromptBuilders } from "@ai-smartbook/book-core";

/** Preserve the existing prompt functions verbatim at the application boundary. */
export const bookPromptBuilders: BookPromptBuilders = {
  buildBookQaPrompt,
  buildSplitBookPrompt,
  buildSummarizeChapterPrompt
};
