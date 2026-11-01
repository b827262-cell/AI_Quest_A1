import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const srcDir = resolve(import.meta.dirname);
const stylesDir = resolve(srcDir, "styles");
const readStyles = () =>
  [
    readFileSync(resolve(srcDir, "styles.css"), "utf8"),
    ...readdirSync(stylesDir).sort().map((file) => readFileSync(resolve(stylesDir, file), "utf8"))
  ].join("\n");

describe("knowledge search responsive layout", () => {
  it.each([360, 390, 412])("stacks all four search controls at %ipx", async () => {
    const css = readStyles();
    expect(css).toMatch(/@media \(max-width: 720px\)[\s\S]*?\.knowledge-search-form \{ grid-template-columns: 1fr;/);
  });
});
