import { describe, expect, it } from "vitest";
import { searchPublicExamCourses } from "./knowledgeSearchContract";

describe("public exam-course search contract", () => {
  it("filters 115/116 courses and supports exact course-code lookup", async () => {
    await expect(searchPublicExamCourses({ examYear: "115", query: "GA-ADM-001" })).resolves.toEqual([
      expect.objectContaining({ exam_year: "115", course_code: "GA-ADM-001" })
    ]);
    await expect(searchPublicExamCourses({ examYear: "116", query: "行政法" })).resolves.toEqual([]);
  });

  it("searches course name and content by keyword", async () => {
    await expect(searchPublicExamCourses({ query: "基本權" })).resolves.toEqual([
      expect.objectContaining({ course_name: "憲法" })
    ]);
  });
});
