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

  it("preserves the unsupported snapshot code with a localized message for HTTP 400", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      error: "unsupported_snapshot_query", message: "Snapshot keyword search supports plain words only"
    }), { status: 400 }));
    const error = await searchPublicExamCourses({ query: "行政法 OR 民法" }, fetcher).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(PublicCourseSearchError);
    expect(error).toMatchObject({ code: "unsupported_snapshot_query", message: "此搜尋語法暫時無法使用，請使用一般關鍵字。" });
    expect((error as Error).message).not.toMatch(/[A-Za-z]|400/);
  });

  it.each([
    [400, JSON.stringify({ error: "invalid_request", message: "Invalid request" })],
    [400, "not JSON"],
    [400, "null"],
    [503, JSON.stringify({ error: "unsupported_snapshot_query", message: "Service unavailable" })]
  ])("keeps the generic HTTP %i behavior for other errors", async (status, body) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status }));
    const error = await searchPublicExamCourses({ query: "憲法" }, fetcher).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(PublicCourseSearchError);
    expect(error).toMatchObject({ message: `公開課程搜尋暫時無法使用（HTTP ${status}）` });
    expect((error as PublicCourseSearchError).code).toBeUndefined();
  });
});
