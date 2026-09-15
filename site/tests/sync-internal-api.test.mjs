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

async function openRun() {
  const res = await postRuns(signedPost("/api/internal/sync/runs", JSON.stringify({ source: "e500" })));
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
  const run = await openRun();
  await postBooks(signedPost("/api/internal/sync/books", JSON.stringify({
    runId: run, source: "e500",
    items: [record("bk-c", stamp, hexDigest("meta"), { title: "Synthetic Content Book", description: "", totalChapters: 1, totalPages: 8, createdAt: stamp })],
  })));
  const created = sqlite.prepare("SELECT storage_state FROM books WHERE source_record_id = 'bk-c'").get();
  assert.equal(created.storage_state, "pending");

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
  const active = sqlite.prepare("SELECT storage_state, sha256, sync_version FROM books WHERE id = ?").get(targetId);
  assert.equal(active.storage_state, "active");
  assert.equal(active.sha256, sha);

  const resend = await (await POST_CONTENT(signedPost(`/api/internal/sync/books/${targetId}/content`, pdf, extra, "application/pdf"), context)).json();
  assert.equal(resend.skipped, true);

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
