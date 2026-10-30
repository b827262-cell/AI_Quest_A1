import { afterEach, describe, expect, it } from "vitest";
import { createServer, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { Book, BookContent } from "@ai-smartbook/schema";
import { SqliteDataSource, type StudentDataSource } from "@ai-smartbook/student-runtime";
import { rawHttpRequest, startStudentTestApp, type StudentTestApp } from "./testApp";
import { createReadyCheck } from "./health-routes";

/**
 * F2-HEALTH-01: the student API must expose the same public liveness/readiness
 * probes as the admin API. Every case below runs against the real express
 * boundary over TCP with no session cookie.
 */

let app: StudentTestApp | null = null;
let sqliteSource: SqliteDataSource | null = null;
const fakeAdmins: FakeAdmin[] = [];

afterEach(async () => {
  if (app) {
    await app.close();
    app = null;
  }
  if (sqliteSource) {
    sqliteSource.close();
    sqliteSource = null;
  }
  while (fakeAdmins.length > 0) await fakeAdmins.pop()!.close();
});

interface FakeAdmin {
  baseUrl: string;
  requests: string[];
  close(): Promise<void>;
}

/** Local stand-in for the admin API. `respond` may leave the request hanging. */
async function startFakeAdmin(respond: (res: ServerResponse) => void): Promise<FakeAdmin> {
  const requests: string[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((req, res) => {
    requests.push(req.url ?? "");
    respond(res);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected fake admin address");
  const admin: FakeAdmin = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
  fakeAdmins.push(admin);
  return admin;
}

function remoteApiApp(adminBaseUrl: string, readyTimeoutMs = 2000): Promise<StudentTestApp> {
  return startStudentTestApp({
    sessionTtlMs: 3_600_000,
    readyTimeoutMs,
    readyCheck: createReadyCheck({
      mode: "remote-api",
      remoteApiBaseUrl: adminBaseUrl,
      timeoutMs: readyTimeoutMs,
      // In remote-api mode the local data source must never be consulted.
      getDataSource: () => {
        throw new Error("SENTINEL_LOCAL_DATA_SOURCE_USED");
      }
    })
  });
}

async function probe(path: string) {
  const response = await rawHttpRequest(new URL(`${app!.baseUrl}${path}`));
  return { ...response, payload: JSON.parse(response.bodyText) as unknown };
}

describe("Student API health probes over real HTTP", () => {
  it("answers /health/live with 200 for an unauthenticated caller", async () => {
    app = await startStudentTestApp({ sessionTtlMs: 3_600_000 });
    const response = await probe("/health/live");
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]?.[0]).toContain("application/json");
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(response.payload).toEqual({ status: "live" });
  });

  it("answers /health/ready with 200 after a read-only data source probe", async () => {
    app = await startStudentTestApp({ sessionTtlMs: 3_600_000 });
    const response = await probe("/health/ready");
    expect(response.status).toBe(200);
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(response.payload).toEqual({ status: "ready" });
  });

  it("answers 503 not_ready when the readiness probe throws", async () => {
    app = await startStudentTestApp({
      sessionTtlMs: 3_600_000,
      readyCheck: async () => {
        throw new Error("SENTINEL_DATABASE_DOWN");
      }
    });
    const response = await probe("/health/ready");
    expect(response.status).toBe(503);
    expect(response.payload).toEqual({ status: "not_ready" });
    // The failure reason must not leak to the caller.
    expect(response.bodyText).not.toContain("SENTINEL_DATABASE_DOWN");
    expect(response.bodyText).not.toContain("<!DOCTYPE");
  });

  it("answers 503 not_ready when the readiness probe exceeds the deadline", async () => {
    app = await startStudentTestApp({
      sessionTtlMs: 3_600_000,
      readyTimeoutMs: 100,
      // A probe that never settles stands in for a wedged data source.
      readyCheck: () => new Promise<void>(() => undefined)
    });

    const startedAt = Date.now();
    const response = await probe("/health/ready");

    expect(response.status).toBe(503);
    expect(response.payload).toEqual({ status: "not_ready" });
    expect(Date.now() - startedAt).toBeLessThan(2000);
  });

  it("returns only the status literal, never application data", async () => {
    app = await startStudentTestApp({ sessionTtlMs: 3_600_000 });
    for (const path of ["/health/live", "/health/ready"]) {
      const response = await probe(path);
      expect(response.status, path).toBe(200);
      expect(Object.keys(response.payload as Record<string, unknown>), path).toEqual(["status"]);
      expect(response.bodyText, path).not.toContain("book-alpha");
      expect(response.bodyText, path).not.toContain("Alpha Botany");
      expect(response.bodyText, path).not.toContain("<!DOCTYPE");
    }
  });
});

/**
 * F2-HEALTH-01 follow-up: in `remote-api` mode the local data source is a
 * credential-less proxy of an authenticated admin route, so readiness must ask
 * the admin API's own public probe instead, and must not hang forever.
 */
describe("Student API readiness in remote-api mode", () => {
  it("answers 200 ready when the admin readiness probe answers 200", async () => {
    const admin = await startFakeAdmin((res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ready" }));
    });
    app = await remoteApiApp(admin.baseUrl);

    const response = await probe("/health/ready");

    expect(response.status).toBe(200);
    expect(response.payload).toEqual({ status: "ready" });
    expect(admin.requests).toEqual(["/health/ready"]);
  });

  it("answers 503 not_ready when the admin readiness probe answers 503", async () => {
    const admin = await startFakeAdmin((res) => {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "not_ready" }));
    });
    app = await remoteApiApp(admin.baseUrl);

    const response = await probe("/health/ready");

    expect(response.status).toBe(503);
    expect(response.payload).toEqual({ status: "not_ready" });
  });

  it("answers 503 not_ready when the admin readiness probe answers 401", async () => {
    const admin = await startFakeAdmin((res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "SENTINEL_ADMIN_UNAUTHORIZED" }));
    });
    app = await remoteApiApp(admin.baseUrl);

    const response = await probe("/health/ready");

    expect(response.status).toBe(503);
    expect(response.payload).toEqual({ status: "not_ready" });
    expect(response.bodyText).not.toContain("SENTINEL_ADMIN_UNAUTHORIZED");
    expect(response.bodyText).not.toContain("<!DOCTYPE");
  });

  it("answers 503 not_ready when the admin API never responds", async () => {
    // The fake admin accepts the connection and never writes a response.
    const admin = await startFakeAdmin(() => undefined);
    app = await remoteApiApp(admin.baseUrl, 150);

    const startedAt = Date.now();
    const response = await probe("/health/ready");
    const elapsed = Date.now() - startedAt;

    expect(response.status).toBe(503);
    expect(response.payload).toEqual({ status: "not_ready" });
    expect(elapsed).toBeLessThan(2000);
    expect(admin.requests).toEqual(["/health/ready"]);
  });

  it("answers 503 not_ready when the admin base url is not configured", async () => {
    app = await startStudentTestApp({
      sessionTtlMs: 3_600_000,
      readyTimeoutMs: 150,
      readyCheck: createReadyCheck({
        mode: "remote-api",
        getDataSource: () => null
      })
    });

    const response = await probe("/health/ready");

    expect(response.status).toBe(503);
    expect(response.payload).toEqual({ status: "not_ready" });
  });
});

