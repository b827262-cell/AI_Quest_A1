import type { BookChapter } from "@ai-smartbook/schema";
import type { BookCoreContext } from "./context";

/**
 * Summarise a chapter using the AI provider and persist the result into
 * book_chapters.summary. Returns the updated chapter.
 */
export async function summarizeChapter(
  ctx: BookCoreContext,
  bookId: string,
  chapterId: string
): Promise<BookChapter> {
  const chapter = ctx.repos.chapters.findById(chapterId);
  if (!chapter || chapter.bookId !== bookId) {
    throw new Error(`Chapter not found: ${chapterId}`);
  }

  const chapterContents = ctx.repos.contents.findByChapterId(chapterId);
  const fallbackContents =
    chapterContents.length > 0 ? chapterContents : ctx.repos.contents.findByBookId(bookId);
  const contentText = fallbackContents.map((c) => c.contentText).join("\n\n");

  const prompt = ctx.prompts.buildSummarizeChapterPrompt({
    chapterTitle: chapter.title,
    contentText
  });
  const summary = (await ctx.ai.generateText(prompt)).trim();

  const updated = ctx.repos.chapters.update(chapterId, { summary });
  if (!updated) throw new Error(`Failed to update chapter: ${chapterId}`);
  return updated;
}
