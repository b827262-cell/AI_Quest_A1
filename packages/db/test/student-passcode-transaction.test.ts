import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { expect, it, vi } from "vitest";
import { runMigrations } from "../src/migrate";
import { makeStudentPasscodeRepo } from "../src/repositories/studentPasscode.repo";
import { schema } from "../src/schema";

it("starts changeAndRevoke with an immediate SQLite transaction", () => {
  const sqlite = new Database(":memory:");
  try {
    runMigrations(sqlite);
    const db = drizzle(sqlite, { schema });
    const repo = makeStudentPasscodeRepo(db);
    const row = repo.create({ email: "student@example.test", passcodeHash: "hash" });
    const transaction = vi.spyOn(db, "transaction");
    expect(repo.changeAndRevoke(row.id, { status: "disabled" })).toBe(true);
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), { behavior: "immediate" });
    expect(repo.findActiveByEmail(row.email)).toBeUndefined();
  } finally { sqlite.close(); }
});
