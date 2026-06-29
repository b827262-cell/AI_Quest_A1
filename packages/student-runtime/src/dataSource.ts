import type { Book, BookChapter, BookContent } from "@ai-smartbook/schema";

export interface StudentBookPdfFile {
  id: string;
  bookId: string;
  fileName: string;
  filePath: string;
  fileType: string;
  fileSize: number;
  role: string;
}

export interface StudentBookDetail extends Book {
  chapters: BookChapter[];
  pdfFileId?: string | null;
  pdfFileName?: string | null;
}

/** Read-only data access used by the student API across all runtime modes. */
export interface StudentDataSource {
  listBooks(): Promise<Book[]>;
  getBook(bookId: string): Promise<StudentBookDetail | null>;
  getContents(bookId: string): Promise<BookContent[]>;
  getPdfFile(bookId: string, fileId: string): Promise<StudentBookPdfFile | null>;
}
