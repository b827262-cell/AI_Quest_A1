import { describe, expect, it } from "vitest";
import rawSnapshot from "../../../data/b1-ibrain-public/raw-snapshot.json";
import { buildKnowledgePriorities, extractGroundedSubjects } from "./knowledgeAiDiagnostic";
import type { PublicCourseSearchResult } from "./knowledgeSearchContract";

const course = (overrides: Partial<PublicCourseSearchResult>): PublicCourseSearchResult => ({ exam_year: "115", course_code: "C-1", course_name: "憲法", course_content: "基本權與違憲審查。", source_url: null, ...overrides });

describe("knowledge AI diagnostic", () => {
  it("extracts only a literal, source-visible subject with its evidence", () => {
    expect(extractGroundedSubjects(course({ course_name: "行政法概要", course_content: "行政程序與救濟。" }))).toEqual([{ subject: "行政法概要", sourceField: "course_name", evidence: "行政法概要" }]);
  });

  it("does not invent a subject or question when source detail is insufficient", () => {
    const priority = buildKnowledgePriorities([course({ course_name: "115 高普考全修課程", course_content: "公開頁面只有類科說明。" })])[0];
    expect(priority).toMatchObject({ level: "category", evidenceStatus: "insufficient" });
    expect(priority.recommendation).toContain("類科層級建議／資料不足");
    expect(priority.recommendation).toContain("不提供推測題目");
    expect(priority.subjects).toEqual([]);
  });

  it("prioritizes name-backed evidence before content-only evidence, stably", () => {
    const priorities = buildKnowledgePriorities([
      course({ course_code: "content", course_name: "題庫課程", course_content: "統計學重點整理。" }),
      course({ course_code: "name", course_name: "會計學", course_content: "公開課程。" }),
      course({ course_code: "none", course_name: "全修課程", course_content: "類科說明。" })
    ]);
    expect(priorities.map((item) => item.course.course_code)).toEqual(["name", "content", "none"]);
  });

  it("keeps every emitted subject literal in its claimed source field for all B1 rows", () => {
    expect(rawSnapshot).toHaveLength(16);
    for (const row of rawSnapshot) {
      const subjects = extractGroundedSubjects(course({
        exam_year: String(row.exam_year) as "115" | "116",
        course_code: row.course_code,
        course_name: row.course_name,
        course_content: row.course_content,
        source_url: row.source_url
      }));
      for (const subject of subjects) expect(row[subject.sourceField]).toContain(subject.subject);
    }
  });
});
