import { z } from "zod";

/**
 * 高普考 (115/116) course catalog contracts.
 *
 * Wire field names stay snake_case because they mirror the snapshot columns
 * produced by the ec.ibrain.com.tw crawl and mirrored by the PostgreSQL
 * schema; renaming them at the boundary would make the snapshot, the table
 * and the API response three different vocabularies for one row.
 */

export const EXAM_COURSE_YEARS_V1 = [115, 116] as const;
export const examCourseYearV1Schema = z.union([z.literal(115), z.literal(116)]);
export type ExamCourseYearV1 = z.infer<typeof examCourseYearV1Schema>;

/** Only these hosts may ever appear in a public source_url. */
export const EXAM_COURSE_SOURCE_HOSTS_V1 = ["ec.ibrain.com.tw"] as const;

export const EXAM_COURSE_SEARCH_MODES_V1 = [
  "product_name",
  "product_code",
  "teacher",
  "scope"
] as const;
export const examCourseSourceSearchModeV1Schema = z.enum(EXAM_COURSE_SEARCH_MODES_V1);
export type ExamCourseSourceSearchModeV1 = z.infer<typeof examCourseSourceSearchModeV1Schema>;

export const EXAM_COURSE_CATEGORIES_V1 = ["高普考"] as const;
export const examCourseCategoryV1Schema = z.literal("高普考");
export type ExamCourseCategoryV1 = z.infer<typeof examCourseCategoryV1Schema>;

/** One crawled course row, including the provenance fields kept in the snapshot. */
export const examCourseRecordV1Schema = z.object({
  exam_year: examCourseYearV1Schema,
  category: examCourseCategoryV1Schema,
  course_code: z.string().trim().min(1).max(128),
  course_name: z.string().trim().min(1).max(512),
  course_content: z.string().max(20_000),
  teacher: z.string().trim().max(128).nullable().optional(),
  instructor: z.string().trim().max(128).nullable().optional(),
  applicable_scope: z.string().trim().max(256).nullable().optional(),
  source_url: z.string().trim().min(1).max(2_048),
  fetched_at: z.string().trim().min(1).max(64),
  content_hash: z.string().trim().regex(/^[a-f0-9]{64}$/)
}).strict();
export type ExamCourseRecordV1 = z.infer<typeof examCourseRecordV1Schema>;

/** Query parameters of GET /api/public/exam-courses/search. */
export const examCourseSearchQueryV1Schema = z.object({
  exam_year: examCourseYearV1Schema.optional(),
  category: examCourseCategoryV1Schema.optional(),
  course_code: z.string().trim().min(1).max(128).optional(),
  keyword: z.string().trim().min(1).max(200).optional(),
  search_mode: examCourseSourceSearchModeV1Schema.optional(),
  teacher: z.string().trim().min(1).max(128).optional(),
  applicable_scope: z.string().trim().min(1).max(256).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional()
}).strict();
export type ExamCourseSearchQueryV1 = z.infer<typeof examCourseSearchQueryV1Schema>;

/**
 * Result rows expose the public fields the public answer page renders,
 * including teacher, applicable scope, mode, and matched field provenance.
 */
export const examCourseSearchResultV1Schema = z.object({
  exam_year: examCourseYearV1Schema,
  course_code: z.string().min(1).max(128),
  course_name: z.string().min(1).max(512),
  course_content: z.string().max(20_000),
  teacher: z.string().nullable().optional(),
  instructor: z.string().nullable().optional(),
  applicable_scope: z.string().nullable().optional(),
  source_search_mode: examCourseSourceSearchModeV1Schema.optional(),
  matched_field: z.string().max(64).optional(),
  source_url: z.string().min(1).max(2_048).nullable()
}).strict();
export type ExamCourseSearchResultV1 = z.infer<typeof examCourseSearchResultV1Schema>;

export const examCourseSearchModeV1Schema = z.enum(["postgres", "snapshot", "mock"]);
export type ExamCourseSearchModeV1 = z.infer<typeof examCourseSearchModeV1Schema>;

