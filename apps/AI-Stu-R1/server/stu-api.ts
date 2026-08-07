import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, isAbsolute, resolve } from "node:path";
import express, { type Request, type Response } from "express";
import {
  assertStudentAuthConfig,
  createStudentAuthRuntime,
  resolveStudentAuthConfig
} from "@ai-smartbook/auth/server";
import {
  loadStudentRuntimeConfig,
  createDataSource,
  keywordChat,
  type StudentBookPdfFile,
  type StudentDataSource
} from "@ai-smartbook/student-runtime";
import { DEFAULT_APPEARANCE, readerOutlineResponseSchema, studentChatRequestSchema } from "@ai-smartbook/schema";
import { createStudentAuthRouter, createStudentSessionMiddleware } from "@ai-smartbook/auth/express";
import { createStudentRagRouter, resolveStudentRagEnv } from "./student-rag";

const config = loadStudentRuntimeConfig();
const studentAuthConfig = resolveStudentAuthConfig(process.env);
assertStudentAuthConfig(studentAuthConfig);
const studentAuthDbPath = process.env.STUDENT_AUTH_DB_PATH || process.env.SQLITE_PATH || resolve(process.cwd(), "data", "ai-smartbook-r1.db");
const studentAuthRuntime = createStudentAuthRuntime(studentAuthDbPath, studentAuthConfig);

type PdfSession = { id: string; bookId: string; lastSeenAt: number };
const pdfSessions = new Map<string, PdfSession>();
const PDF_SESSION_MAX_AGE_MS = 1000 * 60 * 60 * 8;

// Build the data source defensively: a missing/unopenable SQLite file (e.g.
// the student.db has not been synced yet) must not crash the server. We keep
// the process alive and answer data endpoints with an explicit 503 instead.
let dataSource: StudentDataSource | null = null;
let dataSourceError: string | null = null;
try {
  dataSource = createDataSource(config);
} catch (err) {
  dataSourceError = err instanceof Error ? err.message : String(err);
  console.error(
    `[stu-api] data source unavailable (mode=${config.mode}, db=${config.dbPath}): ${dataSourceError}`
  );
}

/** Return the data source, or send a 503 and return null when unavailable. */
function requireDataSource(res: Response): StudentDataSource | null {
  if (!dataSource) {
    res.status(503).json({
      error: "student data source unavailable",
      detail: dataSourceError ?? "not initialized",
      mode: config.mode
    });
    return null;
  }
  return dataSource;
}

function cleanupPdfSessions(): void {
  const now = Date.now();
  for (const [id, session] of pdfSessions) {
    if (now - session.lastSeenAt > PDF_SESSION_MAX_AGE_MS) pdfSessions.delete(id);
  }
}

function createPdfSession(bookId: string): PdfSession {
  cleanupPdfSessions();
  const session = { id: `stu-${randomUUID()}`, bookId, lastSeenAt: Date.now() };
  pdfSessions.set(session.id, session);
  return session;
}

function resolvePdfSession(req: Request, bookId: string): PdfSession | null {
  cleanupPdfSessions();
  const raw = req.header("X-Student-Session-Id") || "";
  const session = pdfSessions.get(raw);
  if (!session || session.bookId !== bookId) return null;
  session.lastSeenAt = Date.now();
  return session;
}

function isPdfFile(file: StudentBookPdfFile): boolean {
  return (
    file.role === "source_document" &&
    (file.fileType === "application/pdf" || file.fileName.toLowerCase().endsWith(".pdf"))
  );
}

function candidatePdfPaths(file: StudentBookPdfFile): string[] {
  const candidates = new Set<string>();
  const stored = file.filePath;
  const normalized = stored.replace(/\\/g, "/");
  const safeBaseName = basename(normalized);

  if (isAbsolute(stored)) candidates.add(stored);
  candidates.add(resolve(stored));
  candidates.add(resolve(config.uploadDir, file.bookId, safeBaseName));

  const marker = `/uploads/books/${file.bookId}/`;
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex >= 0) {
    const relativeTail = normalized.slice(markerIndex + marker.length);
    candidates.add(resolve(config.uploadDir, file.bookId, relativeTail));
  }

  return [...candidates];
}

function resolveExistingPdfPath(file: StudentBookPdfFile): { path: string | null; checkedPaths: string[] } {
  const checkedPaths = candidatePdfPaths(file);
  for (const path of checkedPaths) {
    if (existsSync(path)) return { path, checkedPaths };
  }
  return { path: null, checkedPaths };
}

const app = express();
app.use(express.json());

// Appearance is authored in the admin system; the standalone student server
// serves the schema defaults so the SPA never 404s on boot.
app.get("/api/appearance-settings", (_req, res) => {
  res.json({ settings: DEFAULT_APPEARANCE });
});

// Google OAuth and session restore are public auth boundaries. All learning
// endpoints below them require the same server-side Student session.
app.use("/api/student/auth", createStudentAuthRouter(studentAuthRuntime.auth, studentAuthConfig));
app.use("/api/student", createStudentSessionMiddleware(studentAuthRuntime.auth, studentAuthConfig));

// Scoped RAG question endpoint: session + completed profile are already
// enforced by the middleware above; the route derives studentId/bookId from
// the session and route parameter, never from the request body.
app.use("/api/student", createStudentRagRouter({
  getDataSource: () => dataSource,
  env: resolveStudentRagEnv()
}));

// ---- Student API (read-only) ---------------------------------------------
app.get("/api/student/books", async (_req, res) => {
  const ds = requireDataSource(res);
  if (!ds) return;
  try {
    const books = await ds.listBooks();
    res.json({ mode: config.mode, books });
  } catch (err) {
    res.status(503).json({ error: "failed to read books", detail: String(err) });
  }
});

