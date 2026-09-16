import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { POST as postRuns } from "../app/api/internal/sync/runs/route.ts";
import { POST as postStudents } from "../app/api/internal/sync/students/route.ts";
import { POST as postProgress } from "../app/api/internal/sync/progress/route.ts";
import { POST as postBooks } from "../app/api/internal/sync/books/route.ts";
import { POST as postCommit } from "../app/api/internal/sync/commit/route.ts";
import { GET as getConflicts } from "../app/api/internal/sync/conflicts/route.ts";
import { InMemoryR2Bucket } from "../lib/storage.ts";

const SECRET = "unit-test-sync-import-secret-value";
const contentRoute = await import(new URL("../app/api/internal/sync/books/%5Bid%5D/content/route.ts", import.meta.url).href);
const POST_CONTENT = contentRoute.POST;

globalThis.SYNC_IMPORT_SECRET = SECRET;

function normalizeParam(value) {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value === undefined) return null;
  return value;
}

function applyMigrations(sqlite) {
  const dir = fileURLToPath(new URL("../drizzle", import.meta.url));
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".sql")).sort()) {
    const sql = readFileSync(join(dir, file), "utf8").replaceAll("--> statement-breakpoint\n", "").replaceAll("--> statement-breakpoint", "");
    sqlite.exec(sql);
  }
}

function freshDb() {
  const sqlite = new DatabaseSync(":memory:");
  applyMigrations(sqlite);
  globalThis.DB = {
    prepare(sql) {
      const stmt = sqlite.prepare(sql);
      return {
        bind(...params) { this.params = params.map(normalizeParam); return this; },
        async all() { return { results: stmt.all(...(this.params ?? [])) }; },
        async run() { stmt.run(...(this.params ?? [])); return { success: true, meta: {} }; },
        async raw() { return stmt.all(...(this.params ?? [])).map((row) => Object.values(row)); },
      };
    },
  };
  return sqlite;
}

function signHeaders(bodyForDigest, extra = {}) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomUUID().replace(/-/g, "");
  const digest = createHash("sha256").update(bodyForDigest ?? "").digest("hex");
  const signature = createHmac("sha256", SECRET).update(`${timestamp}.${nonce}.${digest}`).digest("base64url");
  return { "x-sync-timestamp": timestamp, "x-sync-nonce": nonce, "x-sync-signature": signature, ...extra };
}

function signedPost(path, body, headers = {}, contentType = "application/json") {
  const raw = typeof body === "string" ? body : "";
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": contentType, ...signHeaders(typeof body === "string" ? body : body, headers) },
    body: typeof body === "string" ? body : body instanceof Uint8Array ? body : raw,
  });
}

function signedGet(path) {
  return new Request(`http://localhost${path}`, { method: "GET", headers: signHeaders("") });
}

function record(sourceRecordId, sourceUpdatedAt, checksum, fields) {
  return { sourceRecordId, sourceUpdatedAt, syncVersion: Date.parse(sourceUpdatedAt), checksum, ...fields };
}

