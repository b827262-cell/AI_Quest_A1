import { Router, type Request, type Response } from "express";
import { existsSync } from "node:fs";
import { z } from "zod";
import { extractPdfOutline, normalizeChaptersToReaderOutline, normalizeReaderOutline, isStructuredReaderOutline } from "@ai-smartbook/book-core";
import { studentChatRequestSchema, createSmartBookNoteInputSchema, updateSmartBookNoteInputSchema, type Book, type BookFile, type ChatSession, type ReaderOutlineNode, type PdfJsonIndex } from "@ai-smartbook/schema";
import type { Repositories } from "@ai-smartbook/db";
import { failValidation } from "./validation-error";

const readerProgressRequestSchema = z.object({
  page: z.number().int().positive().optional(),
  chapterId: z.string().trim().min(1).optional(),
  eventType: z
    .enum(["page_view", "page_complete", "chapter_complete", "note_captured"])
    .default("page_view"),
  source: z.string().trim().min(1).max(64).optional()
});

const readerActionCompleteRequestSchema = z.object({
  page: z.number().int().positive().optional(),
  chapterId: z.string().trim().min(1).optional(),
  actionType: z.enum(["current_page", "current_chapter", "note_captured"]),
  source: z.string().trim().min(1).max(64).optional()
});

export type ReaderProgressEvent = z.infer<typeof readerProgressRequestSchema>;
export type ReaderProgressEventType = ReaderProgressEvent["eventType"];
type ReaderProgressState = {
  currentPage: number | null;
  currentChapterId: string | null;
  completedPages: number[];
  completedChapters: string[];
  updatedAt: string | null;
  lastEventType: ReaderProgressEventType | null;
};

type ReaderProgressSummary = {
  bookId: string;
  currentPage: number | null;
  currentChapterId: string | null;
  completedPagesCount: number;
  completedChapterIds: string[];
  completionPercentage: number | null;
  updatedAt: string | null;
};

type KnowledgePoint = {
  id: string;
  chapterId: string;
  title: string;
  summary: string;
  sourcePageStart: number | null;
  sourcePageEnd: number | null;
  importance: "low" | "medium" | "high";
  difficulty: "basic" | "intermediate" | "advanced";
  status: "available" | "completed";
};

type KnowledgePointState = {
  completedPointIds: string[];
  updatedAt: string | null;
};

type KnowledgePointListResponse = {
  bookId: string;
  chapterId?: string | null;
  points: KnowledgePoint[];
  completedPointsCount: number;
};

type ClientInfo = {
  userAgent: string | null;
  browserName: string;
  browserVersion: string | null;
  osName: string;
  osVersion: string | null;
  deviceType: string;
  deviceVendor: string | null;
  deviceModel: string | null;
  ipAddress: string | null;
  ipSource: string | null;
};


