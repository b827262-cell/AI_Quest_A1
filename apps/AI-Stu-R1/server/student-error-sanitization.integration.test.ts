import { afterEach, describe, expect, it, vi } from "vitest";
import type { StudentDataSource } from "@ai-smartbook/student-runtime";
import {
  BOOK_ALPHA,
  completeAccessLogin,
  completeStudentProfile,
  createMemoryDataSource,
  createTestBrowserSession,
  startStudentTestApp,
  type StudentTestApp
} from "./testApp";

/**
 * N-R540 negative-path suite: every student data route must answer a stable
 * error literal and must never echo `detail`, `String(err)`, Zod messages,
 * stack traces, filesystem paths or credentials. Markers are synthetic.
 */
const SECRET_MARKER = "sk-live-DO-NOT-ECHO-0123456789abcdef";
const INTERNAL_ROOT = "/srv/internal/secret-volume";
const DB_PATH_MARKER = `${INTERNAL_ROOT}/student.db`;
const UPLOAD_PATH_MARKER = `${INTERNAL_ROOT}/uploads/books/book-alpha/leak.pdf`;
const STACK_MARKER = `at internalHandler (${INTERNAL_ROOT}/leak.js:42:13)`;
const LEAK_MARKERS = [SECRET_MARKER, INTERNAL_ROOT, DB_PATH_MARKER, UPLOAD_PATH_MARKER, STACK_MARKER];

function leakingError(context: string): Error {
  const error = new Error(`${context}: unable to open ${DB_PATH_MARKER} (token=${SECRET_MARKER})`);
  error.stack = `${error.name}: ${error.message}\n${STACK_MARKER}`;
  return error;
}

function failingDataSource(): StudentDataSource {
  return {
    async listBooks() {
      throw leakingError("SQLITE_CANTOPEN");
    },
    async getBook() {
      throw leakingError("SQLITE_IOERR");
    },
    async getContents() {
      throw leakingError("SQLITE_READONLY");
    },
    async getPdfFile() {
      throw leakingError("ENOENT");
    }
  };
}

function pdfOnDiskDataSource(): StudentDataSource {
  const memory = createMemoryDataSource();
  return {
    ...memory,
    async getPdfFile(bookId, fileId) {
      if (bookId !== BOOK_ALPHA.id) return null;
      return {
        id: fileId,
        bookId,
        fileName: "leak.pdf",
        filePath: UPLOAD_PATH_MARKER,
        fileType: "application/pdf",
        fileSize: 1024,
        role: "source_document"
      };
    }
  };
}

let app: StudentTestApp | null = null;
let errorSpy: ReturnType<typeof vi.spyOn> | null = null;

afterEach(async () => {
  errorSpy?.mockRestore();
  errorSpy = null;
  if (app) {
    await app.close();
    app = null;
  }
});

function expectNoLeak(text: string, label: string): void {
  for (const marker of LEAK_MARKERS) {
    expect(text, `${label} leaked ${marker}`).not.toContain(marker);
  }
  expect(text, `${label} leaked a stack frame`).not.toMatch(/\bat .+\(.+:\d+:\d+\)/);
}

async function startLoggedIn(dataSource?: StudentDataSource | null) {
  app = await startStudentTestApp({ sessionTtlMs: 3_600_000, dataSource });
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const browser = createTestBrowserSession();
  await completeAccessLogin(app.baseUrl, browser, app.assertion());
  await completeStudentProfile(app.baseUrl, browser);
  return { baseUrl: app.baseUrl, browser };
}

function loggedText(): string {
  if (!errorSpy) return "";
  return errorSpy.mock.calls.map((call: unknown[]) => call.map(String).join(" ")).join("\n");
}

