/**
 * Public-course search boundary.
 *
 * Exposes 4-mode search (product_name, product_code, teacher, scope)
 * and guarantees exact or search-result deep links without bare homepage links.
 */
import {
  buildPublicSourceUrl,
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
  /** Canonical B3 provenance key. */
  source_search_mode?: PublicSourceSearchMode;
  matched_field?: string;
}

export interface PublicCourseSearchRequest {
  examYear?: PublicExamYear | "all";
  query: string;
  searchMode?: PublicSourceSearchMode;
}

export const MOCK_COURSES: PublicCourseSearchResult[] = [
  {
    exam_year: "115",
    course_code: "GA-ADM-001",
    course_name: "行政法概要",
    course_content: "高普考行政法概要課程，涵蓋行政處分、行政程序與救濟的核心概念。",
    teacher: "林清",
    applicable_scope: "普考 一般民政",
    source_url: "https://ec.ibrain.com.tw/Publish/www/book.asp?bkid=18142"
  },
  {
    exam_year: "115",
    course_code: "GA-CON-002",
    course_name: "憲法",
    course_content: "高普考憲法課程，整理基本權、中央與地方權限及違憲審查重點。",
    teacher: "宗台大",
    applicable_scope: "法研所 / 115高普考",
    source_url: "https://ec.ibrain.com.tw/Publish/www/book.asp?bkid=18757"
  },
  {
    exam_year: "116",
    course_code: "GA-ACC-003",
    course_name: "會計學",
    course_content: "116 年高普考會計學課程，從會計循環、分錄到財務報表分析。",
    teacher: "鄭泓",
    applicable_scope: "普考 會計",
    source_url: "https://ec.ibrain.com.tw/Publish/www/book.asp?bkid=18127"
  },
  {
    exam_year: "115",
    course_code: "IPKKW126262",
    course_name: "高普考 統計學 經典題庫班 (趙治勳) (115 行動版)",
    course_content: "重要關頭的題庫班課程；以考古題與經典題型訓練為主，公開頁面說明本課可適用於115高普考。",
    teacher: "趙治勳",
    applicable_scope: "115高普考統計",
    source_url: "https://ec.ibrain.com.tw/Publish/WWW/Book.asp?BKID=18064"
  }
];

export { buildPublicSourceUrl };

/**
 * The sole compatibility boundary for B3 rows.  Older sidecars used
 * `search_mode`; normalize it once while adapting the response and never pass
 * that legacy spelling into the view model.
 */
export function adaptPublicCourseResult(
  row: Omit<PublicCourseSearchResult, "source_search_mode"> & { source_search_mode?: PublicSourceSearchMode; search_mode?: PublicSourceSearchMode },
  fallbackMode: PublicSourceSearchMode
): PublicCourseSearchResult {
  const { search_mode: _legacySearchMode, source_search_mode, ...course } = row;
  return { ...course, source_search_mode: source_search_mode ?? _legacySearchMode ?? fallbackMode };
}

/** Temporary local adapter; B3 can replace only this implementation with fetch. */
export async function searchPublicExamCourses(request: PublicCourseSearchRequest): Promise<PublicCourseSearchResult[]> {
  const examYear = request.examYear ?? "all";
  const searchMode: PublicSourceSearchMode = request.searchMode ?? "product_name";
  const normalized = request.query.trim().toLocaleLowerCase();

  const filtered = MOCK_COURSES.filter((course) => {
    if (examYear !== "all" && course.exam_year !== examYear) return false;
    if (!normalized) return true;

    if (searchMode === "product_code") {
      const code = course.course_code.toLocaleLowerCase();
      return code === normalized || code.startsWith(normalized);
    }
    if (searchMode === "teacher") {
      return (course.teacher ?? "").toLocaleLowerCase().includes(normalized);
    }
    if (searchMode === "scope") {
      return (course.applicable_scope ?? "").toLocaleLowerCase().includes(normalized);
    }
    // Default: product_name
    return (
      course.course_name.toLocaleLowerCase().includes(normalized) ||
      course.course_content.toLocaleLowerCase().includes(normalized)
    );
  });

  // For product_code, prioritize exact match over prefix match
  if (searchMode === "product_code" && normalized) {
    filtered.sort((a, b) => {
      const aExact = a.course_code.toLocaleLowerCase() === normalized ? 0 : 1;
      const bExact = b.course_code.toLocaleLowerCase() === normalized ? 0 : 1;
      return aExact - bExact;
    });
  }

  return filtered.map((course) => {
    let matchedField = "課名";
    if (searchMode === "product_code") {
      matchedField = course.course_code.toLocaleLowerCase() === normalized ? "品號（完全符合）" : "品號（前綴符合）";
    } else if (searchMode === "teacher") {
      matchedField = "師資";
    } else if (searchMode === "scope") {
      matchedField = "適用範圍";
    } else if (course.course_name.toLocaleLowerCase().includes(normalized)) {
      matchedField = "品名";
    } else {
      matchedField = "課程內容";
    }

    return adaptPublicCourseResult({
      ...course,
      matched_field: matchedField,
      source_url: buildPublicSourceUrl({
        exactUrl: course.source_url,
        mode: searchMode,
        keyword: request.query
      })
    }, searchMode);
  });
}
