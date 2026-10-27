import { Router, type NextFunction, type Request, type Response } from "express";
import type { Repositories } from "@ai-smartbook/db";
import type { BookCoreContext } from "@ai-smartbook/book-core";
import multer from "multer";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  parsePdfToContents, splitBookIntoChapters, buildChaptersFromContents,
  buildChaptersFromPdfOutline, buildChapterPreviewRowsFromPdfOutline, buildPdfJsonIndex,
  InvalidPdfPageNumberError, buildReaderTocFromIndexItems,
  linkChaptersByPageRange, summarizeChapter, askBookQuestion
} from "@ai-smartbook/book-core";
import {
  applyChapterPreviewInputSchema, bookFileRoleSchema,
  readerTocImportPayloadSchema, generateReaderTocFromIndexInputSchema,
  createBookInputSchema, updateBookInputSchema, createChapterInputSchema,
  updateChapterInputSchema, chatRequestSchema, generatePdfJsonIndexInputSchema,
  saveJsonIndexInputSchema, pdfJsonIndexSchema,
  type AiJobType, type BookAiJob, type BookFile, type ChapterPreviewRow,
  type PdfJsonIndex, type ReaderOutlineNode, type ReaderTocImportPayload,
  type ReaderTocInputNode, type StoredJsonIndexSummary
} from "@ai-smartbook/schema";

export interface BooksRouterDependencies {
  repos: Repositories;
  ctx: BookCoreContext;
  upload: ReturnType<typeof multer>;
  jsonUpload: ReturnType<typeof multer>;
  uploadRoot: string;
  bookUploadLimit: number;
  jsonIndexRole: "json_index";
  readerTocRole: "reader_toc";
  readerTocSchemaVersion: string;
  readerTocSource: "manual_admin_import";
  fail: (res: Response, status: number, message: string) => void;
  uploadErrorHandler: (error: unknown, req: Request, res: Response, next: NextFunction) => void;
  removeUncommittedUpload: (path: string | undefined) => void;
  sanitizeUploadFileName: (name: string) => string;
  isPdfUpload: (fileName: string, fileType: string, filePath: string) => boolean;
  matchesStoredRasterSignature: (mimeType: string, filePath: string) => boolean;
  isPdfBookFile: (file: BookFile) => boolean;
  isImageFile: (file: Pick<BookFile, "fileName" | "fileType">) => boolean;
  deleteStoredBookFile: (file: BookFile) => void;
  replaceParsedContentsForFile: (file: BookFile) => Promise<{ parsed: number; pageCount: number }>;
  writeJsonIndexArtifact: (bookId: string, baseName: string, json: PdfJsonIndex) => string;
  setActiveQaReferenceId: (bookId: string, fileId: string | null) => void;
  getActiveQaReferenceId: (bookId: string) => string | null;
  summarizeStoredJsonIndex: (file: BookFile, activeId: string | null) => StoredJsonIndexSummary;
  readStoredJsonIndex: (file: BookFile) => PdfJsonIndex | null;
  parseReaderTocImportFromPayload: (bookId: string, payload: ReaderTocImportPayload) => {
    file: { schemaVersion: string; bookId: string; source: string; items: ReaderTocInputNode[] };
    outline: ReaderOutlineNode[];
  };
  writeReaderTocArtifact: (bookId: string, payload: { schemaVersion: string; bookId: string; source: string; items: unknown[] }) => string;
  summarizeReaderToc: (nodes: ReaderOutlineNode[]) => { itemCount: number };
  findLatestReaderTocFile: (bookId: string) => { file: BookFile | null; outline: ReaderOutlineNode[] | null };
  toReaderTocInputNodes: (nodes: ReaderOutlineNode[]) => ReaderTocInputNode[];
  normalizePreviewRowsForApply: (rows: ChapterPreviewRow[]) => ChapterPreviewRow[];
  runJob: <T>(bookId: string, jobType: AiJobType, input: unknown, fn: () => Promise<T>) => Promise<{ job: BookAiJob; result: T }>;
  parseManualQaMarkdown: (markdown: string) => { question: string; answer: string }[];
}

