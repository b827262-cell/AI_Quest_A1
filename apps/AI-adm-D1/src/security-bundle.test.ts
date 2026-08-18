import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const distRoot = join(process.cwd(), "dist");

function requireBuiltBundle(): void {
  // Clean-checkout guard: this suite asserts against the PRODUCTION bundle,
  // so it needs `pnpm build` to have run before `pnpm test`. Fail with an
  // actionable message instead of an opaque assertion (release gates must
  // always order build before test; never rely on a stale local dist/).
  if (!existsSync(join(distRoot, "index.html"))) {
    throw new Error(
      "dist/index.html not found: the admin production bundle has not been built. "
      + "Run `pnpm build` (or `pnpm --filter AI-adm-D1 build`) BEFORE `pnpm test`. "
      + "Release gates must keep the build -> test order."
    );
  }
}

describe("admin production bundle security", () => {
  it("does not contain the server-only ADMIN_API_TOKEN name or value", () => {
    requireBuiltBundle();
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