interface StudentBooksDependencies {
  repos: Repositories;
  findPublishedBook: (bookId: string) => Book | null;
  fail: (res: Response, status: number, message: string) => void;
  findPrimaryPdfSourceFile: (bookId: string) => BookFile | null;
  findLatestReaderTocFile: (bookId: string) => { file: BookFile | null; outline: ReaderOutlineNode[] | null };
  JSON_INDEX_ROLE: "json_index";
  getActiveQaReferenceId: (bookId: string) => string | null;
  readStoredJsonIndex: (file: BookFile, throwValidation?: boolean) => PdfJsonIndex | null;
  isPdfBookFile: (file: BookFile) => boolean;
  resolveStudentSession: (req: Request, res: Response, bookId: string, options: { allowCreate: boolean; title?: string; sessionIdOverride?: string | null; requireSessionHeader?: boolean }) => { session: ChatSession; clientInfo: ClientInfo } | null;
  rejectIfBlocked: (req: Request, res: Response, session: ChatSession | null) => boolean;
  parseClientInfo: (req: Request) => ClientInfo;
  enrichSessionClientInfo: (existing: ChatSession | null, next: ClientInfo) => Parameters<Repositories["chat"]["updateSessionClientInfo"]>[1];
  findManualQaAnswer: (bookId: string, question: string) => { question: string; answer: string } | null;
  keywordChat: (question: string, bookId: string, chapterId?: string | null) => { answer: string };
  summarizeReaderProgress: (book: { id: string }, sessionId: string) => ReaderProgressSummary;
  getChapterByIdOrNull: (bookId: string, chapterId: string | null) => { id: string } | null;
  readReaderProgressState: (bookId: string, sessionId: string) => ReaderProgressState;
  applyReaderProgressEvent: (book: { id: string }, state: ReaderProgressState, event: z.infer<typeof readerProgressRequestSchema>) => ReaderProgressState;
  writeReaderProgressState: (bookId: string, sessionId: string, state: ReaderProgressState) => void;
  getKnowledgePointsForBook: (bookId: string, sessionId: string, chapterId?: string | null) => KnowledgePointListResponse;
  getKnowledgePointById: (bookId: string, pointId: string) => KnowledgePoint | null;
  readKnowledgePointState: (bookId: string, sessionId: string) => KnowledgePointState;
  enrichKnowledgePointWithCompletion: (point: Omit<KnowledgePoint, "status">, completedPointIds: string[]) => KnowledgePoint;
  distinctStringValues: (values: Array<string | null | undefined>) => string[];
  writeKnowledgePointState: (bookId: string, sessionId: string, state: KnowledgePointState) => void;
  READER_PROGRESS_SOURCE_DEFAULT: string;
}

