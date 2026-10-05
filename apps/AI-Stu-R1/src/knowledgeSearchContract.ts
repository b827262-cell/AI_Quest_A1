/** Public-course search compatibility boundary for B3. */
import {
  buildPublicSourceUrl,
  examCourseSearchResponseV1Schema,
  type ExamCourseSourceSearchModeV1
} from "@ai-smartbook/contracts";

export type PublicExamYear = "115" | "116";
export type PublicSourceSearchMode = ExamCourseSourceSearchModeV1;
export const PUBLIC_SEARCH_MODE_OPTIONS: ReadonlyArray<{ value: PublicSourceSearchMode; label: string }> = [
  { value: "product_name", label: "品名" },
  { value: "product_code", label: "品號" },
  { value: "teacher", label: "師資" },
  { value: "scope", label: "適用範圍" }
];

export interface PublicCourseSearchResult {
  exam_year: PublicExamYear;
  course_code: string;
  course_name: string;
  course_content: string;
  source_url: string | null;
  teacher?: string | null;
  applicable_scope?: string | null;
  source_search_mode?: PublicSourceSearchMode;
  matched_field?: string;
}

export interface PublicCourseSearchRequest {
  examYear?: PublicExamYear | "all";
  query: string;
  searchMode?: PublicSourceSearchMode;
}

export const PUBLIC_EXAM_COURSE_SEARCH_PATH = "/api/public/exam-courses/search";

export class PublicCourseSearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicCourseSearchError";
  }
}

/** Normalizes the legacy B3 `search_mode` spelling once at this boundary. */
export function adaptPublicCourseResult(
  row: Omit<PublicCourseSearchResult, "source_search_mode"> & { source_search_mode?: PublicSourceSearchMode; search_mode?: PublicSourceSearchMode },
  fallbackMode: PublicSourceSearchMode,
  keyword = ""
): PublicCourseSearchResult {
  const { search_mode: _legacySearchMode, source_search_mode, ...course } = row;
  const mode = source_search_mode ?? _legacySearchMode ?? fallbackMode;
  return {
    ...course,
    source_search_mode: mode,
    source_url: buildPublicSourceUrl({ exactUrl: course.source_url, mode, keyword })
  };
}

function searchUrl(request: PublicCourseSearchRequest): URLSearchParams {
  const searchMode = request.searchMode ?? "product_name";
  const params = new URLSearchParams({ search_mode: searchMode, limit: "20" });
  if (request.examYear && request.examYear !== "all") params.set("exam_year", request.examYear);
  const query = request.query.trim();
  if (searchMode === "product_code") params.set("course_code", query);
  else if (searchMode === "teacher") params.set("teacher", query);
  else if (searchMode === "scope") params.set("applicable_scope", query);
  else params.set("keyword", query);
  return params;
}

/** Fetches the shared B3 contract; deliberately has no local catalog fallback. */
export async function searchPublicExamCourses(
  request: PublicCourseSearchRequest,
  fetcher: typeof fetch = fetch
): Promise<PublicCourseSearchResult[]> {
  const searchMode = request.searchMode ?? "product_name";
  const response = await fetcher(`${PUBLIC_EXAM_COURSE_SEARCH_PATH}?${searchUrl(request).toString()}`, {
    headers: { Accept: "application/json" }
  });
  if (!response.ok) throw new PublicCourseSearchError(`公開課程搜尋暫時無法使用（HTTP ${response.status}）`);

  const parsed = examCourseSearchResponseV1Schema.safeParse(await response.json() as unknown);
  if (!parsed.success) throw new PublicCourseSearchError("公開課程搜尋回應格式無效");

  return parsed.data.results.map((course) => adaptPublicCourseResult({
    exam_year: String(course.exam_year) as PublicExamYear,
    course_code: course.course_code,
    course_name: course.course_name,
    course_content: course.course_content,
    source_url: course.source_url,
    teacher: course.teacher ?? course.instructor ?? null,
    applicable_scope: course.applicable_scope ?? null,
    source_search_mode: course.source_search_mode,
    matched_field: course.matched_field
  }, searchMode, request.query));
}

export { buildPublicSourceUrl };
