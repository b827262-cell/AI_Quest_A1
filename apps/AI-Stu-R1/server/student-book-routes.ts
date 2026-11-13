import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, isAbsolute, resolve } from "node:path";
import type { Express, Request, Response } from "express";
import { keywordChat, type StudentBookPdfFile, type StudentDataSource } from "@ai-smartbook/student-runtime";
import { readerOutlineResponseSchema, studentChatRequestSchema } from "@ai-smartbook/schema";

export interface StudentBookRoutesOptions {
  /** Resolved lazily so an unavailable data source still answers a stable 503. */
  getDataSource: () => StudentDataSource | null;
  mode: string;
  chatMode: string;
  /** Root used to resolve legacy relative PDF paths. */
  uploadDir: string;
  /** Server-side diagnostics only; never forwarded to a client. */
  logError?: (context: string, error: unknown) => void;
}

type PdfSession = { id: string; bookId: string; lastSeenAt: number };
const pdfSessions = new Map<string, PdfSession>();
const PDF_SESSION_MAX_AGE_MS = 1000 * 60 * 60 * 8;

/**
 * Log a server-side failure without echoing the raw error text. Node, SQLite
 * and provider errors embed filesystem paths, SQL fragments and response
 * bodies in `message`/`stack`; only the stable class name and system code are
 * safe to keep in logs. Clients never see either field.
 */
export function logServerError(scope: string, context: string, error: unknown): void {
  const name = error instanceof Error ? error.name : typeof error;
  const code = (error as { code?: unknown } | null)?.code;
  const suffix = typeof code === "string" && code ? ` code=${code}` : "";
  console.error(`[${scope}] ${context} failed (${name}${suffix})`);
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

function candidatePdfPaths(file: StudentBookPdfFile, uploadDir: string): string[] {
  const candidates = new Set<string>();
  const stored = file.filePath;
  const normalized = stored.replace(/\\/g, "/");
  const safeBaseName = basename(normalized);

  if (isAbsolute(stored)) candidates.add(stored);
  candidates.add(resolve(stored));
  candidates.add(resolve(uploadDir, file.bookId, safeBaseName));

  const marker = `/uploads/books/${file.bookId}/`;
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex >= 0) {
    const relativeTail = normalized.slice(markerIndex + marker.length);
    candidates.add(resolve(uploadDir, file.bookId, relativeTail));
  }

  return [...candidates];
}

function resolveExistingPdfPath(
  file: StudentBookPdfFile,
  uploadDir: string
): { path: string | null; checkedPaths: string[] } {
  const checkedPaths = candidatePdfPaths(file, uploadDir);
  for (const path of checkedPaths) {
    if (existsSync(path)) return { path, checkedPaths };
  }
  return { path: null, checkedPaths };
}

/**
 * Register the read-only student book routes. Responses only ever carry a
 * stable error literal; `detail`, `String(err)`, Zod messages, stacks and
 * resolved filesystem paths stay on the server (see `logServerError`).
 */
export function registerStudentBookRoutes(app: Express, options: StudentBookRoutesOptions): void {
  const { getDataSource, mode, chatMode, uploadDir } = options;
  const logError = options.logError ?? ((context, error) => logServerError("stu-api", context, error));

  function requireDataSource(res: Response): StudentDataSource | null {
    const dataSource = getDataSource();
    if (!dataSource) {
      res.status(503).json({ error: "student data source unavailable", mode });
      return null;
    }
    return dataSource;
  }

  app.get("/api/student/books", async (_req, res) => {
    const ds = requireDataSource(res);
    if (!ds) return;
    try {
      const books = await ds.listBooks();
      res.json({ mode, books });
    } catch (err) {
      logError("read books", err);
      res.status(503).json({ error: "failed to read books" });
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
      logError("read book", err);
      res.status(503).json({ error: "failed to read book" });
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
      if (!parsed.success) {
        logError("outline shape invalid", parsed.error);
        return res.status(500).json({ error: "outline shape invalid" });
      }
      res.json(parsed.data);
    } catch (err) {
      logError("load outline", err);
      res.status(503).json({ error: "failed to load outline" });
    }
  });

  app.get("/api/student/books/:bookId/contents", async (req, res) => {
    const ds = requireDataSource(res);
    if (!ds) return;
    try {
      const contents = await ds.getContents(String(req.params.bookId));
      res.json({ contents });
    } catch (err) {
      logError("read contents", err);
      res.status(503).json({ error: "failed to read contents" });
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
      logError("create reader session", err);
      res.status(503).json({ error: "failed to create reader session" });
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

      const resolved = resolveExistingPdfPath(file, uploadDir);
      if (!resolved.path) {
        // The resolved candidates stay server-side: they expose the upload
        // root and the deployment layout. Only the ids the caller already
        // supplied are echoed back.
        logError("pdf not found on disk", { code: "PDF_NOT_ON_DISK", checked: resolved.checkedPaths.length });
        return res.status(404).json({
          error: "PDF file not found on disk",
          fileId: file.id,
          fileName: file.fileName
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
      logError("stream pdf", err);
      res.status(503).json({ error: "failed to stream pdf" });
    }
  });

  app.post("/api/student/books/:bookId/chat", async (req, res) => {
    const ds = requireDataSource(res);
    if (!ds) return;
    const parsed = studentChatRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      logError("invalid chat request", parsed.error);
      return res.status(400).json({ error: "invalid chat request" });
    }
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
        chatMode,
        messages: []
      });
    } catch (err) {
      logError("answer chat", err);
      res.status(503).json({ error: "failed to answer chat" });
    }
  });
}
