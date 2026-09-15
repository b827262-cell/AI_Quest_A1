import { eq } from "drizzle-orm";
import { getDb } from "../../../../../../../db";
import { books, syncItems } from "../../../../../../../db/schema";
import { authorizeSyncRequest, jsonError, readBody, writeAudit, type StorageBucket } from "../../../_shared";
import { sha256Hex } from "../../../../../../../lib/sync-core";

const DEFAULT_MAX_PDF_BYTES = 50 * 1024 * 1024;

function bucket(): StorageBucket | null {
  return (globalThis as unknown as { BOOKS_BUCKET?: StorageBucket }).BOOKS_BUCKET ?? null;
}

async function readPdf(request: Request): Promise<{ bytes: Uint8Array; sourceRecordId: string; sourceSystem: string; sourceUpdatedAt: string; syncVersion: number | undefined; runId: string }> {
  const contentType = (request.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
  if (contentType === "application/pdf") {
    const bytes = new Uint8Array(await request.arrayBuffer());
    return { bytes, sourceRecordId: request.headers.get("x-source-record-id") ?? "", sourceSystem: request.headers.get("x-source-system") ?? "", sourceUpdatedAt: request.headers.get("x-source-updated-at") ?? new Date(0).toISOString(), syncVersion: Number(request.headers.get("x-sync-version") ?? "") || undefined, runId: request.headers.get("x-run-id") ?? "" };
  }
  const { value } = await readBody(request);
  if (value.contentType !== "application/pdf" || typeof value.contentBase64 !== "string") throw new Error("contentType application/pdf and contentBase64 are required");
  const binary = atob(value.contentBase64);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return { bytes, sourceRecordId: String(value.sourceRecordId ?? ""), sourceSystem: String(value.sourceSystem ?? ""), sourceUpdatedAt: typeof value.sourceUpdatedAt === "string" ? value.sourceUpdatedAt : new Date(0).toISOString(), syncVersion: typeof value.syncVersion === "number" ? value.syncVersion : undefined, runId: String(value.runId ?? "") };
}

function validatePdf(bytes: Uint8Array): string | null {
  const max = Number((globalThis as unknown as { SYNC_MAX_PDF_BYTES?: string }).SYNC_MAX_PDF_BYTES ?? DEFAULT_MAX_PDF_BYTES);
  if (bytes.length === 0) return "PDF is empty";
  if (bytes.length > max) return "PDF exceeds configured size limit";
  if (new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-") return "PDF magic header is missing";
  return null;
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const raw = await request.clone().arrayBuffer();
    const authError = await authorizeSyncRequest(request, raw); if (authError) return authError;
    const requestBody = await readPdf(request);
    const validationError = validatePdf(requestBody.bytes); if (validationError) return Response.json({ error: "invalid_pdf", message: validationError }, { status: 400 });
    const runId = requestBody.runId; if (!runId) throw new Error("runId is required");
    const id = (await context.params).id;
    const db = await getDb();
    const bookRows = await db.select().from(books).where(eq(books.id, id)).limit(1);
    const book = bookRows[0]; if (!book) return Response.json({ error: "book_not_found" }, { status: 404 });
    if (!requestBody.sourceRecordId || !requestBody.sourceSystem) throw new Error("sourceSystem and sourceRecordId are required");
    if (book.sourceSystem !== requestBody.sourceSystem || book.sourceRecordId !== requestBody.sourceRecordId) return Response.json({ error: "source_identity_mismatch" }, { status: 409 });
    const sha256 = await sha256Hex(requestBody.bytes);
    const incomingVersion = requestBody.syncVersion ?? 0;
    if (book.syncVersion != null && incomingVersion < book.syncVersion) return Response.json({ runId, bookId: book.id, skipped: true, reason: "stale", sha256 });
    if (book.syncVersion != null && incomingVersion === book.syncVersion && book.sha256 && book.sha256 !== sha256) return Response.json({ error: "content_conflict", message: "same source version with different PDF checksum" }, { status: 409 });
    if (book.sha256 === sha256 && book.storageState === "active" && book.objectKey) {
      await db.insert(syncItems).values({ id: crypto.randomUUID(), runId, entityType: "book_content", sourceRecordId: requestBody.sourceRecordId, targetRecordId: book.id, operation: "skip", checksum: sha256, sourceVersion: incomingVersion, status: "skipped", error: null });
      return Response.json({ runId, bookId: book.id, skipped: true, sha256 });
    }
    const objectKey = `books/${book.id}/${sha256}.pdf`;
    const targetBucket = bucket(); if (!targetBucket) return Response.json({ error: "r2_unavailable" }, { status: 503 });
    try {
      await targetBucket.put(objectKey, requestBody.bytes, { httpMetadata: { contentType: "application/pdf" }, customMetadata: { sha256, sourceSystem: requestBody.sourceSystem, sourceRecordId: requestBody.sourceRecordId } });
      const stored = await targetBucket.head(objectKey);
      const retrieved = await targetBucket.get(objectKey);
      const retrievedBytes = retrieved ? new Uint8Array(await retrieved.arrayBuffer()) : null;
      if (!stored || stored.size !== requestBody.bytes.length || !retrievedBytes || await sha256Hex(retrievedBytes) !== sha256) throw new Error("R2 HEAD/GET verification failed");
    } catch (error) {
      let compensated = false;
      try { await targetBucket.delete(objectKey); compensated = !(await targetBucket.head(objectKey)); } catch { /* preserve the primary error */ }
      return Response.json({ error: "r2_put_failed", message: error instanceof Error ? error.message : "R2 write failed", compensated }, { status: 502 });
    }
    try {
      await db.update(books).set({ objectKey, contentType: "application/pdf", byteSize: requestBody.bytes.length, sha256, storageState: "active", updatedAt: requestBody.sourceUpdatedAt, sourceUpdatedAt: requestBody.sourceUpdatedAt, syncVersion: requestBody.syncVersion ?? book.syncVersion }).where(eq(books.id, book.id));
    } catch {
      let compensated = false;
      try { await targetBucket.delete(objectKey); compensated = !(await targetBucket.head(objectKey)); } catch { /* recorded below */ }
      if (!compensated) {
        await db.insert(syncItems).values({ id: crypto.randomUUID(), runId, entityType: "book_content", sourceRecordId: requestBody.sourceRecordId, targetRecordId: book.id, operation: "compensate", checksum: sha256, sourceVersion: requestBody.syncVersion ?? null, status: "compensation_required", error: "D1 metadata update failed and R2 compensation failed" }).catch(() => undefined);
      }
      await writeAudit("sync_book_content", "book", book.id, compensated ? "d1_failed_compensated" : "compensation_required");
      return Response.json({ error: "d1_commit_failed", compensated }, { status: 502 });
    }
    await db.insert(syncItems).values({ id: crypto.randomUUID(), runId, entityType: "book_content", sourceRecordId: requestBody.sourceRecordId, targetRecordId: book.id, operation: "update", checksum: sha256, sourceVersion: requestBody.syncVersion ?? null, status: "applied", error: null });
    await writeAudit("sync_book_content", "book", book.id, "applied");
    return Response.json({ runId, bookId: book.id, objectKey, contentType: "application/pdf", byteSize: requestBody.bytes.length, sha256, state: "active" }, { status: 201 });
  } catch (error) { return jsonError(error, 400); }
}
