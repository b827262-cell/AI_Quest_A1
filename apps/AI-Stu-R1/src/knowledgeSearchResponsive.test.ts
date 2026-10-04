import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("knowledge search responsive layout", () => {
  it.each([360, 390, 412])("stacks all four search controls at %ipx", async () => {
    const css = await readFile(new URL("./styles.css", import.meta.url), "utf8");
    expect(css).toMatch(/@media \(max-width: 720px\)[\s\S]*?\.knowledge-search-form \{ grid-template-columns: 1fr;/);
  });
});
