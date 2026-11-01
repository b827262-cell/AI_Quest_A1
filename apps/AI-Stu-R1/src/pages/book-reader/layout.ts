import type { BookChapter, ReaderOutlineNode } from "@ai-smartbook/schema";
import type { ReaderRatio } from "../../components/PdfReaderToolbar";
import {
  LAYOUT_RATIO_KEY,
  OUTER_GUTTER_MAX,
  OUTER_GUTTER_MIN,
  OUTER_LAYOUT_KEY
} from "./constants";

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function readStoredWidth(key: string, fallback: number, min: number, max: number): number {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? clamp(n, min, max) : fallback;
  } catch {
    return fallback;
  }
}

export function readStoredRatio(): ReaderRatio {
  try {
    const raw = localStorage.getItem(LAYOUT_RATIO_KEY);
    return raw === "6:4" || raw === "1:1" || raw === "4:6" ? raw : "6:4";
  } catch {
    return "6:4";
  }
}

export function defaultOuterGutter(): number {
  if (typeof window === "undefined") return 80;
  return clamp(Math.floor((window.innerWidth - 1280) / 2), OUTER_GUTTER_MIN, OUTER_GUTTER_MAX);
}

export function readStoredOuterLayout(): { leftGutter: number; rightGutter: number } {
  try {
    const fallback = defaultOuterGutter();
    const raw = localStorage.getItem(OUTER_LAYOUT_KEY);
    if (!raw) return { leftGutter: fallback, rightGutter: fallback };
    const parsed = JSON.parse(raw) as { leftGutter?: unknown; rightGutter?: unknown };
    const left = typeof parsed.leftGutter === "number" ? parsed.leftGutter : fallback;
    const right = typeof parsed.rightGutter === "number" ? parsed.rightGutter : fallback;
    return {
      leftGutter: clamp(left, OUTER_GUTTER_MIN, OUTER_GUTTER_MAX),
      rightGutter: clamp(right, OUTER_GUTTER_MIN, OUTER_GUTTER_MAX)
    };
  } catch {
    const fallback = defaultOuterGutter();
    return { leftGutter: fallback, rightGutter: fallback };
  }
}

export function studentSessionKey(bookId: string): string {
  return `smartbook.chatSession.${bookId}`;
}

export function flattenOutline(nodes: ReaderOutlineNode[]): ReaderOutlineNode[] {
  const flat: ReaderOutlineNode[] = [];
  function walk(items: ReaderOutlineNode[]) {
    for (const item of items) {
      flat.push(item);
      walk(item.children);
    }
  }
  walk(nodes);
  return flat;
}

export function chaptersToFallbackOutline(chapters: BookChapter[]): ReaderOutlineNode[] {
  const nodes = chapters
    .slice()
    .sort((a, b) => a.orderIndex - b.orderIndex)
    .map((chapter) => ({
      id: chapter.id,
      title: chapter.title,
      level: Math.max(1, (chapter.level ?? 0) + 1),
      page: chapter.pageStart ?? null,
      pdfPage: chapter.pageStart ?? null,
      displayPage: chapter.pageStart != null ? String(chapter.pageStart) : null,
      children: [],
      source: (chapter.source === "pdf_outline" ? "pdf_outline" : "chapter_table") as ReaderOutlineNode["source"]
    }));

  const stack: ReaderOutlineNode[] = [];
  const roots: ReaderOutlineNode[] = [];

  for (const node of nodes) {
    while (stack.length > 0 && stack[stack.length - 1].level >= node.level) {
      stack.pop();
    }

    if (stack.length === 0) {
      roots.push(node);
    } else {
      stack[stack.length - 1].children.push(node);
    }

    stack.push(node);
  }

  return roots;
}
