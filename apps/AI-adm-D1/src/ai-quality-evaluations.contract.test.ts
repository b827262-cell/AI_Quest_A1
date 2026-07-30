import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const sidebarSource = readFileSync(new URL("./components/admin/AdminSidebar.tsx", import.meta.url), "utf8");
const pageSource = readFileSync(new URL("./pages/AiQualityEvaluationsPage.tsx", import.meta.url), "utf8");

describe("AI quality evaluation admin UI contract", () => {
  it("registers the expected route", () => expect(appSource).toContain("/admin/ai-quality-evaluations"));
  it("imports the quality evaluation page", () => expect(appSource).toContain("AiQualityEvaluationsPage"));
  it("shows the quality evaluation sidebar label", () => expect(sidebarSource).toContain("AI 品質評測"));
  it("places the page after quota navigation", () => expect(sidebarSource.indexOf("ai-quota-center")).toBeLessThan(sidebarSource.indexOf("ai-quality-evaluations")));
  it("has loading state", () => expect(pageSource).toContain("評測載入中"));
  it("has empty state", () => expect(pageSource).toContain("尚無評測紀錄"));
  it("has error state", () => expect(pageSource).toContain("AdminErrorCard"));
  it("shows offline accuracy disclaimer", () => expect(pageSource).toContain("不代表正式模型的真實世界準確率"));
  it("offers Fixture and Mock controls", () => { expect(pageSource).toContain("執行 Fixture 評測"); expect(pageSource).toContain("執行 Mock 評測"); });
  it("does not expose Live as a run button", () => expect(pageSource).not.toContain("執行 Live"));
  it("shows confidence calibration", () => expect(pageSource).toContain("Confidence Calibration"));
  it("shows safe failed cases", () => expect(pageSource).toContain("Safe Summary"));
  it("offers report downloads", () => { expect(pageSource).toContain("下載 JSON"); expect(pageSource).toContain("下載 Markdown"); });
  it("requires delete confirmation in the UI", () => expect(pageSource).toContain("window.confirm"));
  it("renders explicit mode badges", () => expect(pageSource).toContain("evaluation-mode-badge"));
  it("offers comparable baseline selection", () => expect(pageSource).toContain("evaluation-baseline-picker"));
});
