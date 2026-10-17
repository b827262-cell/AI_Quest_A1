import express, { type ErrorRequestHandler, type RequestHandler } from "express";
import type { LearningHistoryRecord, StudentLearningHistoryRepo } from "@ai-smartbook/db";
import { studentOriginAllowed, type StudentAuthConfig } from "./server";

const CATEGORIES = new Set(["auto", "programming", "math", "humanities", "cybersecurity", "教材問答"]);
const SOURCES = new Set(["manual", "image", "file"]);
export const MAX_LEARNING_HISTORY_BATCH = 25;
export const MAX_LEARNING_HISTORY_BODY_BYTES = 256 * 1024;

/** Routes whose oversize bodies are reported with the batch-specific code. */
const LEARNING_HISTORY_BODY_PATHS = ["/api/student/learning-history", "/api/admin/learning-history"];

/**
 * Turns body-parser's `entity.too.large` into a stable JSON response.
 *
 * Express' default error page is HTML and prints a stack trace in development,
 * and the parser's own message is never something a client should see. The code
 * is endpoint-specific only where a batch contract exists: learning-history
 * routes answer `BATCH_TOO_LARGE`, every other route answers the generic
 * `PAYLOAD_TOO_LARGE`, so the code never claims a batch limit that was not
 * applied. Register it as the last error middleware so it sees errors from
 * every JSON parser in the app.
 */
export function oversizeJsonBodyHandler(): ErrorRequestHandler {
  return (error, req, res, next) => {
    if (res.headersSent) return next(error);
    if ((error as { type?: unknown } | null | undefined)?.type !== "entity.too.large") return next(error);
    const path = (req.originalUrl || req.url || "").split("?")[0];
    const isLearningHistory = LEARNING_HISTORY_BODY_PATHS.some((base) => path === base || path.startsWith(`${base}/`));
    res.status(413).json({ error: isLearningHistory ? "BATCH_TOO_LARGE" : "PAYLOAD_TOO_LARGE" });
  };
}

function validTime(value: unknown): value is string {
  return typeof value === "string" && value.length <= 40 && !Number.isNaN(Date.parse(value));
}

function optionalText(value: unknown, max: number): value is string | undefined {
  return value === undefined || (typeof value === "string" && value.length <= max);
}

/** Match the front-end allowlist without ever fetching a supplied URL. */
export function safeLearningSourceUrl(sourceUrl: string, question: string): boolean {
  try {
    const url = new URL(sourceUrl);
    const normalize = (text: string) => text.normalize("NFKC").toLocaleLowerCase("zh-TW").replace(/[\s\p{P}\p{S}_]+/gu, "");
    return url.protocol === "https:" && url.hostname === "www.google.com" && !url.username && !url.password
      && !url.port && url.pathname === "/search" && url.searchParams.get("udm") === "50"
      && normalize(url.searchParams.get("q") || "") === normalize(question);
  } catch {
    return false;
  }
}

function validRecord(value: unknown): value is LearningHistoryRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const text = (name: string, max: number) => typeof item[name] === "string" && (item[name] as string).length > 0 && (item[name] as string).length <= max;
  if ("studentId" in item || "deletedAt" in item) return false;
  if (!text("id", 128) || !/^[a-zA-Z0-9_-]+$/.test(item.id as string)) return false;
  if (!validTime(item.askedAt) || !text("question", 2000)) return false;
  if (!CATEGORIES.has(item.category as string) || !SOURCES.has(item.sourceType as string)) return false;
  if (item.strategy !== "api" && item.strategy !== "google-ai") return false;
  if (!Number.isSafeInteger(item.syncVersion) || (item.syncVersion as number) < 1 || (item.syncVersion as number) > 1_000_000_000) return false;
  if (!optionalText(item.answer, 20_000) || !optionalText(item.rawAnswer, 20_000) || !optionalText(item.organizedAnswer, 20_000)) return false;
  if (!optionalText(item.sourceUrl, 2048) || !optionalText(item.answerUpdatedAt, 40) || !optionalText(item.rawAnswerCapturedAt, 40)) return false;
  if (item.answerUpdatedAt !== undefined && !validTime(item.answerUpdatedAt)) return false;
  if (item.rawAnswerCapturedAt !== undefined && !validTime(item.rawAnswerCapturedAt)) return false;
  if (item.sourceUrl && (item.strategy !== "google-ai" || !safeLearningSourceUrl(item.sourceUrl as string, item.question as string))) return false;
  return true;
}

