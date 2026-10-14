import type { BookChapter } from "@ai-smartbook/schema";
import { type BookCoreContext, extractJson } from "./context";

interface ChapterDraft {
  title: string;
  summary?: string;
  pageStart?: number | null;
  pageEnd?: number | null;
}

/**
 * Use the AI provider to propose a chapter outline from book contents,
 * then persist the drafts as book_chapters. Returns the created chapters.
 */
export async function splitBookIntoChapters(
  ctx: BookCoreContext,
  bookId: string
): Promise<BookChapter[]> {
  const book = ctx.repos.books.findById(bookId);
  if (!book) throw new Error(`Book not found: ${bookId}`);

  const contents = ctx.repos.contents.findByBookId(bookId);
  const contentText = contents.map((c) => c.contentText).join("\n\n");

  const prompt = ctx.prompts.buildSplitBookPrompt({ bookTitle: book.title, contentText });
  const raw = await ctx.ai.generateText(prompt);
  const drafts = extractJson<ChapterDraft[]>(raw) ?? [];

  const safeDrafts: ChapterDraft[] =
    drafts.length > 0
      ? drafts
      : [{ title: `${book.title} 全書內容`, summary: "自動建立的單一章節。" }];

  const created = ctx.repos.chapters.createMany(
    safeDrafts.map((d, i) => ({
      bookId,
      title: d.title?.trim() || `第 ${i + 1} 章`,
      summary: d.summary ?? null,
      orderIndex: i,
      pageStart: d.pageStart ?? null,
      pageEnd: d.pageEnd ?? null,
      status: "draft" as const
    }))
  );

  return created;
}
