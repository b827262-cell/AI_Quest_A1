import { createRequire } from "node:module";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer, request as nodeHttpRequest, type Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";

/**
 * Shared harness for the student auth / dashboard / RAG smoke gates.
 *
 * Everything here drives the REAL student API process (server/stu-api.ts)
 * over real TCP against throwaway SQLite databases. No service layer is
 * called directly and no production data is touched.
 */

export const repoRoot = resolve(new URL("..", import.meta.url).pathname);

const studentAppRequire = createRequire(join(repoRoot, "apps/AI-Stu-R1/package.json"));
// better-sqlite3 is a native dependency of the student app; resolve it from
// there so root-level smoke scripts do not need their own native dep.
const Database = studentAppRequire("better-sqlite3") as typeof import("better-sqlite3");

export function createThrowawayDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Seed a throwaway student.db matching SqliteDataSource's read schema. */
export function seedThrowawayStudentDb(dbPath: string): void {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE books (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      subtitle TEXT,
      description TEXT,
      cover_url TEXT,
      category TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE book_chapters (
      id TEXT PRIMARY KEY,
      book_id TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT,
      order_index INTEGER NOT NULL,
      page_start INTEGER,
      page_end INTEGER,
      level INTEGER,
      source TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE book_contents (
      id TEXT PRIMARY KEY,
      book_id TEXT NOT NULL,
      file_id TEXT,
      chapter_id TEXT,
      page_number INTEGER,
      content_text TEXT NOT NULL,
      order_index INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE book_files (
      id TEXT PRIMARY KEY,
      book_id TEXT NOT NULL,
      file_name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      file_type TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      role TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  const now = "2026-01-01T00:00:00.000Z";
  db.prepare(
    "INSERT INTO books (id,title,subtitle,description,cover_url,category,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)"
  ).run("book-alpha", "Alpha Botany", null, "Smoke fixture book A", null, "science", "published", now, now);
  db.prepare(
    "INSERT INTO books (id,title,subtitle,description,cover_url,category,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)"
  ).run("book-beta", "Beta Hydrology", null, "Smoke fixture book B", null, "science", "published", now, now);
  db.prepare(
    "INSERT INTO book_chapters (id,book_id,title,summary,order_index,page_start,page_end,level,source,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)"
  ).run("ch-alpha-1", "book-alpha", "Photosynthesis", null, 0, 1, 10, 0, "manual", "published", now, now);
  db.prepare(
    "INSERT INTO book_contents (id,book_id,file_id,chapter_id,page_number,content_text,order_index,created_at) VALUES (?,?,?,?,?,?,?,?)"
  ).run("alpha-1", "book-alpha", null, "ch-alpha-1", 3, "光合作用 photosynthesis 是植物利用光能將水與二氧化碳轉化為養分。", 0, now);
  db.prepare(
    "INSERT INTO book_contents (id,book_id,file_id,chapter_id,page_number,content_text,order_index,created_at) VALUES (?,?,?,?,?,?,?,?)"
  ).run("beta-1", "book-beta", null, null, 7, "水循環 water cycle 描述蒸發、凝結與降水的循環過程。", 0, now);
  db.close();
}

export interface FakeProviderHandle {
  baseUrl: string;
  setSubject(subject: string): void;
  close(): Promise<void>;
}

/**
 * Deterministic Google OAuth provider fixture. The /authorize endpoint
 * behaves like a consent screen that immediately approves: it redirects the
 * browser straight back to the redirect_uri with the original state, so the
 * real browser smoke can complete the full round trip.
 */
export async function startFakeGoogleProvider(): Promise<FakeProviderHandle> {
  let subject = "smoke-google-subject";
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://internal");
    if (req.method === "GET" && url.pathname === "/authorize") {
      const redirectUri = url.searchParams.get("redirect_uri") ?? "";
      const state = url.searchParams.get("state") ?? "";
      const target = `${redirectUri}?state=${encodeURIComponent(state)}&code=deterministic-auth-code`;
      res.statusCode = 302;
      res.setHeader("Location", target);
      res.end();
      return;
    }
    if (req.method === "POST" && url.pathname === "/token") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ access_token: "smoke-provider-access-token" }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/userinfo") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        sub: subject,
        email: "smoke-student@example.test",
        email_verified: true,
        name: "Smoke Student",
        picture: "https://example.test/avatar.png"
      }));
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture provider has no address");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    setSubject(next: string) {
      subject = next;
    },
    async close() {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  };
}

export interface StudentApiHandle {
  baseUrl: string;
  port: number;
  child: ChildProcess;
  close(): Promise<void>;
}

export interface StudentApiOptions {
  port: number;
  studentDbPath: string;
  authDbPath: string;
  sessionTtlMs: number;
  ragProvider?: string;
  ragFakeMode?: string;
  publicDir?: string;
  googleEndpoints: { authorize: string; token: string; userinfo: string };
}

