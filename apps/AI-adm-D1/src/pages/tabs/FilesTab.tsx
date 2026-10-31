import { useEffect, useMemo, useRef, useState } from "react";
import type {
  BookFile,
  ChapterPreviewApplyStatus,
  ChapterPreviewEntryType,
  ChapterPreviewRow,
  ReaderOutlineNode,
  PdfJsonIndex,
  PdfJsonIndexLevel,
  StoredJsonIndexSummary
} from "@ai-smartbook/schema";
import {
  adminApi,
  type GenerateReaderTocResponse,
  type ReaderTocImportPayload,
  type ReaderTocResponse
} from "../../api";
import { useConfirm } from "../../components/useConfirm";

const ENTRY_TYPE_OPTIONS: ChapterPreviewEntryType[] = [
  "front_matter",
  "toc",
  "chapter",
  "appendix",
  "copyright",
  "back_matter",
  "group",
  "unknown"
];

const JSON_INDEX_LEVEL_OPTIONS: Array<{ value: PdfJsonIndexLevel; label: string }> = [
  { value: "page", label: "簡單：分頁數" },
  { value: "chapter", label: "進階：分章節" },
  { value: "clause", label: "複雜：分逗號" },
  { value: "line", label: "高階：分行" },
  { value: "sentence", label: "頂級：分句" }
];

type ReaderTocNode = ReaderOutlineNode;

