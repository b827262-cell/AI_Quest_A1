import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("production server bundle contract", () => {
  it("declares every esbuild external as a direct dependency", () => {
    const appPackage = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      scripts: Record<string, string>;
      dependencies: Record<string, string>;
    };
    const externals = [...appPackage.scripts["server:build"].matchAll(/--external:([\w@/-]+)/g)].map((m) => m[1]);
    expect(externals.length).toBeGreaterThan(0);
    for (const external of externals) {
      expect(appPackage.dependencies[external], `${external} is externalized but not declared`).toBeDefined();
    }
  });
});