export function createStudentBooksRouter(deps: StudentBooksDependencies): Router {
  const { repos, findPublishedBook, fail, findPrimaryPdfSourceFile, findLatestReaderTocFile, JSON_INDEX_ROLE, getActiveQaReferenceId, readStoredJsonIndex, isPdfBookFile, resolveStudentSession, rejectIfBlocked, parseClientInfo, enrichSessionClientInfo, findManualQaAnswer, keywordChat, summarizeReaderProgress, getChapterByIdOrNull, readReaderProgressState, applyReaderProgressEvent, writeReaderProgressState, getKnowledgePointsForBook, getKnowledgePointById, readKnowledgePointState, enrichKnowledgePointWithCompletion, distinctStringValues, writeKnowledgePointState, READER_PROGRESS_SOURCE_DEFAULT } = deps;
  const app = Router();
app.get("/api/student/books", (_req, res) => {
  res.json({ mode: "repo-api", books: repos.books.findPublished() });
});

app.get("/api/student/books/:bookId", (req, res) => {
  const book = findPublishedBook(String(req.params.bookId));
  if (!book) return fail(res, 404, "book not found");
  const chapters = repos.chapters.findByBookId(book.id);
  const pdfFile = findPrimaryPdfSourceFile(book.id);
  res.json({
    book: {
      ...book,
      chapters,
      pdfFileId: pdfFile?.id ?? null,
      pdfFileName: pdfFile?.fileName ?? null
    }
  });
});

app.get("/api/student/books/:bookId/outline", async (req, res) => {
  const book = findPublishedBook(String(req.params.bookId));
  if (!book) return fail(res, 404, "book not found");

  const manualToc = findLatestReaderTocFile(book.id);
  if (manualToc.outline && manualToc.outline.length > 0) {
    return res.json({ bookId: book.id, source: "manual_toc", outline: manualToc.outline });
  }

  const jsonIndexFiles = repos.files
    .findByBookId(book.id)
    .filter((file) => file.role === JSON_INDEX_ROLE)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const activeId = getActiveQaReferenceId(book.id);
  const candidates = [
    ...jsonIndexFiles.filter((file) => {
      const index = readStoredJsonIndex(file);
      return index?.level === "chapter";
    }),
    ...jsonIndexFiles.filter((file) => file.id === activeId),
    ...jsonIndexFiles
  ];
  const seen = new Set<string>();

  for (const file of candidates) {
    if (seen.has(file.id)) continue;
    seen.add(file.id);
    const index = readStoredJsonIndex(file);
    if (!index) continue;
    const outline = normalizeReaderOutline(index, "split_json");
    if (outline.length > 0 && isStructuredReaderOutline(outline)) {
      return res.json({ bookId: book.id, source: "split_json", outline });
    }
  }

  const chapters = repos.chapters.findByBookId(book.id);
  const outline = normalizeChaptersToReaderOutline(chapters, "chapter_table");
  if (outline.length > 0 && isStructuredReaderOutline(outline)) {
    return res.json({ bookId: book.id, source: "chapter_table", outline });
  }

  const sourcePdf = findPrimaryPdfSourceFile(book.id);
  if (sourcePdf && isPdfBookFile(sourcePdf) && existsSync(sourcePdf.filePath)) {
    const fallbackEntries = await extractPdfOutline(sourcePdf.filePath);
    const fallbackOutline = normalizeReaderOutline(
      fallbackEntries.map((entry, index) => ({
        id: `pdf-outline-${index + 1}`,
        title: entry.title,
        level: (entry.level ?? 0) + 1,
        page: entry.pageNumber,
        pdfPage: entry.pageNumber,
        displayPage: entry.pageNumber != null ? String(entry.pageNumber) : null,
        children: [],
        source: "pdf_outline" as const
      })),
      "pdf_outline"
    );
    if (fallbackOutline.length > 0) {
      return res.json({ bookId: book.id, source: "pdf_outline", outline: fallbackOutline });
    }
  }

  res.json({ bookId: book.id, source: "fallback", outline: [] });
});

app.get("/api/student/books/:bookId/contents", (req, res) => {
  const book = findPublishedBook(String(req.params.bookId));
  if (!book) return fail(res, 404, "book not found");
  res.json({ contents: repos.contents.findByBookId(book.id) });
});

// ---- Smart Notes (text / ai_answer / canvas) -----------------------------
// Notes are scoped to a published book and optionally to chapter/page context.
app.get("/api/student/books/:bookId/notes", (req, res) => {
  const book = findPublishedBook(String(req.params.bookId));
  if (!book) return fail(res, 404, "book not found");
  res.json({ notes: repos.notes.findByBookId(book.id) });
});

app.post("/api/student/books/:bookId/notes", (req, res) => {
  const book = findPublishedBook(String(req.params.bookId));
  if (!book) return fail(res, 404, "book not found");
  const parsed = createSmartBookNoteInputSchema.safeParse(req.body);
  if (!parsed.success) return failValidation(res, parsed.error);
  if (parsed.data.type === "canvas" && !parsed.data.canvasData) {
    return fail(res, 400, "canvas notes require canvasData");
  }
  if (parsed.data.type !== "canvas" && !parsed.data.content?.trim()) {
    return fail(res, 400, "text/ai_answer notes require content");
  }
  res.status(201).json({ note: repos.notes.create(book.id, parsed.data) });
});

app.patch("/api/student/books/:bookId/notes/:noteId", (req, res) => {
  const book = findPublishedBook(String(req.params.bookId));
  if (!book) return fail(res, 404, "book not found");
  const note = repos.notes.findById(String(req.params.noteId));
  if (!note || note.bookId !== book.id) return fail(res, 404, "note not found");
  const parsed = updateSmartBookNoteInputSchema.safeParse(req.body);
  if (!parsed.success) return failValidation(res, parsed.error);
  res.json({ note: repos.notes.update(note.id, parsed.data) });
});

app.delete("/api/student/books/:bookId/notes/:noteId", (req, res) => {
  const book = findPublishedBook(String(req.params.bookId));
  if (!book) return fail(res, 404, "book not found");
  const note = repos.notes.findById(String(req.params.noteId));
  if (!note || note.bookId !== book.id) return fail(res, 404, "note not found");
  repos.notes.delete(note.id);
  res.json({ deleted: true });
});

app.post("/api/student/books/:bookId/session", (req, res) => {
  const book = findPublishedBook(String(req.params.bookId));
  if (!book) return fail(res, 404, "book not found");

  const resolved = resolveStudentSession(req, res, book.id, {
    allowCreate: true,
    title: `Reader session · ${book.title}`,
    sessionIdOverride:
      typeof req.body?.sessionId === "string" && req.body.sessionId.trim() !== ""
        ? req.body.sessionId.trim()
        : null
  });
  if (!resolved) return;

  res.json({ sessionId: resolved.session.id });
});

app.get("/api/student/books/:bookId/files/:fileId/pdf-view", (req, res) => {
  const book = findPublishedBook(String(req.params.bookId));
  if (!book) return fail(res, 404, "book not found");

  const resolved = resolveStudentSession(req, res, book.id, {
    allowCreate: false,
    requireSessionHeader: true
  });
  if (!resolved) return;

  const file = repos.files.findById(String(req.params.fileId));
  if (!file || file.bookId !== book.id) return fail(res, 404, "file not found");
  if (file.role !== "source_document" || !isPdfBookFile(file)) {
    return fail(res, 400, "file is not a PDF source document");
  }
  if (!existsSync(file.filePath)) return fail(res, 404, "file not found");

  repos.pdfAccessLogs.create({
    bookId: book.id,
    fileId: file.id,
    sessionId: resolved.session.id,
    ipAddress: resolved.clientInfo.ipAddress ?? null,
    userAgent: resolved.clientInfo.userAgent ?? null
  });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", 'inline; filename="reader.pdf"');
  res.setHeader("Cache-Control", "private, no-store, no-cache, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.sendFile(file.filePath);
});

app.post("/api/student/books/:bookId/chat", (req, res) => {
  const book = findPublishedBook(String(req.params.bookId));
  if (!book) return fail(res, 404, "book not found");
  // Accept both { message } (student UX) and { question } (legacy) bodies.
  const parsed = studentChatRequestSchema.safeParse(req.body);
  if (!parsed.success) return failValidation(res, parsed.error);
  const question = parsed.data.message ?? parsed.data.question ?? "";
  if (!question.trim()) return fail(res, 400, "message is required");

  // Resolve or create a chat session bound to this book.
  let sessionId = parsed.data.sessionId;
  const requestClientInfo = parseClientInfo(req);

  // Enforce admin blocks before doing any work: reject a blocked session, or a
  // brand-new session opened from an already-blocked public IP.
  const existingSession = sessionId ? repos.chat.findSessionById(sessionId) : null;
  if (rejectIfBlocked(req, res, existingSession)) return;

  if (sessionId) {
    const session = existingSession;
    if (!session || session.bookId !== book.id) {
      sessionId = undefined;
    } else {
      repos.chat.updateSessionClientInfo(session.id, enrichSessionClientInfo(session, requestClientInfo));
    }
  }
  if (!sessionId) {
    sessionId = repos.chat.createSession({
      bookId: book.id,
      title: question.slice(0, 40),
      ...enrichSessionClientInfo(null, requestClientInfo)
    }).id;
  }

  // When a chapter is selected but has no linked content, tell the student to
  // re-link it in the admin instead of silently searching the whole book.
  const chapterId = parsed.data.chapterId;
  if (chapterId) {
    const chapter = repos.chapters.findById(chapterId);
    const chapterLinked =
      chapter && chapter.bookId === book.id
        ? repos.contents.findByChapterId(chapterId).length > 0
        : false;
    if (chapter && chapter.bookId === book.id && !chapterLinked) {
      const notice = "此章尚未建立可問答內容，請回後台重新連結內容。";
      repos.chat.addMessage({ sessionId, role: "user", content: question });
      repos.chat.addMessage({ sessionId, role: "assistant", content: notice });
      return res.json({
        sessionId,
        answer: notice,
        chatMode: "chapter-unlinked",
        source: "chapter_unlinked",
        provider: "system",
        model: "local",
        messages: repos.chat.findMessages(sessionId)
      });
    }
  }

  const manualAnswer = findManualQaAnswer(book.id, question);
  const result = manualAnswer
    ? {
        answer: `以下為老師整理的 Q&A：\n${manualAnswer.answer}`,
        chatMode: "manual-qa",
        source: "manual_qa",
        provider: "manual",
        model: "markdown",
        matchedQuestion: manualAnswer.question
      }
    : {
        ...keywordChat(question, book.id, chapterId),
        chatMode: "keyword",
        source: chapterId ? "chapter_contents" : "book_contents",
        provider: "keyword",
        model: "local"
      };
  repos.chat.addMessage({ sessionId, role: "user", content: question });
  repos.chat.addMessage({ sessionId, role: "assistant", content: result.answer });

  res.json({
    sessionId,
    ...result,
    messages: repos.chat.findMessages(sessionId)
  });
});

app.get("/api/student/books/:bookId/chat-sessions/:sessionId", (req, res) => {
  const book = findPublishedBook(String(req.params.bookId));
  if (!book) return fail(res, 404, "book not found");
  const session = repos.chat.findSessionById(String(req.params.sessionId));
  // Only expose sessions that belong to this published book.
  if (!session || session.bookId !== book.id) return fail(res, 404, "session not found");
  if (rejectIfBlocked(req, res, session)) return;
  repos.chat.updateSessionClientInfo(session.id, enrichSessionClientInfo(session, parseClientInfo(req)));
  res.json({ sessionId: session.id, messages: repos.chat.findMessages(session.id) });
});

app.get("/api/student/books/:bookId/progress-summary", (req, res) => {
  const book = findPublishedBook(String(req.params.bookId));
  if (!book) return fail(res, 404, "book not found");

  const resolved = resolveStudentSession(req, res, book.id, {
    allowCreate: false,
    requireSessionHeader: true
  });
  if (!resolved) return;

  res.json(summarizeReaderProgress(book, resolved.session.id));
});

app.post("/api/student/books/:bookId/progress", (req, res) => {
  const book = findPublishedBook(String(req.params.bookId));
  if (!book) return fail(res, 404, "book not found");

  const resolved = resolveStudentSession(req, res, book.id, {
    allowCreate: false,
    requireSessionHeader: true
  });
  if (!resolved) return;

  const parsed = readerProgressRequestSchema.safeParse(req.body);
  if (!parsed.success) return failValidation(res, parsed.error);

  if (
    (parsed.data.eventType === "page_complete" ||
      parsed.data.eventType === "note_captured") &&
    !parsed.data.page
  ) {
    return fail(res, 400, "page is required for page_complete and note_captured");
  }

  if (parsed.data.eventType === "chapter_complete") {
    const chapter = getChapterByIdOrNull(book.id, parsed.data.chapterId ?? null);
    if (!chapter) {
      return fail(res, 400, "chapter not found");
    }
  }

  const current = readReaderProgressState(book.id, resolved.session.id);
  const next = applyReaderProgressEvent(book, current, {
    ...parsed.data,
    source: parsed.data.source?.trim() || READER_PROGRESS_SOURCE_DEFAULT
  });

  writeReaderProgressState(book.id, resolved.session.id, next);
  res.json(summarizeReaderProgress(book, resolved.session.id));
});

app.post("/api/student/books/:bookId/reader-actions/complete", (req, res) => {
  const book = findPublishedBook(String(req.params.bookId));
  if (!book) return fail(res, 404, "book not found");

  const resolved = resolveStudentSession(req, res, book.id, {
    allowCreate: false,
    requireSessionHeader: true
  });
  if (!resolved) return;

  const parsed = readerActionCompleteRequestSchema.safeParse(req.body);
  if (!parsed.success) return failValidation(res, parsed.error);

  if (parsed.data.actionType === "current_chapter" && !parsed.data.chapterId) {
    return fail(res, 400, "chapterId is required for current_chapter");
  }

  if (parsed.data.actionType === "current_page" && !parsed.data.page) {
    return fail(res, 400, "page is required for current_page");
  }

  if (parsed.data.chapterId) {
    const chapter = getChapterByIdOrNull(book.id, parsed.data.chapterId);
    if (!chapter) {
      return fail(res, 400, "chapter not found");
    }
  }

  const mappedEvent: z.infer<typeof readerProgressRequestSchema> = {
    page: parsed.data.page,
    chapterId: parsed.data.chapterId,
    source: parsed.data.source?.trim() || READER_PROGRESS_SOURCE_DEFAULT,
    eventType:
      parsed.data.actionType === "current_page"
        ? "page_complete"
        : parsed.data.actionType === "current_chapter"
          ? "chapter_complete"
          : "note_captured"
  };

  const current = readReaderProgressState(book.id, resolved.session.id);
  if (mappedEvent.eventType === "chapter_complete" && !mappedEvent.chapterId) {
    return fail(res, 400, "chapterId is required for current_chapter");
  }
  const next = applyReaderProgressEvent(book, current, mappedEvent);
  writeReaderProgressState(book.id, resolved.session.id, next);
  res.json(summarizeReaderProgress(book, resolved.session.id));
});

app.get("/api/student/books/:bookId/knowledge-points", (req, res) => {
  const book = findPublishedBook(String(req.params.bookId));
  if (!book) return fail(res, 404, "book not found");

  const resolved = resolveStudentSession(req, res, book.id, {
    allowCreate: false,
    requireSessionHeader: true
  });
  if (!resolved) return;

  const chapterIdRaw = req.query.chapterId;
  const chapterId =
    typeof chapterIdRaw === "string" && chapterIdRaw.trim() ? chapterIdRaw.trim() : null;
  if (chapterId) {
    const chapter = getChapterByIdOrNull(book.id, chapterId);
    if (!chapter) {
      return fail(res, 404, "chapter not found");
    }
  }

  res.json(getKnowledgePointsForBook(book.id, resolved.session.id, chapterId));
});

app.get("/api/student/books/:bookId/chapters/:chapterId/knowledge-points", (req, res) => {
  const book = findPublishedBook(String(req.params.bookId));
  if (!book) return fail(res, 404, "book not found");

  const resolved = resolveStudentSession(req, res, book.id, {
    allowCreate: false,
    requireSessionHeader: true
  });
  if (!resolved) return;

  const chapter = getChapterByIdOrNull(book.id, String(req.params.chapterId));
  if (!chapter) return fail(res, 404, "chapter not found");

  res.json(getKnowledgePointsForBook(book.id, resolved.session.id, chapter.id));
});

app.get("/api/student/books/:bookId/knowledge-points/:pointId", (req, res) => {
  const book = findPublishedBook(String(req.params.bookId));
  if (!book) return fail(res, 404, "book not found");

  const resolved = resolveStudentSession(req, res, book.id, {
    allowCreate: false,
    requireSessionHeader: true
  });
  if (!resolved) return;

  const point = getKnowledgePointById(book.id, String(req.params.pointId));
  if (!point) return fail(res, 404, "knowledge point not found");

  const state = readKnowledgePointState(book.id, resolved.session.id);
  res.json({
    bookId: book.id,
    point: enrichKnowledgePointWithCompletion(point, state.completedPointIds)
  });
});

app.post("/api/student/books/:bookId/knowledge-points/:pointId/complete", (req, res) => {
  const book = findPublishedBook(String(req.params.bookId));
  if (!book) return fail(res, 404, "book not found");

  const resolved = resolveStudentSession(req, res, book.id, {
    allowCreate: false,
    requireSessionHeader: true
  });
  if (!resolved) return;

  const point = getKnowledgePointById(book.id, String(req.params.pointId));
  if (!point) return fail(res, 404, "knowledge point not found");

  const state = readKnowledgePointState(book.id, resolved.session.id);
  const completedPointIds = distinctStringValues([...state.completedPointIds, point.id]);
  writeKnowledgePointState(book.id, resolved.session.id, {
    completedPointIds,
    updatedAt: new Date().toISOString()
  });

  const knowledgePointList = getKnowledgePointsForBook(book.id, resolved.session.id);
  res.json({
    bookId: book.id,
    point: enrichKnowledgePointWithCompletion(point, completedPointIds),
    completedPointsCount: knowledgePointList.completedPointsCount
  });
});


  return app;
}