export function createBooksRouter(deps: BooksRouterDependencies): Router {
  const {
    repos, ctx, upload, jsonUpload, uploadRoot: UPLOAD_ROOT, bookUploadLimit: BOOK_UPLOAD_LIMIT,
    jsonIndexRole: JSON_INDEX_ROLE, readerTocRole: READER_TOC_ROLE,
    readerTocSchemaVersion: READER_TOC_SCHEMA_VERSION, readerTocSource: READER_TOC_SOURCE,
    fail, uploadErrorHandler, removeUncommittedUpload, sanitizeUploadFileName,
    isPdfUpload, matchesStoredRasterSignature, isPdfBookFile, isImageFile,
    deleteStoredBookFile, replaceParsedContentsForFile, writeJsonIndexArtifact,
    setActiveQaReferenceId, getActiveQaReferenceId, summarizeStoredJsonIndex,
    readStoredJsonIndex, parseReaderTocImportFromPayload, writeReaderTocArtifact,
    summarizeReaderToc, findLatestReaderTocFile, toReaderTocInputNodes,
    normalizePreviewRowsForApply, runJob, parseManualQaMarkdown
  } = deps;
  const router = Router();
// ---- Books ----------------------------------------------------------------
router.get("/api/admin/books", (_req, res) => {
  res.json({ books: repos.books.findAll() });
});

router.post("/api/admin/books", (req, res) => {
  const parsed = createBookInputSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, parsed.error.message);
  res.status(201).json({ book: repos.books.create(parsed.data) });
});

router.get("/api/admin/books/:bookId", (req, res) => {
  const book = repos.books.findById(req.params.bookId);
  if (!book) return fail(res, 404, "book not found");
  const chapters = repos.chapters.findByBookId(book.id);
  const files = repos.files.findByBookId(book.id);
  res.json({ book, chapters, files });
});

router.patch("/api/admin/books/:bookId", (req, res) => {
  const parsed = updateBookInputSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, parsed.error.message);
  const book = repos.books.update(req.params.bookId, parsed.data);
  if (!book) return fail(res, 404, "book not found");
  res.json({ book });
});

// ---- Files & parsing ------------------------------------------------------
router.post("/api/admin/books/:bookId/files", (req: Request, res: Response, next: NextFunction) => {
  if (!repos.books.findById(String(req.params.bookId))) return fail(res, 404, "book not found");
  next();
}, upload.single("file"), (req: Request, res: Response, next: NextFunction) => {
  const book = repos.books.findById(String(req.params.bookId));
  const file = (req as Request & { file?: Express.Multer.File }).file;
  if (!file) return fail(res, 400, "file is required (multipart field 'file')");
  if (file.size > BOOK_UPLOAD_LIMIT) {
    removeUncommittedUpload(file.path);
    return fail(res, 413, "uploaded file is too large");
  }
  let storedPath: string | undefined;
  let committed = false;
  try {
    if (!book) return fail(res, 404, "book not found");
    const rawDisplayName =
      typeof req.body?.displayName === "string" && req.body.displayName.trim() !== ""
        ? req.body.displayName
        : file.originalname;
    const displayName = sanitizeUploadFileName(rawDisplayName);
    const parsedRole = bookFileRoleSchema.safeParse(req.body?.role ?? "source_document");
    if (!parsedRole.success) return fail(res, 400, parsedRole.error.message);

    const role = parsedRole.data;
    if (role === READER_TOC_ROLE) {
      return fail(res, 400, "Use /reader-toc/import to create structured TOC files.");
    }
    const relatedFileId =
      typeof req.body?.relatedFileId === "string" && req.body.relatedFileId.trim() !== ""
        ? req.body.relatedFileId.trim()
        : null;

    if (role === "source_document" && !isPdfUpload(displayName, file.mimetype || "", file.path)) {
      return fail(res, 415, "Source documents must be uploaded as PDF files.");
    }

    if (role === "reference_image") {
      if (!matchesStoredRasterSignature(file.mimetype || "", file.path)) {
        return fail(res, 415, "Reference images must be PNG, JPEG, or WebP files.");
      }
      if (!relatedFileId) {
        return fail(res, 400, "Reference images require a relatedFileId.");
      }
      const relatedFile = repos.files.findById(relatedFileId);
      if (!relatedFile || relatedFile.bookId !== book.id) {
        return fail(res, 404, "Related PDF file not found.");
      }
      if (!isPdfBookFile(relatedFile)) {
        return fail(res, 400, "Reference images can only be attached to a PDF source document.");
      }
    }

    const dir = resolve(UPLOAD_ROOT, book.id);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    storedPath = resolve(dir, `${randomUUID()}_${displayName}`);
    renameSync(file.path, storedPath);
    const record = repos.files.create({
      bookId: book.id,
      fileName: displayName,
      filePath: storedPath,
      fileType: file.mimetype || "application/octet-stream",
      fileSize: file.size,
      role,
      relatedFileId: role === "reference_image" ? relatedFileId : null,
      parseStatus: "pending"
    });
    committed = true;
    res.status(201).json({ file: record });
  } catch (error) {
    next(error);
  } finally {
    if (!committed) {
      removeUncommittedUpload(file.path);
      removeUncommittedUpload(storedPath);
    }
  }
}, uploadErrorHandler);

