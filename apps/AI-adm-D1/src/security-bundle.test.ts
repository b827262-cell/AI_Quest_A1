import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const distRoot = join(process.cwd(), "dist");

describe("admin production bundle security", () => {
  it("does not contain the server-only ADMIN_API_TOKEN name or value", () => {
    expect(existsSync(join(distRoot, "index.html"))).toBe(true);
    const files = [join(distRoot, "index.html"), ...readdirSync(join(distRoot, "assets")).map((file) => join(distRoot, "assets", file))];
    const token = process.env.ADMIN_API_TOKEN?.trim();
    for (const file of files) {
      const contents = readFileSync(file, "utf8");
      expect(contents).not.toContain("ADMIN_API_TOKEN");
      expect(contents).not.toMatch(/VITE_[A-Z0-9_]*(?:TOKEN|PASSWORD|SECRET|API_KEY)/i);
      expect(contents).not.toMatch(/\b(?:localStorage|sessionStorage)\b/);
      if (token) expect(contents).not.toContain(token);
    }
  });
});