app.get("/api/student/books/:bookId", async (req, res) => {
  const ds = requireDataSource(res);
  if (!ds) return;
  try {
    const book = await ds.getBook(String(req.params.bookId));
    if (!book) return res.status(404).json({ error: "book not found" });
    res.json({ book });
  } catch (err) {
    res.status(503).json({ error: "failed to read book", detail: String(err) });
  }
});

app.get("/api/student/books/:bookId/outline", async (req, res) => {
  const ds = requireDataSource(res);
  if (!ds) return;
  try {
    const book = await ds.getBook(String(req.params.bookId));
    if (!book) return res.status(404).json({ error: "book not found" });
    // The standalone student server only carries the chapter table; manual
    // TOCs and split-JSON indexes stay on the admin origin.
    const outline = [...book.chapters]
      .sort((a, b) => a.orderIndex - b.orderIndex)
      .map((chapter) => ({
        id: chapter.id,
        title: chapter.title,
        level: Math.max(1, (chapter.level ?? 0) + 1),
        page: chapter.pageStart ?? null,
        pdfPage: chapter.pageStart ?? null,
        displayPage: chapter.pageStart != null ? String(chapter.pageStart) : null,
        children: [],
        source: "chapter_table" as const
      }));
    const parsed = readerOutlineResponseSchema.safeParse({ bookId: book.id, source: "chapter_table", outline });
    if (!parsed.success) return res.status(500).json({ error: "outline shape invalid", detail: parsed.error.message });
    res.json(parsed.data);
  } catch (err) {
    res.status(503).json({ error: "failed to load outline", detail: String(err) });
  }
});

app.get("/api/student/books/:bookId/contents", async (req, res) => {
  const ds = requireDataSource(res);
  if (!ds) return;
  try {
    const contents = await ds.getContents(String(req.params.bookId));
    res.json({ contents });
  } catch (err) {
    res.status(503).json({ error: "failed to read contents", detail: String(err) });
  }
});

app.post("/api/student/books/:bookId/session", async (req, res) => {
  const ds = requireDataSource(res);
  if (!ds) return;
  const bookId = String(req.params.bookId);
  try {
    const book = await ds.getBook(bookId);
    if (!book) return res.status(404).json({ error: "book not found" });

    const requested = typeof req.body?.sessionId === "string" ? req.body.sessionId.trim() : "";
    const existing = requested ? pdfSessions.get(requested) : null;
    if (existing && existing.bookId === bookId) {
      existing.lastSeenAt = Date.now();
      return res.json({ sessionId: existing.id });
    }

    const session = createPdfSession(bookId);
    res.json({ sessionId: session.id });
  } catch (err) {
    res.status(503).json({ error: "failed to create reader session", detail: String(err) });
  }
});

app.get("/api/student/books/:bookId/files/:fileId/pdf-view", async (req, res) => {
  const ds = requireDataSource(res);
  if (!ds) return;
  const bookId = String(req.params.bookId);
  const fileId = String(req.params.fileId);

  try {
    const book = await ds.getBook(bookId);
    if (!book) return res.status(404).json({ error: "book not found" });

    if (!resolvePdfSession(req, bookId)) return res.status(401).json({ error: "invalid session" });

    const file = await ds.getPdfFile(bookId, fileId);
    if (!file) return res.status(404).json({ error: "file not found" });
    if (!isPdfFile(file)) return res.status(400).json({ error: "file is not a PDF source document" });

    const resolved = resolveExistingPdfPath(file);
    if (!resolved.path) {
      return res.status(404).json({
        error: "PDF file not found on disk",
        fileId: file.id,
        fileName: file.fileName,
        filePath: file.filePath,
        uploadDir: config.uploadDir,
        checkedPaths: resolved.checkedPaths
      });
    }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'inline; filename="reader.pdf"');
    res.setHeader("Cache-Control", "private, no-store, no-cache, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.sendFile(resolved.path);
  } catch (err) {
    res.status(503).json({ error: "failed to stream pdf", detail: String(err) });
  }
});

app.post("/api/student/books/:bookId/chat", async (req, res) => {
  const ds = requireDataSource(res);
  if (!ds) return;
  const parsed = studentChatRequestSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
  const question = parsed.data.message ?? parsed.data.question ?? "";
  if (!question.trim()) return res.status(400).json({ error: "message is required" });

  try {
    const bookId = String(req.params.bookId);
    const contents = await ds.getContents(bookId);

    // 1GB sqlite-api mode uses local keyword retrieval — no external AI call.
    const { answer, matchedContentIds } = keywordChat(question, contents);
    const sessionId = parsed.data.sessionId || `chat-${bookId}`;
    res.json({
      sessionId,
      answer,
      matchedContentIds,
      chatMode: config.chatMode,
      messages: []
    });
  } catch (err) {
    res.status(503).json({ error: "failed to answer chat", detail: String(err) });
  }
});

// ---- Static frontend (production) ----------------------------------------
const publicDir = resolve(config.publicDir);
if (existsSync(publicDir)) {
  app.use(express.static(publicDir));
  app.get(/^(?!\/api\/).*/, (_req, res) => {
    res.sendFile(resolve(publicDir, "index.html"));
  });
}

app.listen(config.apiPort, () => {
  console.log(
    `AI-Stu-R1 student API listening on ${config.apiPort} (mode=${config.mode}, chat=${config.chatMode})`
  );
});

export { app };
