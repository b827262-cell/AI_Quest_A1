import { describe, expect, it, vi } from "vitest";
import { PUBLIC_EXAM_COURSE_SEARCH_PATH, PUBLIC_SEARCH_MODE_OPTIONS, PublicCourseSearchError, adaptPublicCourseResult, searchPublicExamCourses } from "./knowledgeSearchContract";

const b3Response = {
  contractVersion: 1, mode: "postgres", query: { keyword: "憲法", search_mode: "product_name", limit: 20 }, total: 1,
  results: [{ exam_year: 115, course_code: "GA-CON-002", course_name: "憲法", course_content: "整理基本權與違憲審查重點。", teacher: "宗台大", applicable_scope: "法研所 / 115高普考", source_search_mode: "product_name", matched_field: "品名", source_url: "https://ec.ibrain.com.tw/Publish/www/book.asp?bkid=18757" }]
};

describe("public exam-course search contract", () => {
  it("publishes the fixed four-mode UI order", () => {
    expect(PUBLIC_SEARCH_MODE_OPTIONS).toEqual([
      { value: "product_name", label: "品名" }, { value: "product_code", label: "品號" },
      { value: "teacher", label: "師資" }, { value: "scope", label: "適用範圍" }
    ]);
  });

  it.each([
    ["product_name", "憲法", "keyword=", "search_mode=product_name"],
    ["product_code", "GA-CON-002", "course_code=GA-CON-002", "search_mode=product_code"],
    ["teacher", "宗台大", "teacher=", "search_mode=teacher"],
    ["scope", "法研所", "applicable_scope=", "search_mode=scope"]
  ] as const)("calls the real B3 boundary for %s", async (searchMode, query, expectedParam, expectedMode) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ ...b3Response, query: { keyword: query, search_mode: searchMode, limit: 20 }, results: [{ ...b3Response.results[0], source_search_mode: searchMode }] })));
    const results = await searchPublicExamCourses({ examYear: "115", query, searchMode }, fetcher);
    const url = String(fetcher.mock.calls[0][0]);
    expect(url).toContain(`${PUBLIC_EXAM_COURSE_SEARCH_PATH}?`);
    expect(url).toContain(expectedParam);
    expect(url).toContain(expectedMode);
    expect(url).toContain("exam_year=115");
    expect(results[0].source_search_mode).toBe(searchMode);
  });

  it("rejects malformed B3 data instead of falling back to local mock rows", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ results: [] })));
    await expect(searchPublicExamCourses({ query: "憲法" }, fetcher)).rejects.toBeInstanceOf(PublicCourseSearchError);
  });

  it("normalizes legacy source mode once and keeps source URLs on the approved host", () => {
    const legacy = {
      exam_year: "115" as const, course_code: "GA-CON-002", course_name: "憲法", course_content: "整理基本權與違憲審查重點。",
      teacher: "宗台大", applicable_scope: "法研所 / 115高普考", matched_field: "品名",
      source_url: "https://ec.ibrain.com.tw/Publish/www/book.asp?bkid=18757", search_mode: "teacher" as const
    };
    const adapted = adaptPublicCourseResult(legacy, "product_name", "宗台大");
    expect(adapted.source_search_mode).toBe("teacher");
    expect(adapted).not.toHaveProperty("search_mode");
    expect(adapted.source_url).toBe("https://ec.ibrain.com.tw/Publish/www/book.asp?bkid=18757");
  });

  it("surfaces B3 HTTP failures", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("down", { status: 503 }));
    await expect(searchPublicExamCourses({ query: "憲法" }, fetcher)).rejects.toThrow("HTTP 503");
  });
});
