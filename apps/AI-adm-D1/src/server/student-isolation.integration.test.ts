import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { digestStudentSecret } from "@ai-smartbook/auth/server";
import { createDbHandle } from "@ai-smartbook/db";
import { createAdminApp } from "./app";
import { createAdminTestDependencies } from "./dependencies";

const origin = "http://127.0.0.1:5174";
const directories: string[] = [];
const handles: Array<ReturnType<typeof createDbHandle>> = [];

afterEach(() => {
  for (const handle of handles.splice(0)) handle.sqlite.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "a01-student-isolation-"));
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
  const book = dependencies.repos.books.create({ title: "Isolation fixture", status: "published" });
  function student(subject: string) {
    const user = dependencies.repos.studentUsers.create({ googleSubject: subject, email: `${subject}@example.test`, displayName: subject });
    dependencies.repos.studentUsers.updateProfile(user.id, { displayName: subject, schoolName: "Fixture School", gradeLevel: "1" });
    const token = `fixture-session-${subject}`;
    dependencies.repos.studentSessions.create({ tokenDigest: digestStudentSecret(token), userId: user.id, expiresAt: "2099-01-01T00:00:00.000Z" });
    return { userId: user.id, cookie: `ai_student_session=${token}` };
  }
  return { app, dependencies, book, student };
}

type Fixture = ReturnType<typeof fixture>;
type Student = ReturnType<Fixture["student"]>;

function notesPath(bookId: string) {
  return `/api/student/books/${bookId}/notes`;
}

async function createNote(app: Fixture["app"], book: Fixture["book"], who: Student, title: string) {
  const response = await request(app)
    .post(notesPath(book.id))
    .set("Cookie", who.cookie)
    .send({ type: "text", title, content: `${title} content` });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.note as { id: string; title: string; studentId: string | null };
}

describe("student notes are personal", () => {
  it("writes the authenticated student as owner and lists only that student's notes", async () => {
    const { app, book, student } = fixture();
    const alice = student("alice");
    const bob = student("bob");

    const note = await createNote(app, book, alice, "Alice note");
    expect(note.studentId).toBe(alice.userId);

    const aliceList = await request(app).get(notesPath(book.id)).set("Cookie", alice.cookie);
    expect(aliceList.status).toBe(200);
    expect(aliceList.body.notes.map((item: { id: string }) => item.id)).toEqual([note.id]);

    const bobList = await request(app).get(notesPath(book.id)).set("Cookie", bob.cookie);
    expect(bobList.status).toBe(200);
    expect(bobList.body.notes).toEqual([]);
  });

  it("answers another student's note with 404 on read-modify-delete and leaves it intact", async () => {
    const { app, book, student } = fixture();
    const alice = student("alice");
    const bob = student("bob");
    const note = await createNote(app, book, alice, "Alice note");

    const bobPatch = await request(app).patch(`${notesPath(book.id)}/${note.id}`).set("Cookie", bob.cookie).send({ title: "hijacked" });
    expect(bobPatch.status).toBe(404);
    expect(bobPatch.body).toEqual({ error: "note not found" });

    const bobDelete = await request(app).delete(`${notesPath(book.id)}/${note.id}`).set("Cookie", bob.cookie);
    expect(bobDelete.status).toBe(404);
    expect(bobDelete.body).toEqual({ error: "note not found" });

    // Alice still owns the untouched note, and she can change and delete it.
    const aliceGet = await request(app).get(notesPath(book.id)).set("Cookie", alice.cookie);
    expect(aliceGet.body.notes).toHaveLength(1);
    expect(aliceGet.body.notes[0].title).toBe("Alice note");

    const alicePatch = await request(app).patch(`${notesPath(book.id)}/${note.id}`).set("Cookie", alice.cookie).send({ title: "Alice renamed" });
    expect(alicePatch.status).toBe(200);
    expect(alicePatch.body.note.title).toBe("Alice renamed");

    const aliceDelete = await request(app).delete(`${notesPath(book.id)}/${note.id}`).set("Cookie", alice.cookie);
    expect(aliceDelete.status).toBe(200);
    expect(aliceDelete.body).toEqual({ deleted: true });

    const after = await request(app).get(notesPath(book.id)).set("Cookie", alice.cookie);
    expect(after.body.notes).toEqual([]);
  });

  it("hides legacy notes without an owner instead of guessing one", async () => {
    const { app, dependencies, book, student } = fixture();
    const alice = student("alice");
    const legacy = dependencies.repos.notes.create(book.id, { type: "text", title: "Legacy", content: "old" }, null);
    expect(legacy.studentId).toBeNull();

    const list = await request(app).get(notesPath(book.id)).set("Cookie", alice.cookie);
    expect(list.status).toBe(200);
    expect(list.body.notes).toEqual([]);

    const patch = await request(app).patch(`${notesPath(book.id)}/${legacy.id}`).set("Cookie", alice.cookie).send({ title: "claimed" });
    expect(patch.status).toBe(404);
    const remove = await request(app).delete(`${notesPath(book.id)}/${legacy.id}`).set("Cookie", alice.cookie);
    expect(remove.status).toBe(404);

    // Fail-closed means hidden, not deleted: the row survives untouched.
    expect(dependencies.repos.notes.findById(legacy.id)).toMatchObject({ id: legacy.id, title: "Legacy", studentId: null });
  });
});

