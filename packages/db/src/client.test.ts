import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveDbPath } from "./client";

const temporaryRoots: string[] = [];

function makeWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "shared-db-path-"));
  temporaryRoots.push(root);
  writeFileSync(join(root, "pnpm-workspace.yaml"), "packages: []\n");
  const adminCwd = join(root, "apps", "AI-adm-D1");
  const studentCwd = join(root, "apps", "AI-Stu-R1");
  mkdirSync(adminCwd, { recursive: true });
  mkdirSync(studentCwd, { recursive: true });
  return { root, adminCwd, studentCwd };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("resolveDbPath", () => {
  it("uses the same repository-root default from filtered workspace cwd values", () => {
    const { root, adminCwd, studentCwd } = makeWorkspace();
    const expected = join(root, "data", "ai-smartbook-r1.db");
    expect(resolveDbPath({}, adminCwd)).toBe(expected);
    expect(resolveDbPath({}, studentCwd)).toBe(expected);
  });

  it("anchors relative SQLite and DATABASE_URL paths at repository root", () => {
    const { root, adminCwd, studentCwd } = makeWorkspace();
    const expected = join(root, "data", "shared.db");
    expect(resolveDbPath({ SQLITE_PATH: "./data/shared.db" }, adminCwd)).toBe(expected);
    expect(resolveDbPath({ DATABASE_URL: "file:./data/shared.db" }, studentCwd)).toBe(expected);
  });

  it("keeps absolute database path overrides absolute", () => {
    const { adminCwd } = makeWorkspace();
    expect(resolveDbPath({ SQLITE_PATH: "/var/lib/shared.db" }, adminCwd)).toBe("/var/lib/shared.db");
  });
});