router.get("/api/admin/books/:bookId/files/:fileId/raw", (req, res) => {
  const file = repos.files.findById(req.params.fileId);
  if (!file || file.bookId !== req.params.bookId) return fail(res, 404, "file not found");
  if (file.fileType === "image/svg+xml" || file.fileName.toLowerCase().endsWith(".svg") || file.filePath.toLowerCase().endsWith(".svg")) {
    return fail(res, 404, "file not found");
  }
  if (file.role === "reference_image" && !matchesStoredRasterSignature(file.fileType, file.filePath)) {
    return fail(res, 404, "file not found");
  }
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "sandbox");
  res.sendFile(file.filePath);
});

router.delete("/api/admin/books/:bookId/files/:fileId", (req, res) => {
  const file = repos.files.findById(req.params.fileId);
  if (!file || file.bookId !== req.params.bookId) return fail(res, 404, "file not found");

  try {
    for (const related of repos.files.findByRelatedFileId(file.id)) {
      deleteStoredBookFile(related);
    }
    deleteStoredBookFile(file);
  } catch (err) {
    return fail(res, 500, "delete file failed");
  }

  res.json({ deleted: true });
});

router.post("/api/admin/books/:bookId/files/:fileId/parse-content", async (req, res) => {
  const file = repos.files.findById(req.params.fileId);
  if (!file || file.bookId !== req.params.bookId) return fail(res, 404, "file not found");
  if (file.role !== "source_document" || !isPdfBookFile(file)) {
    return fail(res, 400, "content parsing requires a PDF source document");
  }

  try {
    const result = await replaceParsedContentsForFile(file);
    res.json({ ...result, fileId: file.id });
  } catch (err) {
    repos.files.updateParseStatus(file.id, "failed");
    fail(res, 500, "parse content failed");
  }
});

router.post("/api/admin/books/:bookId/files/:fileId/attach-reference-image", (req, res) => {
  const file = repos.files.findById(req.params.fileId);
  if (!file || file.bookId !== req.params.bookId) return fail(res, 404, "file not found");
  if (!isImageFile(file)) return fail(res, 400, "only image files can be attached as reference images");

  const relatedFileId =
    typeof req.body?.relatedFileId === "string" && req.body.relatedFileId.trim() !== ""
      ? req.body.relatedFileId.trim()
      : "";
  if (!relatedFileId) return fail(res, 400, "relatedFileId is required");

  const relatedFile = repos.files.findById(relatedFileId);
  if (!relatedFile || relatedFile.bookId !== req.params.bookId) {
    return fail(res, 404, "related PDF file not found");
  }
  if (relatedFile.role !== "source_document" || !isPdfBookFile(relatedFile)) {
    return fail(res, 400, "reference images must be attached to a PDF source document");
  }

  const updated = repos.files.updateMetadata(file.id, {
    role: "reference_image",
    relatedFileId: relatedFile.id
  });
  if (!updated) return fail(res, 500, "failed to update file classification");
  res.json({ file: updated });
});

router.post("/api/admin/books/:bookId/files/:fileId/outline-preview", async (req, res) => {
  const file = repos.files.findById(req.params.fileId);
  if (!file || file.bookId !== req.params.bookId) return fail(res, 404, "file not found");
  if (file.role !== "source_document" || !isPdfBookFile(file)) {
    return fail(res, 400, "outline preview requires a PDF source document");
  }

  try {
    const { parsed, pageCount } = await replaceParsedContentsForFile(file);
    const rows = await buildChapterPreviewRowsFromPdfOutline(file.filePath, pageCount);
    res.json({ parsed, pageCount, rows });
  } catch (err) {
    repos.files.updateParseStatus(file.id, "failed");
    fail(res, 500, "outline preview failed");
  }
});

