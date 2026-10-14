import type {
  Book,
  BookFile,
  BookContent,
  BookChapter,
  BookQaLog,
  CreateChapterInput,
  UpdateChapterInput,
  CreateQaLogInput
} from "@ai-smartbook/schema";

/** Storage operations owned by book-core; applications supply their implementations.
 * Keep these methods synchronous to preserve the current service behavior.
 */
export interface BookRepositories {
  books: {
    findById(id: string): Book | null;
  };
  files: {
    findByBookId(bookId: string): BookFile[];
  };
  contents: {
    findByBookId(bookId: string): BookContent[];
    findByChapterId(chapterId: string): BookContent[];
    searchByKeyword(bookId: string, keyword: string): BookContent[];
    unlinkChaptersByBookId(bookId: string): void;
    linkChapter(contentId: string, chapterId: string | null): void;
  };
  chapters: {
    findById(id: string): BookChapter | null;
    findByBookId(bookId: string): BookChapter[];
    createMany(inputs: CreateChapterInput[]): BookChapter[];
    update(id: string, input: UpdateChapterInput): BookChapter | null;
  };
  qaLogs: {
    create(input: CreateQaLogInput): BookQaLog;
  };
}

/** The book workflows need text generation only; apps own provider configuration. */
export interface BookAiPrompt {
  system?: string;
  prompt: string;
}

export interface BookAiProvider {
  readonly name: string;
  readonly model: string;
  generateText(input: BookAiPrompt): Promise<string>;
}

/** Pure prompt builders supplied by the application composition layer. */
export interface BookPromptBuilders {
  buildSplitBookPrompt(input: { bookTitle: string; contentText: string }): BookAiPrompt;
  buildSummarizeChapterPrompt(input: { chapterTitle: string; contentText: string }): BookAiPrompt;
  buildBookQaPrompt(input: { bookTitle: string; question: string; contextChunks: string[] }): BookAiPrompt;
}

/** Shared dependencies injected into book-core service functions. */
export interface BookCoreContext {
  repos: BookRepositories;
  ai: BookAiProvider;
  prompts: BookPromptBuilders;
}

/** Extract the first JSON array/object found in a model response. */
export function extractJson<T>(text: string): T | null {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : trimmed;
  const start = candidate.search(/[[{]/);
  if (start === -1) return null;
  const slice = candidate.slice(start);
  try {
    return JSON.parse(slice) as T;
  } catch {
    // Try to trim trailing noise after the last closing bracket.
    const lastArr = slice.lastIndexOf("]");
    const lastObj = slice.lastIndexOf("}");
    const end = Math.max(lastArr, lastObj);
    if (end > 0) {
      try {
        return JSON.parse(slice.slice(0, end + 1)) as T;
      } catch {
        return null;
      }
    }
    return null;
  }
}
