// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDbHandle, createRepositories, runMigrations } from "../../../packages/db/src";
import { createStudentNotesRouter, createStudentSessionMiddleware } from "@ai-smartbook/auth/express";
import { resolveStudentAuthConfig, type StudentAuthService } from "@ai-smartbook/auth/server";
import { studentAiAskResponseSchema } from "@ai-smartbook/schema";
import { createStudentAiAskRouter } from "./student-ai-ask";

describe("student AI ask HTTP integration", () => {
  const directory = mkdtempSync(join(tmpdir(), "student-ai-ask-"));
  const db = createDbHandle(join(directory, "auth.sqlite"));
  runMigrations(db.sqlite);
  const repos = createRepositories(db.db);
  const config = resolveStudentAuthConfig({});
  const auth = { restoreSession(token: string | undefined) {
    if (!token) return undefined;
    return { user: { id: token }, profile: { profileCompleted: true }, session: { id: "session", userId: token, expiresAt: "2099-01-01" } };
  } } as unknown as StudentAuthService;
  const app = express();
  app.use(express.json());
  app.use("/api/student", createStudentSessionMiddleware(auth, config));
  app.use("/api/student", createStudentAiAskRouter({ learningHistory: repos.studentLearningHistory, env: {}, rateLimit: { max: 2, windowMs: 60_000 } }, config));
  app.use("/api/student", createStudentNotesRouter({ notes: repos.studentNotes, learningHistory: repos.studentLearningHistory }, config));
  const server = app.listen(0, "127.0.0.1");
  let base: string;
  beforeAll(async () => {
    if (!server.listening) await new Promise<void>((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.sqlite.close();
    rmSync(directory, { recursive: true, force: true });
  });
  async function post(path: string, body: unknown, student?: string, origin?: string) {
    const headers: Record<string, string> = { "content-type": "application/json", origin: origin ?? base };
    if (student) headers.cookie = `${config.sessionCookie}=${student}`;
    const response = await fetch(`${base}/api/student${path}`, { method: "POST", headers, body: JSON.stringify(body) });
    return { response, body: await response.json() as Record<string, unknown> };
  }
  it("requires authentication and enforces origin and strict input", async () => {
    expect((await post("/ai-ask", { question: "Q" })).response.status).toBe(401);
    const cross = await post("/ai-ask", { question: "Q" }, "alice", "https://evil.example");
    expect(cross.response.status).toBe(403);
    expect(cross.body).toEqual({ error: "STUDENT_ORIGIN_NOT_ALLOWED" });
    for (const body of [{ question: " " }, { question: "Q", studentId: "bob" }]) {
      const invalid = await post("/ai-ask", body, "alice");
      expect(invalid.response.status).toBe(400);
      expect(invalid.body).toEqual({ error: "INVALID_AI_ASK" });
    }
  });
  it("writes mock answer to the owner's history and converts it to an API note", async () => {
    const result = await post("/ai-ask", { question: "  How?  ", category: "math" }, "alice");
    expect(result.response.status).toBe(200);
    expect(result.response.headers.get("cache-control")).toBe("no-store");
    expect(studentAiAskResponseSchema.safeParse(result.body).success).toBe(true);
    expect(result.body).toMatchObject({ question: "How?", strategy: "api", providerMode: "mock" });
    const id = String(result.body.entryId);
    expect(repos.studentLearningHistory.findById("alice", id)).toMatchObject({ strategy: "api", answer: result.body.answer, syncVersion: 1 });
    expect(repos.studentLearningHistory.findById("bob", id)).toBeUndefined();
    const saved = await post("/notes/from-history", { entryId: id }, "alice");
    expect(saved.response.status).toBe(201);
    expect(saved.body.note).toMatchObject({ source: "gemini-api", entryId: id, content: result.body.answer });
  });
  it("limits each student independently and supplies Retry-After", async () => {
    expect((await post("/ai-ask", { question: "Q2" }, "alice")).response.status).toBe(200);
    const limited = await post("/ai-ask", { question: "Q3" }, "alice");
    expect(limited.response.status).toBe(429);
    expect(limited.body.error).toBe("AI_ASK_RATE_LIMITED");
    expect(Number(limited.response.headers.get("retry-after"))).toBe(limited.body.retryAfterSeconds);
    expect(Number(limited.body.retryAfterSeconds)).toBeGreaterThan(0);
    expect((await post("/ai-ask", { question: "Q" }, "bob")).response.status).toBe(200);
  });
});

describe("provider failure sanitization", () => {
  it("does not expose a provider exception or key in the response or logs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "student-ai-error-"));
    const db = createDbHandle(join(dir, "auth.sqlite"));
    runMigrations(db.sqlite);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.studentAuth = { user: { id: "alice" } } as Express.Request["studentAuth"]; next(); });
    const fakeKey = "test-secret-never-log";
    app.use("/api/student", createStudentAiAskRouter({ learningHistory: createRepositories(db.db).studentLearningHistory, env: { STUDENT_AI_ASK_MODE: "gemini", GEMINI_API_KEY: fakeKey }, generateAnswer: async () => { throw new Error(fakeKey); } }, resolveStudentAuthConfig({})));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const server = app.listen(0, "127.0.0.1");
    try {
      if (!server.listening) await new Promise<void>((resolve) => server.once("listening", resolve));
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const response = await fetch(`${base}/api/student/ai-ask`, { method: "POST", headers: { origin: base, "content-type": "application/json" }, body: JSON.stringify({ question: "Q" }) });
      const text = await response.text();
      expect(response.status).toBe(502);
      expect(JSON.parse(text)).toEqual({ error: "AI_ASK_UNAVAILABLE" });
      expect(text).not.toContain(fakeKey);
      expect(JSON.stringify(warn.mock.calls)).not.toContain(fakeKey);
      expect(createRepositories(db.db).studentLearningHistory.listStudent("alice")).toHaveLength(0);
    } finally {
      warn.mockRestore();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      db.sqlite.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
