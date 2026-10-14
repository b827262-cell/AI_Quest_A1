import { describe, expect, it, vi } from "vitest";
import { bookChapterSchema, type Book, type BookContent, type BookChapter, type BookQaLog } from "@ai-smartbook/schema";
import { type BookCoreContext, type BookRepositories } from "../src/context";
import { buildChaptersFromContents, linkChaptersByPageRange } from "../src/chapter-builder";
import { askBookQuestion } from "../src/book-qa";
import { summarizeChapter } from "../src/chapter-summarizer";

/** A complete storage port with no database implementation or connection. */
function fixture() {
  const book: Book = {
    id: "b", title: "Test book", category: "test", status: "draft", createdAt: "now", updatedAt: "now"
  };
  const contents: BookContent[] = [2, 3, 10].map((page, index) => ({
    id: `content-${index}`, bookId: book.id, pageNumber: page,
    contentText: `Repository chapter content ${index}`, orderIndex: index, createdAt: "now"
  }));
  const chapters: BookChapter[] = [];
  const logs: BookQaLog[] = [];
  const repos: BookRepositories = {
    books: { findById: id => id === book.id ? book : null },
    files: { findByBookId: () => [] },
    contents: {
      findByBookId: id => contents.filter(row => row.bookId === id),
      findByChapterId: id => contents.filter(row => row.chapterId === id),
      searchByKeyword: (id, keyword) => contents.filter(row => row.bookId === id && row.contentText.includes(keyword)),
      unlinkChaptersByBookId: id => { for (const row of contents) if (row.bookId === id) row.chapterId = null; },
      linkChapter: (id, chapterId) => { const row = contents.find(row => row.id === id); if (row) row.chapterId = chapterId; }
    },
    chapters: {
      findById: id => chapters.find(row => row.id === id) ?? null,
      findByBookId: id => chapters.filter(row => row.bookId === id),
      createMany: inputs => inputs.map(input => {
        const row = bookChapterSchema.parse({
          ...input, id: `chapter-${chapters.length}`, status: input.status ?? "draft",
          createdAt: "now", updatedAt: "now"
        });
        chapters.push(row);
        return row;
      }),
      update: (id, input) => {
        const row = chapters.find(row => row.id === id);
        if (!row) return null;
        Object.assign(row, input);
        return row;
      }
    },
    qaLogs: {
      create: input => {
        const row = { ...input, id: `qa-${logs.length}`, createdAt: "now" };
        logs.push(row);
        return row;
      }
    }
  };
  const generateText = vi.fn(async () => "answer from fake provider");
  const ctx: BookCoreContext = { repos, ai: { name: "mock", model: "port-test", generateText } };
  return { ctx, contents, chapters, logs, generateText };
}

describe("book-core repository port", () => {
  it("builds and relinks chapter ranges using injected in-memory storage", async () => {
    const { ctx, contents, chapters, generateText } = fixture();
    const built = await buildChaptersFromContents(ctx, "b", 2);
    expect(built.map(row => [row.pageStart, row.pageEnd])).toEqual([[2, 3], [10, 10]]);
    expect(contents.map(row => row.chapterId)).toEqual([chapters[0].id, chapters[0].id, chapters[1].id]);
    expect(linkChaptersByPageRange(ctx, "b")).toBe(3);
    expect(linkChaptersByPageRange(ctx, "b")).toBe(3);
    expect(chapters).toHaveLength(2);
    expect(generateText).not.toHaveBeenCalled();
  });

  it("keeps missing-book behavior without performing writes", async () => {
    const { ctx, chapters, generateText } = fixture();
    await expect(buildChaptersFromContents(ctx, "missing")).rejects.toThrow("Book not found: missing");
    expect(chapters).toHaveLength(0);
    expect(generateText).not.toHaveBeenCalled();
  });

  it("retrieves context and persists QA through the injected storage port", async () => {
    const { ctx, logs, generateText } = fixture();
    const result = await askBookQuestion(ctx, "b", "repository", { contextLimit: 2 });
    expect(result.contextChunks).toHaveLength(2);
    expect(result.answer).toBe("answer from fake provider");
    expect(generateText).toHaveBeenCalledOnce();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ bookId: "b", provider: "mock", model: "port-test", answer: result.answer });
    expect(JSON.parse(logs[0].contextJson!)).toEqual(result.contextChunks);
  });

  it("preserves failure when a chapter update returns null", async () => {
    const { ctx } = fixture();
    const [chapter] = await buildChaptersFromContents(ctx, "b");
    ctx.repos.chapters.update = () => null;
    await expect(summarizeChapter(ctx, "b", chapter.id)).rejects.toThrow(`Failed to update chapter: ${chapter.id}`);
  });
});
