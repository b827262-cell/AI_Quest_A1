import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbHandle, createRepositories, runMigrations, type LearningHistoryRecord, type StudentNoteRecord } from "@ai-smartbook/db";
import { createStudentNotesRouter, MAX_STUDENT_NOTE_BODY_BYTES } from "./student-notes-express";
import { oversizeJsonBodyHandler } from "./learning-history-express";
import { resolveStudentAuthConfig } from "./server";
import type { StudentRequestAuth } from "./express";

type NotesResponseBody = { note: StudentNoteRecord; notes: StudentNoteRecord[]; deleted: boolean };

describe("student notes HTTP integration", () => {
  const dir = mkdtempSync(join(tmpdir(), "notes-http-"));
  const db = createDbHandle(join(dir, "test.sqlite"));
  runMigrations(db.sqlite);
  const repos = createRepositories(db.db);
  const app = express();
  app.use("/api/student/notes", express.json({ limit: MAX_STUDENT_NOTE_BODY_BYTES }));
  app.use(express.json());
  app.use((req, _res, next) => {
    const id = req.header("x-test-student");
    if (id) req.studentAuth = { user: { id } } as StudentRequestAuth;
    next();
  });
  app.use("/api/student", createStudentNotesRouter({ notes: repos.studentNotes, learningHistory: repos.studentLearningHistory }, resolveStudentAuthConfig({})));
  app.use(oversizeJsonBodyHandler());
  const server = app.listen(0, "127.0.0.1");
  let base: string;
  beforeAll(async () => {
    if (!server.listening) await new Promise<void>((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    db.sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });
  async function request(path: string, method = "GET", student?: string, body?: unknown, origin?: string) {
    const headers: Record<string, string> = { origin: origin ?? base };
    if (student) headers["x-test-student"] = student;
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await fetch(`${base}/api/student${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() as NotesResponseBody, cache: response.headers.get("cache-control") };
  }
  const entry = (id: string): LearningHistoryRecord => ({ id, askedAt: "2026-10-20T10:00:00.000Z", question: "Question", category: "auto", sourceType: "manual", strategy: "google-ai", organizedAnswer: "Answer", syncVersion: 1 });

  it("requires authentication for all six endpoints", async () => {
    for (const [path, method, body] of [["/notes", "GET", undefined], ["/notes", "POST", { content: "x" }], ["/notes/from-history", "POST", { entryId: "entry" }], ["/notes/id", "GET", undefined], ["/notes/id", "PATCH", { title: "x" }], ["/notes/id?syncVersion=1", "DELETE", undefined]] as const) {
      const result = await request(path, method, undefined, body);
      expect(result.status).toBe(401);
      expect(result.body).toEqual({ error: "AUTH_REQUIRED" });
      expect(result.cache).toBe("no-store");
    }
  });
  it("isolates Alice's note from Bob and supports update", async () => {
    const created = await request("/notes", "POST", "alice", { content: "secret" });
    expect(created.status).toBe(201);
    const id = created.body.note.id;
    for (const [method, body] of [["GET", undefined], ["PATCH", { title: "changed" }], ["DELETE", { syncVersion: 1 }]] as const) {
      const result = await request(`/notes/${id}`, method, "bob", body);
      expect(result.status).toBe(404);
      expect(result.body).toEqual({ error: "NOTE_NOT_FOUND" });
    }
    expect((await request(`/notes/${id}`, "GET", "alice")).body.note.content).toBe("secret");
    expect((await request(`/notes/${id}`, "PATCH", "alice", { title: "updated" })).body.note.title).toBe("updated");
  });
  it("imports history once and rejects foreign and deleted entries", async () => {
    repos.studentLearningHistory.upsertBatch("alice", [entry("owned"), entry("deleted")]);
    repos.studentLearningHistory.upsertBatch("bob", [entry("foreign")]);
    repos.studentLearningHistory.tombstone("alice", "deleted", 2);
    const first = await request("/notes/from-history", "POST", "alice", { entryId: "owned" });
    expect(first.status).toBe(201);
    expect(first.body.note.content).toBe("Answer");
    const retry = await request("/notes/from-history", "POST", "alice", { entryId: "owned" });
    expect(retry.status).toBe(200);
    expect(retry.body.note.id).toBe(first.body.note.id);
    for (const entryId of ["foreign", "deleted", "missing"]) {
      const result = await request("/notes/from-history", "POST", "alice", { entryId });
      expect(result.status).toBe(404);
      expect(result.body).toEqual({ error: "ENTRY_NOT_FOUND" });
    }
  });
  it("filters book IDs and validates offsets", async () => {
    await request("/notes", "POST", "alice", { content: "book one", bookId: "one" });
    await request("/notes", "POST", "alice", { content: "book two", bookId: "two" });
    const result = await request("/notes?bookId=one", "GET", "alice");
    expect(result.status).toBe(200);
    expect(result.body.notes).toHaveLength(1);
    expect(result.body.notes[0].content).toBe("book one");
    expect((await request("/notes?offset=-1", "GET", "alice")).body).toEqual({ error: "INVALID_OFFSET" });
  });
  it("filters tag and text before pagination and rejects invalid queries", async () => {
    await request("/notes", "POST", "filter-user", { title: "Gravity", content: "Physics", tags: ["science"], bookId: "one" });
    await request("/notes", "POST", "filter-user", { title: "Algebra", content: "Math", tags: ["math"], bookId: "one" });
    const result = await request("/notes?tag=%20science%20&q=GRAV&limit=1", "GET", "filter-user");
    expect(result.body.notes).toHaveLength(1);
    expect(result.body.notes[0].title).toBe("Gravity");
    expect((await request("/notes?tag=math&q=gravity", "GET", "filter-user")).body.notes).toHaveLength(0);
    for (const query of [`tag=${"x".repeat(25)}`, `q=${"x".repeat(101)}`, "tag=%20", "q=%20"]) {
      const invalid = await request(`/notes?${query}`, "GET", "filter-user");
      expect(invalid.status).toBe(400);
      expect(invalid.body).toEqual({ error: "INVALID_QUERY" });
    }
  });
  it("rejects oversized bodies and cross-site writes", async () => {
    const oversized = await request("/NOTES/from-history", "POST", "alice", { entryId: "x".repeat(MAX_STUDENT_NOTE_BODY_BYTES) });
    expect(oversized.status).toBe(413);
    expect(oversized.body).toEqual({ error: "NOTE_TOO_LARGE" });
    const crossSite = await request("/notes", "POST", "alice", { content: "x" }, "https://evil.example");
    expect(crossSite.status).toBe(403);
    expect(crossSite.body).toEqual({ error: "STUDENT_ORIGIN_NOT_ALLOWED" });
  });
  it("validates delete versions, reports stale versions accurately, and exposes tombstones", async () => {
    const created = await request("/notes", "POST", "alice", { content: "delete me", bookId: "tombstone-test" });
    const id = created.body.note.id;
    const missing = await request(`/notes/${id}`, "DELETE", "alice");
    expect(missing.status).toBe(400);
    expect(missing.body).toEqual({ error: "INVALID_DELETE" });
    const updated = await request(`/notes/${id}`, "PATCH", "alice", { title: "version 2" });
    expect(updated.body.note.syncVersion).toBe(2);
    const stale = await request(`/notes/${id}?syncVersion=1`, "DELETE", "alice");
    expect(stale.status).toBe(200);
    expect(stale.body.deleted).toBe(false);
    expect(stale.body.note.deletedAt).toBeNull();
    const deleted = await request(`/notes/${id}`, "DELETE", "alice", { syncVersion: 2 });
    expect(deleted.status).toBe(200);
    expect(deleted.body.deleted).toBe(true);
    expect(deleted.body.note.deletedAt).toBeTruthy();
    expect((await request("/notes?bookId=tombstone-test", "GET", "alice")).body.notes).toHaveLength(0);
    const list = await request("/notes?bookId=tombstone-test&includeDeleted=1", "GET", "alice");
    expect(list.body.notes).toHaveLength(1);
    expect(list.body.notes[0].deletedAt).toBeTruthy();
  });
});
