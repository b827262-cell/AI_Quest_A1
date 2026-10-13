import { describe, expect, it } from "vitest";
import {
  EXAM_COURSE_SEARCH_COLUMNS,
  buildExamCourseSearch,
  buildExamCourseSearchCount,
  mapExamCourseSearchRow,
  type ExamCourseSearchQuery
} from "../src/exam/exam-course.repo";

describe("exam-course.repo 4-mode and column contract", () => {
  it("includes teacher, instructor alias, and applicable_scope in search columns", () => {
    expect(EXAM_COURSE_SEARCH_COLUMNS).toContain("teacher");
    expect(EXAM_COURSE_SEARCH_COLUMNS).toContain("teacher AS instructor");
    expect(EXAM_COURSE_SEARCH_COLUMNS).toContain("applicable_scope");
  });

  it("builds SQL queries for all 4 modes targeting expected columns", () => {
    // Mode: product_name
    const nameQuery: ExamCourseSearchQuery = {
      search_mode: "product_name",
      keyword: "憲法"
    };
    const nameStmt = buildExamCourseSearch(nameQuery);
    expect(nameStmt.text).toContain("course_name ILIKE $1");
    expect(nameStmt.params).toEqual(["%憲法%", "憲法", 20]);

    // Mode: product_code
    const codeQuery: ExamCourseSearchQuery = {
      search_mode: "product_code",
      keyword: "GA-CON-002"
    };
    const codeStmt = buildExamCourseSearch(codeQuery);
    expect(codeStmt.text).toContain("course_code = $1 OR course_code LIKE $1 || '%'");
    expect(codeStmt.params).toEqual(["GA-CON-002", 20]);

    // Mode: teacher
    const teacherQuery: ExamCourseSearchQuery = {
      search_mode: "teacher",
      teacher: "宗台大"
    };
    const teacherStmt = buildExamCourseSearch(teacherQuery);
    expect(teacherStmt.text).toContain("teacher ILIKE $1");
    expect(teacherStmt.params).toEqual(["%宗台大%", 20]);

    // Mode: scope
    const scopeQuery: ExamCourseSearchQuery = {
      search_mode: "scope",
      applicable_scope: "法研所"
    };
    const scopeStmt = buildExamCourseSearch(scopeQuery);
    expect(scopeStmt.text).toContain("applicable_scope ILIKE $1");
    expect(scopeStmt.params).toEqual(["%法研所%", 20]);
  });

  it("builds consistent count SQL for teacher and scope modes", () => {
    const teacherCount = buildExamCourseSearchCount({
      search_mode: "teacher",
      teacher: "宗台大"
    });
    expect(teacherCount.text).toContain("SELECT count(*) AS total");
    expect(teacherCount.text).toContain("teacher ILIKE $1");

    const scopeCount = buildExamCourseSearchCount({
      search_mode: "scope",
      applicable_scope: "法研所"
    });
    expect(scopeCount.text).toContain("SELECT count(*) AS total");
    expect(scopeCount.text).toContain("applicable_scope ILIKE $1");
  });

  it("maps database row columns to ExamCourseSearchResult with source_search_mode", () => {
    const row = {
      exam_year: 115,
      course_code: "GA-CON-002",
      course_name: "憲法",
      course_content: "內容",
      source_url: "https://ec.ibrain.com.tw/Publish/www/book.asp?bkid=18757",
      teacher: "宗台大",
      instructor: "宗台大",
      applicable_scope: "法研所",
      source_search_mode: "teacher",
      matched_field: "師資"
    };

    const mapped = mapExamCourseSearchRow(row);
    expect(mapped).toEqual({
      exam_year: 115,
      course_code: "GA-CON-002",
      course_name: "憲法",
      course_content: "內容",
      source_url: "https://ec.ibrain.com.tw/Publish/www/book.asp?bkid=18757",
      teacher: "宗台大",
      instructor: "宗台大",
      applicable_scope: "法研所",
      source_search_mode: "teacher",
      matched_field: "師資"
    });
  });

  it("normalizes legacy search_mode in row mapping to canonical source_search_mode", () => {
    const legacyRow = {
      exam_year: 116,
      course_code: "IPKKW126262",
      course_name: "統計學",
      course_content: "統計內容",
      source_url: "https://ec.ibrain.com.tw/Publish/www/book.asp?bkid=18064",
      teacher: "趙治勳",
      applicable_scope: "116高普考統計",
      search_mode: "scope"
    };

    const mapped = mapExamCourseSearchRow(legacyRow);
    expect(mapped.source_search_mode).toBe("scope");
    expect(mapped.instructor).toBe("趙治勳");
  });
});
