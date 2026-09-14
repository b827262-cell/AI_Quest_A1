import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function requestWorker(pathname, options = {}) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${Math.random()}`);
  const { default: worker } = await import(workerUrl.href);

  const req = new Request(`http://localhost${pathname}`, {
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...(options.headers ?? {}),
    },
    method: options.method ?? "GET",
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  return worker.fetch(
    req,
    {
      ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
      DB: options.db,
    },
    { waitUntil() {}, passThroughOnException() {} }
  );
}

test("Phase 3A: D1 migration SQL contains required table schemas", () => {
  const migrationPath = path.join(__dirname, "..", "drizzle", "0000_sloppy_talon.sql");
  assert.ok(fs.existsSync(migrationPath), "Migration SQL file must exist");
  const sql = fs.readFileSync(migrationPath, "utf-8");
  assert.match(sql, /CREATE TABLE `students`/);
  assert.match(sql, /CREATE TABLE `reading_progress`/);
  assert.match(sql, /CREATE TABLE `books`/);
  assert.match(sql, /CREATE TABLE `admin_overview`/);
});

test("Phase 3A: Initial GET /api/student/progress returns valid progress list", async () => {
  const res = await requestWorker("/api/student/progress");
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(Array.isArray(data.progress));
  assert.ok(data.progress.length > 0);
  assert.equal(data.progress[0].studentId, "student-synth-001");
});

test("Phase 3A: PUT /api/student/progress updates progress and second GET proves persistence", async () => {
  const payload = {
    bookId: "book-synth-001",
    progressPercent: 88,
    lastReadChapter: "ch-04-cpu-architecture",
    lastReadPage: 72,
  };

  // 1. Send PUT request
  const putRes = await requestWorker("/api/student/progress", {
    method: "PUT",
    headers: {
      "oai-authenticated-user-id": "student-synth-001",
      "oai-authenticated-user-email": "student.alice@synthetic.ai-smartbook.test",
    },
    body: payload,
  });
  assert.equal(putRes.status, 200);
  const putData = await putRes.json();
  assert.equal(putData.success, true);
  assert.equal(putData.updated.progressPercent, 88);
  assert.equal(putData.updated.lastReadChapter, "ch-04-cpu-architecture");
  assert.equal(putData.updated.lastReadPage, 72);

  // 2. Second GET request verifies persistence across requests
  const getRes = await requestWorker("/api/student/progress", {
    headers: {
      "oai-authenticated-user-id": "student-synth-001",
      "oai-authenticated-user-email": "student.alice@synthetic.ai-smartbook.test",
    },
  });
  assert.equal(getRes.status, 200);
  const getData = await getRes.json();
  const updatedBook = getData.progress.find((p) => p.bookId === "book-synth-001");
  assert.ok(updatedBook, "Updated book progress must exist");
  assert.equal(updatedBook.progressPercent, 88);
  assert.equal(updatedBook.lastReadChapter, "ch-04-cpu-architecture");
  assert.equal(updatedBook.lastReadPage, 72);
});

test("Phase 3A: Production unauthenticated PUT /api/student/progress returns 401", async () => {
  const originalEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";

  try {
    const res = await requestWorker("/api/student/progress", {
      method: "PUT",
      body: { bookId: "book-synth-001", progressPercent: 90 },
    });
    assert.equal(res.status, 401);
    const data = await res.json();
    assert.equal(data.error, "unauthorized");
  } finally {
    process.env.NODE_ENV = originalEnv;
  }
});

test("Phase 3A: Production missing D1 binding returns controlled 503", async () => {
  const originalEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";

  try {
    // Authenticated request in production with missing D1 binding must return 503
    const res = await requestWorker("/api/student/progress", {
      headers: {
        "oai-authenticated-user-id": "student-prod-001",
        "oai-authenticated-user-email": "student@example.org",
      },
    });
    assert.equal(res.status, 503);
    const data = await res.json();
    assert.equal(data.error, "database_unavailable");
  } finally {
    process.env.NODE_ENV = originalEnv;
  }
});
