import type {
  BookChapter,
  PdfJsonIndex,
  PdfJsonIndexItem,
  PdfJsonIndexLevel,
  PdfJsonIndexLevelLabel,
  PdfJsonIndexSource
} from "@ai-smartbook/schema";

export interface PdfIndexContentRow {
  pageNumber?: number | null;
  contentText: string;
  orderIndex: number;
}

export interface BuildPdfJsonIndexInput {
  bookId: string;
  fileId: string;
  fileName: string;
  level: PdfJsonIndexLevel;
  pageCount: number;
  contents: PdfIndexContentRow[];
  chapters?: BookChapter[];
}

type ResolvedChapter = Pick<BookChapter, "id" | "title" | "pageStart" | "pageEnd" | "orderIndex">;

const LEVEL_LABELS: Record<PdfJsonIndexLevel, PdfJsonIndexLevelLabel> = {
  page: "簡單",
  chapter: "進階",
  clause: "複雜",
  line: "高階",
  sentence: "頂級"
};

function sanitizeText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\u00a0/g, " ").trim();
}

function charCount(text: string): number {
  return [...text].length;
}

function splitKeepingDelimiter(text: string, boundary: RegExp): string[] {
  return sanitizeText(text)
    .split(boundary)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function validPageNumber(pageNumber: number | null | undefined): pageNumber is number {
  return typeof pageNumber === "number" && Number.isInteger(pageNumber) && pageNumber >= 1;
}

function findChapterForPage(chapters: ResolvedChapter[], pageNumber: number) {
  return (
    chapters.find(
      (chapter) =>
        chapter.pageStart != null &&
        chapter.pageEnd != null &&
        pageNumber >= chapter.pageStart &&
        pageNumber <= chapter.pageEnd
    ) ?? null
  );
}

function attachChapter(
  item: Omit<PdfJsonIndexItem, "chapterId" | "chapterTitle">,
  chapter: ResolvedChapter | null
): PdfJsonIndexItem {
  return chapter
    ? {
        ...item,
        chapterId: chapter.id,
        chapterTitle: chapter.title
      }
    : item;
}

function normalizeChapters(chapters: BookChapter[]): ResolvedChapter[] {
  return chapters
    .filter(
      (chapter) =>
        chapter.pageStart != null &&
        chapter.pageEnd != null &&
        chapter.pageStart >= 1 &&
        chapter.pageEnd >= chapter.pageStart
    )
    .map((chapter) => ({
      id: chapter.id,
      title: chapter.title,
      pageStart: chapter.pageStart ?? null,
      pageEnd: chapter.pageEnd ?? null,
      orderIndex: chapter.orderIndex
    }))
    .sort((a, b) => a.orderIndex - b.orderIndex);
}

export class InvalidPdfPageNumberError extends Error {
  constructor(message = "PDF index generation requires parsed content rows with physical PDF page numbers.") {
    super(message);
    this.name = "InvalidPdfPageNumberError";
  }
}

function ensurePhysicalPageContents(contents: PdfIndexContentRow[]): PdfIndexContentRow[] {
  const invalid = contents.find((content) => !validPageNumber(content.pageNumber));
  if (invalid) {
    throw new InvalidPdfPageNumberError();
  }
  return [...contents].sort((a, b) => a.orderIndex - b.orderIndex);
}

export function buildPdfJsonIndex(input: BuildPdfJsonIndexInput): PdfJsonIndex {
  const chapters = normalizeChapters(input.chapters ?? []);
  const contents = ensurePhysicalPageContents(input.contents);
  const notes: string[] = [];
  const source: PdfJsonIndexSource = {
    pageNumberMode: "pdf_physical_page"
  };
  const items: PdfJsonIndexItem[] = [];

  if (input.level === "page") {
    const byPage = new Map<number, string[]>();
    for (const content of contents) {
      const pageNumber = content.pageNumber as number;
      const bucket = byPage.get(pageNumber) ?? [];
      bucket.push(content.contentText);
      byPage.set(pageNumber, bucket);
    }

    for (let pageNumber = 1; pageNumber <= input.pageCount; pageNumber += 1) {
      const text = (byPage.get(pageNumber) ?? []).map(sanitizeText).filter(Boolean).join("\n\n");
      items.push(
        attachChapter(
          {
            id: `page-${pageNumber}`,
            type: "page",
            pageStart: pageNumber,
            pageEnd: pageNumber,
            text,
            charCount: charCount(text)
          },
          findChapterForPage(chapters, pageNumber)
        )
      );
    }
  }

  if (input.level === "chapter") {
    if (input.chapters == null || input.chapters.length === 0) {
      throw new Error("Chapter-level JSON index requires applied chapters.");
    }
    const skipped = (input.chapters ?? []).length - chapters.length;
    if (skipped > 0) {
      notes.push(`Skipped ${skipped} applied chapter rows without a valid physical page range.`);
    }

    for (const chapter of chapters) {
      const text = contents
        .filter((content) => {
          const pageNumber = content.pageNumber as number;
          return pageNumber >= (chapter.pageStart as number) && pageNumber <= (chapter.pageEnd as number);
        })
        .map((content) => sanitizeText(content.contentText))
        .filter(Boolean)
        .join("\n\n");

      items.push({
        id: `chapter-${chapter.id}`,
        type: "chapter",
        pageStart: chapter.pageStart as number,
        pageEnd: chapter.pageEnd as number,
        text,
        charCount: charCount(text),
        chapterId: chapter.id,
        chapterTitle: chapter.title
      });
    }
  }

  if (input.level === "clause") {
    let nextId = 1;
    for (const content of contents) {
      const pageNumber = content.pageNumber as number;
      const segments = splitKeepingDelimiter(content.contentText, /(?<=[，、；：,;:])/u);
      for (const text of segments) {
        items.push(
          attachChapter(
            {
              id: `clause-${nextId++}`,
              type: "clause",
              pageStart: pageNumber,
              pageEnd: pageNumber,
              text,
              charCount: charCount(text)
            },
            findChapterForPage(chapters, pageNumber)
          )
        );
      }
    }
  }

  if (input.level === "line") {
    source.lineMode = "newline_split_from_stored_page_text";
    notes.push("Line level uses newline splits from stored page text. True PDF line geometry/bbox data is not available.");

    let nextId = 1;
    for (const content of contents) {
      const pageNumber = content.pageNumber as number;
      const lines = sanitizeText(content.contentText)
        .split(/\n+/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

      const segments = lines.length > 0 ? lines : [sanitizeText(content.contentText)].filter(Boolean);
      for (const text of segments) {
        items.push(
          attachChapter(
            {
              id: `line-${nextId++}`,
              type: "line",
              pageStart: pageNumber,
              pageEnd: pageNumber,
              text,
              charCount: charCount(text)
            },
            findChapterForPage(chapters, pageNumber)
          )
        );
      }
    }
  }

  if (input.level === "sentence") {
    let nextId = 1;
    for (const content of contents) {
      const pageNumber = content.pageNumber as number;
      const segments = splitKeepingDelimiter(content.contentText, /(?<=[。！？；.!?;])/u);
      for (const text of segments) {
        items.push(
          attachChapter(
            {
              id: `sentence-${nextId++}`,
              type: "sentence",
              pageStart: pageNumber,
              pageEnd: pageNumber,
              text,
              charCount: charCount(text)
            },
            findChapterForPage(chapters, pageNumber)
          )
        );
      }
    }
  }

  return {
    schemaVersion: "smartbook-pdf-index-v1",
    bookId: input.bookId,
    fileId: input.fileId,
    fileName: input.fileName,
    level: input.level,
    levelLabel: LEVEL_LABELS[input.level],
    generatedAt: new Date().toISOString(),
    pageCount: input.pageCount,
    itemCount: items.length,
    source,
    notes: notes.length > 0 ? notes : undefined,
    items
  };
}