router.post("/api/admin/books/:bookId/files/:fileId/generate-json-index", async (req, res) => {
  const book = repos.books.findById(req.params.bookId);
  if (!book) return fail(res, 404, "book not found");

  const file = repos.files.findById(req.params.fileId);
  if (!file || file.bookId !== book.id) return fail(res, 404, "file not found");
  if (file.role !== "source_document" || !isPdfBookFile(file)) {
    return fail(res, 400, "JSON index generation requires a PDF source document");
  }

  const parsed = generatePdfJsonIndexInputSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, parsed.error.message);

  try {
    const { contents, pageCount } = await parsePdfToContents(file.filePath, book.id, file.id);
    const index = buildPdfJsonIndex({
      bookId: book.id,
      fileId: file.id,
      fileName: file.fileName,
      level: parsed.data.level,
      pageCount,
      contents,
      chapters: repos.chapters.findByBookId(book.id)
    });
    res.json({ index });
  } catch (err) {
    if (err instanceof InvalidPdfPageNumberError) {
      return fail(res, 400, err.message);
    }
    fail(res, 500, "generate json index failed");
  }
});

// Persist a JSON index as a managed json_index file. The request body carries
// only { level, setActive }; the server regenerates the (possibly very large)
// index from the PDF so the request never ships the full item array (no 413).
router.post("/api/admin/books/:bookId/files/:fileId/save-json-index", async (req, res) => {
  const book = repos.books.findById(req.params.bookId);
  if (!book) return fail(res, 404, "book not found");
  const source = repos.files.findById(req.params.fileId);
  if (!source || source.bookId !== book.id) return fail(res, 404, "file not found");
  if (source.role !== "source_document" || !isPdfBookFile(source)) {
    return fail(res, 400, "saving a JSON index requires a PDF source document");
  }

  const parsed = saveJsonIndexInputSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, parsed.error.message);

  let storedPath: string | undefined;
  let committed = false;
  try {
    const { contents, pageCount } = await parsePdfToContents(source.filePath, book.id, source.id);
    const index = buildPdfJsonIndex({
      bookId: book.id,
      fileId: source.id,
      fileName: source.fileName,
      level: parsed.data.level,
      pageCount,
      contents,
      chapters: repos.chapters.findByBookId(book.id)
    });
    const baseName = `${source.fileName.replace(/\.pdf$/i, "")}-${index.level}-index`;
    storedPath = writeJsonIndexArtifact(book.id, baseName, index);
    const record = repos.files.create({
      bookId: book.id,
      fileName: `${baseName}.json`,
      filePath: storedPath,
      fileType: "application/json",
      fileSize: Buffer.byteLength(JSON.stringify(index)),
      role: JSON_INDEX_ROLE,
      relatedFileId: source.id,
      parseStatus: "parsed"
    });
    committed = true;
    if (parsed.data.setActive) setActiveQaReferenceId(book.id, record.id);
    res.status(201).json({ index: summarizeStoredJsonIndex(record, getActiveQaReferenceId(book.id)) });
  } catch (err) {
    if (!committed) removeUncommittedUpload(storedPath);
    if (err instanceof InvalidPdfPageNumberError) {
      return fail(res, 400, err.message);
    }
    fail(res, 500, "save json index failed");
  }
});

// Manually upload a JSON index file (validated against the v1 schema).
router.post("/api/admin/books/:bookId/json-indexes/upload", jsonUpload.single("file"), (req: Request, res: Response) => {
  const book = repos.books.findById(String(req.params.bookId));
  if (!book) return fail(res, 404, "book not found");
  const file = (req as Request & { file?: Express.Multer.File }).file;
  if (!file) return fail(res, 400, "file is required (multipart field 'file')");
  if (file.size > BOOK_UPLOAD_LIMIT) return fail(res, 413, "uploaded file is too large");

  let json: unknown;
  try {
    json = JSON.parse(file.buffer.toString("utf8"));
  } catch {
    return fail(res, 400, "Uploaded file is not valid JSON.");
  }
  const parsed = pdfJsonIndexSchema.safeParse(json);
  if (!parsed.success) {
    return fail(res, 400, `Invalid JSON index (smartbook-pdf-index-v1): ${parsed.error.message}`);
  }
  if (parsed.data.bookId !== book.id) {
    return fail(
      res,
      400,
      `This JSON index belongs to book ${parsed.data.bookId}, not the current book. Upload rejected.`
    );
  }

  let storedPath: string | undefined;
  try {
    const baseName = `${parsed.data.fileName.replace(/\.pdf$/i, "")}-${parsed.data.level}-index`;
    storedPath = writeJsonIndexArtifact(book.id, baseName, parsed.data);
    const record = repos.files.create({
      bookId: book.id,
      fileName: sanitizeUploadFileName(file.originalname) || `${baseName}.json`,
      filePath: storedPath,
      fileType: "application/json",
      fileSize: file.size,
      role: JSON_INDEX_ROLE,
      relatedFileId: null,
      parseStatus: "parsed"
    });
    res.status(201).json({ index: summarizeStoredJsonIndex(record, getActiveQaReferenceId(book.id)) });
  } catch (err) {
    removeUncommittedUpload(storedPath);
    fail(res, 500, "upload json index failed");
  }
}, uploadErrorHandler);

