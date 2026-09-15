import { and, desc, eq, lt } from "drizzle-orm";
import { getDb } from "../../../../db";
import { auditLogs, books, readingProgress, students, syncItems, syncNonces, syncRuns } from "../../../../db/schema";
import { decideSync, sha256Hex, sourceVersion, stableTargetId, type SyncMetadata } from "../../../../lib/sync-core";

const MAX_CLOCK_SKEW_SECONDS = 300;
const MAX_BATCH = 100;
const MAX_BODY_CHARS = 8_000_000;

export type StorageBucket = {
  put(key: string, value: Uint8Array, options?: Record<string, unknown>): Promise<unknown>;
  head(key: string): Promise<{ size: number } | null>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  delete(key: string): Promise<unknown>;
};
type GlobalRuntime = { SYNC_IMPORT_SECRET?: string; BOOKS_BUCKET?: StorageBucket };

function runtime(): GlobalRuntime {
  return globalThis as unknown as GlobalRuntime;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export async function authorizeSyncRequest(request: Request, body: string | ArrayBuffer | Uint8Array): Promise<Response | null> {
  const timestamp = request.headers.get("x-sync-timestamp") ?? "";
  const nonce = request.headers.get("x-sync-nonce") ?? "";
  const signature = request.headers.get("x-sync-signature") ?? "";
  const hasSiteIdentity = Boolean(request.headers.get("oai-authenticated-user-id") || request.headers.get("authorization"));
  const secret = runtime().SYNC_IMPORT_SECRET;

  if (!timestamp || !nonce || !signature || !secret) {
    return Response.json({ error: hasSiteIdentity ? "forbidden" : "unauthorized" }, { status: hasSiteIdentity ? 403 : 401 });
  }
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) return Response.json({ error: "invalid_sync_request" }, { status: 401 });
  const timestampSeconds = Number(timestamp);
  if (!Number.isInteger(timestampSeconds) || Math.abs(Math.floor(Date.now() / 1000) - timestampSeconds) > MAX_CLOCK_SKEW_SECONDS) {
    return Response.json({ error: "sync_request_expired" }, { status: 401 });
  }

  const bodyDigest = await sha256Hex(body);
  const signingInput = `${timestamp}.${nonce}.${bodyDigest}`;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = base64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signingInput))));
  const providedBytes = new TextEncoder().encode(signature);
  const expectedBytes = new TextEncoder().encode(expected);
  if (!bytesEqual(providedBytes, expectedBytes)) return Response.json({ error: "invalid_sync_credential" }, { status: 401 });

  const db = await getDb();
  const nowSeconds = Math.floor(Date.now() / 1000);
  await db.delete(syncNonces).where(lt(syncNonces.expiresAt, nowSeconds));
  const accepted = await db.insert(syncNonces).values({ nonce, expiresAt: nowSeconds + MAX_CLOCK_SKEW_SECONDS }).onConflictDoNothing().returning({ nonce: syncNonces.nonce });
  if (accepted.length !== 1) return Response.json({ error: "replayed_sync_request" }, { status: 401 });
  return null;
}

export async function readBody(request: Request): Promise<{ raw: string; value: Record<string, unknown> }> {
  const raw = await request.text();
  if (raw.length > MAX_BODY_CHARS) throw new Error("sync request is too large");
  const value = JSON.parse(raw) as Record<string, unknown>;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JSON object required");
  return { raw, value };
}

export function jsonError(error: unknown, status = 400): Response {
  return Response.json({ error: error instanceof Error ? error.message : "sync request failed" }, { status });
}

export function getRunId(value: Record<string, unknown>): string {
  if (typeof value.runId !== "string" || !value.runId.trim()) throw new Error("runId is required");
  return value.runId.trim();
}

export function getItems(value: Record<string, unknown>): Record<string, unknown>[] {
  if (!Array.isArray(value.items) || value.items.length === 0 || value.items.length > MAX_BATCH) throw new Error(`items must contain 1-${MAX_BATCH} records`);
  return value.items.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item));
}