function hexDigest(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function openRun(payload = { source: "e500" }) {
  const res = await postRuns(signedPost("/api/internal/sync/runs", JSON.stringify(payload)));
  assert.equal(res.status, 201);
  return (await res.json()).runId;
}

test("sync API rejects guests with 401 and signed-in visitors with 403", async () => {
  freshDb();
  const guest = await postRuns(new Request("http://localhost/api/internal/sync/runs", { method: "POST", body: "{}" }));
  assert.equal(guest.status, 401);
  assert.equal((await guest.json()).error, "unauthorized");

  const signedIn = await postRuns(new Request("http://localhost/api/internal/sync/runs", {
    method: "POST",
    body: "{}",
    headers: { "content-type": "application/json", "oai-authenticated-user-id": "user-1", authorization: "Bearer visitor-session" },
  }));
  assert.equal(signedIn.status, 403);
  assert.equal((await signedIn.json()).error, "forbidden");

  const badSignature = await postRuns(new Request("http://localhost/api/internal/sync/runs", {
    method: "POST",
    body: "{}",
    headers: { "content-type": "application/json", ...signHeaders("{}", { "x-sync-signature": "a".repeat(40) }) },
  }));
  assert.equal(badSignature.status, 401);
  assert.equal((await badSignature.json()).error, "invalid_sync_credential");
});

test("sync run applies student batches once and skips identical re-imports", async () => {
  const sqlite = freshDb();
  const stamp = "2026-09-01T00:00:00.000Z";
  const items = [
    record("stu-1", stamp, hexDigest("one"), { email: "synth-1@example.invalid", displayName: "Synthetic One", createdAt: stamp }),
    record("stu-2", stamp, hexDigest("two"), { email: "synth-2@example.invalid", displayName: "Synthetic Two", createdAt: stamp }),
  ];
  const body = JSON.stringify({ source: "e500", items });

  const run1 = await openRun();
  const applied = await postStudents(signedPost("/api/internal/sync/students", JSON.stringify({ runId: run1, source: "e500", items })));
  assert.equal(applied.status, 200);
  const commit1 = await postCommit(signedPost("/api/internal/sync/commit", JSON.stringify({ runId: run1 })));
  const firstRun = await commit1.json();
  assert.equal(firstRun.status, "completed");
  assert.equal(firstRun.inserted, 2);
  assert.equal(firstRun.total, 2);

  const run2 = await openRun();
  await postStudents(signedPost("/api/internal/sync/students", JSON.stringify({ runId: run2, source: "e500", items })));
  const secondRun = await (await postCommit(signedPost("/api/internal/sync/commit", JSON.stringify({ runId: run2 })))).json();
  assert.equal(secondRun.skipped, 2);
  assert.equal(secondRun.inserted, 0);

  const rows = sqlite.prepare("SELECT COUNT(*) AS count FROM students WHERE source_system = 'e500'").get();
  assert.equal(rows.count, 2);
  void body;
});

test("replayed nonces are rejected even with a valid signature", async () => {
  freshDb();
  const body = JSON.stringify({ source: "e500" });
  const headers = { "content-type": "application/json", ...signHeaders(body) };
  const first = await postRuns(new Request("http://localhost/api/internal/sync/runs", { method: "POST", body, headers }));
  assert.equal(first.status, 201);
  const replay = await postRuns(new Request("http://localhost/api/internal/sync/runs", { method: "POST", body, headers }));
  assert.equal(replay.status, 401);
  assert.equal((await replay.json()).error, "replayed_sync_request");
});

test("equal versions with different checksums conflict and never overwrite", async () => {
  const sqlite = freshDb();
  const stamp = "2026-09-02T00:00:00.000Z";
  const run1 = await openRun();
  await postStudents(signedPost("/api/internal/sync/students", JSON.stringify({
    runId: run1, source: "e500",
    items: [record("stu-conflict", stamp, hexDigest("original"), { email: "conflict-original@example.invalid", displayName: "Original", createdAt: stamp })],
  })));

  const run2 = await openRun();
  await postStudents(signedPost("/api/internal/sync/students", JSON.stringify({
    runId: run2, source: "e500",
    items: [record("stu-conflict", stamp, hexDigest("changed"), { email: "conflict-changed@example.invalid", displayName: "Changed", createdAt: stamp })],
  })));
  const committed = await (await postCommit(signedPost("/api/internal/sync/commit", JSON.stringify({ runId: run2 })))).json();
  assert.equal(committed.status, "completed_with_errors");
  assert.equal(committed.conflicts, 1);

  const row = sqlite.prepare("SELECT display_name FROM students WHERE source_record_id = 'stu-conflict'").get();
  assert.equal(row.display_name, "Original");

  const conflicts = await (await getConflicts(signedGet("/api/internal/sync/conflicts"))).json();
  assert.equal(conflicts.conflicts.length, 1);
  assert.equal(conflicts.conflicts[0].source_record_id ?? conflicts.conflicts[0].sourceRecordId, "stu-conflict");
});

test("progress batches resolve sync source identities to stable target ids", async () => {
  const sqlite = freshDb();
  const stamp = "2026-09-03T00:00:00.000Z";
  const run = await openRun();
  await postStudents(signedPost("/api/internal/sync/students", JSON.stringify({
    runId: run, source: "e500",
    items: [record("stu-p", stamp, hexDigest("s"), { email: "progress-user@example.invalid", displayName: "Progress User", createdAt: stamp })],
  })));
  await postBooks(signedPost("/api/internal/sync/books", JSON.stringify({
    runId: run, source: "e500",
    items: [record("bk-p", stamp, hexDigest("b"), { title: "Synthetic Progress Book", description: "", totalChapters: 3, totalPages: 40, createdAt: stamp })],
  })));
  const progressRes = await postProgress(signedPost("/api/internal/sync/progress", JSON.stringify({
    runId: run, source: "e500",
    items: [record("pg-1", stamp, hexDigest("p"), { studentId: "stu-p", bookId: "bk-p", progressPercent: 55, lastReadChapter: "ch-2", lastReadPage: 21 })],
  })));
  assert.equal(progressRes.status, 200);
  const row = sqlite.prepare("SELECT student_id, book_id, progress_percent FROM reading_progress WHERE source_record_id = 'pg-1'").get();
  assert.equal(row.student_id, "sync-student-e500-stu-p");
  assert.equal(row.book_id, "sync-book-e500-bk-p");
  assert.equal(row.progress_percent, 55);
});

test("book content upload stores verified R2 bytes, skips resends, and rejects bad payloads", async () => {
  const sqlite = freshDb();
  const bucket = new InMemoryR2Bucket();
  globalThis.BOOKS_BUCKET = bucket;
  const stamp = "2026-09-04T00:00:00.000Z";
  const metadataChecksum = hexDigest("meta");
  const run = await openRun();
  await postBooks(signedPost("/api/internal/sync/books", JSON.stringify({
    runId: run, source: "e500",
    items: [record("bk-c", stamp, metadataChecksum, { title: "Synthetic Content Book", description: "", totalChapters: 1, totalPages: 8, createdAt: stamp })],
  })));
  const created = sqlite.prepare("SELECT storage_state, checksum FROM books WHERE source_record_id = 'bk-c'").get();
  assert.equal(created.storage_state, "pending");
  assert.equal(created.checksum, metadataChecksum);

  const pdf = new TextEncoder().encode("%PDF-1.4 synthetic sync content\n%%EOF\n");
  const sha = hexDigest(pdf);
  const targetId = "sync-book-e500-bk-c";
  const context = { params: Promise.resolve({ id: targetId }) };
  const extra = { "x-run-id": run, "x-source-system": "e500", "x-source-record-id": "bk-c", "x-source-updated-at": stamp, "x-sync-version": String(Date.parse(stamp)) };

  const uploaded = await POST_CONTENT(signedPost(`/api/internal/sync/books/${targetId}/content`, pdf, extra, "application/pdf"), context);
  assert.equal(uploaded.status, 201);
  const upload = await uploaded.json();
  assert.equal(upload.objectKey, `books/${targetId}/${sha}.pdf`);
  assert.equal(upload.byteSize, pdf.length);
  assert.ok(await bucket.head(upload.objectKey));
  const active = sqlite.prepare("SELECT storage_state, sha256, checksum, sync_version FROM books WHERE id = ?").get(targetId);
  assert.equal(active.storage_state, "active");
  assert.equal(active.sha256, sha);
  assert.equal(active.checksum, metadataChecksum);

  const resend = await (await POST_CONTENT(signedPost(`/api/internal/sync/books/${targetId}/content`, pdf, extra, "application/pdf"), context)).json();
  assert.equal(resend.skipped, true);

  const identicalRun = await openRun();
  await postBooks(signedPost("/api/internal/sync/books", JSON.stringify({
    runId: identicalRun, source: "e500",
    items: [record("bk-c", stamp, metadataChecksum, { title: "Synthetic Content Book", description: "", totalChapters: 1, totalPages: 8, createdAt: stamp })],
  })));
  const identicalCommit = await (await postCommit(signedPost("/api/internal/sync/commit", JSON.stringify({ runId: identicalRun })))).json();
  assert.equal(identicalCommit.skipped, 1);
  assert.equal(identicalCommit.conflicts, 0);

  const conflictRun = await openRun();
  await postBooks(signedPost("/api/internal/sync/books", JSON.stringify({
    runId: conflictRun, source: "e500",
    items: [record("bk-c", stamp, hexDigest("changed metadata"), { title: "Changed Content Book", description: "", totalChapters: 1, totalPages: 8, createdAt: stamp })],
  })));
  const conflictCommit = await (await postCommit(signedPost("/api/internal/sync/commit", JSON.stringify({ runId: conflictRun })))).json();
  assert.equal(conflictCommit.conflicts, 1);
  const preserved = sqlite.prepare("SELECT title, checksum, sha256 FROM books WHERE id = ?").get(targetId);
  assert.equal(preserved.title, "Synthetic Content Book");
  assert.equal(preserved.checksum, metadataChecksum);
  assert.equal(preserved.sha256, sha);

  const base64Res = await POST_CONTENT(signedPost(`/api/internal/sync/books/${targetId}/content`, JSON.stringify({
    contentType: "application/pdf", contentBase64: Buffer.from(pdf).toString("base64"), sourceSystem: "e500", sourceRecordId: "bk-c", runId: run,
  }), { "x-run-id": run }), context);
  assert.equal(base64Res.status, 200);
  assert.equal((await base64Res.json()).skipped, true);

  const badMagic = await POST_CONTENT(signedPost(`/api/internal/sync/books/${targetId}/content`, new TextEncoder().encode("NOTA PDF FILE"), { ...extra, "x-sync-version": String(Date.parse(stamp) + 5000) }, "application/pdf"), context);
  assert.equal(badMagic.status, 400);
  assert.equal((await badMagic.json()).error, "invalid_pdf");

  const oversizedBase64 = "QQ".repeat(4_000_001);
  const tooLarge = await POST_CONTENT(signedPost(`/api/internal/sync/books/${targetId}/content`, JSON.stringify({
    contentType: "application/pdf", contentBase64: oversizedBase64, sourceSystem: "e500", sourceRecordId: "bk-c", runId: run,
  }), { "x-run-id": run }), context);
  assert.equal(tooLarge.status, 400);
  assert.match((await tooLarge.json()).error, /too large/);

  const missingBook = await POST_CONTENT(signedPost("/api/internal/sync/books/sync-book-e500-unknown/content", pdf, { ...extra, "x-source-record-id": "unknown" }, "application/pdf"), { params: Promise.resolve({ id: "sync-book-e500-unknown" }) });
  assert.equal(missingBook.status, 404);
  assert.equal((await missingBook.json()).error, "book_not_found");

  const wrongIdentity = await POST_CONTENT(signedPost(`/api/internal/sync/books/${targetId}/content`, pdf, { ...extra, "x-source-record-id": "bk-other" }, "application/pdf"), context);
  assert.equal(wrongIdentity.status, 409);
  assert.equal((await wrongIdentity.json()).error, "source_identity_mismatch");
});

test("book metadata sync repairs legacy rows whose checksum was overwritten by content sha256", async () => {
  const sqlite = freshDb();
  const bucket = new InMemoryR2Bucket();
  globalThis.BOOKS_BUCKET = bucket;
  const stamp = "2026-09-05T00:00:00.000Z";
  const metadataChecksum = hexDigest("legacy metadata");
  const book = record("bk-legacy", stamp, metadataChecksum, { title: "Legacy Content Book", description: "", totalChapters: 1, totalPages: 4, createdAt: stamp });
  const firstRun = await openRun();
  await postBooks(signedPost("/api/internal/sync/books", JSON.stringify({ runId: firstRun, source: "e500", items: [book] })));

  const pdf = new TextEncoder().encode("%PDF-1.4 legacy checksum repair\n%%EOF\n");
  const pdfSha256 = hexDigest(pdf);
  const targetId = "sync-book-e500-bk-legacy";
  const contentHeaders = { "x-run-id": firstRun, "x-source-system": "e500", "x-source-record-id": "bk-legacy", "x-source-updated-at": stamp, "x-sync-version": String(Date.parse(stamp)) };
  const upload = await POST_CONTENT(signedPost(`/api/internal/sync/books/${targetId}/content`, pdf, contentHeaders, "application/pdf"), { params: Promise.resolve({ id: targetId }) });
  assert.equal(upload.status, 201);

  sqlite.prepare("UPDATE books SET checksum = sha256 WHERE id = ?").run(targetId);
  const corrupted = sqlite.prepare("SELECT checksum, sha256 FROM books WHERE id = ?").get(targetId);
  assert.equal(corrupted.checksum, pdfSha256);

  const repairRun = await openRun();
  await postBooks(signedPost("/api/internal/sync/books", JSON.stringify({ runId: repairRun, source: "e500", items: [book] })));
  const repairedCommit = await (await postCommit(signedPost("/api/internal/sync/commit", JSON.stringify({ runId: repairRun })))).json();
  assert.equal(repairedCommit.updated, 1);
  assert.equal(repairedCommit.conflicts, 0);
  const repaired = sqlite.prepare("SELECT checksum, sha256, storage_state FROM books WHERE id = ?").get(targetId);
  assert.equal(repaired.checksum, metadataChecksum);
  assert.equal(repaired.sha256, pdfSha256);
  assert.equal(repaired.storage_state, "active");

  const validationRun = await openRun();
  await postBooks(signedPost("/api/internal/sync/books", JSON.stringify({ runId: validationRun, source: "e500", items: [book] })));
  const validationCommit = await (await postCommit(signedPost("/api/internal/sync/commit", JSON.stringify({ runId: validationRun })))).json();
  assert.equal(validationCommit.skipped, 1);
  assert.equal(validationCommit.conflicts, 0);
});

test("dry-run sync run calculates decisions and records items without mutating domain tables or R2", async () => {
  const sqlite = freshDb();
  const bucket = new InMemoryR2Bucket();
  globalThis.BOOKS_BUCKET = bucket;
  const stamp = "2026-09-06T00:00:00.000Z";
  const runId = await openRun({ source: "e500", dryRun: true });

  const studentItem = record("stu-dry", stamp, hexDigest("s-dry"), { email: "dry@example.invalid", displayName: "Dry Student", createdAt: stamp });
  const bookItem = record("bk-dry", stamp, hexDigest("b-dry"), { title: "Dry Book", description: "", totalChapters: 2, totalPages: 20, createdAt: stamp });
  const progressItem = record("pg-dry", stamp, hexDigest("p-dry"), { studentId: "stu-dry", bookId: "bk-dry", progressPercent: 40, lastReadChapter: "ch-1", lastReadPage: 8 });

  const stuRes = await (await postStudents(signedPost("/api/internal/sync/students", JSON.stringify({ runId, source: "e500", items: [studentItem] })))).json();
  assert.equal(stuRes.accepted, true);
  assert.equal(stuRes.dryRun, true);

  const bkRes = await (await postBooks(signedPost("/api/internal/sync/books", JSON.stringify({ runId, source: "e500", items: [bookItem] })))).json();
  assert.equal(bkRes.accepted, true);
  assert.equal(bkRes.dryRun, true);

  const pgRes = await (await postProgress(signedPost("/api/internal/sync/progress", JSON.stringify({ runId, source: "e500", items: [progressItem] })))).json();
  assert.equal(pgRes.accepted, true);
  assert.equal(pgRes.dryRun, true);

  const commitRes = await (await postCommit(signedPost("/api/internal/sync/commit", JSON.stringify({ runId })))).json();
  assert.equal(commitRes.status, "completed");
  assert.equal(commitRes.dryRun, true);
  assert.equal(commitRes.inserted, 3);
  assert.equal(commitRes.total, 3);

  // Assert domain tables have zero inserted rows
  const studentCount = sqlite.prepare("SELECT COUNT(*) AS count FROM students WHERE source_system = 'e500'").get().count;
  const bookCount = sqlite.prepare("SELECT COUNT(*) AS count FROM books WHERE source_system = 'e500'").get().count;
  const progressCount = sqlite.prepare("SELECT COUNT(*) AS count FROM reading_progress WHERE source_system = 'e500'").get().count;
  assert.equal(studentCount, 0);
  assert.equal(bookCount, 0);
  assert.equal(progressCount, 0);

  // Assert sync_items has dry_run records
  const itemStatuses = sqlite.prepare("SELECT DISTINCT status FROM sync_items WHERE run_id = ?").all(runId);
  assert.deepEqual(itemStatuses.map((row) => row.status), ["dry_run"]);
});

test("book content upload enforces active sync run and dry-run isolation", async () => {
  const sqlite = freshDb();
  const bucket = new InMemoryR2Bucket();
  globalThis.BOOKS_BUCKET = bucket;
  const stamp = "2026-09-07T00:00:00.000Z";
  const liveRun = await openRun();
  const bookItem = record("bk-guard", stamp, hexDigest("b-guard"), { title: "Guard Book", description: "", totalChapters: 1, totalPages: 10, createdAt: stamp });
  await postBooks(signedPost("/api/internal/sync/books", JSON.stringify({ runId: liveRun, source: "e500", items: [bookItem] })));

  const targetId = "sync-book-e500-bk-guard";
  const pdf = new TextEncoder().encode("%PDF-1.4 guard test content\n%%EOF\n");
  const contentHeaders = {
    "x-source-system": "e500", "x-source-record-id": "bk-guard", "x-source-updated-at": stamp, "x-sync-version": String(Date.parse(stamp)),
  };

  // Rejects upload with non-existent or inactive runId
  const badRunRes = await POST_CONTENT(signedPost(`/api/internal/sync/books/${targetId}/content`, pdf, {
    "x-run-id": "non-existent-run", ...contentHeaders,
  }, "application/pdf"), { params: Promise.resolve({ id: targetId }) });
  assert.equal(badRunRes.status, 409);

  // Dry-run content upload does not store to R2 or update D1
  const dryRun = await openRun({ source: "e500", dryRun: true });
  const dryUploadRes = await POST_CONTENT(signedPost(`/api/internal/sync/books/${targetId}/content`, pdf, {
    "x-run-id": dryRun, ...contentHeaders,
  }, "application/pdf"), { params: Promise.resolve({ id: targetId }) });
  assert.equal(dryUploadRes.status, 200);
  const dryData = await dryUploadRes.json();
  assert.equal(dryData.dryRun, true);
  assert.equal(dryData.skipped, false);

  const bookInDb = sqlite.prepare("SELECT storage_state, object_key FROM books WHERE id = ?").get(targetId);
  assert.equal(bookInDb.storage_state, "pending");
  assert.equal(bookInDb.object_key, "");
  assert.equal((await bucket.head(`books/${targetId}/${dryData.sha256}.pdf`)), null);
});

test("reconciliation resolves pre-existing student by email without unique constraint failure", async () => {
  const sqlite = freshDb();
  // Pre-existing student on platform (e.g. SIWC user), source_system is NULL
  sqlite.prepare("INSERT INTO students (id, email, display_name, role, is_synthetic, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    "user-native-1", "reconcile@example.invalid", "Native Reconcile", "student", 0, "2026-08-01T00:00:00.000Z"
  );

  const stamp = "2026-09-08T00:00:00.000Z";
  const runId = await openRun();
  const studentItem = record("stu-e500-1", stamp, hexDigest("s-rec"), { email: "reconcile@example.invalid", displayName: "Synced Reconcile", createdAt: stamp });

  const res = await postStudents(signedPost("/api/internal/sync/students", JSON.stringify({ runId, source: "e500", items: [studentItem] })));
  assert.equal(res.status, 200);

  const commit = await (await postCommit(signedPost("/api/internal/sync/commit", JSON.stringify({ runId })))).json();
  assert.equal(commit.status, "completed");
  assert.equal(commit.failed, 0);

  const student = sqlite.prepare("SELECT id, email, display_name, source_system, source_record_id FROM students WHERE email = ?").get("reconcile@example.invalid");
  assert.equal(student.id, "user-native-1");
  assert.equal(student.source_system, "e500");
  assert.equal(student.source_record_id, "stu-e500-1");
  assert.equal(student.display_name, "Synced Reconcile");
});

test("reconciliation resolves pre-existing progress by student and book without unique constraint failure", async () => {
  const sqlite = freshDb();
  // Pre-existing progress on platform
  sqlite.prepare("INSERT INTO students (id, email, display_name, role, is_synthetic) VALUES (?, ?, ?, ?, ?)").run(
    "stu-native-p", "prog-user@example.invalid", "Prog Native", "student", 0
  );
  sqlite.prepare("INSERT INTO books (id, title, total_chapters, total_pages, is_synthetic) VALUES (?, ?, ?, ?, ?)").run(
    "bk-native-p", "Prog Book", 1, 10, 0
  );
  sqlite.prepare("INSERT INTO reading_progress (id, student_id, book_id, progress_percent, last_read_page, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    "prog-native-1", "stu-native-p", "bk-native-p", 25, 3, "2026-08-01T00:00:00.000Z"
  );

  const stamp = "2026-09-09T00:00:00.000Z";
  const runId = await openRun();
  const progressItem = record("pg-e500-1", stamp, hexDigest("p-rec"), { studentId: "stu-native-p", bookId: "bk-native-p", progressPercent: 75, lastReadChapter: "ch-1", lastReadPage: 8 });

  const res = await postProgress(signedPost("/api/internal/sync/progress", JSON.stringify({ runId, source: "e500", items: [progressItem] })));
  assert.equal(res.status, 200);

  const commit = await (await postCommit(signedPost("/api/internal/sync/commit", JSON.stringify({ runId })))).json();
  assert.equal(commit.status, "completed");
  assert.equal(commit.failed, 0);

  const progress = sqlite.prepare("SELECT id, student_id, book_id, progress_percent, source_system, source_record_id FROM reading_progress WHERE id = ?").get("prog-native-1");
  assert.equal(progress.progress_percent, 75);
  assert.equal(progress.source_system, "e500");
  assert.equal(progress.source_record_id, "pg-e500-1");
});

test("student reconciliation records a conflict when source identity and email resolve to different rows", async () => {
  const sqlite = freshDb();
  sqlite.prepare("INSERT INTO students (id, email, display_name, role, is_synthetic, source_system, source_record_id, source_updated_at, sync_version, checksum) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "student-source", "source@example.invalid", "Source", "student", 0, "e500", "stu-collision", "2026-09-01T00:00:00.000Z", 1, hexDigest("source")
  );
  sqlite.prepare("INSERT INTO students (id, email, display_name, role, is_synthetic) VALUES (?, ?, ?, ?, ?)").run(
    "student-email", "email@example.invalid", "Email", "student", 0
  );

  const runId = await openRun();
  const item = record("stu-collision", "2026-09-10T00:00:00.000Z", hexDigest("collision"), { email: "email@example.invalid", displayName: "Incoming", createdAt: "2026-09-10T00:00:00.000Z" });
  const res = await postStudents(signedPost("/api/internal/sync/students", JSON.stringify({ runId, source: "e500", items: [item] })));
  assert.equal(res.status, 200);
  const commit = await (await postCommit(signedPost("/api/internal/sync/commit", JSON.stringify({ runId })))).json();
  assert.equal(commit.conflicts, 1);
  assert.equal(commit.failed, 0);
});

test("progress reconciliation records a conflict when source identity and natural key resolve to different rows", async () => {
  const sqlite = freshDb();
  sqlite.prepare("INSERT INTO students (id, email, display_name, role, is_synthetic) VALUES (?, ?, ?, ?, ?)").run("student-pair", "pair@example.invalid", "Pair", "student", 0);
  sqlite.prepare("INSERT INTO books (id, title, total_chapters, total_pages, is_synthetic) VALUES (?, ?, ?, ?, ?)").run("book-pair", "Pair Book", 1, 10, 0);
  sqlite.prepare("INSERT INTO reading_progress (id, student_id, book_id, progress_percent, last_read_page, source_system, source_record_id, source_updated_at, sync_version, checksum) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "progress-source", "student-other", "book-other", 10, 1, "e500", "progress-collision", "2026-09-01T00:00:00.000Z", 1, hexDigest("progress-source")
  );
  sqlite.prepare("INSERT INTO reading_progress (id, student_id, book_id, progress_percent, last_read_page) VALUES (?, ?, ?, ?, ?)").run("progress-pair", "student-pair", "book-pair", 20, 2);

  const runId = await openRun();
  const item = record("progress-collision", "2026-09-10T00:00:00.000Z", hexDigest("progress-collision"), { studentId: "student-pair", bookId: "book-pair", progressPercent: 80, lastReadChapter: "ch-1", lastReadPage: 9 });
  const res = await postProgress(signedPost("/api/internal/sync/progress", JSON.stringify({ runId, source: "e500", items: [item] })));
  assert.equal(res.status, 200);
  const commit = await (await postCommit(signedPost("/api/internal/sync/commit", JSON.stringify({ runId })))).json();
  assert.equal(commit.conflicts, 1);
  assert.equal(commit.failed, 0);
});