// List stored JSON index artifacts for the book (newest first).
router.get("/api/admin/books/:bookId/json-indexes", (req, res) => {
  const book = repos.books.findById(req.params.bookId);
  if (!book) return fail(res, 404, "book not found");
  const activeId = getActiveQaReferenceId(book.id);
  const indexes = repos.files
    .findByBookId(book.id)
    .filter((f) => f.role === JSON_INDEX_ROLE)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((f) => summarizeStoredJsonIndex(f, activeId));
  res.json({ indexes, activeId: activeId || null });
});

// Set a stored JSON index as the active Knowledge QA reference.
router.post("/api/admin/books/:bookId/json-indexes/:indexFileId/set-active-qa-reference", (req, res) => {
  const book = repos.books.findById(req.params.bookId);
  if (!book) return fail(res, 404, "book not found");
  const file = repos.files.findById(req.params.indexFileId);
  if (!file || file.bookId !== book.id || file.role !== JSON_INDEX_ROLE) {
    return fail(res, 404, "JSON index not found");
  }
  setActiveQaReferenceId(book.id, file.id);
  res.json({ activeId: file.id, index: summarizeStoredJsonIndex(file, file.id) });
});

// Stream a stored JSON index file (View / Download).
router.get("/api/admin/books/:bookId/json-indexes/:indexFileId/raw", (req, res) => {
  const file = repos.files.findById(req.params.indexFileId);
  if (!file || file.bookId !== req.params.bookId || file.role !== JSON_INDEX_ROLE) {
    return fail(res, 404, "JSON index not found");
  }
  res.type("application/json").sendFile(file.filePath);
});

// Delete a stored JSON index artifact (never touches the source PDF).
router.delete("/api/admin/books/:bookId/json-indexes/:indexFileId", (req, res) => {
  const book = repos.books.findById(req.params.bookId);
  if (!book) return fail(res, 404, "book not found");
  const file = repos.files.findById(req.params.indexFileId);
  if (!file || file.bookId !== book.id || file.role !== JSON_INDEX_ROLE) {
    return fail(res, 404, "JSON index not found");
  }
  try {
    deleteStoredBookFile(file);
    // Clearing the active reference falls QA back to content-based behavior.
    if (getActiveQaReferenceId(book.id) === file.id) setActiveQaReferenceId(book.id, null);
    res.json({ deleted: true });
  } catch (err) {
    fail(res, 500, "delete json index failed");
  }
});

router.post("/api/admin/books/:bookId/reader-toc/import", (req, res) => {
  const book = repos.books.findById(req.params.bookId);
  if (!book) return fail(res, 404, "book not found");
  const parsed = readerTocImportPayloadSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, parsed.error.message);

  try {
    const { outline, file } = parseReaderTocImportFromPayload(book.id, parsed.data);
    const path = writeReaderTocArtifact(book.id, file);

    const previous = repos.files.findByBookId(book.id).filter((item) => item.role === READER_TOC_ROLE);
    for (const candidate of previous) {
      deleteStoredBookFile(candidate);
    }

    const record = repos.files.create({
      bookId: book.id,
      fileName: `${file.source}-${Date.now()}.json`,
      filePath: path,
      fileType: "application/json",
      fileSize: Buffer.byteLength(JSON.stringify(file), "utf8"),
      role: READER_TOC_ROLE,
      relatedFileId: null,
      parseStatus: "parsed"
    });

    res.status(201).json({
      source: "manual_toc",
      file: {
        fileId: record.id,
        fileName: record.fileName,
        createdAt: record.createdAt,
        itemCount: summarizeReaderToc(outline).itemCount
      },
      outline
    });
  } catch (err) {
    fail(res, 400, "import manual TOC failed");
  }
});

