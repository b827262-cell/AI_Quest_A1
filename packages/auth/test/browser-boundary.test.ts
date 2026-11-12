import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("Student Auth browser boundary", () => {
  it("keeps Node, DB and secret implementation out of the browser entry", () => {
    const source = readFileSync(fileURLToPath(new URL("../src/browser.ts", import.meta.url)), "utf8");
    expect(source).not.toMatch(/node:|@ai-smartbook\/db|client_secret|GOOGLE_CLIENT_SECRET|SESSION_SECRET/);
  });
});
