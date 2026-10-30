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
  type StudentAuthConfig,
  type StudentAuthRuntime
} from "@ai-smartbook/auth/server";
import {
  createStudentAuthRouter,
  createStudentSessionMiddleware,
  createStudentLearningHistoryRouter,
  oversizeJsonBodyHandler,
  MAX_LEARNING_HISTORY_BODY_BYTES
} from "@ai-smartbook/auth/express";
import type { StudentDataSource } from "@ai-smartbook/student-runtime";
import type { Book, BookContent } from "@ai-smartbook/schema";
import { createStudentRagRouter } from "./student-rag";
import { registerHealthRoutes, type HealthReadyCheck } from "./health-routes";
import { startFakeAccessCerts } from "../../../scripts/student-access-fixture";

/**
 * Shared in-process Student API test harness. It composes the same express
 * stack as stu-api.ts (public auth router, session middleware, protected
 * book routes, scoped RAG route) so integration suites exercise the real
 * HTTP boundary instead of calling services directly.
 */

export const STUDENT_TEST_ORIGIN = "https://student.example.test";

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
  config: StudentAuthConfig;
  assertion(overrides?: Record<string, unknown>, headerOverrides?: Record<string, unknown>): string;
  certs: Awaited<ReturnType<typeof startFakeAccessCerts>>;
  close(): Promise<void>;
}

export interface StartStudentTestAppOptions {
  sessionTtlMs: number;
  port?: number;
  secureCookies?: boolean;
  /** Overrides the readiness probe so suites can exercise the failure path. */
  readyCheck?: HealthReadyCheck;
  /** Shortens the readiness deadline so timeout cases stay fast. */
  readyTimeoutMs?: number;
}

export async function startStudentTestApp(options: StartStudentTestAppOptions): Promise<StudentTestApp> {
  const directory = mkdtempSync(join(tmpdir(), "ai-quest-student-testapp-"));
  const certs = await startFakeAccessCerts();
  const config = resolveStudentAuthConfig({
    NODE_ENV: "test",
    STUDENT_SESSION_SECURE: options.secureCookies === false ? "false" : "true",
    STUDENT_ACCESS_TEAM_DOMAIN: certs.teamDomain,
    STUDENT_ACCESS_AUD: certs.aud,
    STUDENT_ACCESS_CERTS_URL: certs.certsUrl,
    STUDENT_SESSION_SECRET: "a-test-session-secret-that-is-longer-than-32-chars",
    STUDENT_ALLOWED_ORIGINS: STUDENT_TEST_ORIGIN,
    STUDENT_SESSION_TTL_MS: String(options.sessionTtlMs)
  });
  const runtime = createStudentAuthRuntime(join(directory, "auth.sqlite"), config);
  const dataSource = createMemoryDataSource();

  const app: Express = express();
  app.use("/api/student/learning-history", express.json({ limit: MAX_LEARNING_HISTORY_BODY_BYTES }));
  app.use(express.json());
  // Same placement as stu-api.ts: public probes before the auth boundary.
  registerHealthRoutes(app, options.readyCheck ?? (async () => {
    await dataSource.listBooks();
  }), { timeoutMs: options.readyTimeoutMs });
  app.use("/api/student/auth", createStudentAuthRouter(runtime.auth, config));
  app.use("/api/student", createStudentSessionMiddleware(runtime.auth, config));
  app.use("/api/student", createStudentLearningHistoryRouter(runtime.learningHistory, config));
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

  // Mirror the production error boundary: oversize bodies answer JSON 413,
  // BATCH_TOO_LARGE only on the learning-history endpoints.
  app.use(oversizeJsonBodyHandler());

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
    config,
    assertion: certs.assertion,
    certs,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      runtime.dbHandle.sqlite.close();
      await certs.close();
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

export async function completeAccessLogin(baseUrl: string, browser: TestBrowserSession, assertion: string): Promise<void> {
  const response = await browser.fetch(`${baseUrl}/api/student/auth/access/login?returnTo=%2Fdashboard`, {
    headers: { "Cf-Access-Jwt-Assertion": assertion }, redirect: "manual"
  });
  if (response.status !== 302) throw new Error(`access/login failed: ${response.status}`);
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
export async function accessLoginViaRawHttp(baseUrl: string, assertion: string): Promise<string> {
  const response = await rawHttpRequest(new URL(`${baseUrl}/api/student/auth/access/login?returnTo=%2Fdashboard`), {
    headers: { "Cf-Access-Jwt-Assertion": assertion }
  });
  if (response.status !== 302) throw new Error(`access/login failed: ${response.status} ${response.bodyText}`);
  const cookie = (response.headers["set-cookie"] ?? []).find((entry) => entry.startsWith("ai_student_session="));
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
