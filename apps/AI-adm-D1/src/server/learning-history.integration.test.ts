import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { digestStudentSecret } from "@ai-smartbook/auth/server";
import { createDbHandle, runMigrations } from "@ai-smartbook/db";
import { createAdminApp } from "./app";
import { createAdminTestDependencies } from "./dependencies";

const origin = "http://127.0.0.1:5174";
const EXPECTED_MAX_LEARNING_HISTORY_BATCH = 25;
const EXPECTED_MAX_LEARNING_HISTORY_BODY_BYTES = 256 * 1024;
const directories: string[] = [];
const handles: Array<ReturnType<typeof createDbHandle>> = [];

afterEach(() => {
  for (const handle of handles.splice(0)) handle.sqlite.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "a01-learning-history-"));
  directories.push(directory);
  const handle = createDbHandle(join(directory, "test.sqlite"));
  handles.push(handle);
  const env = {
    NODE_ENV: "test", ADMIN_API_TOKEN: "test-admin-token", ADMIN_USERNAME: "admin", ADMIN_PASSWORD: "test-password",
    ADMIN_ALLOWED_ORIGINS: origin, STUDENT_ALLOWED_ORIGINS: origin, AI_PROVIDER: "mock", AI_GATEWAY_ENABLED: "false",
    AI_CREDENTIAL_ENCRYPTION_KEY: "test-only-encryption-key-0123456789",
    STUDENT_SESSION_SECRET: "test-only-student-session-secret-0123456789"
  };
  const dependencies = createAdminTestDependencies(env, handle);
  const app = createAdminApp(dependencies);
  function student(subject: string) {
    const user = dependencies.repos.studentUsers.create({ googleSubject: subject, email: `${subject}@example.test`, displayName: subject });
    dependencies.repos.studentUsers.updateProfile(user.id, { displayName: subject, schoolName: "Fixture School", gradeLevel: "1" });
    const token = `fixture-session-${subject}`;
    dependencies.repos.studentSessions.create({ tokenDigest: digestStudentSecret(token), userId: user.id, expiresAt: "2099-01-01T00:00:00.000Z" });
    return { userId: user.id, cookie: `ai_student_session=${token}` };
  }
  return { app, handle, dependencies, student };
}

function entry(id: string, question: string, syncVersion = 1) {
  return {
    id, askedAt: "2026-10-16T10:24:00.000Z", question, category: "auto", sourceType: "manual" as const, strategy: "google-ai" as const,
    rawAnswer: "這是測試原始回答", rawAnswerCapturedAt: "2026-10-16T10:25:00.000Z",
    sourceUrl: `https://www.google.com/search?udm=50&q=${encodeURIComponent(question)}`,
    organizedAnswer: "這是測試原始回答", syncVersion
  };
}