router.get("/api/admin/books/:bookId/reader-toc", (req, res) => {
  const book = repos.books.findById(req.params.bookId);
  if (!book) return fail(res, 404, "book not found");

  const latest = findLatestReaderTocFile(book.id);
  if (!latest.file || !latest.outline) {
    return res.json({ source: "manual_toc", file: null, outline: [] as ReaderOutlineNode[] });
  }

  res.json({
    source: "manual_toc",
    file: {
      fileId: latest.file.id,
      fileName: latest.file.fileName,
      createdAt: latest.file.createdAt,
      itemCount: summarizeReaderToc(latest.outline).itemCount
    },
    outline: latest.outline
  });
});

router.delete("/api/admin/books/:bookId/reader-toc", (req, res) => {
  const book = repos.books.findById(req.params.bookId);
  if (!book) return fail(res, 404, "book not found");

  const files = repos.files.findByBookId(book.id).filter((file) => file.role === READER_TOC_ROLE);
  if (files.length === 0) {
    return res.json({ deleted: 0 });
  }

  for (const file of files) {
    deleteStoredBookFile(file);
  }

  res.json({ deleted: files.length });
});

// Generate a compact reader TOC from an already-stored JSON index file. The
// large index never travels through the request body — only its file id + page
// range — so this avoids the 413 that pasting a full sentence index causes.
router.post("/api/admin/books/:bookId/reader-toc/generate-from-json-index", (req, res) => {
  const book = repos.books.findById(req.params.bookId);
  if (!book) return fail(res, 404, "book not found");

  const parsed = generateReaderTocFromIndexInputSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, parsed.error.message);

  const indexFile = repos.files.findById(parsed.data.jsonIndexFileId);
  if (!indexFile || indexFile.bookId !== book.id) return fail(res, 404, "JSON index not found");
  if (indexFile.role !== JSON_INDEX_ROLE) {
    return fail(res, 400, "Selected file is not a json_index file");
  }
  const index = readStoredJsonIndex(indexFile);
  if (!index) return fail(res, 400, "Stored JSON index is not a valid smartbook-pdf-index-v1 file");

  try {
    const { outline, lines, warnings } = buildReaderTocFromIndexItems(
      index.items,
      parsed.data.pageStart,
      parsed.data.pageEnd
    );
    if (outline.length === 0) {
      return fail(
        res,
        400,
        warnings[0] ?? "No chapter/section headings were found in the selected page range."
      );
    }

    const file = {
      schemaVersion: READER_TOC_SCHEMA_VERSION,
      bookId: book.id,
      source: READER_TOC_SOURCE,
      items: toReaderTocInputNodes(outline)
    };
    const path = writeReaderTocArtifact(book.id, file);

    // Replace any previous manual TOC so the latest one is the active source.
    for (const candidate of repos.files.findByBookId(book.id).filter((f) => f.role === READER_TOC_ROLE)) {
      deleteStoredBookFile(candidate);
    }
    const record = repos.files.create({
      bookId: book.id,
      fileName: `${READER_TOC_SOURCE}-${Date.now()}.json`,
      filePath: path,
      fileType: "application/json",
      fileSize: Buffer.byteLength(JSON.stringify(file), "utf8"),
      role: READER_TOC_ROLE,
      relatedFileId: indexFile.id,
      parseStatus: "parsed"
    });

    res.status(201).json({
      source: "manual_toc",
      file: {
        fileId: record.id,
        fileName: record.fileName,
        createdAt: record.createdAt,
        itemCount: summarizeReaderToc(outline).itemCount
      },
      outline,
      textPreview: lines.slice(0, 40).join("\n"),
      warnings
    });
  } catch (err) {
    fail(res, 500, "generate reader TOC failed");
  }
});