function originGuard(config: StudentAuthConfig): RequestHandler {
  return (req, res, next) => {
    if (req.method === "GET" || req.method === "HEAD") return next();
    const origin = req.header("origin");
    const host = req.header("host");
    let sameOrigin = false;
    try { sameOrigin = Boolean(origin && host && new URL(origin).host === host); } catch { /* reject */ }
    const explicitlyAllowed = Boolean(origin && config.allowedOrigins.has(origin));
    if (!origin || (!sameOrigin && !explicitlyAllowed) || !studentOriginAllowed(config, origin)
      || (req.header("sec-fetch-site") === "cross-site" && !explicitlyAllowed)) {
      res.status(403).json({ error: "STUDENT_ORIGIN_NOT_ALLOWED" });
      return;
    }
    next();
  };
}

export function createStudentLearningHistoryRouter(repo: StudentLearningHistoryRepo, config: StudentAuthConfig) {
  const router = express.Router();
  router.use("/learning-history", originGuard(config));
  router.use("/learning-history", (_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
  router.get("/learning-history", (req, res) => {
    const studentId = req.studentAuth?.user.id;
    if (!studentId) return res.status(401).json({ error: "AUTH_REQUIRED" });
    const offset = Number(req.query.offset ?? 0);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100_000) return res.status(400).json({ error: "INVALID_OFFSET" });
    const entries = repo.listStudent(studentId, offset, 101);
    return res.json({ entries: entries.slice(0, 100), nextOffset: entries.length > 100 ? offset + 100 : null });
  });
  const upsert: RequestHandler = (req, res) => {
    const studentId = req.studentAuth?.user.id;
    if (!studentId) return res.status(401).json({ error: "AUTH_REQUIRED" });
    const body = req.body as { entries?: unknown } | undefined;
    const entries = body?.entries;
    if (!Array.isArray(entries) || entries.length < 1 || entries.length > MAX_LEARNING_HISTORY_BATCH) return res.status(400).json({ error: "INVALID_BATCH" });
    if (Buffer.byteLength(JSON.stringify(req.body) ?? "", "utf8") > MAX_LEARNING_HISTORY_BODY_BYTES) return res.status(413).json({ error: "BATCH_TOO_LARGE" });
    if (!entries.every(validRecord) || new Set(entries.map((entry: LearningHistoryRecord) => entry.id)).size !== entries.length) {
      return res.status(400).json({ error: "INVALID_ENTRY" });
    }
    return res.json({ entries: repo.upsertBatch(studentId, entries) });
  };
  router.post("/learning-history", upsert);
  router.put("/learning-history", upsert);
  router.delete("/learning-history/:id", (req, res) => {
    const studentId = req.studentAuth?.user.id;
    if (!studentId) return res.status(401).json({ error: "AUTH_REQUIRED" });
    const id = String(req.params.id);
    const version = (req.body as { syncVersion?: unknown } | undefined)?.syncVersion;
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id) || !Number.isSafeInteger(version) || (version as number) < 1 || (version as number) > 1_000_000_000) {
      return res.status(400).json({ error: "INVALID_DELETE" });
    }
    const entry = repo.tombstone(studentId, id, version as number);
    if (!entry) return res.status(404).json({ error: "ENTRY_NOT_FOUND" });
    return res.json({ entry });
  });
  return router;
}
