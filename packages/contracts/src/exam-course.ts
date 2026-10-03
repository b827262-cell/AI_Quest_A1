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
  limit: z.coerce.number().int().min(1).max(100).optional()
}).strict();
export type ExamCourseSearchQueryV1 = z.infer<typeof examCourseSearchQueryV1Schema>;

/**
 * Result rows expose exactly the five fields the public answer page renders.
 * Provenance that is not displayable (hash, fetch timestamp) never crosses
 * this boundary.
 */
export const examCourseSearchResultV1Schema = z.object({
  exam_year: examCourseYearV1Schema,
  course_code: z.string().min(1).max(128),
  course_name: z.string().min(1).max(512),
  course_content: z.string().max(20_000),
  source_url: z.string().min(1).max(2_048)
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

export function searchExamCourseRows(
  rows: readonly ExamCourseSearchRow[],
  query: ExamCourseSearchQueryV1,
  limit: number = 20
): ExamCourseSearchResultV1[] {
  return rows
    .filter((row) =>
      matchesExamCourseYear(row, query.exam_year) &&
      (!query.category || row.category === query.category) &&
      matchesExamCourseCode(row, query.course_code) &&
      matchesExamCourseKeyword(row, query.keyword)
    )
    .slice(0, limit)
    .map((row) => ({
      exam_year: row.exam_year,
      course_code: row.course_code,
      course_name: row.course_name,
      course_content: row.course_content,
      source_url: row.source_url
    }));
}