export const examCourseSearchResponseV1Schema = z.object({
  contractVersion: z.literal(1),
  mode: examCourseSearchModeV1Schema,
  query: examCourseSearchQueryV1Schema,
  total: z.number().int().min(0),
  results: z.array(examCourseSearchResultV1Schema),
  snapshot_date: z.string().trim().max(32).optional(),
  message: z.string().trim().max(500).optional()
}).strict();
export type ExamCourseSearchResponseV1 = z.infer<typeof examCourseSearchResponseV1Schema>;

/** Row shape accepted by the snapshot-backed matcher; mirrors the table columns. */
export type ExamCourseSearchRow = Readonly<{
  exam_year: ExamCourseYearV1;
  category: ExamCourseCategoryV1;
  course_code: string;
  course_name: string;
  course_content: string;
  teacher?: string | null;
  instructor?: string | null;
  applicable_scope?: string | null;
  source_url: string;
}>;

export function matchesExamCourseYear(row: ExamCourseSearchRow, examYear: number | undefined): boolean {
  return examYear === undefined || row.exam_year === examYear;
}

/** Case-insensitive substring match over course_name + course_content. */
export function matchesExamCourseKeyword(row: ExamCourseSearchRow, keyword: string | undefined): boolean {
  if (!keyword) return true;
  const needle = keyword.trim().toLowerCase();
  if (!needle) return true;
  return row.course_name.toLowerCase().includes(needle) || row.course_content.toLowerCase().includes(needle);
}

/** course_code is an exact, case-insensitive identifier match — never a prefix. */
export function matchesExamCourseCode(row: ExamCourseSearchRow, courseCode: string | undefined): boolean {
  if (!courseCode) return true;
  return row.course_code.toLowerCase() === courseCode.trim().toLowerCase();
}

let big5Map: Map<string, readonly [number, number]> | undefined;

/**
 * Builds the complete Big5 reverse map from the platform codec.  This is the
 * same algorithm used by B3's server-only public-source-url helper; unlike a
 * hand-maintained character list, every representable character is encoded and
 * an unrepresentable character is rejected rather than UTF-8 encoded.
 */
function getBig5Map(): Map<string, readonly [number, number]> {
  if (big5Map) return big5Map;
  const decoder = new TextDecoder("big5", { fatal: false });
  const map = new Map<string, readonly [number, number]>();
  for (let lead = 0x81; lead <= 0xfe; lead += 1) {
    for (let trail = 0x40; trail <= 0xfe; trail += 1) {
      if (trail === 0x7f || (trail > 0x7e && trail < 0xa1)) continue;
      const character = decoder.decode(Uint8Array.of(lead, trail));
      if (character.length === 1 && character !== "\uFFFD" && !map.has(character)) {
        map.set(character, [lead, trail]);
      }
    }
  }
  big5Map = map;
  return map;
}

/**
 * Big5 percent-encoder for search keywords.
 * Preserves ASCII unreserved characters, encodes spaces as %20, and encodes
 * Chinese characters using their authentic Big5 byte representation.
 */