describe("student API error sanitisation (N-R540)", () => {
  it("answers stable 503s for every data route when the data source throws", async () => {
    const { baseUrl, browser } = await startLoggedIn(failingDataSource());

    const requests: Array<[string, RequestInit]> = [
      ["/api/student/books", { method: "GET" }],
      [`/api/student/books/${BOOK_ALPHA.id}`, { method: "GET" }],
      [`/api/student/books/${BOOK_ALPHA.id}/outline`, { method: "GET" }],
      [`/api/student/books/${BOOK_ALPHA.id}/contents`, { method: "GET" }],
      [`/api/student/books/${BOOK_ALPHA.id}/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({})
      }],
      [`/api/student/books/${BOOK_ALPHA.id}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "光合作用" })
      }]
    ];

    for (const [path, init] of requests) {
      const response = await browser.fetch(`${baseUrl}${path}`, init);
      expect(response.status, path).toBe(503);
      const body = await response.text();
      expectNoLeak(body, path);
      const parsed = JSON.parse(body) as Record<string, unknown>;
      expect(parsed.detail, path).toBeUndefined();
      expect(typeof parsed.error, path).toBe("string");
    }

    expectNoLeak(loggedText(), "server log");
  });

  it("does not expose the resolved upload paths when the PDF is missing on disk", async () => {
    const { baseUrl, browser } = await startLoggedIn(pdfOnDiskDataSource());

    const sessionResponse = await browser.fetch(`${baseUrl}/api/student/books/${BOOK_ALPHA.id}/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    expect(sessionResponse.status).toBe(200);
    const { sessionId } = (await sessionResponse.json()) as { sessionId: string };

    const response = await browser.fetch(
      `${baseUrl}/api/student/books/${BOOK_ALPHA.id}/files/pdf-alpha/pdf-view`,
      { headers: { "X-Student-Session-Id": sessionId } }
    );
    expect(response.status).toBe(404);
    const body = await response.text();
    expectNoLeak(body, "pdf-view");
    const parsed = JSON.parse(body) as Record<string, unknown>;
    expect(parsed).toMatchObject({ error: "PDF file not found on disk", fileId: "pdf-alpha", fileName: "leak.pdf" });
    expect(parsed.filePath).toBeUndefined();
    expect(parsed.uploadDir).toBeUndefined();
    expect(parsed.checkedPaths).toBeUndefined();
    expectNoLeak(loggedText(), "server log");
  });

  it("answers an unavailable data source with a fixed 503 body and no failure detail", async () => {
    const { baseUrl, browser } = await startLoggedIn(null);

    const response = await browser.fetch(`${baseUrl}/api/student/books`);
    expect(response.status).toBe(503);
    const body = await response.text();
    expectNoLeak(body, "unavailable data source");
    const parsed = JSON.parse(body) as Record<string, unknown>;
    expect(parsed).toEqual({ error: "student data source unavailable", mode: "sqlite-api" });

    const ready = await browser.fetch(`${baseUrl}/health/ready`);
    expect(ready.status).toBe(503);
    expect(await ready.json()).toEqual({ status: "not_ready" });
    expectNoLeak(loggedText(), "server log");
  });

  it("replaces Zod validation output with a stable 400 error literal", async () => {
    const { baseUrl, browser } = await startLoggedIn();

    const response = await browser.fetch(`${baseUrl}/api/student/books/${BOOK_ALPHA.id}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: 42, unexpectedField: "x" })
    });
    expect(response.status).toBe(400);
    const body = await response.text();
    expectNoLeak(body, "chat validation");
    expect(JSON.parse(body)).toEqual({ error: "invalid chat request" });
    expect(body).not.toContain("Expected");
    expect(body).not.toContain("received");
  });

  it("keeps provider failures on the RAG contract without echoing the credential", async () => {
    app = await startStudentTestApp({
      sessionTtlMs: 3_600_000,
      ragEnv: {
        provider: "cerebras",
        cerebrasApiKey: SECRET_MARKER,
        // Unreachable loopback endpoint: the adapter fails before any HTTP call
        // succeeds, and the credential must never appear in the response.
        cerebrasBaseUrl: "http://127.0.0.1:1",
        cerebrasModel: "test-model"
      }
    });
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const browser = createTestBrowserSession();
    await completeAccessLogin(app.baseUrl, browser, app.assertion());
    await completeStudentProfile(app.baseUrl, browser);

    const response = await browser.fetch(`${app.baseUrl}/api/student/books/${BOOK_ALPHA.id}/rag-ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "光合作用" })
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    const body = await response.text();
    expect(body).not.toContain(SECRET_MARKER);
    expectNoLeak(body, "rag provider failure");
    const parsed = JSON.parse(body) as { error?: { code?: string; message?: string } };
    expect(parsed.error?.code).toMatch(/^RAG_/);
    expect(parsed.error?.message).toBeTruthy();
    expectNoLeak(loggedText(), "server log");
  });
});
