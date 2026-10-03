/**
 * Public-course search boundary.
 *
 * The mock deliberately has the same response shape that the eventual B3
 * search endpoint returns, so the page can switch transports without a UI
 * rewrite.  This module contains no authentication state or credentials.
 */
export type PublicExamYear = "115" | "116";

export interface PublicCourseSearchResult {
  exam_year: PublicExamYear;
  course_code: string;
  course_name: string;
  course_content: string;
  source_url: string;
}

export interface PublicCourseSearchRequest {
  examYear?: PublicExamYear | "all";
  query: string;
}

const MOCK_COURSES: PublicCourseSearchResult[] = [
  {
    exam_year: "115",
    course_code: "GA-ADM-001",
    course_name: "行政法概要",
    course_content: "高普考行政法概要課程，涵蓋行政處分、行政程序與救濟的核心概念。",
    source_url: "https://ec.ibrain.com.tw/"
  },
  {
    exam_year: "115",
    course_code: "GA-CON-002",
    course_name: "憲法",
    course_content: "高普考憲法課程，整理基本權、中央與地方權限及違憲審查重點。",
    source_url: "https://ec.ibrain.com.tw/"
  },
  {
    exam_year: "116",
    course_code: "GA-ACC-003",
    course_name: "會計學",
    course_content: "116 年高普考會計學課程，從會計循環、分錄到財務報表分析。",
    source_url: "https://ec.ibrain.com.tw/"
  }
];

function matchesCourse(course: PublicCourseSearchResult, query: string) {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return true;
  // course_code is deliberately exact; name/content permit keyword matching.
  return course.course_code.toLocaleLowerCase() === normalized
    || `${course.course_name} ${course.course_content}`.toLocaleLowerCase().includes(normalized);
}

/** Temporary local adapter; B3 can replace only this implementation with fetch. */
export async function searchPublicExamCourses(request: PublicCourseSearchRequest): Promise<PublicCourseSearchResult[]> {
  const examYear = request.examYear ?? "all";
  return MOCK_COURSES.filter((course) =>
    (examYear === "all" || course.exam_year === examYear) && matchesCourse(course, request.query)
  );
}