/**
 * N-R300: in `sqlite-api` mode readiness must use the data source's
 * lightweight `ping()` instead of reading application data. The SQLite calls
 * are synchronous, so the timeout timer cannot preempt them — the probe has to
 * be cheap enough that it never needs to be preempted.
 */
interface PingSpyDataSource extends StudentDataSource {
  pingCalls: number;
  listBooksCalls: number;
}

function createPingSpyDataSource(ping: () => Promise<void>): PingSpyDataSource {
  const source: PingSpyDataSource = {
    pingCalls: 0,
    listBooksCalls: 0,
    async ping() {
      source.pingCalls += 1;
      await ping();
    },
    async listBooks(): Promise<Book[]> {
      source.listBooksCalls += 1;
      return [];
    },
    async getBook(): Promise<null> {
      return null;
    },
    async getContents(): Promise<BookContent[]> {
      return [];
    },
    async getPdfFile(): Promise<null> {
      return null;
    }
  };
  return source;
}

describe("Student API readiness in sqlite-api mode", () => {
  it("calls ping and never reads books", async () => {
    const dataSource = createPingSpyDataSource(async () => undefined);
    app = await startStudentTestApp({
      sessionTtlMs: 3_600_000,
      readyCheck: createReadyCheck({
        mode: "sqlite-api",
        getDataSource: () => dataSource
      })
    });

    const response = await probe("/health/ready");

    expect(response.status).toBe(200);
    expect(response.payload).toEqual({ status: "ready" });
    expect(dataSource.pingCalls).toBe(1);
    expect(dataSource.listBooksCalls).toBe(0);
  });

  it("answers 503 not_ready when ping rejects", async () => {
    const dataSource = createPingSpyDataSource(async () => {
      throw new Error("SENTINEL_PING_FAILED");
    });
    app = await startStudentTestApp({
      sessionTtlMs: 3_600_000,
      readyCheck: createReadyCheck({
        mode: "sqlite-api",
        getDataSource: () => dataSource
      })
    });

    const response = await probe("/health/ready");

    expect(response.status).toBe(503);
    expect(response.payload).toEqual({ status: "not_ready" });
    expect(response.bodyText).not.toContain("SENTINEL_PING_FAILED");
    expect(response.bodyText).not.toContain("<!DOCTYPE");
    expect(dataSource.pingCalls).toBe(1);
    expect(dataSource.listBooksCalls).toBe(0);
  });

  it("resolves ping on a real SqliteDataSource", async () => {
    app = await startStudentTestApp({ sessionTtlMs: 3_600_000 });
    // Reuse the SQLite file the harness already created for this test.
    sqliteSource = new SqliteDataSource(app.runtime.dbHandle.sqlite.name);

    await expect(sqliteSource.ping()).resolves.toBeUndefined();
  });
});
