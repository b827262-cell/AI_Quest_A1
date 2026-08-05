import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("contracts export boundary", () => {
  it("keeps the default browser entry free of server and secret-bearing code", () => {
    const browser = read("../src/browser.ts");
    expect(browser).not.toMatch(/node:|process\.env|credentialReference|\.\/server/);
  });

  it("does not export internal implementation types", () => {
    const pkg = JSON.parse(read("../package.json")) as { exports: Record<string, unknown> };
    expect(Object.keys(pkg.exports).sort()).toEqual([".", "./browser", "./server"]);
    expect(JSON.stringify(pkg.exports)).not.toContain("internal");
  });

  it("requires browser and server consumers to use public entries", () => {
    const pkg = JSON.parse(read("../package.json")) as { exports: Record<string, unknown> };
    expect(pkg.exports["./browser"]).toBeDefined();
    expect(pkg.exports["./server"]).toBeDefined();
  });
});