/** Spawn the real student API (server/stu-api.ts) against throwaway state. */
export async function startStudentApi(options: StudentApiOptions): Promise<StudentApiHandle> {
  const origin = `http://127.0.0.1:${options.port}`;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "smoke",
    STU_RUNTIME_MODE: "sqlite-api",
    STU_DB_PATH: options.studentDbPath,
    STU_API_PORT: String(options.port),
    STU_PUBLIC_DIR: options.publicDir ?? join(repoRoot, "apps/AI-Stu-R1/dist"),
    STUDENT_AUTH_DB_PATH: options.authDbPath,
    STUDENT_SESSION_SECRET: "smoke-session-secret-that-is-longer-than-32-characters",
    STUDENT_ALLOWED_ORIGINS: origin,
    STUDENT_SESSION_TTL_MS: String(options.sessionTtlMs),
    STUDENT_GOOGLE_AUTH_ENABLED: "true",
    GOOGLE_CLIENT_ID: "smoke-client-id",
    GOOGLE_CLIENT_SECRET: "smoke-client-secret",
    GOOGLE_REDIRECT_URI: `${origin}/api/student/auth/google/callback`,
    GOOGLE_AUTHORIZATION_ENDPOINT: options.googleEndpoints.authorize,
    GOOGLE_TOKEN_ENDPOINT: options.googleEndpoints.token,
    GOOGLE_USERINFO_ENDPOINT: options.googleEndpoints.userinfo,
    STUDENT_RAG_PROVIDER: options.ragProvider ?? "fake",
    ...(options.ragFakeMode ? { STUDENT_RAG_FAKE_MODE: options.ragFakeMode } : {})
  };
  const child = spawn(
    process.execPath,
    [
      "--import",
      join(repoRoot, "apps/AI-adm-D1/node_modules/tsx/dist/loader.mjs"),
      join(repoRoot, "apps/AI-Stu-R1/server/stu-api.ts")
    ],
    { cwd: join(repoRoot, "apps/AI-Stu-R1"), env, stdio: ["ignore", "pipe", "pipe"] }
  );
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  const baseUrl = origin;
  await waitForHttp(`${baseUrl}/api/student/books`, 20_000, output);
  return {
    baseUrl,
    port: options.port,
    child,
    async close() {
      child.kill("SIGTERM");
      await new Promise<void>((resolveClose) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolveClose();
        }, 3_000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolveClose();
        });
      });
    }
  };
}

async function waitForHttp(url: string, timeoutMs: number, diagnostic: () => string | string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const response = await rawHttpRequest(new URL(url));
      // Any HTTP answer (401 included) proves the express stack is up.
      if (response.status > 0) return;
    } catch (error) {
      lastError = String(error);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  const log = typeof diagnostic === "function" ? diagnostic() : diagnostic;
  throw new Error(`student API did not come up at ${url}: ${lastError}\n--- server output ---\n${log.slice(-2000)}`);
}

export interface RawHttpResponse {
  status: number;
  headers: Record<string, string[]>;
  bodyText: string;
}

/** Raw node:http transport used by every smoke assertion. */
export function rawHttpRequest(
  url: URL,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<RawHttpResponse> {
  return new Promise((resolvePromise, rejectPromise) => {
    const request = nodeHttpRequest(
      {
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
          resolvePromise({
            status: response.statusCode ?? 0,
            headers,
            bodyText: Buffer.concat(chunks).toString("utf8")
          });
        });
      }
    );
    request.on("error", rejectPromise);
    if (options.body) request.write(options.body);
    request.end();
  });
}

export interface SmokeBrowser {
  cookie: string | null;
  request(path: string, options?: { method?: string; body?: unknown; headers?: Record<string, string> }): Promise<RawHttpResponse>;
}

/** Cookie-jar HTTP client standing in for the browser. */
export function createSmokeBrowser(baseUrl: string, origin: string): SmokeBrowser {
  const browser: SmokeBrowser = {
    cookie: null,
    async request(path, options = {}) {
      const headers: Record<string, string> = { origin, ...(options.headers ?? {}) };
      if (browser.cookie) headers["cookie"] = browser.cookie;
      if (options.body !== undefined) headers["content-type"] = "application/json";
      const response = await rawHttpRequest(new URL(path, baseUrl), {
        method: options.method ?? "GET",
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined
      });
      const session = (response.headers["set-cookie"] ?? []).find((entry) => entry.startsWith("ai_student_session="));
      if (session) browser.cookie = session.split(";", 1)[0];
      return response;
    }
  };
  return browser;
}

/** Full deterministic login through the real OAuth routes. */
export async function loginViaSmokeOAuth(baseUrl: string, browser: SmokeBrowser): Promise<void> {
  const start = await browser.request("/api/student/auth/google/start?returnTo=%2Fdashboard");
  if (start.status !== 302) throw new Error(`google/start failed: ${start.status} ${start.bodyText}`);
  const location = start.headers["location"]?.[0] ?? "";
  const state = new URL(location).searchParams.get("state") ?? "";
  if (!state) throw new Error("oauth state missing");
  const callback = await browser.request(`/api/student/auth/google/callback?state=${encodeURIComponent(state)}&code=deterministic-auth-code`);
  if (callback.status !== 302) throw new Error(`google/callback failed: ${callback.status} ${callback.bodyText}`);
  if (!browser.cookie) throw new Error("session cookie was not established");
}

export async function completeSmokeProfile(browser: SmokeBrowser, displayName = "Smoke Student"): Promise<void> {
  const response = await browser.request("/api/student/auth/profile", {
    method: "PATCH",
    body: { displayName, schoolName: "Smoke University", gradeLevel: "Year 1" }
  });
  if (response.status !== 200) throw new Error(`profile completion failed: ${response.status} ${response.bodyText}`);
}

export interface GateStep {
  name: string;
  ok: boolean;
  detail?: string;
}

export class GateReport {
  readonly steps: GateStep[] = [];

  pass(name: string, detail?: string): void {
    this.steps.push({ name, ok: true, detail });
    console.log(`  ✓ ${name}${detail ? ` (${detail})` : ""}`);
  }

  fail(name: string, detail?: string): never {
    this.steps.push({ name, ok: false, detail });
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
    throw new Error(`smoke gate failed: ${name}${detail ? ` — ${detail}` : ""}`);
  }

  expect(condition: boolean, name: string, detail?: string): void {
    if (condition) this.pass(name, detail);
    else this.fail(name, detail);
  }
}

export function requireEnvFileExists(path: string): void {
  if (!existsSync(path)) throw new Error(`required file missing: ${path}`);
}
