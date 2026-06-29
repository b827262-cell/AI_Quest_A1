import type { Book, BookChapter, BookContent } from "@ai-smartbook/schema";
import type { StudentBookDetail, StudentBookPdfFile, StudentDataSource } from "./dataSource";

const now = "2026-01-01T00:00:00.000Z";

const DEMO_BOOK: Book = {
  id: "demo",
  title: "智能書本範例：學習導論",
  subtitle: "AI SmartBook Demo",
  description: "靜態模式內建的範例書本，用於前台 UX 驗證。",
  coverUrl: null,
  category: "未分類",
  status: "published",
  createdAt: now,
  updatedAt: now
};

const DEMO_CHAPTERS: BookChapter[] = [
  {
    id: "demo-ch1",
    bookId: "demo",
    title: "第一章 智能書本概論",
    summary: "介紹智能書本的概念與學習方式。",
    orderIndex: 0,
    pageStart: 1,
    pageEnd: 3,
    level: 0,
    source: "manual",
    status: "published",
    createdAt: now,
    updatedAt: now
  }
];

const DEMO_CONTENTS: BookContent[] = [
  {
    id: "demo-c1",
    bookId: "demo",
    chapterId: "demo-ch1",
    fileId: null,
    pageNumber: 1,
    orderIndex: 0,
    contentText: "智能書本結合文字內容與 AI 問答，讀者可以閱讀章節，也可以直接向書本提問。",
    createdAt: now
  },
  {
    id: "demo-c2",
    bookId: "demo",
    chapterId: "demo-ch1",
    fileId: null,
    pageNumber: 2,
    orderIndex: 1,
    contentText: "系統將 PDF 解析為段落，透過 AI 拆書建立章節，並提供以書本內容為基礎的知識問答。",
    createdAt: now
  },
  {
    id: "demo-c3",
    bookId: "demo",
    chapterId: "demo-ch1",
    fileId: null,
    pageNumber: 3,
    orderIndex: 2,
    contentText: "在 1GB 部署模式下，前台使用 SQLite 與關鍵字檢索回答問題，不需連線外部 AI 服務。",
    createdAt: now
  }
];

/** In-memory data source for the `static` runtime mode. */
export class StaticDataSource implements StudentDataSource {
  async listBooks(): Promise<Book[]> {
    return [DEMO_BOOK];
  }

  async getBook(bookId: string): Promise<StudentBookDetail | null> {
    if (bookId !== DEMO_BOOK.id) return null;
    return { ...DEMO_BOOK, chapters: DEMO_CHAPTERS, pdfFileId: null, pdfFileName: null };
  }

  async getContents(bookId: string): Promise<BookContent[]> {
    if (bookId !== DEMO_BOOK.id) return [];
    return DEMO_CONTENTS;
  }

  async getPdfFile(_bookId: string, _fileId: string): Promise<StudentBookPdfFile | null> {
    return null;
  }
}