describe("student learning history sync and admin visibility", () => {
  it("accepts a 25-entry body at exactly 256 KiB and rejects one extra byte", async () => {
    const { app, student } = fixture();
    const alice = student("size-boundary");
    const entries = Array.from({ length: EXPECTED_MAX_LEARNING_HISTORY_BATCH }, (_, index) => ({
      ...entry(`size-${index}`, "AI agents"),
      answer: ""
    }));
    entries.slice(0, 12).forEach((item) => { item.answer = "x".repeat(20_000); });

    const paddingIndex = 12;
    const emptyPaddingBytes = EXPECTED_MAX_LEARNING_HISTORY_BODY_BYTES - Buffer.byteLength(JSON.stringify({ entries }), "utf8");
    expect(emptyPaddingBytes).toBeGreaterThan(0);
    expect(emptyPaddingBytes).toBeLessThanOrEqual(20_000);
    entries[paddingIndex].answer = "x".repeat(emptyPaddingBytes);
    const exactBody = JSON.stringify({ entries });
    expect(Buffer.byteLength(exactBody, "utf8")).toBe(EXPECTED_MAX_LEARNING_HISTORY_BODY_BYTES);

    const path = "/api/student/learning-history";
    const exact = await request(app).post(path).set("Cookie", alice.cookie).set("Origin", origin).set("Content-Type", "application/json").send(exactBody);
    expect(exact.status).toBe(200);
    expect(exact.body.entries).toHaveLength(EXPECTED_MAX_LEARNING_HISTORY_BATCH);

    const overEntries = entries.map((item) => ({ ...item }));
    overEntries[paddingIndex].answer += "x";
    const overBody = JSON.stringify({ entries: overEntries });
    expect(Buffer.byteLength(overBody, "utf8")).toBe(EXPECTED_MAX_LEARNING_HISTORY_BODY_BYTES + 1);
    const over = await request(app).post(path).set("Cookie", alice.cookie).set("Origin", origin).set("Content-Type", "application/json").send(overBody);
    expect(over.status).toBe(413);
    expect(over.body).toEqual({ error: "BATCH_TOO_LARGE" });
  });

  it("requires a verified student, handles bounded idempotent updates, tombstones and ownership", async () => {
    const { app, handle, student } = fixture();
    const alice = student("alice");
    const bob = student("bob");
    const path = "/api/student/learning-history";
    expect((await request(app).get(path)).status).toBe(401);
    expect((await request(app).post(path).set("Origin", origin).send({ entries: [entry("e1", "AI agents")] })).status).toBe(401);
    expect((await request(app).post(path).set("Cookie", alice.cookie).send({ entries: [entry("e1", "AI agents")] })).status).toBe(403);
    expect((await request(app).post(path).set("Cookie", alice.cookie).set("Origin", origin).send({ entries: [entry("e1", "AI agents"), entry("e1", "AI agents")] })).status).toBe(400);
    expect((await request(app).post(path).set("Cookie", alice.cookie).set("Origin", origin).send({ entries: [entry("e1", "AI agents"), ...Array.from({ length: 25 }, (_, i) => entry(`x${i}`, "other"))] })).status).toBe(400);
    expect((await request(app).post(path).set("Cookie", alice.cookie).set("Origin", origin).send({ entries: [{ ...entry("e1", "AI agents"), sourceUrl: "https://www.google.com.evil.test/search?udm=50&q=AI" }] })).status).toBe(400);
    const saved = await request(app).post(path).set("Cookie", alice.cookie).set("Origin", origin).send({ entries: [entry("e1", "AI agents"), entry("e2", "AI 如何寫程式")] });
    expect(saved.status).toBe(200);
    expect(saved.body.entries).toHaveLength(2);
    const replay = await request(app).put(path).set("Cookie", alice.cookie).set("Origin", origin).send({ entries: [entry("e1", "AI agents")] });
    expect(replay.status).toBe(200);
    expect(replay.body.entries[0].syncVersion).toBe(1);
    expect(handle.sqlite.prepare("SELECT COUNT(*) n FROM student_learning_history").get()).toMatchObject({ n: 2 });
    const bobList = await request(app).get(path).set("Cookie", bob.cookie);
    expect(bobList.body.entries).toEqual([]);
    expect((await request(app).delete(`${path}/e1`).set("Cookie", bob.cookie).set("Origin", origin).send({ syncVersion: 2 })).status).toBe(404);
    const deleted = await request(app).delete(`${path}/e1`).set("Cookie", alice.cookie).set("Origin", origin).send({ syncVersion: 2 });
    expect(deleted.status).toBe(200);
    expect(deleted.body.entry.deletedAt).toBeTruthy();
    expect(deleted.body.entry.question).toBe("");
    expect(deleted.body.entry.rawAnswer).toBeUndefined();
    const stale = await request(app).post(path).set("Cookie", alice.cookie).set("Origin", origin).send({ entries: [entry("e1", "AI agents", 1)] });
    expect(stale.body.entries[0].deletedAt).toBeTruthy();
    const offlineNewer = await request(app).post(path).set("Cookie", alice.cookie).set("Origin", origin).send({ entries: [entry("e1", "AI agents", 9)] });
    expect(offlineNewer.body.entries[0].deletedAt).toBeTruthy();
    expect((await request(app).get(path).set("Cookie", alice.cookie)).body.entries).toHaveLength(2);
    await request(app).put(path).set("Cookie", alice.cookie).set("Origin", origin).send({ entries: [entry("e2", "AI 如何寫程式", 5)] });
    const staleDelete = await request(app).delete(`${path}/e2`).set("Cookie", alice.cookie).set("Origin", origin).send({ syncVersion: 2 });
    expect(staleDelete.body.entry.deletedAt).toBeNull();
    const currentDelete = await request(app).delete(`${path}/e2`).set("Cookie", alice.cookie).set("Origin", origin).send({ syncVersion: 6 });
    expect(currentDelete.body.entry.deletedAt).toBeTruthy();
    runMigrations(handle.sqlite);
    runMigrations(handle.sqlite);
    expect(handle.sqlite.prepare("SELECT COUNT(*) n FROM student_learning_history").get()).toMatchObject({ n: 2 });
  });

  it("shows redacted list rows, full detail and filtered pages only behind admin auth", async () => {
    const { app, dependencies, student } = fixture();
    const alice = student("alice");
    dependencies.repos.studentLearningHistory.upsertBatch(alice.userId, [entry("e1", "AI agents"), entry("e2", "AI 如何寫程式")]);
    expect((await request(app).get("/api/admin/learning-history")).status).toBe(401);
    const login = await request(app).post("/api/admin/auth/login").set("Origin", origin).send({ username: "admin", password: "test-password" });
    expect(login.status).toBe(200);
    const cookie = (login.headers["set-cookie"] as unknown as string[]).map((value) => value.split(";", 1)[0]).join("; ");
    const list = await request(app).get("/api/admin/learning-history?limit=1&offset=0&q=agents").set("Cookie", cookie);
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(1);
    expect(list.body.entries).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain("這是測試原始回答");
    const detail = await request(app).get(`/api/admin/learning-history/${alice.userId}/e1`).set("Cookie", cookie);
    expect(detail.status).toBe(200);
    expect(detail.body.entry.rawAnswer).toBe("這是測試原始回答");
    const secondPage = await request(app).get("/api/admin/learning-history?limit=1&offset=1").set("Cookie", cookie);
    expect(secondPage.status).toBe(200);
    expect(secondPage.body.entries).toHaveLength(1);
  });
});
