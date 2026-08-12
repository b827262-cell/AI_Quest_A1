import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, createServer, request as nodeHttpRequest, type Server } from "node:http";

/** Dedicated connection pool with keep-alive disabled: Node's global agent
 * keeps idle sockets open across server restarts on the same port, and a
 * stale pooled socket surfaces as ECONNRESET against the fresh server. */
const testHttpAgent = new Agent({ keepAlive: false });
import express, { type Express } from "express";
import {
  createStudentAuthRuntime,
  resolveStudentAuthConfig,
  type StudentAuthRuntime
} from "@ai-smartbook/auth/server";
import { createStudentAuthRouter, createStudentSessionMiddleware } from "@ai-smartbook/auth/express";
import type { StudentDataSource } from "@ai-smartbook/student-runtime";
import type { Book, BookContent } from "@ai-smartbook/schema";
import { createStudentRagRouter } from "./student-rag";

/**
 * Shared in-process Student API test harness. It composes the same express
 * stack as stu-api.ts (public auth router, session middleware, protected
 * book routes, scoped RAG route) so integration suites exercise the real
 * HTTP boundary instead of calling services directly.
 */

export const FAKE_GOOGLE_ENDPOINTS = {
  authorization: "https://accounts.example.test/oauth/authorize",
  token: "https://accounts.example.test/oauth/token",
  userinfo: "https://accounts.example.test/oauth/userinfo"
};

/** Provider fixture paths served by the test app itself, so the auth
 * service's server-side fetch travels real TCP like production. */
export const LOCAL_FAKE_GOOGLE_ENDPOINTS = {
  authorization: "https://accounts.example.test/oauth/authorize",
  token: "/test-provider/token",
  userinfo: "/test-provider/userinfo"
};

export const STUDENT_TEST_ORIGIN = "https://student.example.test";

/** Deterministic Google provider fixture. The subject can be swapped between
 * logins to simulate different Google accounts. */
export function installFakeGoogleProvider(
  originalFetch: typeof fetch,
  getSubject: () => string
): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === FAKE_GOOGLE_ENDPOINTS.token) {
      return new Response(JSON.stringify({ access_token: "provider-access-token" }), { status: 200 });
    }
    if (url === FAKE_GOOGLE_ENDPOINTS.userinfo) {
      return new Response(JSON.stringify({
        sub: getSubject(),
        email: "student@example.test",
        email_verified: true,
        name: "Student",
        picture: "https://example.test/avatar.png"
      }), { status: 200 });
    }
    return originalFetch(input as RequestInfo, init);
  }) as typeof fetch;
}

export const BOOK_ALPHA: Book = {
  id: "book-alpha",
  title: "Alpha Botany",
  category: "science",
  status: "published",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z"
};
export const BOOK_BETA: Book = {
  id: "book-beta",
  title: "Beta Hydrology",
  category: "science",
  status: "published",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z"
};
export const CONTENT_ALPHA: BookContent = {
  id: "alpha-1",
  bookId: "book-alpha",
  chapterId: "ch-alpha-1",
  pageNumber: 3,
  contentText: "光合作用 photosynthesis 是植物利用光能將水與二氧化碳轉化為養分。",
  orderIndex: 0,
  createdAt: "2026-01-01T00:00:00.000Z"
};
export const CONTENT_BETA: BookContent = {
  id: "beta-1",
  bookId: "book-beta",
  chapterId: "ch-beta-1",
  pageNumber: 7,
  contentText: "水循環 water cycle 描述蒸發、凝結與降水的循環過程。",
  orderIndex: 0,
  createdAt: "2026-01-01T00:00:00.000Z"
};

export function createMemoryDataSource(): StudentDataSource {
  const books = [BOOK_ALPHA, BOOK_BETA];
  const contents: Record<string, BookContent[]> = {
    "book-alpha": [CONTENT_ALPHA],
    "book-beta": [CONTENT_BETA]
  };
  return {
    async listBooks() {
      return books;
    },
    async getBook(bookId) {
      const book = books.find((entry) => entry.id === bookId);
      return book ? { ...book, chapters: [] } : null;
    },
    async getContents(bookId) {
      return contents[bookId] ?? [];
    },
    async getPdfFile() {
      return null;
    }
  };
}

