import { readFile } from "node:fs/promises";
import { stat } from "node:fs/promises";
import { PDFParse } from "pdf-parse";
import type { CreateBookContentInput } from "@ai-smartbook/schema";
import { splitTextIntoParagraphs } from "./content-splitter";

export interface ParsePdfResult {
  contents: CreateBookContentInput[];
  pageCount: number;
}

/**
 * Bounded resource limits for PDF parsing. These values are deliberately
 * conservative so that a crafted-but-benign or malicious PDF cannot exhaust
 * memory or CPU during parsing.
 */
export const PDF_PARSE_LIMITS = {
  /** Maximum input file size in bytes (50 MiB). */
  MAX_INPUT_BYTES: 50 * 1024 * 1024,
  /** Maximum number of pages to parse (1000 pages). */
  MAX_PAGES: 1000,
  /** Maximum total extracted text characters (5 MiB of text). */
  MAX_OUTPUT_CHARS: 5 * 1024 * 1024
} as const;

/**
 * Error raised when a PDF cannot be parsed safely within resource bounds.
 * The message is intentionally generic: it never includes the file path,
 * raw parser stack, or any internal implementation detail.
 */
export class PdfParseBoundedError extends Error {
  public readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PdfParseBoundedError";
    this.code = code;
  }
}

function boundedError(code: string, message: string): PdfParseBoundedError {
  return new PdfParseBoundedError(code, message);
}

/**
 * Parse a PDF file into book_contents input rows using pdf-parse v2, which
 * exposes per-page text. Empty paragraphs are never emitted; when no pages
 * are available the whole document is split into paragraphs instead.
 *
 * Resource bounds are enforced before and after parsing so that a malformed,
 * truncated, or oversized PDF cannot exhaust memory or CPU:
 *
 * - Input file size is checked against MAX_INPUT_BYTES before reading.
 * - Page count is checked against MAX_PAGES after parsing.
 * - Total extracted text length is checked against MAX_OUTPUT_CHARS.
 * - Any failure rethrows a PdfParseBoundedError with a safe, generic message
 *   that never leaks the file path, raw parser stack, or internals.
 */
export async function parsePdfToContents(
  filePath: string,
  bookId: string,
  fileId: string
): Promise<ParsePdfResult> {
  let fileSize: number;
  try {
    const fileStat = await stat(filePath);
    fileSize = fileStat.size;
  } catch {
    throw boundedError(
      "pdf_unreadable",
      "Unable to read the PDF file for parsing."
    );
  }

  if (fileSize > PDF_PARSE_LIMITS.MAX_INPUT_BYTES) {
    throw boundedError(
      "pdf_input_too_large",
      `PDF input exceeds the maximum allowed size of ${PDF_PARSE_LIMITS.MAX_INPUT_BYTES} bytes.`
    );
  }

  let buffer: Buffer;
  try {
    buffer = await readFile(filePath);
  } catch {
    throw boundedError(
      "pdf_unreadable",
      "Unable to read the PDF file for parsing."
    );
  }

  const parser = new PDFParse({ data: new Uint8Array(buffer) });

  let result: Awaited<ReturnType<typeof parser.getText>>;
  try {
    result = await parser.getText();
  } catch {
    throw boundedError(
      "pdf_parse_failed",
      "The PDF could not be parsed. It may be malformed or truncated."
    );
  } finally {
    await parser.destroy();
  }

  const pageCount = result.pages.length;
  if (pageCount > PDF_PARSE_LIMITS.MAX_PAGES) {
    throw boundedError(
      "pdf_page_count_exceeded",
      `PDF page count ${pageCount} exceeds the maximum of ${PDF_PARSE_LIMITS.MAX_PAGES} pages.`
    );
  }

  let totalChars = 0;
  for (const page of result.pages) {
    totalChars += (page.text ?? "").length;
  }
  totalChars += (result.text ?? "").length;

  if (totalChars > PDF_PARSE_LIMITS.MAX_OUTPUT_CHARS) {
    throw boundedError(
      "pdf_output_too_large",
      `Extracted PDF text exceeds the maximum of ${PDF_PARSE_LIMITS.MAX_OUTPUT_CHARS} characters.`
    );
  }

  const contents: CreateBookContentInput[] = [];
  let orderIndex = 0;

  if (result.pages.length > 0) {
    for (const page of result.pages) {
      if (!Number.isInteger(page.num) || page.num < 1) {
        throw boundedError(
          "pdf_invalid_page_number",
          "Invalid PDF page number from parser. Expected 1-based physical page number."
        );
      }
      const physicalPageNumber = page.num;
      for (const text of splitTextIntoParagraphs(page.text)) {
        contents.push({
          bookId,
          fileId,
          pageNumber: physicalPageNumber,
          orderIndex: orderIndex++,
          contentText: text
        });
      }
    }
  } else {
    for (const text of splitTextIntoParagraphs(result.text)) {
      contents.push({
        bookId,
        fileId,
        pageNumber: null,
        orderIndex: orderIndex++,
        contentText: text
      });
    }
  }

  return { contents, pageCount: result.total ?? result.pages.length };
}
