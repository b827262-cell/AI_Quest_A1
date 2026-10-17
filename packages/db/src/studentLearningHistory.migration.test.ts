import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

describe("student learning history SQL migration", () => {
  it("can be applied twice without losing a learner's row", () => {
    const sqlite = new Database(":memory:");
    try {
      const migration = readFileSync(new URL("../sql/20261016_student_learning_history.sql", import.meta.url), "utf8");
      sqlite.exec(migration);
      sqlite.prepare("INSERT INTO student_learning_history(student_id,entry_id,asked_at,question,category,source_type,strategy,created_at,updated_at,sync_version) VALUES(?,?,?,?,?,?,?,?,?,?)")
        .run("student-fixture", "entry-fixture", "2026-10-16T10:22:00.000Z", "AI agents", "auto", "manual", "google-ai", "2026-10-16T10:22:00.000Z", "2026-10-16T10:22:00.000Z", 1);
      sqlite.exec(migration);
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM student_learning_history").get()).toMatchObject({ count: 1 });
      expect(() => sqlite.prepare("INSERT INTO student_learning_history(student_id,entry_id,asked_at,question,category,source_type,strategy,created_at,updated_at,sync_version) VALUES(?,?,?,?,?,?,?,?,?,?)")
        .run("student-fixture", "entry-fixture", "2026-10-16T10:22:00.000Z", "duplicate", "auto", "manual", "google-ai", "2026-10-16T10:22:00.000Z", "2026-10-16T10:22:00.000Z", 1)).toThrow();
    } finally { sqlite.close(); }
  });
});
