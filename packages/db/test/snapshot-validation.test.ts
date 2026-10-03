import { describe, expect, it } from "vitest";
import {
  EXAM_COURSE_RECORD_COLUMNS,
  examCourseContentHashCandidates,
  validateExamSnapshot,
  type ExamCourseRecord
} from "../src/exam";

function rowWithCategory(category: string): ExamCourseRecord {
  const row: ExamCourseRecord = {
    exam_year: 116,
    category,
    course_code: "IPPP001",
    course_name: "116 普考 會計學",
    course_content: "課程內容",
    source_url: "https://ec.ibrain.com.tw/book.asp?bkid=1",
    fetched_at: "2026-10-04T00:00:00.000Z",
    content_hash: ""
  };
  return { ...row, content_hash: examCourseContentHashCandidates(row)[0].digest };
}

describe("exam snapshot category contract", () => {
  it("accepts only the literal 高普考 category", () => {
    const manifest = {
      schema_version: "b1-public-exam-course-snapshot/v1",
      rows: 1,
      record_contract: [...EXAM_COURSE_RECORD_COLUMNS],
      source_host: "ec.ibrain.com.tw",
      allowed_exam_years: [115, 116]
    };

    expect(validateExamSnapshot({ rows: [rowWithCategory("高普考")], manifest, expectedRows: 1, freshnessOverride: "VERIFIED" }).ok).toBe(true);

    for (const category of ["高考", "普考"]) {
      const report = validateExamSnapshot({ rows: [rowWithCategory(category)], manifest, expectedRows: 1, freshnessOverride: "VERIFIED" });
      expect(report.ok).toBe(false);
      expect(report.findings).toContainEqual(expect.objectContaining({ code: "CATEGORY_OUT_OF_RANGE", severity: "error" }));
    }
  });
});
