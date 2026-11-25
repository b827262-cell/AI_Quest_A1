import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveStudentAuthDbPath } from "./student-auth-db-path";

const temporaryRoots: string[] = [];

function makeWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "student-auth-db-path-"));
  temporaryRoots.push(root);
  writeFileSync(join(root, "pnpm-workspace.yaml"), "packages: []\n");
  mkdirSync(join(root, "apps", "AI-Stu-R1"), { recursive: true });
  return { root, app: join(root, "apps", "AI-Stu-R1") };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("resolveStudentAuthDbPath", () => {
  it("anchors the default database at repository root from a workspace cwd", () => {
    const { root, app } = makeWorkspace();
    expect(resolveStudentAuthDbPath({}, app)).toBe(join(root, "data", "ai-smartbook-r1.db"));
  });

  it("anchors relative auth and shared SQLite overrides at repository root", () => {
    const { root, app } = makeWorkspace();
    expect(resolveStudentAuthDbPath({ STUDENT_AUTH_DB_PATH: "./data/auth.db" }, app)).toBe(join(root, "data", "auth.db"));
    expect(resolveStudentAuthDbPath({ SQLITE_PATH: "./data/shared.db" }, app)).toBe(join(root, "data", "shared.db"));
  });

  it("preserves an explicitly absolute auth database path", () => {
    const { app } = makeWorkspace();
    expect(resolveStudentAuthDbPath({ STUDENT_AUTH_DB_PATH: "/var/lib/student-auth.db" }, app)).toBe("/var/lib/student-auth.db");
  });
});
