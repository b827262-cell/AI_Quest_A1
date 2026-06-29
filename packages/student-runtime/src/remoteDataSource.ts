import type { Book, BookContent } from "@ai-smartbook/schema";
import type { StudentBookDetail, StudentBookPdfFile, StudentDataSource } from "./dataSource";

/**
 * Data source for the `remote-api` runtime mode. It proxies the admin
 * (AI-adm-D1) student API so the returned book shape matches the student UI
 * contract, including pdfFileId/pdfFileName.
 */
export class RemoteDataSource implements StudentDataSource {
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    if (!baseUrl) throw new Error("RemoteDataSource requires STU_REMOTE_API_BASE_URL");
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`);
    if (!res.ok) throw new Error(`Remote API ${path} failed: ${res.status}`);
    return (await res.json()) as T;
  }

  async listBooks(): Promise<Book[]> {
    const data = await this.get<{ books: Book[] }>("/api/student/books");
    return data.books.filter((b) => b.status === "published");
  }

  async getBook(bookId: string): Promise<StudentBookDetail | null> {
    try {
      const data = await this.get<{ book: StudentBookDetail }>(`/api/student/books/${bookId}`);
      return data.book;
    } catch {
      return null;
    }
  }

  async getContents(bookId: string): Promise<BookContent[]> {
    const data = await this.get<{ contents: BookContent[] }>(
      `/api/student/books/${bookId}/contents`
    );
    return data.contents;
  }

  async getPdfFile(_bookId: string, _fileId: string): Promise<StudentBookPdfFile | null> {
    // Remote PDF streaming is handled by the central admin/student API. The
    // local standalone server cannot safely map a remote file id to a disk path.
    return null;
  }
}
