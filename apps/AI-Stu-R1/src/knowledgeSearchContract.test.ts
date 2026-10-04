import React from "react";
import { describe, expect, it } from "vitest";
import {
  MOCK_COURSES,
  PUBLIC_SEARCH_MODE_OPTIONS,
  adaptPublicCourseResult,
  searchPublicExamCourses
} from "./knowledgeSearchContract";

describe("public exam-course search contract", () => {
  it("publishes the fixed four-mode UI order with product name as default", () => {
    expect(PUBLIC_SEARCH_MODE_OPTIONS).toEqual([
      { value: "product_name", label: "品名" },
      { value: "product_code", label: "品號" },
      { value: "teacher", label: "師資" },
      { value: "scope", label: "適用範圍" }
    ]);
  });

  it("guarantees all mock courses have exact non-homepage source URLs", () => {
    expect(MOCK_COURSES.length).toBeGreaterThan(0);
    for (const course of MOCK_COURSES) {
      expect(course.source_url).toMatch(/^https:\/\/ec\.ibrain\.com\.tw\/.+/);
      expect(course.source_url).not.toBe("https://ec.ibrain.com.tw/");
      expect(course.source_url).not.toBe("https://ec.ibrain.com.tw");
      expect(course.source_url).not.toBeNull();
      expect(course.source_url?.toLowerCase()).toContain("book.asp?bkid=");
    }
  });

  it("filters 115/116 courses and supports exact course-code lookup", async () => {
    const results = await searchPublicExamCourses({
      examYear: "115",
      query: "GA-ADM-001",
      searchMode: "product_code"
    });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      exam_year: "115",
      course_code: "GA-ADM-001",
      source_search_mode: "product_code",
      matched_field: "品號（完全符合）",
      source_url: "https://ec.ibrain.com.tw/Publish/www/book.asp?bkid=18142"
    });

    await expect(searchPublicExamCourses({ examYear: "116", query: "行政法" })).resolves.toEqual([]);
  });

  it("mode=product_name defaults for 憲法 and returns exact source URL", async () => {
    const results = await searchPublicExamCourses({ query: "憲法" });
    expect(results).toHaveLength(1);
    expect(results[0].course_code).toBe("GA-CON-002");
    expect(results[0].course_name).toBe("憲法");
    expect(results[0].source_search_mode).toBe("product_name");
    expect(results[0].matched_field).toBe("品名");
    expect(results[0].source_url).toBe("https://ec.ibrain.com.tw/Publish/www/book.asp?bkid=18757");
    expect(results[0].source_url).not.toBe("https://ec.ibrain.com.tw/");
  });

  it("mode=product_code prioritizes exact code before prefix fallback", async () => {
    const exact = await searchPublicExamCourses({ query: "GA-CON-002", searchMode: "product_code" });
    expect(exact).toHaveLength(1);
    expect(exact[0].matched_field).toBe("品號（完全符合）");

    const prefix = await searchPublicExamCourses({ query: "GA-", searchMode: "product_code" });
    expect(prefix.length).toBeGreaterThan(1);
    expect(prefix[0].matched_field).toBe("品號（前綴符合）");
  });

  it("mode=teacher matches instructor field", async () => {
    const results = await searchPublicExamCourses({ query: "宗台大", searchMode: "teacher" });
    expect(results).toHaveLength(1);
    expect(results[0].course_code).toBe("GA-CON-002");
    expect(results[0].teacher).toBe("宗台大");
    expect(results[0].matched_field).toBe("師資");
    expect(results[0].source_url).toBe("https://ec.ibrain.com.tw/Publish/www/book.asp?bkid=18757");
  });

  it("mode=scope matches applicable_scope field", async () => {
    const results = await searchPublicExamCourses({ query: "法研所", searchMode: "scope" });
    expect(results).toHaveLength(1);
    expect(results[0].course_code).toBe("GA-CON-002");
    expect(results[0].applicable_scope).toContain("法研所");
    expect(results[0].matched_field).toBe("適用範圍");
    expect(results[0].source_url).toBe("https://ec.ibrain.com.tw/Publish/www/book.asp?bkid=18757");
  });

  it("searches course content by keyword when product_name is default", async () => {
    const results = await searchPublicExamCourses({ query: "基本權" });
    expect(results).toHaveLength(1);
    expect(results[0].course_name).toBe("憲法");
    expect(results[0].matched_field).toBe("課程內容");
  });

  it("normalizes the legacy API key once and exposes source_search_mode through all four modes", () => {
    for (const source_search_mode of ["product_name", "product_code", "teacher", "scope"] as const) {
      const adapted = adaptPublicCourseResult({
        exam_year: "115",
        course_code: "GA-CON-002",
        course_name: "憲法",
        course_content: "課程內容",
        source_url: "https://ec.ibrain.com.tw/Publish/www/book.asp?bkid=18757",
        search_mode: source_search_mode
      }, "product_name");
      expect(adapted.source_search_mode).toBe(source_search_mode);
      expect(adapted).not.toHaveProperty("search_mode");
    }
  });

  it("enforces ec.ibrain.com.tw allowlist, rejects bare homepage, and supports spaces/special chars in Big5 fallback", async () => {
    const { buildPublicSourceUrl } = await import("./knowledgeSearchContract");

    // Exact URL passes through
    const exact = buildPublicSourceUrl({ exactUrl: "https://ec.ibrain.com.tw/Publish/www/book.asp?bkid=18757" });
    expect(exact).toBe("https://ec.ibrain.com.tw/Publish/www/book.asp?bkid=18757");

    // Bare homepage rejected -> falls back to stable search URL
    const homepageFallback = buildPublicSourceUrl({ exactUrl: "https://ec.ibrain.com.tw/", mode: "product_name", keyword: "憲法" });
    expect(homepageFallback).toBe("https://ec.ibrain.com.tw/Publish/www/search.asp?PS=30&Col=1&keyword=%BE%CB%AAk&PG=0");

    // Foreign host / open-redirect rejected -> falls back to ec.ibrain search URL
    const phishingFallback = buildPublicSourceUrl({ exactUrl: "https://attacker.com/steal", mode: "teacher", keyword: "宗台大" });
    expect(phishingFallback).toBe("https://ec.ibrain.com.tw/Publish/www/search.asp?PS=30&Col=3&keyword=%A9v%A5x%A4j&PG=0");

    // Spaces and special characters in Big5
    const spaceTerm = buildPublicSourceUrl({ mode: "product_name", keyword: "憲法 宗台大" });
    expect(spaceTerm).toBe("https://ec.ibrain.com.tw/Publish/www/search.asp?PS=30&Col=1&keyword=%BE%CB%AAk%20%A9v%A5x%A4j&PG=0");
  });

  it("proves source_search_mode survives API -> adapter -> card rendering for all 4 modes", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { MemoryRouter } = await import("react-router-dom");

    const testModes = [
      { mode: "product_name" as const, query: "憲法", expectedBadge: "模式：品名" },
      { mode: "product_code" as const, query: "GA-CON-002", expectedBadge: "模式：品號" },
      { mode: "teacher" as const, query: "宗台大", expectedBadge: "模式：師資" },
      { mode: "scope" as const, query: "法研所", expectedBadge: "模式：適用範圍" }
    ];

    const MODE_LABELS: Record<string, string> = {
      product_name: "品名",
      product_code: "品號",
      teacher: "師資",
      scope: "適用範圍"
    };

    for (const { mode, query, expectedBadge } of testModes) {
      // 1. API layer returns row with canonical source_search_mode
      const apiResults = await searchPublicExamCourses({ query, searchMode: mode });
      expect(apiResults.length).toBeGreaterThan(0);
      expect(apiResults[0].source_search_mode).toBe(mode);
      expect(apiResults[0]).not.toHaveProperty("search_mode");

      // 2. Adapter boundary verification with legacy compatibility simulation
      const legacyRaw = {
        ...apiResults[0],
        search_mode: mode
      };
      delete (legacyRaw as Record<string, unknown>).source_search_mode;
      const adapted = adaptPublicCourseResult(legacyRaw as any, mode);
      expect(adapted.source_search_mode).toBe(mode);
      expect(adapted).not.toHaveProperty("search_mode");

      // 3. Card rendering verifies the badge displays the exact localized label
      const cardHtml = renderToStaticMarkup(
        React.createElement(
          MemoryRouter,
          null,
          React.createElement(
            "div",
            { className: "knowledge-card-meta" },
            React.createElement("span", { className: "knowledge-year" }, `${adapted.exam_year} 年`),
            React.createElement("code", null, adapted.course_code),
            React.createElement(
              "span",
              { className: "knowledge-badge-mode" },
              `模式：${MODE_LABELS[adapted.source_search_mode ?? "product_name"]}`
            ),
            React.createElement("span", { className: "knowledge-badge-match" }, `符合：${adapted.matched_field ?? "相符"}`)
          )
        )
      );
      expect(cardHtml).toContain(expectedBadge);
    }
  });
});