export function encodeBig5SearchKeyword(term: string): string | null {
  if (!term || typeof term !== "string") return null;
  const trimmed = term.trim();
  if (!trimmed) return null;
  const bytes: number[] = [];
  const map = getBig5Map();
  for (const character of trimmed) {
    const code = character.codePointAt(0)!;
    if (code <= 0x7f) {
      bytes.push(code);
      continue;
    }
    const pair = map.get(character);
    if (!pair) return null;
    bytes.push(...pair);
  }
  return bytes.map((byte) => (
    (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a) ||
    (byte >= 0x30 && byte <= 0x39) || "-._~".includes(String.fromCharCode(byte))
      ? String.fromCharCode(byte)
      : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`
  )).join("");
}

export const encodeBig5Percent = encodeBig5SearchKeyword;

/**
 * Returns a canonical exact product page, or null when it is not trustworthy.
 * Requires:
 * - protocol normalizes to https
 * - hostname exactly ec.ibrain.com.tw
 * - pathname case-insensitively exactly /Publish/www/book.asp
 * - bkid is digits-only and present
 * - no username/password
 */
export function normalizeExactProductUrl(value: string | null | undefined): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    const parsed = new URL(value.trim());
    const isApprovedHost = parsed.hostname.toLowerCase() === "ec.ibrain.com.tw";
    const isApprovedProtocol = parsed.protocol === "http:" || parsed.protocol === "https:";
    if (!isApprovedHost || !isApprovedProtocol) return null;
    if (parsed.username || parsed.password) return null;
    if (parsed.pathname.toLowerCase() !== "/publish/www/book.asp") return null;
    const bkid = [...parsed.searchParams.entries()]
      .find(([name]) => name.toLowerCase() === "bkid")?.[1];
    if (!bkid || !/^\d+$/.test(bkid)) return null;
    return `https://ec.ibrain.com.tw/Publish/www/book.asp?bkid=${bkid}`;
  } catch {
    return null;
  }
}

/**
 * Validates and normalizes source URLs against the approved ec.ibrain.com.tw host.
 * Strictly prevents open-redirects and forbids bare homepage links when exact product/search URL is required.
 */
export function buildPublicSourceUrl(options: {
  exactUrl?: string | null;
  mode?: ExamCourseSourceSearchModeV1;
  keyword?: string | null;
}): string | null {
  const { exactUrl, mode = "product_name", keyword } = options;

  const exact = normalizeExactProductUrl(exactUrl);
  if (exact) return exact;

  const colMap: Record<ExamCourseSourceSearchModeV1, string> = {
    product_name: "1",
    product_code: "2",
    teacher: "3",
    scope: "7"
  };

  const col = colMap[mode] ?? "1";
  const term = (keyword ?? "").trim();
  const encodedTerm = encodeBig5SearchKeyword(term);
  if (!encodedTerm) return null;
  return `https://ec.ibrain.com.tw/Publish/www/search.asp?PS=30&Col=${col}&keyword=${encodedTerm}&PG=0`;
}

export function searchExamCourseRows(
  rows: readonly ExamCourseSearchRow[],
  query: ExamCourseSearchQueryV1,
  limit: number = 20
): ExamCourseSearchResultV1[] {
  const mode: ExamCourseSourceSearchModeV1 = query.search_mode ?? (query.course_code ? "product_code" : "product_name");
  const keyword = (query.keyword ?? query.course_code ?? query.teacher ?? query.applicable_scope ?? "").trim();
  const needle = keyword.toLowerCase();

  const filtered = rows.filter((row) => {
    if (!matchesExamCourseYear(row, query.exam_year)) return false;
    if (query.category && row.category !== query.category) return false;
    if (!needle) return true;

    if (mode === "product_code") {
      // Exact code priority
      if (row.course_code.toLowerCase() === needle) return true;
      // Prefix fallback
      return row.course_code.toLowerCase().startsWith(needle);
    }

    if (mode === "teacher") {
      const teacher = (row.teacher ?? row.instructor ?? "").toLowerCase();
      return teacher.includes(needle);
    }

    if (mode === "scope") {
      const scope = (row.applicable_scope ?? "").toLowerCase();
      return scope.includes(needle);
    }

    // Default: product_name
    return row.course_name.toLowerCase().includes(needle) || row.course_content.toLowerCase().includes(needle);
  });

  // Sort exact matches first when mode is product_code
  if (mode === "product_code" && needle) {
    filtered.sort((a, b) => {
      const aExact = a.course_code.toLowerCase() === needle ? 0 : 1;
      const bExact = b.course_code.toLowerCase() === needle ? 0 : 1;
      return aExact - bExact;
    });
  }

  return filtered.slice(0, limit).map((row) => {
    let matchedField = "課名";
    if (mode === "product_code") {
      matchedField = row.course_code.toLowerCase() === needle ? "品號（完全符合）" : "品號（前綴符合）";
    } else if (mode === "teacher") {
      matchedField = "師資";
    } else if (mode === "scope") {
      matchedField = "適用範圍";
    } else if (row.course_name.toLowerCase().includes(needle)) {
      matchedField = "品名";
    } else {
      matchedField = "課程內容";
    }

    return {
      exam_year: row.exam_year,
      course_code: row.course_code,
      course_name: row.course_name,
      course_content: row.course_content,
      teacher: row.teacher ?? row.instructor ?? null,
      instructor: row.instructor ?? row.teacher ?? null,
      applicable_scope: row.applicable_scope ?? null,
      source_search_mode: mode,
      matched_field: matchedField,
      source_url: buildPublicSourceUrl({ exactUrl: row.source_url, mode, keyword })
    };
  });
}
