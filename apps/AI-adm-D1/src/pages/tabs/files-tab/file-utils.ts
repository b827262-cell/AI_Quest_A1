import type { BookFile, ChapterPreviewApplyStatus, ChapterPreviewEntryType, ChapterPreviewRow, ReaderOutlineNode, PdfJsonIndexLevel } from "@ai-smartbook/schema";
import type { ReaderTocImportPayload } from "../../../api";

export const ENTRY_TYPE_OPTIONS: ChapterPreviewEntryType[] = [
  "front_matter",
  "toc",
  "chapter",
  "appendix",
  "copyright",
  "back_matter",
  "group",
  "unknown"
];

export const JSON_INDEX_LEVEL_OPTIONS: Array<{ value: PdfJsonIndexLevel; label: string }> = [
  { value: "page", label: "簡單：分頁數" },
  { value: "chapter", label: "進階：分章節" },
  { value: "clause", label: "複雜：分逗號" },
  { value: "line", label: "高階：分行" },
  { value: "sentence", label: "頂級：分句" }
];

export type ReaderTocNode = ReaderOutlineNode;

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

export function parseReaderTocForPreview(format: ReaderTocFormat, content: string): ReaderTocNode[] {
  if (format === "markdown") {
    return parseReaderTocMarkdown(content);
  }

  return parseReaderTocJson(content);
}

export function renderPreview(nodes: ReaderTocNode[], depth = 0): string[] {
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

export type ReaderTocFormat = ReaderTocImportPayload["format"];

type FileRowKind = "pdf_source" | "reference_image" | "misclassified_image" | "unsupported_source";

function isPdfFile(file: Pick<BookFile, "fileName" | "fileType">): boolean {
  return file.fileType === "application/pdf" || file.fileName.toLowerCase().endsWith(".pdf");
}

function isImageFile(file: Pick<BookFile, "fileName" | "fileType">): boolean {
  return /^image\//.test(file.fileType) || /\.(png|jpe?g|webp|gif|bmp|svg)$/i.test(file.fileName);
}

export function getFileRowKind(file: BookFile): FileRowKind {
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

export function withApplyStatus(row: ChapterPreviewRow): ChapterPreviewRow {
  return { ...row, applyStatus: getApplyStatus(row) };
}

export function parseNullableInt(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : null;
}


export function statusText(status: ChapterPreviewApplyStatus | undefined): string {
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
