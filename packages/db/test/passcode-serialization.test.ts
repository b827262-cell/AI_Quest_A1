import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("SQLite transaction serialization", () => {
  it("serializes BEGIN IMMEDIATE across two SQLite connections", () => {
    const dir = mkdtempSync(join(tmpdir(), "student-sqlite-"));
    const db1 = new Database(join(dir, "test.sqlite"));
    const db2 = new Database(join(dir, "test.sqlite"), { timeout: 0 });
    try {
      db1.exec("CREATE TABLE attempts (value INTEGER); BEGIN IMMEDIATE; INSERT INTO attempts VALUES (1)");
      expect(() => db2.exec("BEGIN IMMEDIATE")).toThrow(/locked/i);
      db1.exec("COMMIT");
      db2.exec("BEGIN IMMEDIATE; INSERT INTO attempts VALUES (2); COMMIT");
      expect(db1.prepare("SELECT count(*) AS count FROM attempts").get()).toEqual({ count: 2 });
    } finally { db1.close(); db2.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