export interface StudentTestApp {
  baseUrl: string;
  runtime: StudentAuthRuntime;
  close(): Promise<void>;
}

export interface StartStudentTestAppOptions {
  sessionTtlMs: number;
  port?: number;
  /** Serve a deterministic Google provider fixture on the app itself. */
  fakeProvider?: { getSubject: () => string };
}

export async function startStudentTestApp(options: StartStudentTestAppOptions): Promise<StudentTestApp> {
  const directory = mkdtempSync(join(tmpdir(), "ai-quest-student-testapp-"));
  const googleEndpoints = options.fakeProvider ? LOCAL_FAKE_GOOGLE_ENDPOINTS : FAKE_GOOGLE_ENDPOINTS;
  const config = resolveStudentAuthConfig({
    NODE_ENV: "test",
    STUDENT_GOOGLE_AUTH_ENABLED: "true",
    GOOGLE_CLIENT_ID: "client-id",
    GOOGLE_CLIENT_SECRET: "server-only-provider-secret",
    GOOGLE_REDIRECT_URI: `${STUDENT_TEST_ORIGIN}/api/student/auth/google/callback`,
    STUDENT_SESSION_SECRET: "a-test-session-secret-that-is-longer-than-32-chars",
    STUDENT_ALLOWED_ORIGINS: STUDENT_TEST_ORIGIN,
    GOOGLE_AUTHORIZATION_ENDPOINT: googleEndpoints.authorization,
    GOOGLE_TOKEN_ENDPOINT: googleEndpoints.token,
    GOOGLE_USERINFO_ENDPOINT: googleEndpoints.userinfo,
    STUDENT_SESSION_TTL_MS: String(options.sessionTtlMs)
  });
  const runtime = createStudentAuthRuntime(join(directory, "auth.sqlite"), config);
  const dataSource = createMemoryDataSource();

  const app: Express = express();
  app.use(express.json());
  if (options.fakeProvider) {
    const { getSubject } = options.fakeProvider;
    app.post("/test-provider/token", (_req, res) => {
      res.json({ access_token: "provider-access-token" });
    });
    app.get("/test-provider/userinfo", (_req, res) => {
      res.json({
        sub: getSubject(),
        email: "student@example.test",
        email_verified: true,
        name: "Student",
        picture: "https://example.test/avatar.png"
      });
    });
  }
  app.use("/api/student/auth", createStudentAuthRouter(runtime.auth, config));
  app.use("/api/student", createStudentSessionMiddleware(runtime.auth, config));
  app.use("/api/student", createStudentRagRouter({
    getDataSource: () => dataSource,
    env: { provider: "fake" }
  }));
  app.get("/api/student/books", async (_req, res) => {
    res.json({ books: await dataSource.listBooks() });
  });
  app.get("/api/student/books/:bookId", async (req, res) => {
    const book = await dataSource.getBook(String(req.params.bookId));
    if (!book) return res.status(404).json({ error: "book not found" });
    res.json({ book });
  });
  app.get("/api/student/books/:bookId/contents", async (req, res) => {
    res.json({ contents: await dataSource.getContents(String(req.params.bookId)) });
  });

  const server: Server = await new Promise((resolve, reject) => {
    const listener = createServer(app);
    listener.once("error", reject);
    listener.listen(options.port ?? 0, "127.0.0.1", () => resolve(listener));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    baseUrl,
    runtime,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      runtime.dbHandle.sqlite.close();
      const { rmSync } = await import("node:fs");
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

export interface TestBrowserSession {
  cookie: string | null;
  fetch(path: string, init?: RequestInit): Promise<Response>;
}

/** Minimal cookie-aware fetch wrapper standing in for the browser jar. */
export function createTestBrowserSession(): TestBrowserSession {
  const browser: TestBrowserSession = {
    cookie: null,
    async fetch(path, init = {}) {
      const headers = new Headers(init.headers);
      if (browser.cookie) headers.set("cookie", browser.cookie);
      const response = await globalThis.fetch(path, { ...init, headers, redirect: "manual" });
      const setCookies = typeof response.headers.getSetCookie === "function"
        ? response.headers.getSetCookie()
        : response.headers.get("set-cookie") ? [String(response.headers.get("set-cookie"))] : [];
      const session = setCookies.find((entry) => entry.startsWith("ai_student_session="));
      if (session) browser.cookie = session.split(";", 1)[0];
      return response;
    }
  };
  return browser;
}

export async function completeOAuthLogin(baseUrl: string, browser: TestBrowserSession): Promise<void> {
  const start = await browser.fetch(`${baseUrl}/api/student/auth/google/start?returnTo=${encodeURIComponent("/dashboard")}`);
  if (start.status !== 302) throw new Error(`google/start failed: ${start.status}`);
  const authorizationUrl = new URL(start.headers.get("location") ?? "");
  const state = authorizationUrl.searchParams.get("state") ?? "";
  if (!state) throw new Error("oauth state missing from authorization url");
  const callback = await browser.fetch(`${baseUrl}/api/student/auth/google/callback?state=${encodeURIComponent(state)}&code=authorization-code`);
  if (callback.status !== 302) throw new Error(`google/callback failed: ${callback.status}`);
  if (!browser.cookie) throw new Error("session cookie was not established");
}

export async function completeStudentProfile(baseUrl: string, browser: TestBrowserSession, displayName = "Student"): Promise<void> {
  const response = await browser.fetch(`${baseUrl}/api/student/auth/profile`, {
    method: "PATCH",
    headers: { "content-type": "application/json", origin: STUDENT_TEST_ORIGIN },
    body: JSON.stringify({ displayName, schoolName: "Test University", gradeLevel: "Year 1" })
  });
  if (response.status !== 200) throw new Error(`profile completion failed: ${response.status}`);
}

export interface RawHttpResponse {
  status: number;
  headers: Record<string, string[]>;
  bodyText: string;
}

/**
 * Real TCP transport built directly on node:http. Unlike globalThis.fetch it
 * is immune to DOM test environments (happy-dom's fetch applies same-origin
 * policy against a virtual document origin), so integration suites use it as
 * the authoritative transport.
 */
export function rawHttpRequest(
  url: URL,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<RawHttpResponse> {
  return new Promise((resolve, reject) => {
    const request = nodeHttpRequest(
      {
        agent: testHttpAgent,
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: options.method ?? "GET",
        headers: options.headers ?? {}
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const headers: Record<string, string[]> = {};
          for (const [name, value] of Object.entries(response.headers)) {
            if (value === undefined) continue;
            headers[name.toLowerCase()] = Array.isArray(value) ? value : [value];
          }
          resolve({
            status: response.statusCode ?? 0,
            headers,
            bodyText: Buffer.concat(chunks).toString("utf8")
          });
        });
      }
    );
    request.on("error", reject);
    if (options.body) request.write(options.body);
    request.end();
  });
}

/**
 * Transport-level login helpers built on rawHttpRequest. They work from any
 * vitest environment (node or happy-dom) because they never touch
 * globalThis.fetch; UI integration suites use them to establish a real
 * session cookie before mounting the app.
 */
export async function oauthLoginViaRawHttp(baseUrl: string): Promise<string> {
  const start = await rawHttpRequest(new URL(`${baseUrl}/api/student/auth/google/start?returnTo=${encodeURIComponent("/dashboard")}`));
  if (start.status !== 302) throw new Error(`google/start failed: ${start.status}`);
  const location = start.headers["location"]?.[0] ?? "";
  const state = new URL(location).searchParams.get("state") ?? "";
  if (!state) throw new Error("oauth state missing from authorization url");
  const callback = await rawHttpRequest(new URL(`${baseUrl}/api/student/auth/google/callback?state=${encodeURIComponent(state)}&code=authorization-code`));
  if (callback.status !== 302) throw new Error(`google/callback failed: ${callback.status}`);
  const cookie = (callback.headers["set-cookie"] ?? []).find((entry) => entry.startsWith("ai_student_session="));
  if (!cookie) throw new Error("session cookie was not established");
  return cookie.split(";", 1)[0];
}

export async function completeStudentProfileViaRawHttp(baseUrl: string, cookie: string, displayName = "Student"): Promise<void> {
  const response = await rawHttpRequest(new URL(`${baseUrl}/api/student/auth/profile`), {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      origin: STUDENT_TEST_ORIGIN,
      cookie
    },
    body: JSON.stringify({ displayName, schoolName: "Test University", gradeLevel: "Year 1" })
  });
  if (response.status !== 200) throw new Error(`profile completion failed: ${response.status} ${response.bodyText}`);
}
