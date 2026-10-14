import type { BookContent, BookQaLog } from "@ai-smartbook/schema";
import type { BookCoreContext } from "./context";

export interface BookQaResult {
  answer: string;
  contextChunks: string[];
  log: BookQaLog;
}

/**
 * Build search tokens from a query. Latin words are kept whole; CJK text is
 * expanded into character bigrams so retrieval works without word spacing.
 */
export function tokenizeQuery(question: string): string[] {
  const grams = new Set<string>();
  for (const w of question.split(/[\s,，。．.!?？！、:：;；()「」『』\[\]]+/)) {
    const t = w.trim().toLowerCase();
    if (t.length >= 2 && /[a-z0-9]/.test(t)) grams.add(t);
  }
  const cleaned = question.replace(/[\s,，。．.!?？！、:：;；()「」『』\[\]]+/g, "").toLowerCase();
  for (let i = 0; i < cleaned.length - 1; i++) {
    grams.add(cleaned.slice(i, i + 2));
  }
  return [...grams];
}

/** Naive keyword retrieval: rank contents by how many query tokens they contain. */
function retrieveContext(
  ctx: BookCoreContext,
  bookId: string,
  question: string,
  limit: number
): BookContent[] {
  const tokens = tokenizeQuery(question);

  const all = ctx.repos.contents.findByBookId(bookId);
  if (tokens.length === 0) return all.slice(0, limit);

  const scored = all
    .map((c) => {
      const text = c.contentText.toLowerCase();
      const score = tokens.reduce((acc, t) => acc + (text.includes(t) ? 1 : 0), 0);
      return { c, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    // Fall back to keyword search on the strongest single token.
    const matches = ctx.repos.contents.searchByKeyword(bookId, tokens[0]);
    return matches.slice(0, limit);
  }

  return scored.slice(0, limit).map((s) => s.c);
}

/**
 * Answer a question about a book: retrieve relevant passages, call the AI
 * provider, persist a qa log, and return the answer with its context.
 */
export async function askBookQuestion(
  ctx: BookCoreContext,
  bookId: string,
  question: string,
  options: { chapterId?: string | null; contextLimit?: number } = {}
): Promise<BookQaResult> {
  const book = ctx.repos.books.findById(bookId);
  if (!book) throw new Error(`Book not found: ${bookId}`);

  const limit = options.contextLimit ?? 4;
  const contextContents = retrieveContext(ctx, bookId, question, limit);
  const contextChunks = contextContents.map((c) => c.contentText);

  const prompt = ctx.prompts.buildBookQaPrompt({
    bookTitle: book.title,
    question,
    contextChunks
  });
  const answer = (await ctx.ai.generateText(prompt)).trim();

  const log = ctx.repos.qaLogs.create({
    bookId,
    chapterId: options.chapterId ?? null,
    question,
    answer,
    contextJson: JSON.stringify(contextChunks),
    provider: ctx.ai.name,
    model: ctx.ai.model
  });

  return { answer, contextChunks, log };
}