describe("student chat sessions and progress are personal", () => {
  async function aliceSession(app: Fixture["app"], book: Fixture["book"], alice: Student) {
    const created = await request(app).post(`/api/student/books/${book.id}/session`).set("Cookie", alice.cookie).send({});
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const sessionId = created.body.sessionId as string;
    const chat = await request(app)
      .post(`/api/student/books/${book.id}/chat`)
      .set("Cookie", alice.cookie)
      .send({ message: "Alice private question", sessionId });
    expect(chat.status, JSON.stringify(chat.body)).toBe(200);
    return sessionId;
  }

  it("records the student as session owner and keeps the chat readable for that student", async () => {
    const { app, dependencies, book, student } = fixture();
    const alice = student("alice");
    const sessionId = await aliceSession(app, book, alice);

    expect(dependencies.repos.chat.findSessionById(sessionId)?.userId).toBe(alice.userId);

    const own = await request(app).get(`/api/student/books/${book.id}/chat-sessions/${sessionId}`).set("Cookie", alice.cookie);
    expect(own.status).toBe(200);
    expect(own.body.messages.some((message: { content: string }) => message.content === "Alice private question")).toBe(true);
  });

  it("answers another student's session with 404 for chat history, chat writes and progress", async () => {
    const { app, book, student } = fixture();
    const alice = student("alice");
    const bob = student("bob");
    const sessionId = await aliceSession(app, book, alice);

    const history = await request(app).get(`/api/student/books/${book.id}/chat-sessions/${sessionId}`).set("Cookie", bob.cookie);
    expect(history.status).toBe(404);
    expect(history.body).toEqual({ error: "session not found" });

    const write = await request(app)
      .post(`/api/student/books/${book.id}/chat`)
      .set("Cookie", bob.cookie)
      .send({ message: "Bob writes into Alice's session", sessionId });
    expect(write.status).toBe(404);
    expect(write.body).toEqual({ error: "session not found" });

    const summary = await request(app)
      .get(`/api/student/books/${book.id}/progress-summary`)
      .set("Cookie", bob.cookie)
      .set("x-student-session-id", sessionId);
    expect(summary.status).toBe(404);

    const progress = await request(app)
      .post(`/api/student/books/${book.id}/progress`)
      .set("Cookie", bob.cookie)
      .set("x-student-session-id", sessionId)
      .send({ eventType: "page_complete", page: 3 });
    expect(progress.status).toBe(404);

    // Bob's failed writes never reached Alice's transcript.
    const aliceView = await request(app).get(`/api/student/books/${book.id}/chat-sessions/${sessionId}`).set("Cookie", alice.cookie);
    expect(aliceView.status).toBe(200);
    expect(aliceView.body.messages.some((message: { content: string }) => message.content.startsWith("Bob writes"))).toBe(false);

    // Alice's own progress route still works.
    const aliceSummary = await request(app)
      .get(`/api/student/books/${book.id}/progress-summary`)
      .set("Cookie", alice.cookie)
      .set("x-student-session-id", sessionId);
    expect(aliceSummary.status).toBe(200);
  });

  it("hides legacy sessions without an owner from every student", async () => {
    const { app, dependencies, book, student } = fixture();
    const alice = student("alice");
    const legacy = dependencies.repos.chat.createSession({ bookId: book.id, title: "Legacy reader session" });
    expect(legacy.userId).toBeNull();

    const history = await request(app).get(`/api/student/books/${book.id}/chat-sessions/${legacy.id}`).set("Cookie", alice.cookie);
    expect(history.status).toBe(404);

    const summary = await request(app)
      .get(`/api/student/books/${book.id}/progress-summary`)
      .set("Cookie", alice.cookie)
      .set("x-student-session-id", legacy.id);
    expect(summary.status).toBe(404);

    const write = await request(app)
      .post(`/api/student/books/${book.id}/chat`)
      .set("Cookie", alice.cookie)
      .send({ message: "adopt legacy session", sessionId: legacy.id });
    expect(write.status).toBe(404);

    // The legacy row is preserved for the Owner to decide on, not deleted.
    expect(dependencies.repos.chat.findSessionById(legacy.id)).toMatchObject({ id: legacy.id, userId: null });
  });
});
