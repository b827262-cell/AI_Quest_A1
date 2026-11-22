import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { parsePdfToContents, PDF_PARSE_LIMITS, PdfParseBoundedError } from "../src/pdf-parser";
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { Stats } from "node:fs";

const hoisted = vi.hoisted(() => ({
  originalStat: vi.fn(),
  originalReadFile: vi.fn(),
  mockGetText: vi.fn(),
  mockDestroy: vi.fn()
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    stat: hoisted.originalStat,
    readFile: hoisted.originalReadFile
  };
});

vi.mock("pdf-parse", () => {
  return {
    PDFParse: class {
      public getText = hoisted.mockGetText;
      public destroy = hoisted.mockDestroy;
    }
  };
});

const MINIMAL_VALID_PDF = Buffer.from(
  "%PDF-1.4\n" +
  "1 0 obj\n" +
  "<< /Type /Catalog /Pages 2 0 R >>\n" +
  "endobj\n" +
  "2 0 obj\n" +
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>\n" +
  "endobj\n" +
  "3 0 obj\n" +
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>\n" +
  "endobj\n" +
  "4 0 obj\n" +
  "<< /Length 44 >>\n" +
  "stream\n" +
  "BT /F1 12 Tf 50 700 Td (Hello World) Tj ET\n" +
  "endstream\n" +
  "endobj\n" +
  "xref\n" +
  "0 5\n" +
  "0000000000 65535 f \n" +
  "0000000009 00000 n \n" +
  "0000000058 00000 n \n" +
  "0000000115 00000 n \n" +
  "0000000196 00000 n \n" +
  "trailer\n" +
  "<< /Size 5 /Root 1 0 R >>\n" +
  "startxref\n" +
  "286\n" +
  "%%EOF\n"
);

const MALFORMED_PDF = Buffer.from("this is not a pdf file at all%%EOF");

const VALID_PARSE_RESULT = {
  pages: [{ num: 1, text: "Hello World" }],
  text: "Hello World",
  total: 1
};

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "pdf-parser-test-"));
  vi.resetAllMocks();
  hoisted.originalStat.mockImplementation(async (_path: string): Promise<Stats> => {
    if (String(_path).includes("oversized")) {
      return { size: PDF_PARSE_LIMITS.MAX_INPUT_BYTES + 1 } as unknown as Stats;
    }
    return { size: 100 } as unknown as Stats;
  });
  hoisted.originalReadFile.mockImplementation(async (path: string) => {
    if (String(path).includes("valid")) return MINIMAL_VALID_PDF;
    if (String(path).includes("malformed")) return MALFORMED_PDF;
    throw new Error("ENOENT");
  });
  hoisted.mockGetText.mockResolvedValue(VALID_PARSE_RESULT);
  hoisted.mockDestroy.mockResolvedValue(undefined);
});

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("pdf-parser bounded resource policy", () => {
  it("parses a valid small crafted-but-benign PDF successfully", async () => {
    const filePath = join(tempDir, "valid.pdf");
    writeFileSync(filePath, MINIMAL_VALID_PDF);

    const result = await parsePdfToContents(filePath, "book-1", "file-1");

    expect(result.pageCount).toBe(1);
    expect(Array.isArray(result.contents)).toBe(true);
    expect(result.contents.length).toBeGreaterThan(0);
  });

  it("rejects a malformed/truncated PDF with a safe bounded error", async () => {
    const filePath = join(tempDir, "malformed.pdf");
    writeFileSync(filePath, MALFORMED_PDF);
    hoisted.mockGetText.mockRejectedValue(new Error("parse error"));

    await expect(parsePdfToContents(filePath, "book-1", "file-1")).rejects.toMatchObject({
      code: "pdf_parse_failed",
      name: "PdfParseBoundedError"
    });
  });

  it("does not leak the file path or raw stack in the error message", async () => {
    const filePath = join(tempDir, "malformed.pdf");
    writeFileSync(filePath, MALFORMED_PDF);
    hoisted.mockGetText.mockRejectedValue(new Error("parse error"));

    try {
      await parsePdfToContents(filePath, "book-1", "file-1");
      throw new Error("should have thrown");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).not.toContain(tempDir);
      expect(message).not.toContain(filePath);
      expect(message).not.toMatch(/at /);
      expect((err as PdfParseBoundedError).code).toBe("pdf_parse_failed");
    }
  });

  it("rejects an oversized input file before reading", async () => {
    hoisted.originalStat.mockImplementation(async (_path: string): Promise<Stats> => {
      if (String(_path).includes("oversized")) {
        return { size: PDF_PARSE_LIMITS.MAX_INPUT_BYTES + 1 } as unknown as Stats;
      }
      return { size: 100 } as unknown as Stats;
    });

    const filePath = join(tempDir, "oversized.pdf");
    writeFileSync(filePath, Buffer.alloc(10));

    await expect(parsePdfToContents(filePath, "book-1", "file-1")).rejects.toMatchObject({
      code: "pdf_input_too_large"
    });
  });

  it("rejects a PDF exceeding the page limit with a safe error", async () => {
    const manyPagesResult = {
      pages: Array.from({ length: PDF_PARSE_LIMITS.MAX_PAGES + 1 }, (_, i) => ({
        num: i + 1,
        text: `page ${i + 1}`
      })),
      text: "",
      total: PDF_PARSE_LIMITS.MAX_PAGES + 1
    };
    hoisted.mockGetText.mockResolvedValue(manyPagesResult);

    hoisted.originalStat.mockImplementation(async (): Promise<Stats> => {
      return { size: 100 } as unknown as Stats;
    });
    hoisted.originalReadFile.mockImplementation(async () => MINIMAL_VALID_PDF);

    const filePath = join(tempDir, "many-pages.pdf");
    writeFileSync(filePath, MINIMAL_VALID_PDF);

    await expect(parsePdfToContents(filePath, "book-1", "file-1")).rejects.toMatchObject({
      code: "pdf_page_count_exceeded"
    });
  });

  it("PDF_PARSE_LIMITS exports expected bound values", () => {
    expect(PDF_PARSE_LIMITS.MAX_INPUT_BYTES).toBe(50 * 1024 * 1024);
    expect(PDF_PARSE_LIMITS.MAX_PAGES).toBe(1000);
    expect(PDF_PARSE_LIMITS.MAX_OUTPUT_CHARS).toBe(5 * 1024 * 1024);
  });

  it("PdfParseBoundedError carries a code and safe message", () => {
    const err = new PdfParseBoundedError("test_code", "safe message");
    expect(err.code).toBe("test_code");
    expect(err.name).toBe("PdfParseBoundedError");
    expect(err.message).toBe("safe message");
    expect(err instanceof Error).toBe(true);
  });
});
