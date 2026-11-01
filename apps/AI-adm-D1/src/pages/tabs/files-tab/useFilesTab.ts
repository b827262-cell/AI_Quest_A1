import { useEffect, useMemo, useRef, useState } from "react";
import type { BookFile, ChapterPreviewRow, PdfJsonIndex, PdfJsonIndexLevel, StoredJsonIndexSummary } from "@ai-smartbook/schema";
import { adminApi, type GenerateReaderTocResponse, type ReaderTocImportPayload, type ReaderTocResponse } from "../../../api";
import { useConfirm } from "../../../components/useConfirm";
import { parseReaderTocForPreview, renderPreview, withApplyStatus, type ReaderTocFormat, type ReaderTocNode } from "./file-utils";

export function useFilesTab(bookId: string) {
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
  return { files, setFiles, readerToc, setReaderToc, busy, setBusy, msg, setMsg, error, setError, readerTocFormat, setReaderTocFormat, readerTocContent, setReaderTocContent, readerTocPreview, setReaderTocPreview, readerTocPreviewError, setReaderTocPreviewError, previewRows, setPreviewRows, previewFileId, setPreviewFileId, previewPageCount, setPreviewPageCount, jsonLevels, setJsonLevels, generatedIndex, setGeneratedIndex, jsonIndexes, setJsonIndexes, tocPageStart, setTocPageStart, tocPageEnd, setTocPageEnd, genTocResult, setGenTocResult, inputRef, jsonUploadRef, previewSectionRef, jsonResultRef, readerTocSectionRef, previewFile, documentFiles, generatedJsonText, readerTocPreviewText, looksLikeSentenceIndex, onUploadPdf, onParseContent, onParseOutline, onGenerateJsonIndex, onDelete, onViewJsonResult, onViewImageFile, onDownloadJsonResult, onPreviewReaderToc, onImportReaderToc, onDeleteReaderToc, onSaveAsQaReference, onUploadJsonIndex, onSetActiveJsonIndex, onGenerateReaderTocFromIndex, onViewJsonIndex, onDownloadJsonIndex, onDeleteJsonIndex, updateRow, onAddRow, onRemoveRow, onApplyChapters, bookId };
}
export type FilesTabState = ReturnType<typeof useFilesTab>;