router.post("/api/admin/books/:bookId/files/:fileId/apply-chapters", async (req, res) => {
  const book = repos.books.findById(req.params.bookId);
  if (!book) return fail(res, 404, "book not found");

  const file = repos.files.findById(req.params.fileId);
  if (!file || file.bookId !== book.id) return fail(res, 404, "file not found");
  if (file.role !== "source_document" || !isPdfBookFile(file)) {
    return fail(res, 400, "chapter apply requires a PDF source document");
  }

  const parsed = applyChapterPreviewInputSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, parsed.error.message);

  try {
    const normalizedRows = normalizePreviewRowsForApply(parsed.data.rows);
    const readyRows = normalizedRows
      .filter((row) => row.applyStatus === "ready")
      .sort((a, b) => a.sortOrder - b.sortOrder);

    const hasFileContents = repos.contents.findByBookId(book.id).some((content) => content.fileId === file.id);
    if (!hasFileContents) {
      await replaceParsedContentsForFile(file);
    }

    repos.contents.unlinkChaptersByBookId(book.id);
    repos.chapters.deleteByBookId(book.id);

    repos.chapters.createMany(
      readyRows.map((row, index) => ({
        bookId: book.id,
        title: row.suggestedTitle,
        summary: row.adminNote ?? null,
        orderIndex: index,
        pageStart: row.pageStart,
        pageEnd: row.pageEnd,
        level: row.outlineLevel ?? 0,
        source: row.originalTitle ? "pdf_outline" : "manual",
        status: "draft"
      }))
    );

    const linked = linkChaptersByPageRange(ctx, book.id);
    res.json({
      applied: readyRows.length,
      skipped: normalizedRows.length - readyRows.length,
      linked,
      chapters: enrichChapters(book.id)
    });
  } catch (err) {
    fail(res, 500, "apply chapters failed");
  }
});

router.get("/api/admin/books/:bookId/contents", (req, res) => {
  res.json({ contents: repos.contents.findByBookId(req.params.bookId) });
});

router.delete("/api/admin/books/:bookId/contents", (req, res) => {
  const book = repos.books.findById(req.params.bookId);
  if (!book) return fail(res, 404, "book not found");

  repos.contents.deleteByBookId(book.id);
  repos.files.resetParseStatusByBookId(book.id, "pending");

  res.json({ cleared: true });
});

// ---- Chapters -------------------------------------------------------------
/** Compute a chapter's content-link status from the book's parsed contents. */
function enrichChapters(bookId: string) {
  const chapters = repos.chapters.findByBookId(bookId);
  const contents = repos.contents.findByBookId(bookId);
  const bookHasContent = contents.length > 0;
  return chapters.map((c) => {
    const linkedContentCount = contents.filter((ct) => ct.chapterId === c.id).length;
    let contentLinkStatus: string;
    if (!bookHasContent) {
      contentLinkStatus = "missing_content";
    } else if (c.pageStart != null && c.pageEnd != null && c.pageEnd < c.pageStart) {
      contentLinkStatus = "page_range_invalid";
    } else if (linkedContentCount > 0) {
      contentLinkStatus = "linked";
    } else {
      contentLinkStatus = "unlinked";
    }
    return { ...c, contentLinkStatus, linkedContentCount };
  });
}

router.get("/api/admin/books/:bookId/chapters", (req, res) => {
  res.json({ chapters: enrichChapters(req.params.bookId) });
});

router.post("/api/admin/books/:bookId/chapters", (req, res) => {
  const parsed = createChapterInputSchema.safeParse({
    ...req.body,
    bookId: req.params.bookId
  });
  if (!parsed.success) return fail(res, 400, parsed.error.message);
  res.status(201).json({ chapter: repos.chapters.create(parsed.data) });
});

router.patch("/api/admin/books/:bookId/chapters/:chapterId", (req, res) => {
  const parsed = updateChapterInputSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, parsed.error.message);
  const chapter = repos.chapters.update(req.params.chapterId, parsed.data);
  if (!chapter) return fail(res, 404, "chapter not found");
  res.json({ chapter });
});

router.delete("/api/admin/books/:bookId/chapters/:chapterId", (req, res) => {
  const chapter = repos.chapters.findById(req.params.chapterId);
  if (!chapter || chapter.bookId !== req.params.bookId) return fail(res, 404, "chapter not found");
  // Detach any content linked to this chapter, then remove it.
  for (const c of repos.contents.findByChapterId(chapter.id)) {
    repos.contents.linkChapter(c.id, null);
  }
  repos.chapters.deleteById(chapter.id);
  res.json({ deleted: true });
});

// Idempotent rebuild: clear existing chapters + links, rebuild from outline
// (or content fallback), then link content by page range.
router.post("/api/admin/books/:bookId/chapters/build", async (req, res) => {
  const book = repos.books.findById(req.params.bookId);
  if (!book) return fail(res, 404, "book not found");
  try {
    repos.contents.unlinkChaptersByBookId(book.id);
    repos.chapters.deleteByBookId(book.id);
    const fromOutline = await buildChaptersFromPdfOutline(ctx, book.id);
    if (fromOutline.length === 0) await buildChaptersFromContents(ctx, book.id);
    linkChaptersByPageRange(ctx, book.id);
    res.json({ chapters: enrichChapters(book.id) });
  } catch (err) {
    fail(res, 500, "build chapters failed");
  }
});

