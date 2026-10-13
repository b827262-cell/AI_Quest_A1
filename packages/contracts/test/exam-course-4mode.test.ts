import { describe, expect, it } from "vitest";
import {
  buildPublicSourceUrl,
  encodeBig5SearchKeyword,
  searchExamCourseRows,
  type ExamCourseSearchRow
} from "../src/exam-course";

const SAMPLE_ROWS: readonly ExamCourseSearchRow[] = [
  {
    exam_year: 115,
    category: "高普考",
    course_code: "GA-CON-002",
    course_name: "憲法",
    course_content: "高普考憲法課程，整理基本權、中央與地方權限及違憲審查重點。",
    teacher: "宗台大",
    applicable_scope: "法研所/高普考",
    source_url: "https://ec.ibrain.com.tw/Publish/www/book.asp?bkid=18757"
  },
  {
    exam_year: 115,
    category: "高普考",
    course_code: "GA-CON-002-ADV",
    course_name: "憲法進階專案",
    course_content: "進階憲法實例研習",
    teacher: "宗台大",
    applicable_scope: "法研所",
    source_url: "https://ec.ibrain.com.tw/Publish/www/book.asp?bkid=18758"
  },
  {
    exam_year: 116,
    category: "高普考",
    course_code: "IPKKW126262",
    course_name: "高普考 統計學 經典題庫班 (趙治勳) (116 行動版)",
    course_content: "統計學概要與經典題型訓練",
    teacher: "趙治勳",
    applicable_scope: "116高普考統計",
    source_url: "https://ec.ibrain.com.tw/Publish/WWW/Book.asp?BKID=18064"
  },
  {
    exam_year: 116,
    category: "高普考",
    course_code: "IPPP3727011",
    course_name: "116高上 普考 一般民政 全修課程",
    course_content: "含行政法概要、行政學概要、地方自治概要等",
    teacher: "林清",
    applicable_scope: "普考一般民政",
    source_url: "https://ec.ibrain.com.tw/Publish/www/book.asp?bkid=18142"
  }
];

