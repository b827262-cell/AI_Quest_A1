// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import express from "express";
import {
  createStudentLearningHistoryRouter,
  createStudentNotesRouter,
  createStudentSessionMiddleware
} from "@ai-smartbook/auth/express";
import {
  completeStudentProfileViaRawHttp,
  accessLoginViaRawHttp,
  rawHttpRequest,
  startStudentTestApp,
  STUDENT_TEST_ORIGIN,
  type StudentTestApp
} from "../server/testApp";

/**
 * R23 CR fix-2/3 integration: the assistant's exact wire contract executed
 * against the REAL auth-package routers (createStudentNotesRouter +
 * createStudentLearningHistoryRouter) on a real SQLite runtime — no client
 * mocks anywhere:
 *   1. an upload without `syncVersion` is rejected (400 INVALID_ENTRY);
 *   2. question(v1) + answer revision(v2) -> from-history -> note.source = google-ai-relay;
 *   3. from-history is idempotent (same note id);
 *   4. a delete carrying a stale version answers deleted=false (version conflict),
 *      and a delete carrying the stored version answers deleted=true.
 */

const TEST_PORT = 43947;

type JsonBody = Record<string, unknown>;

/**
 * Wire the same express stack as apps/AI-Stu-R1/server/stu-api.ts (lines 100-103)
 * for the notes + learning-history surface, using the shared runtime so the
 * session cookie and the two repos are the production objects.
 */
async function startNotesWireApp(app: StudentTestApp): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const wire = express();
  wire.use(express.json({ limit: 256 * 1024 }));
  wire.use("/api/student", createStudentSessionMiddleware(app.runtime.auth, app.config));
  wire.use("/api/student", createStudentNotesRouter(
    { notes: app.runtime.notes, learningHistory: app.runtime.learningHistory },
    app.config
  ));
  wire.use("/api/student", createStudentLearningHistoryRouter(app.runtime.learningHistory, app.config));
  const server: Server = await new Promise((resolve, reject) => {
    const listener = createServer(wire);
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => resolve(listener));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected wire address");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(() => resolve()))
  };
}

async function request(
  baseUrl: string,
  cookie: string,
  path: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  body?: unknown
): Promise<{ status: number; body: JsonBody }> {
  const url = new URL(path, baseUrl);
  const result = await rawHttpRequest(url, {
    method,
    headers: {
      cookie,
      // The student origin guard allowlist in the test fixture.
      origin: STUDENT_TEST_ORIGIN,
      ...(body === undefined ? {} : { "content-type": "application/json" })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: result.status, body: JSON.parse(result.bodyText || "{}") as JsonBody };
}

describe("Student assistant flow on the real history + notes routers", () => {
  it("requires syncVersion, links google-ai-relay source and reports delete version conflicts", async () => {
    const app: StudentTestApp = await startStudentTestApp({ sessionTtlMs: 3_600_000, port: TEST_PORT });
    const wire = await startNotesWireApp(app);
    try {
      // Mirror app-router tests: happy-dom's global fetch hits happy-dom's
      // same-origin policy across ports, so reroute environment fetches
      // through raw node:http before the auth/JWKS flow runs.
      const baseFetch = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = typeof input === "string"
          ? new URL(input, app.baseUrl)
          : input instanceof URL ? input : new URL(input.url, app.baseUrl);
        const result = await rawHttpRequest(url, { method: "GET" });
        return new Response(result.bodyText, { status: result.status });
      }) as typeof fetch;
      const cookie = await accessLoginViaRawHttp(app.baseUrl, app.assertion());
      await completeStudentProfileViaRawHttp(app.baseUrl, cookie, "Notes Flow Student");
      globalThis.fetch = baseFetch;

      const base = wire.baseUrl;
      const entryId = "assistant-entry-1";
      const learningEntry = {
        id: entryId,
        askedAt: "2026-11-01T09:00:00.000Z",
        question: "什麼是重力加速度？",
        category: "auto",
        sourceType: "manual",
        strategy: "google-ai"
      };

      // (1) Legacy client shape (missing syncVersion) must be rejected.
      const rejected = await request(base, cookie, "/api/student/learning-history", "POST", { entries: [learningEntry] });
      expect(rejected.status).toBe(400);
      expect(rejected.body.error).toBe("INVALID_ENTRY");

      // (2) The assistant sends syncVersion: 1; the upload succeeds.
      const uploaded = await request(base, cookie, "/api/student/learning-history", "POST",
        { entries: [{ ...learningEntry, syncVersion: 1 }] });
      expect(uploaded.status).toBe(200);
      expect((uploaded.body.entries as Array<{ id: string; syncVersion: number }>)[0]).toMatchObject({
        id: entryId,
        syncVersion: 1
      });

      // Answer revision arrives with the next version.
      const answerSync = await request(base, cookie, "/api/student/learning-history", "POST",
        {
          entries: [{
            ...learningEntry,
            syncVersion: 2,
            rawAnswer: "重力加速度約為 9.8 m/s²。",
            organizedAnswer: "重力加速度約為 9.8 m/s²。"
          }]
        });
      expect(answerSync.status).toBe(200);

      // from-history conversion keeps the Google AI relay provenance.
      const fromHistory = await request(base, cookie, "/api/student/notes/from-history", "POST", { entryId });
      expect(fromHistory.status).toBe(201);
      const note = fromHistory.body.note as {
        id: string; source: string; syncVersion: number; entryId: string | null
      };
      expect(note.source).toBe("google-ai-relay");
      expect(note.entryId).toBe(entryId);
      expect(note.syncVersion).toBeGreaterThanOrEqual(1);

      // (3) Re-converting the same entry is idempotent (same note id).
      const again = await request(base, cookie, "/api/student/notes/from-history", "POST", { entryId });
      expect(again.status).toBe(200);
      expect((again.body.note as { id: string }).id).toBe(note.id);

      // A concurrent writer bumps the note version.
      const patchResult = await request(base, cookie,
        `/api/student/notes/${encodeURIComponent(note.id)}`, "PATCH",
        { content: "更新後的內容（其他裝置）" });
      expect(patchResult.status).toBe(200);
      const patchedNote = patchResult.body.note as { syncVersion: number; deletedAt: string | null };
      expect(patchedNote.syncVersion).toBeGreaterThan(note.syncVersion);
      expect(patchedNote.deletedAt).toBeNull();

      // (4) A trailing delete carrying the stale version is NOT applied:
      // the server answers deleted=false and keeps the live note.
      const staleDelete = await request(base, cookie,
        `/api/student/notes/${encodeURIComponent(note.id)}?syncVersion=${note.syncVersion}`, "DELETE");
      expect(staleDelete.status).toBe(200);
      expect((staleDelete.body as { deleted: boolean }).deleted).toBe(false);

      // Deleting again with the freshest version (after the panel reloads it)
      // succeeds.
      const freshNote = await request(base, cookie,
        `/api/student/notes/${encodeURIComponent(note.id)}`, "GET");
      expect(freshNote.status).toBe(200);
      const freshVersion = (freshNote.body.note as { syncVersion: number }).syncVersion;
      const freshDelete = await request(base, cookie,
        `/api/student/notes/${encodeURIComponent(note.id)}?syncVersion=${freshVersion}`, "DELETE");
      expect(freshDelete.status).toBe(200);
      expect((freshDelete.body as { deleted: boolean }).deleted).toBe(true);
      // The stored version becomes the caller-provided tombstone version.
      expect((freshDelete.body.note as { syncVersion: number }).syncVersion).toBeGreaterThanOrEqual(freshVersion);
    } finally {
      await wire.close();
      await app.close();
    }
  });
});
