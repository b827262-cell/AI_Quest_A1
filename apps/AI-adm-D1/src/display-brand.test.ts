import { describe, expect, it } from "vitest";
import { displayBrand } from "./display-brand";

describe("displayBrand", () => {
  it.each(["", "   ", "iBrain 智匯", "AI-SmartBook"])("normalizes the old or empty value %j", (value) => {
    expect(displayBrand(value)).toBe("iBrain AI");
  });
  it("preserves a custom brand exactly", () => {
    expect(displayBrand(" 我的品牌 ")).toBe(" 我的品牌 ");
  });
});
