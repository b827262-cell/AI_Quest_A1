import {
  syncPackageSchema,
  SYNC_SCHEMA_VERSION,
  type SyncPackage
} from "@ai-smartbook/schema";
import { createDbHandle, createRepositories, runMigrations } from "@ai-smartbook/db";

/**
 * Build a SyncPackage from an admin SQLite database. Only published books
 * (with their chapters and contents) are exported for student delivery.
 */
export function exportStudentSync(dbPath: string): SyncPackage {
  const { db, sqlite } = createDbHandle(dbPath);
  const repos = createRepositories(db);

  const books = repos.books.findPublished();
  const chapters = books.flatMap((b) => repos.chapters.findByBookId(b.id));
  const contents = books.flatMap((b) => repos.contents.findByBookId(b.id));

  sqlite.close();

  return {
    version: "0.5.0",
    schemaVersion: SYNC_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    books,
    chapters,
    contents
  };
}

/** Validate an untrusted object as a SyncPackage. Throws on invalid input. */
export function validateSyncPackage(input: unknown): SyncPackage {
  return syncPackageSchema.parse(input);
}

/**
 * Import a validated SyncPackage into a target (student) SQLite database.
 * The target schema is ensured first, then rows for the included books are
 * replaced.
 */
export function importStudentSync(dbPath: string, pkg: SyncPackage): void {
  const validated = validateSyncPackage(pkg);
  const { sqlite } = createDbHandle(dbPath);
  runMigrations(sqlite);

  const tx = sqlite.transaction(() => {
    for (const id of validated.books.map((b) => b.id)) {
      sqlite.prepare("DELETE FROM books WHERE id = ?").run(id);
      sqlite.prepare("DELETE FROM book_chapters WHERE book_id = ?").run(id);
      sqlite.prepare("DELETE FROM book_contents WHERE book_id = ?").run(id);
    }

    const insertBook = sqlite.prepare(
      `INSERT INTO books (id, title, subtitle, description, cover_url, category, status, created_at, updated_at)
       VALUES (@id, @title, @subtitle, @description, @coverUrl, @category, @status, @createdAt, @updatedAt)`
    );
    for (const b of validated.books) {
      insertBook.run({
        id: b.id,
        title: b.title,
        subtitle: b.subtitle ?? null,
        description: b.description ?? null,
        coverUrl: b.coverUrl ?? null,
        category: b.category ?? "未分類",
        status: b.status,
        createdAt: b.createdAt,
        updatedAt: b.updatedAt
      });
    }

    const insertChapter = sqlite.prepare(
      `INSERT INTO book_chapters (id, book_id, title, summary, order_index, page_start, page_end, level, source, status, created_at, updated_at)
       VALUES (@id, @bookId, @title, @summary, @orderIndex, @pageStart, @pageEnd, @level, @source, @status, @createdAt, @updatedAt)`
    );
    for (const c of validated.chapters) {
      insertChapter.run({
        id: c.id,
        bookId: c.bookId,
        title: c.title,
        summary: c.summary ?? null,
        orderIndex: c.orderIndex,
        pageStart: c.pageStart ?? null,
        pageEnd: c.pageEnd ?? null,
        level: c.level ?? 0,
        source: c.source ?? "manual",
        status: c.status,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt
      });
    }

    const insertContent = sqlite.prepare(
      `INSERT INTO book_contents (id, book_id, file_id, chapter_id, page_number, content_text, order_index, created_at)
       VALUES (@id, @bookId, @fileId, @chapterId, @pageNumber, @contentText, @orderIndex, @createdAt)`
    );
    for (const c of validated.contents) {
      insertContent.run({
        id: c.id,
        bookId: c.bookId,
        fileId: c.fileId ?? null,
        chapterId: c.chapterId ?? null,
        pageNumber: c.pageNumber ?? null,
        contentText: c.contentText,
        orderIndex: c.orderIndex,
        createdAt: c.createdAt
      });
    }
  });
  tx();
  sqlite.close();
}
