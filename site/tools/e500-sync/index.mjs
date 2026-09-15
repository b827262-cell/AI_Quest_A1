#!/usr/bin/env node
import { createHmac, createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const command = process.argv[2] ?? "scan";
const dryRun = command === "dry-run" || process.argv.includes("--dry-run");
const env = process.env;
const studentBase = (env.E500_STUDENT_URL ?? "http://127.0.0.1:4310").replace(/\/$/, "");
const adminBase = (env.E500_ADMIN_URL ?? "http://127.0.0.1:4300").replace(/\/$/, "");
const backend = (env.SYNC_BACKEND_URL ?? "").replace(/\/$/, "");
const sourceSystem = env.E500_SOURCE_SYSTEM ?? "e500";
const batchSize = Math.max(1, Math.min(100, Number(env.SYNC_BATCH_SIZE ?? 50)));
const authHeaders = env.E500_ADMIN_AUTHORIZATION ? { authorization: env.E500_ADMIN_AUTHORIZATION } : {};

function digest(value) { return createHash("sha256").update(value).digest("hex"); }
function stableTargetId(type, source, id) { return `sync-${type}-${source}-${id}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 180); }
function clean(value, fallback = "") { return typeof value === "string" ? value.trim() : fallback; }
function version(updatedAt) { const parsed = Date.parse(updatedAt ?? ""); return Number.isFinite(parsed) ? parsed : 0; }
function arrayFrom(value, keys) { if (Array.isArray(value)) return value; for (const key of keys) if (Array.isArray(value?.[key])) return value[key]; return []; }
function recordMeta(sourceRecordId, sourceUpdatedAt, payload) { return { ...payload, sourceSystem, sourceRecordId, sourceUpdatedAt, syncVersion: version(sourceUpdatedAt), checksum: digest(JSON.stringify(payload, Object.keys(payload).sort())) }; }

async function fetchJson(url) {
  const response = await fetch(url, { headers: { accept: "application/json", ...authHeaders } });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.json();
}
async function optionalJson(urls) { for (const url of urls) { try { return await fetchJson(url); } catch { /* endpoint may not exist or may require E500_ADMIN_AUTHORIZATION in this deployment */ } } return null; }

async function loadStudents() {
  const data = await optionalJson([env.E500_STUDENTS_URL, `${adminBase}/api/admin/accounts`, `${studentBase}/api/student/students`].filter(Boolean));
  return arrayFrom(data, ["students", "accounts", "items"]).filter((item) => clean(item?.role, "student") === "student").map((item) => {
    const id = clean(item.id); const updatedAt = clean(item.updatedAt ?? item.updated_at ?? item.createdAt, new Date(0).toISOString());
    return recordMeta(id, updatedAt, { email: clean(item.email), displayName: clean(item.displayName ?? item.display_name, "Student"), createdAt: clean(item.createdAt ?? item.created_at, updatedAt) });
  }).filter((item) => item.sourceRecordId && item.email);
}

async function loadProgress() {
  const data = await optionalJson([env.E500_PROGRESS_URL, `${studentBase}/api/student/progress`, `${adminBase}/api/student/progress`].filter(Boolean));
  return arrayFrom(data, ["progress", "items"]).map((item) => {
    const id = clean(item.id ?? `${item.studentId}:${item.bookId}`); const updatedAt = clean(item.updatedAt ?? item.updated_at, new Date(0).toISOString());
    return recordMeta(id, updatedAt, { studentId: clean(item.studentId ?? item.student_id), bookId: clean(item.bookId ?? item.book_id), progressPercent: Number(item.progressPercent ?? item.progress_percent ?? 0), lastReadChapter: item.lastReadChapter ?? item.last_read_chapter ?? null, lastReadPage: Number(item.lastReadPage ?? item.last_read_page ?? 1) });
  }).filter((item) => item.sourceRecordId && item.studentId && item.bookId);
}

function pdfFiles(root) {
  if (!root || !existsSync(root)) return [];
  const found = []; const visit = (dir) => { for (const entry of readdirSync(dir, { withFileTypes: true })) { const path = join(dir, entry.name); if (entry.isDirectory()) visit(path); else if (entry.isFile() && entry.name.toLowerCase().endsWith(".pdf")) found.push(path); } }; visit(root); return found;
}

async function loadBooks() {
  const data = await optionalJson([env.E500_BOOKS_URL, `${adminBase}/api/admin/books`].filter(Boolean));
  const files = pdfFiles(env.E500_BOOKS_DIR); const explicit = env.E500_BOOK_ID_MAP ? JSON.parse(env.E500_BOOK_ID_MAP) : {};
  return arrayFrom(data, ["books", "items"]).map((item) => {
    const id = clean(item.id); const updatedAt = clean(item.updatedAt ?? item.updated_at ?? item.createdAt, new Date(0).toISOString());
    const payload = { title: clean(item.title, "Untitled"), description: clean(item.description), totalChapters: Number(item.totalChapters ?? 1), totalPages: Number(item.totalPages ?? 1), createdAt: clean(item.createdAt ?? item.created_at, updatedAt) };
    const apiPath = arrayFrom(item.files ?? item.bookFiles, []).find((file) => clean(file.fileType ?? file.file_type).toLowerCase() === "application/pdf" || clean(file.fileName ?? file.file_name).toLowerCase().endsWith(".pdf"))?.filePath;
    const pdfPath = explicit[id] || apiPath || files.find((path) => path.includes(id));
    return { ...recordMeta(id, updatedAt, payload), pdfPath: pdfPath && existsSync(pdfPath) ? pdfPath : null };
  }).filter((item) => item.sourceRecordId);
}

async function snapshot() { const [students, progress, books] = await Promise.all([loadStudents(), loadProgress(), loadBooks()]); return { students, progress, books }; }
function summary(data, label) { const pdfBytes = data.books.reduce((sum, book) => sum + (book.pdfPath ? statSync(book.pdfPath).size : 0), 0); console.log(JSON.stringify({ command: label, source: sourceSystem, students: data.students.length, progress: data.progress.length, books: data.books.length, pdfs: data.books.filter((book) => book.pdfPath).length, pdfBytes, dryRun }, null, 2)); }

// A fresh timestamp+nonce+signature is built for every HTTP attempt: transport
// retries must not be blocked by server-side replay protection, while duplicate
// business writes are prevented by per-item idempotency instead.
function signedInit(method, body, contentType = "application/json", extra = {}) {
  if (!env.SYNC_IMPORT_SECRET) throw new Error("SYNC_IMPORT_SECRET is required for an actual sync");
  const timestamp = String(Math.floor(Date.now() / 1000)); const nonce = randomUUID().replace(/-/g, "");
  const signature = createHmac("sha256", env.SYNC_IMPORT_SECRET).update(`${timestamp}.${nonce}.${digest(body ?? "")}`).digest("base64url");
  const headers = { "x-sync-timestamp": timestamp, "x-sync-nonce": nonce, "x-sync-signature": signature, ...extra };
  if (method === "GET" || method === "HEAD") return { method, headers };
  headers["content-type"] = contentType;
  return { method, body, headers };
}

async function request(path, body, { method = "POST", contentType = "application/json", headers = {} } = {}) {
  let last;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(`${backend}${path}`, signedInit(method, body, contentType, headers));
      const text = await response.text();
      if (!response.ok) throw new Error(`${response.status} ${path}: ${text.slice(0, 160)}`);
      return text ? JSON.parse(text) : {};
    } catch (error) { last = error; await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt)); }
  }
  throw last;
}

async function sendBatch(runId, kind, items) {
  for (let offset = 0; offset < items.length; offset += batchSize) {
    const body = JSON.stringify({ runId, source: sourceSystem, items: items.slice(offset, offset + batchSize) });
    await request(`/api/internal/sync/${kind}`, body);
  }
}

async function sync(data, kinds) {
  if (!backend) throw new Error("SYNC_BACKEND_URL is required for an actual sync");
  const run = env.SYNC_RUN_ID ? { runId: env.SYNC_RUN_ID } : await request("/api/internal/sync/runs", JSON.stringify({ source: sourceSystem, dryRun: false }));
  for (const kind of kinds) { const items = data[kind].map((item) => { const copy = { ...item }; delete copy.pdfPath; return copy; }); await sendBatch(run.runId, kind, items); }
  if (kinds.includes("books")) for (const book of data.books) if (book.pdfPath) {
    const bytes = readFileSync(book.pdfPath); const targetId = stableTargetId("book", sourceSystem, book.sourceRecordId);
    await request(`/api/internal/sync/books/${encodeURIComponent(targetId)}/content`, bytes, {
      contentType: "application/pdf",
      headers: { "x-run-id": run.runId, "x-source-system": sourceSystem, "x-source-record-id": book.sourceRecordId, "x-source-updated-at": book.sourceUpdatedAt, "x-sync-version": String(book.syncVersion) },
    });
  }
  return request("/api/internal/sync/commit", JSON.stringify({ runId: run.runId }));
}

const data = await snapshot();
if (command === "scan" || dryRun) {
  summary(data, dryRun ? "dry-run" : "scan");
} else if (command === "verify") {
  if (!backend) throw new Error("SYNC_BACKEND_URL is required for verify");
  console.log(JSON.stringify(await request("/api/internal/sync/conflicts", null, { method: "GET" }), null, 2));
} else {
  if (!["students", "progress", "books", "all"].includes(command)) throw new Error("usage: scan | dry-run | students | progress | books | all | verify");
  console.log(JSON.stringify(await sync(data, command === "all" ? ["students", "progress", "books"] : [command]), null, 2));
}
