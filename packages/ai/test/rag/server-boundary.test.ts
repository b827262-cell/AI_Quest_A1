import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("RAG browser/server boundary", () => {
  it("keeps the browser contract entry free of server/provider imports", () => {
    const browser = readFileSync(new URL("../../src/rag/index.ts", import.meta.url), "utf8");
    expect(browser).not.toMatch(/node:|process\.env|cerebras|\.\/server|credentialResolver/);
  });

  it("publishes a separate server entry", () => {
    const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { exports: Record<string, unknown> };
    expect(packageJson.exports["./rag"]).toBeDefined();
    expect(packageJson.exports["./rag/server"]).toBeDefined();
    expect(JSON.stringify(packageJson.exports["./rag"])).not.toContain("server");
  });
});