describe("ExamCourse 4-mode search & source link builder", () => {
  describe("Big5 keyword encoding & special characters", () => {
    it("encodes authentic Big5 percent-encoding for common terms", () => {
      expect(encodeBig5SearchKeyword("憲法")).toBe("%BE%CB%AAk");
      expect(encodeBig5SearchKeyword("測試")).toBe("%B4%FA%B8%D5");
      expect(encodeBig5SearchKeyword("憲法？")).toBe("%BE%CB%AAk%A1H");
      expect(encodeBig5SearchKeyword("宗台大")).toBe("%A9v%A5x%A4j");
      expect(encodeBig5SearchKeyword("高普考")).toBe("%B0%AA%B4%B6%A6%D2");
      expect(encodeBig5SearchKeyword("GA-CON-002")).toBe("GA-CON-002");
    });

    it("encodes space as %20 and escapes special characters without breaking Big5", () => {
      expect(encodeBig5SearchKeyword("憲法 宗台大")).toBe("%BE%CB%AAk%20%A9v%A5x%A4j");
      expect(encodeBig5SearchKeyword("GA-CON-002 (115)")).toBe("GA-CON-002%20%28115%29");
      expect(encodeBig5SearchKeyword("憲法/行政法")).toBe("%BE%CB%AAk%2F%A6%E6%ACF%AAk");
    });

    it("uses the trusted iconv BIG5 bytes for 行政法 and fails closed when unmappable", () => {
      // `iconv -f UTF-8 -t BIG5` emits a6 e6 ac 46 aa 6b.  URL-safe bytes
      // 46 (F) and 6b (k) stay literal, matching B3's shared behavior.
      expect(encodeBig5SearchKeyword("行政法")).toBe("%A6%E6%ACF%AAk");
      expect(encodeBig5SearchKeyword("😀")).toBeNull();
    });
  });

  describe("source URL policy & host allowlist", () => {
    it("preserves exact product URL for 憲法 and verifies != homepage", () => {
      const url = buildPublicSourceUrl({
        exactUrl: "https://ec.ibrain.com.tw/Publish/www/book.asp?bkid=18757",
        mode: "product_name",
        keyword: "憲法"
      });
      expect(url).toBe("https://ec.ibrain.com.tw/Publish/www/book.asp?bkid=18757");
      expect(url).not.toBe("https://ec.ibrain.com.tw/");
      expect(url).not.toBe("https://ec.ibrain.com.tw");
    });

    it("rejects bare ec.ibrain.com.tw homepage and generates stable deep link", () => {
      const url = buildPublicSourceUrl({
        exactUrl: "https://ec.ibrain.com.tw/",
        mode: "product_name",
        keyword: "憲法"
      });
      expect(url).toBe("https://ec.ibrain.com.tw/Publish/www/search.asp?PS=30&Col=1&keyword=%BE%CB%AAk&PG=0");
    });

    it("rejects open-redirect / foreign host and generates ec.ibrain.com.tw search deep link", () => {
      const url = buildPublicSourceUrl({
        exactUrl: "https://evil.com/phishing-login",
        mode: "teacher",
        keyword: "宗台大"
      });
      expect(url).toBe("https://ec.ibrain.com.tw/Publish/www/search.asp?PS=30&Col=3&keyword=%A9v%A5x%A4j&PG=0");
    });

    it("accepts only an exact product path with a digits-only bkid", () => {
      expect(buildPublicSourceUrl({
        exactUrl: "http://ec.ibrain.com.tw/Publish/www/book.asp?bkid=18757"
      })).toBe("https://ec.ibrain.com.tw/Publish/www/book.asp?bkid=18757");

      for (const exactUrl of [
        "https://ec.ibrain.com.tw/",
        "https://evil.example/Publish/www/book.asp?bkid=18757",
        "mailto:evil.example@ec.ibrain.com.tw",
        "https://ec.ibrain.com.tw.evil.example/Publish/www/book.asp?bkid=18757",
        "https://ec.ibrain.com.tw/redirect?next=https://evil.example/",
        "https://user:password@ec.ibrain.com.tw/Publish/www/book.asp?bkid=18757",
        "https://ec.ibrain.com.tw/Publish/www/book.asp?bkid=abc"
      ]) {
        expect(buildPublicSourceUrl({ exactUrl, mode: "product_name", keyword: "憲法" }))
          .toBe("https://ec.ibrain.com.tw/Publish/www/search.asp?PS=30&Col=1&keyword=%BE%CB%AAk&PG=0");
      }
    });

    it("maps 4 modes to correct public search col (1, 2, 3, 7)", () => {
      expect(buildPublicSourceUrl({ mode: "product_name", keyword: "憲法" }))
        .toBe("https://ec.ibrain.com.tw/Publish/www/search.asp?PS=30&Col=1&keyword=%BE%CB%AAk&PG=0");
      expect(buildPublicSourceUrl({ mode: "product_code", keyword: "GA-CON-002" }))
        .toBe("https://ec.ibrain.com.tw/Publish/www/search.asp?PS=30&Col=2&keyword=GA-CON-002&PG=0");
      expect(buildPublicSourceUrl({ mode: "teacher", keyword: "宗台大" }))
        .toBe("https://ec.ibrain.com.tw/Publish/www/search.asp?PS=30&Col=3&keyword=%A9v%A5x%A4j&PG=0");
      expect(buildPublicSourceUrl({ mode: "scope", keyword: "高普考" }))
        .toBe("https://ec.ibrain.com.tw/Publish/www/search.asp?PS=30&Col=7&keyword=%B0%AA%B4%B6%A6%D2&PG=0");
    });
  });

  describe("searchExamCourseRows 4-mode matching", () => {
    it("mode=product_name finds courses by name or content and defaults for 憲法", () => {
      const results = searchExamCourseRows(SAMPLE_ROWS, {
        keyword: "憲法",
        search_mode: "product_name"
      });
      expect(results.length).toBe(2);
      expect(results[0].course_code).toBe("GA-CON-002");
      expect(results[0].source_search_mode).toBe("product_name");
      expect(results[0].matched_field).toBe("品名");
      expect(results[0].source_url).toBe("https://ec.ibrain.com.tw/Publish/www/book.asp?bkid=18757");
    });

    it("mode=product_code prioritizes exact code before prefix fallback", () => {
      const results = searchExamCourseRows(SAMPLE_ROWS, {
        course_code: "GA-CON-002",
        search_mode: "product_code"
      });
      expect(results.length).toBe(2);
      // Exact match GA-CON-002 must be first, not prefix GA-CON-002-ADV
      expect(results[0].course_code).toBe("GA-CON-002");
      expect(results[0].matched_field).toBe("品號（完全符合）");
      expect(results[1].course_code).toBe("GA-CON-002-ADV");
      expect(results[1].matched_field).toBe("品號（前綴符合）");
    });

    it("mode=teacher matches instructor field", () => {
      const results = searchExamCourseRows(SAMPLE_ROWS, {
        keyword: "趙治勳",
        search_mode: "teacher"
      });
      expect(results.length).toBe(1);
      expect(results[0].course_code).toBe("IPKKW126262");
      expect(results[0].teacher).toBe("趙治勳");
      expect(results[0].matched_field).toBe("師資");
    });

    it("mode=scope matches applicable_scope field", () => {
      const results = searchExamCourseRows(SAMPLE_ROWS, {
        keyword: "法研所",
        search_mode: "scope"
      });
      expect(results.length).toBe(2);
      expect(results[0].applicable_scope).toContain("法研所");
      expect(results[0].matched_field).toBe("適用範圍");
    });

    it("respects 115 / 116 exam year filter independently of search mode", () => {
      const results115 = searchExamCourseRows(SAMPLE_ROWS, {
        keyword: "憲法",
        exam_year: 115,
        search_mode: "product_name"
      });
      expect(results115.every((r) => r.exam_year === 115)).toBe(true);

      const results116 = searchExamCourseRows(SAMPLE_ROWS, {
        keyword: "憲法",
        exam_year: 116,
        search_mode: "product_name"
      });
      expect(results116.length).toBe(0);
    });
  });
});
