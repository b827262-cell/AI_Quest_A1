import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { Book, BookChapter, BookContent } from "@ai-smartbook/schema";
import type { StudentBookDetail, StudentBookPdfFile, StudentDataSource } from "./dataSource";

interface BookRow {
  id: string;
  title: string;
  subtitle: string | null;
  description: string | null;
  cover_url: string | null;
  category: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

interface ChapterRow {
  id: string;
  book_id: string;
  title: string;
  summary: string | null;
  order_index: number;
  page_start: number | null;
  page_end: number | null;
  level?: number | null;
  source?: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

interface ContentRow {
  id: string;
  book_id: string;
  file_id: string | null;
  chapter_id: string | null;
  page_number: number | null;
  content_text: string;
  order_index: number;
  created_at: string;
}

interface BookFileRow {
  id: string;
  book_id: string;
  file_name: string;
  file_path: string;
  file_type: string;
  file_size: number;
  role: string;
  created_at: string;
}

function toBook(r: BookRow): Book {
  return {
    id: r.id,
    title: r.title,
    subtitle: r.subtitle,
    description: r.description,
    coverUrl: r.cover_url,
    category: r.category ?? "未分類",
    status: r.status as Book["status"],
    createdAt: r.created_at,
    updatedAt: r.updated_at
  };
}

function toChapter(r: ChapterRow): BookChapter {
  return {
    id: r.id,
    bookId: r.book_id,
    title: r.title,
    summary: r.summary,
    orderIndex: r.order_index,
    pageStart: r.page_start,
    pageEnd: r.page_end,
    level: r.level ?? 0,
    source: (r.source ?? "manual") as BookChapter["source"],
    status: r.status as BookChapter["status"],
    createdAt: r.created_at,
    updatedAt: r.updated_at
  };
}

function toContent(r: ContentRow): BookContent {
  return {
    id: r.id,
    bookId: r.book_id,
    fileId: r.file_id,
    chapterId: r.chapter_id,
    pageNumber: r.page_number,
    contentText: r.content_text,
    orderIndex: r.order_index,
    createdAt: r.created_at
  };
}

function toPdfFile(r: BookFileRow): StudentBookPdfFile {
  return {
    id: r.id,
    bookId: r.book_id,
    fileName: r.file_name,
    filePath: r.file_path,
    fileType: r.file_type,
    fileSize: r.file_size,
    role: r.role
  };
}

/**
 * Read-only SQLite data source for the `sqlite-api` runtime mode. Only
 * published books are exposed to students.
 */
export class SqliteDataSource implements StudentDataSource {
  private readonly db: Database.Database;

  constructor(dbPath: string, readonly = true) {
    // Make sure the parent directory exists before opening; in dev this keeps
    // a missing data dir from crashing startup. On an unwritable path (e.g.
    // /opt) this is a no-op and the open below surfaces a clear error instead.
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      try {
        mkdirSync(dir, { recursive: true });
      } catch {
        /* ignore — surfaced as an explicit open error below */
      }
    }

    // A read-only connection must require an existing file (it cannot create
    // one) and must never run a writable PRAGMA such as journal_mode = WAL.
    this.db = new Database(dbPath, { readonly, fileMustExist: readonly });
    if (!readonly) {
      this.db.pragma("journal_mode = WAL");
    }
  }

  private findPrimaryPdfFile(bookId: string): StudentBookPdfFile | null {
    const row = this.db
      .prepare(
        `SELECT *
         FROM book_files
         WHERE book_id = ?
           AND role = 'source_document'
           AND (file_type = 'application/pdf' OR lower(file_name) LIKE '%.pdf')
         ORDER BY created_at DESC
         LIMIT 1`
      )
      .get(bookId) as BookFileRow | undefined;
    return row ? toPdfFile(row) : null;
  }

  async listBooks(): Promise<Book[]> {
    const rows = this.db
      .prepare("SELECT * FROM books WHERE status = 'published' ORDER BY created_at DESC")
      .all() as BookRow[];
    return rows.map(toBook);
  }

  async getBook(bookId: string): Promise<StudentBookDetail | null> {
    const row = this.db
      .prepare("SELECT * FROM books WHERE id = ? AND status = 'published'")
      .get(bookId) as BookRow | undefined;
    if (!row) return null;
    const chapters = (
      this.db
        .prepare("SELECT * FROM book_chapters WHERE book_id = ? ORDER BY order_index ASC")
        .all(bookId) as ChapterRow[]
    ).map(toChapter);
    const pdfFile = this.findPrimaryPdfFile(bookId);
    return {
      ...toBook(row),
      chapters,
      pdfFileId: pdfFile?.id ?? null,
      pdfFileName: pdfFile?.fileName ?? null
    };
  }

  async getContents(bookId: string): Promise<BookContent[]> {
    const rows = this.db
      .prepare("SELECT * FROM book_contents WHERE book_id = ? ORDER BY order_index ASC")
      .all(bookId) as ContentRow[];
    return rows.map(toContent);
  }

  async getPdfFile(bookId: string, fileId: string): Promise<StudentBookPdfFile | null> {
    const row = this.db
      .prepare(
        `SELECT *
         FROM book_files
         WHERE id = ?
           AND book_id = ?
           AND role = 'source_document'
           AND (file_type = 'application/pdf' OR lower(file_name) LIKE '%.pdf')
         LIMIT 1`
      )
      .get(fileId, bookId) as BookFileRow | undefined;
    return row ? toPdfFile(row) : null;
  }

  close(): void {
    this.db.close();
  }
}