// Re-link parsed content to chapters by page range (idempotent).
router.post("/api/admin/books/:bookId/chapters/link-content", (req, res) => {
  const book = repos.books.findById(req.params.bookId);
  if (!book) return fail(res, 404, "book not found");
  const linked = linkChaptersByPageRange(ctx, book.id);
  res.json({ linked, chapters: enrichChapters(book.id) });
});

// ---- AI modules -----------------------------------------------------------
router.post("/api/admin/books/:bookId/ai/split-book", async (req, res) => {
  const book = repos.books.findById(req.params.bookId);
  if (!book) return fail(res, 404, "book not found");
  try {
    const { job, result } = await runJob(book.id, "split_book", req.body, () =>
      splitBookIntoChapters(ctx, book.id)
    );
    res.json({ job, chapters: result });
  } catch (err) {
    fail(res, 500, "AI split-book service unavailable");
  }
});

router.post("/api/admin/books/:bookId/ai/build-chapters", async (req, res) => {
  const book = repos.books.findById(req.params.bookId);
  if (!book) return fail(res, 404, "book not found");
  try {
    const { job, result } = await runJob(book.id, "build_chapters", req.body, async () => {
      // Idempotent regeneration: clear existing chapters (and their content
      // links) first so pressing "一鍵生成" twice never stacks duplicates.
      repos.contents.unlinkChaptersByBookId(book.id);
      repos.chapters.deleteByBookId(book.id);

      // Prefer the PDF's built-in outline / bookmarks when available.
      const fromOutline = await buildChaptersFromPdfOutline(ctx, book.id);
      const built = fromOutline.length > 0 ? fromOutline : await buildChaptersFromContents(ctx, book.id);
      // Re-link content by page range so chapters report an accurate status.
      linkChaptersByPageRange(ctx, book.id);
      return built;
    });
    res.json({ job, chapters: result });
  } catch (err) {
    fail(res, 500, "AI build-chapters service unavailable");
  }
});

router.post("/api/admin/books/:bookId/chapters/:chapterId/ai/summarize", async (req, res) => {
  const book = repos.books.findById(req.params.bookId);
  if (!book) return fail(res, 404, "book not found");
  try {
    const { job, result } = await runJob(
      book.id,
      "summarize_chapter",
      { chapterId: req.params.chapterId },
      () => summarizeChapter(ctx, book.id, req.params.chapterId)
    );
    res.json({ job, chapter: result });
  } catch (err) {
    fail(res, 500, "AI summarize service unavailable");
  }
});

router.post("/api/admin/books/:bookId/qa", async (req, res) => {
  const book = repos.books.findById(req.params.bookId);
  if (!book) return fail(res, 404, "book not found");
  const parsed = chatRequestSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, parsed.error.message);
  try {
    const { result } = await runJob(book.id, "book_qa", { question: parsed.data.question }, () =>
      askBookQuestion(ctx, book.id, parsed.data.question)
    );
    res.json({ answer: result.answer, context: result.contextChunks, log: result.log });
  } catch (err) {
    fail(res, 500, "AI QA service unavailable");
  }
});

router.post("/api/admin/books/:bookId/qa/import-markdown", (req, res) => {
  const book = repos.books.findById(req.params.bookId);
  if (!book) return fail(res, 404, "book not found");

  const markdown = typeof req.body?.markdown === "string" ? req.body.markdown : "";
  if (!markdown.trim()) return fail(res, 400, "markdown is required");

  const items = parseManualQaMarkdown(markdown);
  if (items.length === 0) {
    return fail(
      res,
      400,
      "no Q/A pairs found; use lines like 'Q: ...' and 'A: ...' in the markdown file"
    );
  }

  const created = repos.qaLogs.createMany(
    items.map((item) => ({
      bookId: book.id,
      question: item.question,
      answer: item.answer,
      contextJson: null,
      provider: "manual",
      model: "markdown"
    }))
  );

  res.status(201).json({ imported: created.length, logs: created });
});

router.get("/api/admin/books/:bookId/ai-jobs", (req, res) => {
  res.json({ jobs: repos.aiJobs.findByBookId(req.params.bookId) });
});

router.get("/api/admin/books/:bookId/qa-logs", (req, res) => {
  res.json({ logs: repos.qaLogs.findByBookId(req.params.bookId) });
});

  return router;
}
