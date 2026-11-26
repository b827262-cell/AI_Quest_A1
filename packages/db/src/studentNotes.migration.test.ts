import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { runMigrations } from "./migrate";

function indexExists(sqlite: Database.Database, name: string): boolean {
  return Boolean(sqlite
    .prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name = ?")
    .get(name));
}

describe("student notes migration", () => {
  it("runs twice without error and creates the entry-unique index", () => {
    const sqlite = new Database(":memory:");
    try {
      expect(() => {
        runMigrations(sqlite);
        runMigrations(sqlite);
      }).not.toThrow();
      expect(indexExists(sqlite, "uq_student_notes_entry")).toBe(true);
      expect(indexExists(sqlite, "idx_student_notes_student")).toBe(true);
      expect(indexExists(sqlite, "idx_student_notes_book")).toBe(true);
      const columns = (sqlite.prepare("PRAGMA table_info(student_notes)").all() as Array<{ name: string }>)
        .map((column) => column.name);
      expect(columns).toEqual([
        "id", "student_id", "entry_id", "book_id", "chapter_id", "page_number",
        "type", "title", "content", "canvas_data", "tags", "source", "source_detail",
        "created_at", "updated_at", "deleted_at", "sync_version"
      ]);
    } finally {
      sqlite.close();
    }
  });

  it("enforces one note per (student, entry) but ignores NULL entry_id rows", () => {
    const sqlite = new Database(":memory:");
    try {
      runMigrations(sqlite);
      const now = "2026-10-20T09:00:00.000Z";
      const insert = sqlite.prepare(`
        INSERT INTO student_notes(id, student_id, entry_id, created_at, updated_at, sync_version)
        VALUES (?, ?, ?, ?, ?, 1)
      `);
      insert.run("snote-1", "student-a", "entry-1", now, now);
      expect(() => insert.run("snote-2", "student-a", "entry-1", now, now)).toThrow();
      // Same entry_id under another student is fine, and entry_id NULL rows are exempt.
      expect(() => insert.run("snote-3", "student-b", "entry-1", now, now)).not.toThrow();
      expect(() => insert.run("snote-4", "student-a", null, now, now)).not.toThrow();
      expect(() => insert.run("snote-5", "student-a", null, now, now)).not.toThrow();
    } finally {
      sqlite.close();
    }
  });
});