function requiredString(item: Record<string, unknown>, key: string): string {
  const value = item[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required`);
  return value.trim();
}

export async function metadata(item: Record<string, unknown>, sourceSystem: string): Promise<SyncMetadata> {
  const sourceRecordId = requiredString(item, "sourceRecordId");
  const sourceUpdatedAt = typeof item.sourceUpdatedAt === "string" && item.sourceUpdatedAt ? item.sourceUpdatedAt : new Date(0).toISOString();
  const syncVersion = sourceVersion(sourceUpdatedAt, typeof item.syncVersion === "number" ? item.syncVersion : undefined);
  const checksum = typeof item.checksum === "string" && /^[a-f0-9]{64}$/i.test(item.checksum) ? item.checksum.toLowerCase() : await sha256Hex(JSON.stringify(item.payload ?? item));
  return { sourceSystem, sourceRecordId, sourceUpdatedAt, syncVersion, checksum };
}

export async function writeAudit(action: string, entity: string, entityId: string | null, result: string): Promise<void> {
  const db = await getDb();
  await db.insert(auditLogs).values({ id: crypto.randomUUID(), actor: "e500-sync", action, entity, entityId, result, createdAt: new Date().toISOString() });
}

async function bumpRun(runId: string, field: "total" | "inserted" | "updated" | "skipped" | "conflicts" | "failed", amount = 1): Promise<void> {
  const db = await getDb();
  const rows = await db.select().from(syncRuns).where(eq(syncRuns.id, runId)).limit(1);
  if (!rows[0]) throw new Error("sync run not found");
  await db.update(syncRuns).set({ [field]: Number(rows[0][field] ?? 0) + amount }).where(eq(syncRuns.id, runId));
}

async function itemLog(runId: string, entityType: string, meta: SyncMetadata, operation: string, status: string, targetRecordId: string | null, error: string | null): Promise<void> {
  const db = await getDb();
  await db.insert(syncItems).values({ id: crypto.randomUUID(), runId, entityType, sourceRecordId: meta.sourceRecordId, targetRecordId, operation, checksum: meta.checksum, sourceVersion: meta.syncVersion, status, error });
}

function incomingStudent(item: Record<string, unknown>, targetId: string, meta: SyncMetadata) {
  return { id: targetId, email: requiredString(item, "email"), displayName: requiredString(item, "displayName"), role: "student", isSynthetic: false, createdAt: typeof item.createdAt === "string" ? item.createdAt : meta.sourceUpdatedAt, sourceSystem: meta.sourceSystem, sourceRecordId: meta.sourceRecordId, sourceUpdatedAt: meta.sourceUpdatedAt, syncVersion: meta.syncVersion, checksum: meta.checksum };
}

async function findExisting(table: typeof students | typeof books | typeof readingProgress, meta: SyncMetadata) {
  const db = await getDb();
  const rows = await db.select().from(table).where(and(eq(table.sourceSystem, meta.sourceSystem), eq(table.sourceRecordId, meta.sourceRecordId))).limit(1);
  return rows[0] ?? null;
}

async function applyStudent(runId: string, item: Record<string, unknown>, sourceSystem: string) {
  const meta = await metadata(item, sourceSystem);
  const existing = await findExisting(students, meta);
  const decision = decideSync(meta, existing ? { sourceSystem: existing.sourceSystem!, sourceRecordId: existing.sourceRecordId!, sourceUpdatedAt: existing.sourceUpdatedAt!, syncVersion: existing.syncVersion!, checksum: existing.checksum! } : null);
  const targetId = existing?.id ?? (typeof item.targetRecordId === "string" ? item.targetRecordId : stableTargetId("student", sourceSystem, meta.sourceRecordId));
  if (decision === "conflict") { await itemLog(runId, "student", meta, decision, "conflict", targetId, "same source version with different checksum"); await bumpRun(runId, "conflicts"); return "conflict"; }
  if (decision === "skip") { await itemLog(runId, "student", meta, "skip", "skipped", targetId, null); await bumpRun(runId, "skipped"); return "skipped"; }
  const db = await getDb();
  const row = incomingStudent(item, targetId, meta);
  if (decision === "insert") await db.insert(students).values(row);
  else await db.update(students).set(row).where(eq(students.id, targetId));
  await itemLog(runId, "student", meta, decision, "applied", targetId, null); await bumpRun(runId, decision === "insert" ? "inserted" : "updated"); return decision;
}

async function targetIdFor(table: typeof students | typeof books, sourceSystem: string, value: string): Promise<string> {
  const db = await getDb();
  const bySource = await db.select({ id: table.id }).from(table).where(and(eq(table.sourceSystem, sourceSystem), eq(table.sourceRecordId, value))).limit(1);
  if (bySource[0]) return bySource[0].id;
  const direct = await db.select({ id: table.id }).from(table).where(eq(table.id, value)).limit(1);
  if (direct[0]) return direct[0].id;
  throw new Error(`referenced ${table === students ? "student" : "book"} not found: ${value}`);
}

async function applyProgress(runId: string, item: Record<string, unknown>, sourceSystem: string) {
  const meta = await metadata(item, sourceSystem);
  const existing = await findExisting(readingProgress, meta);
  const decision = decideSync(meta, existing ? { sourceSystem: existing.sourceSystem!, sourceRecordId: existing.sourceRecordId!, sourceUpdatedAt: existing.sourceUpdatedAt!, syncVersion: existing.syncVersion!, checksum: existing.checksum! } : null);
  const targetId = existing?.id ?? (typeof item.targetRecordId === "string" ? item.targetRecordId : stableTargetId("progress", sourceSystem, meta.sourceRecordId));
  if (decision === "conflict") { await itemLog(runId, "progress", meta, decision, "conflict", targetId, "same source version with different checksum"); await bumpRun(runId, "conflicts"); return "conflict"; }
  if (decision === "skip") { await itemLog(runId, "progress", meta, "skip", "skipped", targetId, null); await bumpRun(runId, "skipped"); return "skipped"; }
  const studentId = await targetIdFor(students, sourceSystem, requiredString(item, "studentId"));
  const bookId = await targetIdFor(books, sourceSystem, requiredString(item, "bookId"));
  const row = { id: targetId, studentId, bookId, progressPercent: Math.max(0, Math.min(100, Number(item.progressPercent ?? 0))), lastReadChapter: typeof item.lastReadChapter === "string" ? item.lastReadChapter : null, lastReadPage: Math.max(1, Number(item.lastReadPage ?? 1)), updatedAt: meta.sourceUpdatedAt, sourceSystem: meta.sourceSystem, sourceRecordId: meta.sourceRecordId, sourceUpdatedAt: meta.sourceUpdatedAt, syncVersion: meta.syncVersion, checksum: meta.checksum };
  const db = await getDb();
  if (decision === "insert") await db.insert(readingProgress).values(row);
  else await db.update(readingProgress).set(row).where(eq(readingProgress.id, targetId));
  await itemLog(runId, "progress", meta, decision, "applied", targetId, null); await bumpRun(runId, decision === "insert" ? "inserted" : "updated"); return decision;
}

async function applyBook(runId: string, item: Record<string, unknown>, sourceSystem: string) {
  const meta = await metadata(item, sourceSystem);
  const existing = await findExisting(books, meta);
  const decision = decideSync(meta, existing ? { sourceSystem: existing.sourceSystem!, sourceRecordId: existing.sourceRecordId!, sourceUpdatedAt: existing.sourceUpdatedAt!, syncVersion: existing.syncVersion!, checksum: existing.checksum! } : null);
  const targetId = existing?.id ?? (typeof item.targetRecordId === "string" ? item.targetRecordId : stableTargetId("book", sourceSystem, meta.sourceRecordId));
  if (decision === "conflict") { await itemLog(runId, "book", meta, decision, "conflict", targetId, "same source version with different checksum"); await bumpRun(runId, "conflicts"); return "conflict"; }
  if (decision === "skip") { await itemLog(runId, "book", meta, "skip", "skipped", targetId, null); await bumpRun(runId, "skipped"); return "skipped"; }
  const previous = existing as unknown as { objectKey?: string; contentType?: string; byteSize?: number; sha256?: string; storageState?: string };
  const row = { id: targetId, title: requiredString(item, "title"), description: typeof item.description === "string" ? item.description : "", totalChapters: Number(item.totalChapters ?? 1), totalPages: Number(item.totalPages ?? 1), isSynthetic: false, objectKey: previous?.objectKey ?? "", contentType: previous?.contentType ?? "application/pdf", byteSize: previous?.byteSize ?? 0, sha256: previous?.sha256 ?? "", storageState: previous?.storageState ?? "pending", createdAt: typeof item.createdAt === "string" ? item.createdAt : meta.sourceUpdatedAt, updatedAt: meta.sourceUpdatedAt, sourceSystem: meta.sourceSystem, sourceRecordId: meta.sourceRecordId, sourceUpdatedAt: meta.sourceUpdatedAt, syncVersion: meta.syncVersion, checksum: meta.checksum };
  const db = await getDb();
  if (decision === "insert") await db.insert(books).values(row);
  else await db.update(books).set(row).where(eq(books.id, targetId));
  await itemLog(runId, "book", meta, decision, "applied", targetId, null); await bumpRun(runId, decision === "insert" ? "inserted" : "updated"); return decision;
}

export async function applyBatch(runId: string, entityType: "student" | "progress" | "book", items: Record<string, unknown>[], sourceSystem: string): Promise<void> {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(sourceSystem)) throw new Error("invalid source");
  for (const item of items) {
    try {
      if (entityType === "student") await applyStudent(runId, item, sourceSystem);
      else if (entityType === "progress") await applyProgress(runId, item, sourceSystem);
      else await applyBook(runId, item, sourceSystem);
    } catch (error) {
      const meta = await metadata(item, sourceSystem);
      await itemLog(runId, entityType, meta, "failed", "failed", null, error instanceof Error ? error.message : "item failed");
      await bumpRun(runId, "failed");
    }
    await bumpRun(runId, "total");
  }
}

export async function handleRun(request: Request): Promise<Response> {
  const { raw, value } = await readBody(request);
  const authError = await authorizeSyncRequest(request, raw); if (authError) return authError;
  const source = typeof value.source === "string" ? value.source.trim() : "";
  if (!source) return jsonError(new Error("source is required"));
  const id = crypto.randomUUID();
  const db = await getDb();
  await db.insert(syncRuns).values({ id, source, startedAt: new Date().toISOString(), status: "running", dryRun: value.dryRun === true, total: 0, inserted: 0, updated: 0, skipped: 0, conflicts: 0, failed: 0 });
  await writeAudit("sync_run_start", "sync_run", id, "accepted");
  return Response.json({ runId: id, status: "running" }, { status: 201 });
}

export async function handleBatch(request: Request, entityType: "student" | "progress" | "book"): Promise<Response> {
  const { raw, value } = await readBody(request);
  const authError = await authorizeSyncRequest(request, raw); if (authError) return authError;
  const runId = getRunId(value); const sourceSystem = typeof value.source === "string" ? value.source : "";
  const db = await getDb();
  const run = await db.select().from(syncRuns).where(eq(syncRuns.id, runId)).limit(1);
  if (!run[0] || run[0].status !== "running") return jsonError(new Error("sync run is not active"), 409);
  await applyBatch(runId, entityType, getItems(value), sourceSystem || run[0].source);
  return Response.json({ runId, entityType, accepted: true });
}

export async function handleCommit(request: Request): Promise<Response> {
  const { raw, value } = await readBody(request); const authError = await authorizeSyncRequest(request, raw); if (authError) return authError;
  const runId = getRunId(value); const db = await getDb(); const rows = await db.select().from(syncRuns).where(eq(syncRuns.id, runId)).limit(1);
  if (!rows[0]) return jsonError(new Error("sync run not found"), 404);
  const status = rows[0].conflicts > 0 || rows[0].failed > 0 ? "completed_with_errors" : "completed";
  await db.update(syncRuns).set({ status, finishedAt: new Date().toISOString() }).where(eq(syncRuns.id, runId));
  await writeAudit("sync_run_commit", "sync_run", runId, status);
  return Response.json({ ...rows[0], status, finishedAt: new Date().toISOString() });
}

export async function handleRunGet(request: Request, id: string): Promise<Response> {
  const authError = await authorizeSyncRequest(request, ""); if (authError) return authError;
  const db = await getDb();
  const row = await db.select().from(syncRuns).where(eq(syncRuns.id, id)).limit(1);
  return row[0] ? Response.json({ run: row[0] }) : Response.json({ error: "sync run not found" }, { status: 404 });
}

export async function handleConflicts(request: Request): Promise<Response> {
  const authError = await authorizeSyncRequest(request, ""); if (authError) return authError;
  const db = await getDb();
  const rows = await db.select().from(syncItems).where(eq(syncItems.status, "conflict")).orderBy(desc(syncItems.id)).limit(100);
  return Response.json({ conflicts: rows });
}
