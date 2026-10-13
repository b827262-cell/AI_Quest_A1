import { describe, expect, it } from "vitest";
import { loadExamMigrations } from "../src/exam/migrations";

function categoryCheckAllows(sql: string, category: string): boolean {
  const match = /CONSTRAINT\s+exam_courses_category_allowed\s+CHECK\s*\(\s*category\s*=\s*'([^']+)'\s*\)/m.exec(sql);
  if (!match) throw new Error("exam_courses_category_allowed must be a literal equality CHECK");
  return category === match[1];
}

describe("exam_courses PostgreSQL schema category contract", () => {
  const migration = loadExamMigrations().find(({ name }) => name === "0001_exam_courses.sql");

  it("allows only 高普考 at the database constraint boundary", () => {
    expect(migration).toBeDefined();
    const sql = migration!.sql;

    expect(categoryCheckAllows(sql, "高普考")).toBe(true);
    expect(categoryCheckAllows(sql, "高考")).toBe(false);
    expect(categoryCheckAllows(sql, "普考")).toBe(false);
  });

  it("allows the approved HTTP host with mixed-case paths, but not host lookalikes", () => {
    const sql = migration!.sql;

    expect(sql).toContain("CHECK (source_url ~ '^https?://ec\\.ibrain\\.com\\.tw([/?#]|$)')");
    const hostCheck = /^https?:\/\/ec\.ibrain\.com\.tw([/?#]|$)/;
    expect(hostCheck.test("http://ec.ibrain.com.tw/Publish/WWW/Book.asp?BKID=18064")).toBe(true);
    expect(hostCheck.test("http://foreign.example/Publish/WWW/Book.asp")).toBe(false);
    expect(hostCheck.test("http://ec.ibrain.com.tw.evil.example/Publish/WWW/Book.asp")).toBe(false);
    expect(hostCheck.test("http://evil@ec.ibrain.com.tw/Publish/WWW/Book.asp")).toBe(false);
  });
});