function safeTrim(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function parsePage(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.trunc(raw);
  if (typeof raw === "string") {
    const match = raw.match(/\d+/);
    if (!match) return null;
    const parsed = Number.parseInt(match[0], 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function stripPageLabel(rawTitle: string): { title: string; page: number | null } {
  const trimmed = rawTitle.trim();
  const prefixed = trimmed.match(/^\[\s*p\.?\s*(\d+)\s*\]\s*(.+)$/i);
  if (prefixed) return { title: prefixed[2].trim(), page: parseInt(prefixed[1], 10) };

  const suffixed = trimmed.match(/^(.*?)\s+(?:\[?\s*)?p\.?\s*(\d+)\s*(?:\]|\))?\s*$/i);
  if (suffixed) return { title: suffixed[1].trim(), page: parseInt(suffixed[2], 10) };

  return { title: trimmed, page: null };
}

function parseReaderTocMarkdown(content: string): ReaderTocNode[] {
  const lines = content.replace(/\r/g, "").split("\n");
  const roots: ReaderTocNode[] = [];
  const stack: Array<{ level: number; node: ReaderTocNode }> = [];

  function addNode(level: number, title: string, page: number | null): ReaderTocNode {
    const node: ReaderTocNode = {
      id: `preview-${Math.random().toString(36).slice(2, 8)}-${Date.now()}`,
      title,
      level: Math.max(1, level),
      page,
      pdfPage: page,
      displayPage: page != null ? String(page) : null,
      children: [],
      source: "manual_toc"
    };

    while (stack.length > 0 && stack[stack.length - 1].level >= level) {
      stack.pop();
    }

    if (stack.length === 0) {
      roots.push(node);
    } else {
      stack[stack.length - 1].node.children.push(node);
    }

    stack.push({ level: node.level, node });
    return node;
  }

  for (const rawLine of lines) {
    const headingMatch = rawLine.match(/^(#{1,2})\s+(.*)$/);
    if (headingMatch) {
      const heading = stripPageLabel(headingMatch[2]);
      if (heading.title) {
        addNode(headingMatch[1].length, heading.title, heading.page);
      }
      continue;
    }

    const bulletMatch = rawLine.match(/^(\s*)[-*+]\s+(.*)$/);
    if (!bulletMatch) continue;

    const parsed = stripPageLabel(bulletMatch[2]);
    if (!parsed.title) continue;

    // Bullet depth comes only from leading indentation, never from the current
    // stack top — otherwise flat sibling bullets cascade into deeper levels.
    const indent = Math.floor(bulletMatch[1].replace(/\t/g, "    ").length / 2);
    const level = 2 + indent;
    addNode(level, parsed.title, parsed.page);
  }

  return roots;
}

function toReaderTocNode(raw: unknown): ReaderTocNode | null {
  if (!raw || typeof raw !== "object") return null;
  const title = safeTrim((raw as { title?: unknown }).title);
  if (!title) return null;

  const childrenRaw = ((raw as { children?: unknown }).children ?? (raw as { items?: unknown }).items) as unknown;
  const normalizedChildren = Array.isArray(childrenRaw)
    ? childrenRaw.map(toReaderTocNode).filter((x): x is ReaderTocNode => x != null)
    : [];

  const rawLevel = (raw as { level?: unknown }).level;
  const level =
    typeof rawLevel === "number" && Number.isInteger(rawLevel) && rawLevel > 0
      ? rawLevel
      : Math.max(1, normalizedChildren.length > 0 ? 1 : 1);

  return {
    id: safeTrim((raw as { id?: unknown }).id) || `preview-${Math.random().toString(36).slice(2, 8)}-${Date.now()}`,
    title,
    level: Math.max(1, level),
    page: parsePage((raw as { page?: unknown }).page ?? (raw as { pdfPage?: unknown }).pdfPage),
    pdfPage: parsePage((raw as { page?: unknown }).page ?? (raw as { pdfPage?: unknown }).pdfPage),
    displayPage: safeTrim((raw as { displayPage?: unknown }).displayPage) || null,
    children: normalizedChildren,
    source: "manual_toc"
  };
}

function parseReaderTocJson(content: string): ReaderTocNode[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("JSON parse failed");
  }

  const asRecord = (parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null) ?? null;
  const items = asRecord != null && asRecord.schemaVersion === "smartbook-reader-toc-v1" && Array.isArray((asRecord as { items?: unknown }).items)
    ? (asRecord as { items?: unknown[] }).items
    : Array.isArray(parsed)
      ? parsed
      : [];

  if (!Array.isArray(items) || items.length === 0) {
    return [];
  }

  return items
    .map(toReaderTocNode)
    .filter((item): item is ReaderTocNode => item != null);
}

function parseReaderTocForPreview(format: ReaderTocFormat, content: string): ReaderTocNode[] {
  if (format === "markdown") {
    return parseReaderTocMarkdown(content);
  }

  return parseReaderTocJson(content);
}

function renderPreview(nodes: ReaderTocNode[], depth = 0): string[] {
  const lines: string[] = [];
  for (const node of nodes) {
    const prefix = "  ".repeat(depth);
    const pageLabel = node.page != null ? ` [p.${node.page}]` : "";
    lines.push(`${prefix}${"  ".repeat(Math.max(node.level - 1, 0))}${node.title}${pageLabel}`);
    if (node.children.length > 0) {
      lines.push(...renderPreview(node.children, depth + 1));
    }
  }
  return lines;
}

type ReaderTocFormat = ReaderTocImportPayload["format"];

type FileRowKind = "pdf_source" | "reference_image" | "misclassified_image" | "unsupported_source";

function isPdfFile(file: Pick<BookFile, "fileName" | "fileType">): boolean {
  return file.fileType === "application/pdf" || file.fileName.toLowerCase().endsWith(".pdf");
}

function isImageFile(file: Pick<BookFile, "fileName" | "fileType">): boolean {
  return /^image\//.test(file.fileType) || /\.(png|jpe?g|webp|gif|bmp|svg)$/i.test(file.fileName);
}

function getFileRowKind(file: BookFile): FileRowKind {
  if (file.role === "reference_image") return "reference_image";
  if (isPdfFile(file)) return "pdf_source";
  if (isImageFile(file)) return "misclassified_image";
  return "unsupported_source";
}

function getApplyStatus(row: ChapterPreviewRow): ChapterPreviewApplyStatus {
  if (!row.enabled) return "disabled";
  if (row.pageStart == null || row.pageEnd == null) return "missing_page";
  if (row.pageEnd < row.pageStart) return "invalid_range";
  return "ready";
}

function withApplyStatus(row: ChapterPreviewRow): ChapterPreviewRow {
  return { ...row, applyStatus: getApplyStatus(row) };
}

function parseNullableInt(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export function FilesTab({ bookId }: { bookId: string }) {
  const [files, setFiles] = useState<BookFile[]>([]);
  const [readerToc, setReaderToc] = useState<ReaderTocResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  const [readerTocFormat, setReaderTocFormat] = useState<ReaderTocFormat>("markdown");
  const [readerTocContent, setReaderTocContent] = useState("");
  const [readerTocPreview, setReaderTocPreview] = useState<ReaderTocNode[]>([]);
  const [readerTocPreviewError, setReaderTocPreviewError] = useState("");
  const [previewRows, setPreviewRows] = useState<ChapterPreviewRow[]>([]);
  const [previewFileId, setPreviewFileId] = useState<string | null>(null);
  const [previewPageCount, setPreviewPageCount] = useState(0);
  const [jsonLevels, setJsonLevels] = useState<Record<string, PdfJsonIndexLevel>>({});
  const [generatedIndex, setGeneratedIndex] = useState<PdfJsonIndex | null>(null);
  const [jsonIndexes, setJsonIndexes] = useState<StoredJsonIndexSummary[]>([]);
  const [tocPageStart, setTocPageStart] = useState("3");
  const [tocPageEnd, setTocPageEnd] = useState("6");
  const [genTocResult, setGenTocResult] = useState<GenerateReaderTocResponse | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const jsonUploadRef = useRef<HTMLInputElement>(null);
  const previewSectionRef = useRef<HTMLDivElement>(null);
  const jsonResultRef = useRef<HTMLDivElement>(null);
  const readerTocSectionRef = useRef<HTMLDivElement>(null);
  const confirmAction = useConfirm();

  async function reload() {
    const [data, idx, toc] = await Promise.all([
      adminApi.getBook(bookId),
      adminApi.listJsonIndexes(bookId),
      adminApi.getReaderToc(bookId)
    ]);
    setFiles(data.files);
    setJsonIndexes(idx.indexes);
    setReaderToc(toc);
  }

  useEffect(() => {
    void reload().catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [bookId]);

  const previewFile = previewFileId ? files.find((file) => file.id === previewFileId) ?? null : null;
  // The main table lists PDF sources / reference images; stored JSON indexes are
  // managed in their own "JSON Index / QA Reference" section below.
  const documentFiles = files.filter((file) => file.role !== "json_index" && file.role !== "reader_toc");
  const generatedJsonText = useMemo(
    () => (generatedIndex ? JSON.stringify(generatedIndex, null, 2) : ""),
    [generatedIndex]
  );
  const readerTocPreviewText = useMemo(() => renderPreview(readerTocPreview).join("\n"), [readerTocPreview]);
  // Detect a full sentence JSON Index accidentally pasted into the manual TOC box.
  const looksLikeSentenceIndex = useMemo(() => {
    const c = readerTocContent;
    if (!c) return false;
    return (
      c.includes("smartbook-pdf-index-v1") &&
      (/"level"\s*:\s*"sentence"/.test(c) || c.length > 200000)
    );
  }, [readerTocContent]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    setMsg("");
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onUploadPdf() {
    const file = inputRef.current?.files?.[0];
    if (!file) return;
    if (!(file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf"))) {
      setError("Upload PDF accepts PDF files only.");
      setMsg("");
      return;
    }
    await run(async () => {
      await adminApi.uploadFile(bookId, file, { role: "source_document" });
      setMsg(`Uploaded PDF: ${file.name}`);
      if (inputRef.current) inputRef.current.value = "";
      await reload();
    });
  }

  async function onParseContent(fileId: string) {
    await run(async () => {
      const result = await adminApi.parseContent(bookId, fileId);
      setMsg(`Parsed ${result.parsed} content blocks from ${result.pageCount} PDF pages.`);
      await reload();
    });
  }

  async function onParseOutline(fileId: string) {
    await run(async () => {
      const result = await adminApi.parseOutlinePreview(bookId, fileId);
      setPreviewFileId(fileId);
      setPreviewPageCount(result.pageCount);
      setPreviewRows(result.rows.map(withApplyStatus));
      setMsg(
        result.rows.length > 0
          ? `Loaded outline preview with ${result.rows.length} rows from ${result.pageCount} PDF pages.`
          : "No embedded PDF outline was found. You can add rows manually before Apply."
      );
      await reload();
      setTimeout(() => {
        previewSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 0);
    });
  }

  async function onGenerateJsonIndex(fileId: string) {
    const level = jsonLevels[fileId] ?? "page";
    await run(async () => {
      const result = await adminApi.generateJsonIndex(bookId, fileId, level);
      setGeneratedIndex(result.index);
      setMsg(
        `Generated ${result.index.level} JSON index with ${result.index.itemCount} items from ${result.index.pageCount} PDF pages.`
      );
      setTimeout(() => {
        jsonResultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 0);
    });
  }

  async function onDelete(fileId: string, fileName: string) {
    const confirmed = await confirmAction({
      title: "Delete file",
      message: `Delete file "${fileName}"?`,
      tone: "danger"
    });
    if (!confirmed) return;

    await run(async () => {
      await adminApi.deleteFile(bookId, fileId);
      setMsg(`Deleted file: ${fileName}`);
      if (previewFileId === fileId) {
        setPreviewFileId(null);
        setPreviewRows([]);
        setPreviewPageCount(0);
      }
      if (generatedIndex?.fileId === fileId) {
        setGeneratedIndex(null);
      }
      await reload();
    });
  }

  function onViewJsonResult(fileId: string) {
    if (generatedIndex?.fileId !== fileId) return;
    jsonResultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function onViewImageFile(fileId: string) {
    window.open(adminApi.getBookFileUrl(bookId, fileId), "_blank", "noopener,noreferrer");
  }

  function onDownloadJsonResult(fileId: string) {
    if (generatedIndex?.fileId !== fileId) return;
    const blob = new Blob([JSON.stringify(generatedIndex, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${generatedIndex.fileName.replace(/\.pdf$/i, "")}-${generatedIndex.level}-index.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  function onPreviewReaderToc() {
    setReaderTocPreviewError("");
    try {
      const parsed = parseReaderTocForPreview(readerTocFormat, readerTocContent);
      if (parsed.length === 0) {
        setReaderTocPreviewError("No valid TOC items found in content.");
        setReaderTocPreview([]);
        return;
      }
      setReaderTocPreview(parsed);
      setTimeout(() => {
        readerTocSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 0);
    } catch (e) {
      setReaderTocPreview([]);
      setReaderTocPreviewError(e instanceof Error ? e.message : "Failed to parse reader TOC content.");
    }
  }

  async function onImportReaderToc() {
    await run(async () => {
      const payload: ReaderTocImportPayload = {
        format: readerTocFormat,
        content: readerTocContent
      };
      const result = await adminApi.importReaderToc(bookId, payload);
      setReaderToc(result);
      setReaderTocPreview(result.outline);
      setMsg(`Imported reader TOC: ${result.file?.fileName ?? "manual_toc.json"}`);
      await reload();
      setTimeout(() => {
        readerTocSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 0);
    });
  }

  async function onDeleteReaderToc() {
    if (!readerToc?.file) {
      setMsg("No active reader TOC to delete.");
      return;
    }
    const confirmed = await confirmAction({
      title: "Delete reader TOC",
      message: `Delete active reader TOC "${readerToc.file.fileName}"?`,
      tone: "danger"
    });
    if (!confirmed) return;

    await run(async () => {
      const result = await adminApi.deleteReaderToc(bookId);
      setMsg(`Deleted reader TOC records: ${result.deleted}`);
      setReaderToc(null);
      setReaderTocPreview([]);
      await reload();
    });
  }

  // ---- JSON index / QA reference management --------------------------------
  async function onSaveAsQaReference() {
    if (!generatedIndex) return;
    // Send only the level/source metadata; the server regenerates and stores the
    // index so a large item array is never uploaded (avoids 413 Payload Too Large).
    const { fileId, level } = generatedIndex;
    await run(async () => {
      const result = await adminApi.saveJsonIndex(bookId, fileId, level, true);
      setMsg(`Saved JSON index as active QA reference: ${result.index.fileName}`);
      await reload();
    });
  }

  async function onUploadJsonIndex() {
    const file = jsonUploadRef.current?.files?.[0];
    if (!file) return;
    await run(async () => {
      const result = await adminApi.uploadJsonIndex(bookId, file);
      setMsg(`Uploaded JSON index: ${result.index.fileName}`);
      if (jsonUploadRef.current) jsonUploadRef.current.value = "";
      await reload();
    });
  }

  async function onSetActiveJsonIndex(indexFileId: string) {
    await run(async () => {
      await adminApi.setActiveQaReference(bookId, indexFileId);
      setMsg("Active QA reference updated.");
      await reload();
    });
  }

  async function onGenerateReaderTocFromIndex(indexFileId: string) {
    const ps = Number.parseInt(tocPageStart, 10);
    const pe = Number.parseInt(tocPageEnd, 10);
    if (!Number.isFinite(ps) || !Number.isFinite(pe) || ps < 1 || pe < 1) {
      setError("Enter a valid TOC page start and end (>= 1).");
      setMsg("");
      return;
    }
    await run(async () => {
      const result = await adminApi.generateReaderTocFromJsonIndex(bookId, indexFileId, ps, pe);
      setGenTocResult(result);
      // Reuse the manual TOC preview tree to show the generated hierarchy.
      setReaderTocPreview(result.outline);
      setReaderTocPreviewError("");
      const warn = result.warnings.length ? ` ⚠ ${result.warnings.join("; ")}` : "";
      setMsg(`Generated Reader TOC: ${result.file?.itemCount ?? 0} items (active).${warn}`);
      await reload();
    });
  }

  function onViewJsonIndex(indexFileId: string) {
    window.open(adminApi.getJsonIndexRawUrl(bookId, indexFileId), "_blank", "noopener,noreferrer");
  }

  function onDownloadJsonIndex(indexFileId: string, fileName: string) {
    const link = document.createElement("a");
    link.href = adminApi.getJsonIndexRawUrl(bookId, indexFileId);
    link.download = fileName;
    link.click();
  }

  async function onDeleteJsonIndex(indexFileId: string, fileName: string) {
    const confirmed = await confirmAction({
      title: "Delete JSON index",
      message: `Delete JSON index "${fileName}"? The source PDF is not affected.`,
      tone: "danger"
    });
    if (!confirmed) return;
    await run(async () => {
      await adminApi.deleteJsonIndex(bookId, indexFileId);
      setMsg(`Deleted JSON index: ${fileName}`);
      await reload();
    });
  }

  function updateRow(index: number, next: ChapterPreviewRow) {
    setPreviewRows((current) =>
      current.map((row, rowIndex) => (rowIndex === index ? withApplyStatus(next) : row))
    );
  }

  function onAddRow() {
    setPreviewRows((current) => [
      ...current,
      withApplyStatus({
        id: `manual-${Date.now()}`,
        outlineLevel: 0,
        enabled: false,
        originalTitle: "",
        referenceTitle: null,
        suggestedTitle: "",
        printedPageLabel: null,
        printedPageStart: null,
        printedPageEnd: null,
        pageStart: null,
        pageEnd: null,
        entryType: "chapter",
        sortOrder: current.length + 1,
        adminNote: null
      })
    ]);
  }

  function onRemoveRow(index: number) {
    setPreviewRows((current) =>
      current
        .filter((_, rowIndex) => rowIndex !== index)
        .map((row, rowIndex) => withApplyStatus({ ...row, sortOrder: rowIndex + 1 }))
    );
  }

  async function onApplyChapters() {
    if (!previewFileId) return;

    await run(async () => {
      const result = await adminApi.applyChapterPreview(bookId, previewFileId, previewRows);
      setMsg(
        `Applied ${result.applied} chapter rows, skipped ${result.skipped}, and linked ${result.linked} content blocks.`
      );
      await reload();
    });
  }

  function statusText(status: ChapterPreviewApplyStatus | undefined): string {
    switch (status) {
      case "ready":
        return "Ready";
      case "disabled":
        return "Disabled";
      case "missing_page":
        return "Missing page";
      case "invalid_range":
        return "Invalid range";
      default:
        return "Pending";
    }
  }

  return (
    <div>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Upload PDF</h3>
        <div className="row">
          <input ref={inputRef} type="file" accept="application/pdf" style={{ maxWidth: 360 }} />
          <button className="btn" onClick={() => void onUploadPdf()} disabled={busy}>
            Upload
          </button>
        </div>
        {msg && <p className="muted">{msg}</p>}
        {error && <p className="error">{error}</p>}
      </div>

      <div className="card" ref={readerTocSectionRef}>
        <div className="row between" style={{ alignItems: "flex-start" }}>
          <div>
            <h3 style={{ marginTop: 0, marginBottom: 6 }}>Manual Reader TOC</h3>
            <p className="muted" style={{ margin: 0 }}>
              Import structured chapter/section hierarchy used by the student reader.
            </p>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <select
              value={readerTocFormat}
              onChange={(e) => setReaderTocFormat(e.target.value as ReaderTocFormat)}
              disabled={busy}
            >
              <option value="markdown">Markdown</option>
              <option value="json">JSON</option>
            </select>
            <button className="btn secondary" onClick={() => onPreviewReaderToc()} disabled={busy}>
              Preview
            </button>
            <button className="btn" onClick={() => void onImportReaderToc()} disabled={busy || !readerTocContent.trim()}>
              Import / Replace
            </button>
            <button className="btn secondary" onClick={() => void onDeleteReaderToc()} disabled={busy || !readerToc?.file}>
              Delete TOC
            </button>
          </div>
        </div>

        <div className="row" style={{ marginTop: 10, gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <span className="muted" style={{ margin: 0 }}>
            Active TOC:
          </span>
          <strong style={{ color: readerToc?.file ? undefined : "#64748b" }}>
            {readerToc?.file?.fileName ?? "none"}
          </strong>
          {readerToc?.file ? <span className="muted">Items: {readerToc.file.itemCount}</span> : null}
          {readerToc?.file ? <span className="muted">Updated: {readerToc.file.createdAt}</span> : null}
        </div>

        <textarea
          style={{ width: "100%", minHeight: 220, marginTop: 10, resize: "vertical" }}
          value={readerTocContent}
          onChange={(e) => setReaderTocContent(e.target.value)}
          placeholder="# 第零章 緒論 p.1\n- 一、國際會計準則 p.2\n- 二、我國財務會計準則 p.3\n- 三、修正商業會計法 p.4"
        />

        {looksLikeSentenceIndex ? (
          <p className="error" style={{ marginTop: 8 }}>
            This is a sentence JSON Index, not a Reader TOC. Use “Generate Reader TOC from JSON
            Index” instead.
          </p>
        ) : null}

        {readerTocPreviewError ? <p className="error">{readerTocPreviewError}</p> : null}

        {readerTocContent.trim() || readerTocPreview.length > 0 ? (
          <div className="admin-json-panel" style={{ marginTop: 12 }}>
            <details open>
              <summary>Preview parsed tree</summary>
              <pre className="files-json-preview" style={{ marginTop: 8 }}>
                {readerTocPreviewText || "(empty)"}
              </pre>
            </details>
          </div>
        ) : null}
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Files</h3>
        {documentFiles.length === 0 ? (
          <p className="muted">No files uploaded yet.</p>
        ) : (
          <div className="admin-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Role</th>
                  <th>Related PDF</th>
                  <th>Size</th>
                  <th>Parse status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {documentFiles.map((file) => {
                  const rowKind = getFileRowKind(file);
                  const relatedPdf =
                    file.relatedFileId != null
                      ? files.find((candidate) => candidate.id === file.relatedFileId) ?? null
                      : null;
                  const isPdfRow = rowKind === "pdf_source";
                  const isReferenceImageRow = rowKind === "reference_image";
                  const isMisclassifiedImageRow = rowKind === "misclassified_image";
                  const contentActionLabel = file.parseStatus === "parsed" ? "Re-parse Content" : "Parse Content";
                  const outlineActionLabel = file.parseStatus === "parsed" ? "Re-parse Outline" : "Parse Outline";
                  const selectedJsonLevel = jsonLevels[file.id] ?? "page";
                  const hasGeneratedJson = generatedIndex?.fileId === file.id;

                  return (
                    <tr key={file.id}>
                      <td>
                        <div>{file.fileName}</div>
                        {isMisclassifiedImageRow ? (
                          <div className="error" style={{ marginTop: 6 }}>
                            Image file is not a valid PDF parsing source on this page.
                          </div>
                        ) : null}
                        {isReferenceImageRow ? (
                          <div className="muted" style={{ marginTop: 6 }}>
                            Legacy reference image row. Upload is removed from this page.
                          </div>
                        ) : null}
                        {rowKind === "unsupported_source" ? (
                          <div className="error" style={{ marginTop: 6 }}>
                            Unsupported source file type. Only PDF source files are parseable here.
                          </div>
                        ) : null}
                      </td>
                      <td>
                        {isPdfRow
                          ? "PDF source"
                          : isReferenceImageRow
                            ? "Reference image"
                            : isMisclassifiedImageRow
                              ? "Misclassified image"
                              : "Unsupported source"}
                      </td>
                      <td>{relatedPdf?.fileName ?? "—"}</td>
                      <td>{(file.fileSize / 1024).toFixed(1)} KB</td>
                      <td>
                        {isPdfRow ? (
                          <span className={`badge ${file.parseStatus}`}>{file.parseStatus}</span>
                        ) : (
                          <span className="muted">N/A</span>
                        )}
                      </td>
                      <td>
                        <div className="row" style={{ gap: 8 }}>
                          {isPdfRow ? (
                            <>
                              <button
                                className="btn secondary"
                                onClick={() => void onParseContent(file.id)}
                                disabled={busy}
                              >
                                {contentActionLabel}
                              </button>
                              <button
                                className="btn secondary"
                                onClick={() => void onParseOutline(file.id)}
                                disabled={busy}
                              >
                                {outlineActionLabel}
                              </button>
                              <button
                                className="btn secondary"
                                onClick={() => void onGenerateJsonIndex(file.id)}
                                disabled={busy}
                              >
                                Generate JSON Index
                              </button>
                              <select
                                value={selectedJsonLevel}
                                onChange={(e) =>
                                  setJsonLevels((current) => ({
                                    ...current,
                                    [file.id]: e.target.value as PdfJsonIndexLevel
                                  }))
                                }
                                disabled={busy}
                                style={{ width: 180 }}
                              >
                                {JSON_INDEX_LEVEL_OPTIONS.map((option) => (
                                  <option key={option.value} value={option.value}>
                                    {option.label}
                                  </option>
                                ))}
                              </select>
                              <button
                                className="btn secondary"
                                onClick={() => onViewJsonResult(file.id)}
                                disabled={busy || !hasGeneratedJson}
                              >
                                View JSON
                              </button>
                              <button
                                className="btn secondary"
                                onClick={() => onDownloadJsonResult(file.id)}
                                disabled={busy || !hasGeneratedJson}
                              >
                                Download JSON
                              </button>
                            </>
                          ) : null}
                          {isReferenceImageRow ? (
                            <button
                              className="btn secondary"
                              onClick={() => onViewImageFile(file.id)}
                              disabled={busy}
                            >
                              View
                            </button>
                          ) : null}
                          {isMisclassifiedImageRow ? (
                            <button
                              className="btn secondary"
                              onClick={() => onViewImageFile(file.id)}
                              disabled={busy}
                            >
                              View
                            </button>
                          ) : null}
                          <button
                            className="btn secondary"
                            onClick={() => void onDelete(file.id, file.fileName)}
                            disabled={busy}
                          >
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {previewFileId ? (
        <div className="card" ref={previewSectionRef}>
          <div className="row between" style={{ alignItems: "flex-start" }}>
            <div>
              <h3 style={{ marginTop: 0, marginBottom: 6 }}>Preview Chapters</h3>
              <p className="muted" style={{ margin: 0 }}>
                File: <strong>{previewFile?.fileName ?? previewFileId}</strong> · Physical PDF pages:{" "}
                <strong>{previewPageCount}</strong> · Preview rows: <strong>{previewRows.length}</strong>
              </p>
            </div>
            <div className="row" style={{ gap: 8 }}>
              <button className="btn secondary" onClick={onAddRow} disabled={busy}>
                Add Row
              </button>
              <button className="btn" onClick={() => void onApplyChapters()} disabled={busy}>
                Apply Chapters
              </button>
            </div>
          </div>

          <p className="muted" style={{ marginTop: 12 }}>
            Physical PDF page numbers remain the canonical `pageStart` and `pageEnd`. Printed labels
            are display metadata only.
          </p>

          <div className="files-preview-table">
            <div className="admin-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Enabled</th>
                    <th>Original PDF Outline Title</th>
                    <th>Suggested Chapter Title</th>
                    <th>Printed Label / Range</th>
                    <th>PDF Start</th>
                    <th>PDF End</th>
                    <th>Entry Type</th>
                    <th>Sort</th>
                    <th>Admin Note</th>
                    <th>Apply Status</th>
                    <th>Row</th>
                  </tr>
                </thead>
                <tbody>
                  {previewRows.map((row, index) => (
                    <tr key={row.id ?? `${row.originalTitle}-${index}`}>
                      <td>
                        <input
                          type="checkbox"
                          style={{ width: "auto" }}
                          checked={row.enabled}
                          onChange={(e) => updateRow(index, { ...row, enabled: e.target.checked })}
                        />
                      </td>
                      <td>
                        <div style={{ paddingLeft: `${Math.min(row.outlineLevel, 4) * 12}px` }}>
                          {row.originalTitle || <span className="muted">Manual row</span>}
                        </div>
                      </td>
                      <td>
                        <input
                          value={row.suggestedTitle}
                          onChange={(e) =>
                            updateRow(index, { ...row, suggestedTitle: e.target.value })
                          }
                          placeholder="Chapter title"
                        />
                      </td>
                      <td>
                        <input
                          value={row.printedPageLabel ?? ""}
                          onChange={(e) =>
                            updateRow(index, { ...row, printedPageLabel: e.target.value || null })
                          }
                          placeholder="Printed page label"
                        />
                      </td>
                      <td>
                        <input
                          value={row.pageStart ?? ""}
                          onChange={(e) =>
                            updateRow(index, { ...row, pageStart: parseNullableInt(e.target.value) })
                          }
                          placeholder="10"
                        />
                      </td>
                      <td>
                        <input
                          value={row.pageEnd ?? ""}
                          onChange={(e) =>
                            updateRow(index, { ...row, pageEnd: parseNullableInt(e.target.value) })
                          }
                          placeholder="47"
                        />
                      </td>
                      <td>
                        <select
                          value={row.entryType}
                          onChange={(e) =>
                            updateRow(index, {
                              ...row,
                              entryType: e.target.value as ChapterPreviewEntryType
                            })
                          }
                        >
                          {ENTRY_TYPE_OPTIONS.map((entryType) => (
                            <option key={entryType} value={entryType}>
                              {entryType}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <input
                          value={row.sortOrder}
                          onChange={(e) =>
                            updateRow(index, {
                              ...row,
                              sortOrder: parseNullableInt(e.target.value) ?? row.sortOrder
                            })
                          }
                        />
                      </td>
                      <td>
                        <input
                          value={row.adminNote ?? ""}
                          onChange={(e) =>
                            updateRow(index, { ...row, adminNote: e.target.value || null })
                          }
                          placeholder="Optional note"
                        />
                      </td>
                      <td>
                        <span className={`badge ${row.applyStatus === "ready" ? "parsed" : "draft"}`}>
                          {statusText(row.applyStatus)}
                        </span>
                      </td>
                      <td>
                        <button
                          className="admin-link-btn"
                          onClick={() => onRemoveRow(index)}
                          disabled={busy}
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : null}

      {generatedIndex ? (
        <div className="card" ref={jsonResultRef}>
          <div className="row between" style={{ alignItems: "flex-start" }}>
            <div>
              <h3 style={{ marginTop: 0, marginBottom: 6 }}>JSON Index Result</h3>
              <p className="muted" style={{ margin: 0 }}>
                File: <strong>{generatedIndex.fileName}</strong> · Level:{" "}
                <strong>
                  {generatedIndex.level} / {generatedIndex.levelLabel}
                </strong>{" "}
                · Pages: <strong>{generatedIndex.pageCount}</strong> · Items:{" "}
                <strong>{generatedIndex.itemCount}</strong>
              </p>
            </div>
            <div className="row" style={{ gap: 8 }}>
              <button className="btn" onClick={() => void onSaveAsQaReference()} disabled={busy}>
                Save as QA Reference
              </button>
              <button
                className="btn secondary"
                onClick={() => onDownloadJsonResult(generatedIndex.fileId)}
                disabled={busy}
              >
                Download JSON
              </button>
            </div>
          </div>

          {generatedIndex.notes?.length ? (
            <div style={{ marginTop: 12 }}>
              {generatedIndex.notes.map((note) => (
                <p key={note} className="muted" style={{ margin: "4px 0" }}>
                  {note}
                </p>
              ))}
            </div>
          ) : null}

          <details style={{ marginTop: 14 }}>
            <summary style={{ cursor: "pointer", fontWeight: 600 }}>View JSON</summary>
            <pre className="files-json-preview">{generatedJsonText}</pre>
          </details>
        </div>
      ) : null}

      <div className="card">
        <div className="row between" style={{ alignItems: "flex-start" }}>
          <div>
            <h3 style={{ marginTop: 0, marginBottom: 6 }}>JSON Index / QA Reference</h3>
            <p className="muted" style={{ margin: 0 }}>
              Stored JSON indexes persist across refreshes. The active one is used as the Knowledge QA
              structured reference; with none active, QA falls back to content-based search.
            </p>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <input
              ref={jsonUploadRef}
              type="file"
              accept="application/json,.json"
              style={{ maxWidth: 280 }}
            />
            <button className="btn secondary" onClick={() => void onUploadJsonIndex()} disabled={busy}>
              Upload JSON
            </button>
          </div>
        </div>

        <div
          className="row"
          style={{ gap: 8, marginTop: 12, alignItems: "center", flexWrap: "wrap" }}
        >
          <span className="muted">Reader TOC page start:</span>
          <input
            type="number"
            min={1}
            value={tocPageStart}
            onChange={(e) => setTocPageStart(e.target.value)}
            style={{ width: 88 }}
          />
          <span className="muted">page end:</span>
          <input
            type="number"
            min={1}
            value={tocPageEnd}
            onChange={(e) => setTocPageEnd(e.target.value)}
            style={{ width: 88 }}
          />
          <span className="muted">— then click “Generate Reader TOC” on a JSON Index row below.</span>
        </div>

        {genTocResult ? (
          <p
            className={genTocResult.warnings.length ? "error" : "muted"}
            style={{ marginTop: 8 }}
          >
            Reader TOC generated: {genTocResult.file?.itemCount ?? 0} items
            {genTocResult.warnings.length ? ` — ⚠ ${genTocResult.warnings.join("; ")}` : ""}
          </p>
        ) : null}

        {jsonIndexes.length === 0 ? (
          <p className="muted" style={{ marginTop: 12 }}>
            No stored JSON index yet. Generate an index above and click “Save as QA Reference”, or
            upload a JSON index file.
          </p>
        ) : (
          <div className="admin-table-wrap" style={{ marginTop: 12 }}>
            <table>
              <thead>
                <tr>
                  <th>File name</th>
                  <th>Level / Label</th>
                  <th>Items</th>
                  <th>Created</th>
                  <th>QA Reference</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {jsonIndexes.map((idx) => (
                  <tr key={idx.fileId}>
                    <td>
                      <div>{idx.fileName}</div>
                      {!idx.valid ? (
                        <span className="badge failed">invalid / unreadable</span>
                      ) : null}
                    </td>
                    <td>
                      {idx.level ?? "—"}
                      {idx.levelLabel ? ` / ${idx.levelLabel}` : ""}
                    </td>
                    <td>{idx.itemCount ?? "—"}</td>
                    <td className="muted">{new Date(idx.createdAt).toLocaleString("zh-Hant")}</td>
                    <td>
                      {idx.isActive ? (
                        <span className="badge parsed">Active QA Reference</span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td>
                      <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                        <button
                          className="btn secondary"
                          onClick={() => void onSetActiveJsonIndex(idx.fileId)}
                          disabled={busy || idx.isActive || !idx.valid}
                        >
                          Set as QA Reference
                        </button>
                        <button
                          className="btn"
                          onClick={() => void onGenerateReaderTocFromIndex(idx.fileId)}
                          disabled={busy || !idx.valid}
                          title="Generate a chapter/section Reader TOC from this index using the page range above"
                        >
                          Generate Reader TOC
                        </button>
                        <button className="btn secondary" onClick={() => onViewJsonIndex(idx.fileId)}>
                          View JSON
                        </button>
                        <button
                          className="btn secondary"
                          onClick={() => onDownloadJsonIndex(idx.fileId, idx.fileName)}
                        >
                          Download JSON
                        </button>
                        <button
                          className="btn secondary"
                          onClick={() => void onDeleteJsonIndex(idx.fileId, idx.fileName)}
                          disabled={busy}
                        >
                          Delete JSON
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
