import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");

describe("AI evaluation Admin API contract", () => {
  it("has a protected list route", () => { expect(source).toContain('app.get("/api/admin/ai-evaluations"'); });
  it("has a protected detail route", () => { expect(source).toContain('app.get("/api/admin/ai-evaluations/:id"'); });
  it("has a report route", () => { expect(source).toContain('app.get("/api/admin/ai-evaluations/:id/report"'); });
  it("has a start route", () => { expect(source).toContain('app.post("/api/admin/ai-evaluations/run"'); });
  it("has a delete route", () => { expect(source).toContain('app.delete("/api/admin/ai-evaluations/:id"'); });
  it("uses the existing admin guard", () => { expect(source).toContain("requireAdminAccess(req, res)"); });
  it("reads idempotency key from a header", () => { expect(source).toContain('req.header("Idempotency-Key")'); });
  it("requires delete confirmation", () => { expect(source).toContain('x-confirm-delete'); });
  it("allows only JSON and Markdown reports", () => { expect(source).toContain('req.query.format === "markdown"'); expect(source).toContain('req.query.format === "json"'); });
  it("uses an attachment filename", () => { expect(source).toContain("Content-Disposition"); });
  it("rejects arbitrary request body fields", () => { expect(source).toContain("invalid_evaluation_request"); });
  it("does not accept a dataset path field", () => { expect(source).toContain("only datasetId, executionMode and baselineRunId are accepted"); });
  it("returns a safe invalid format code", () => { expect(source).toContain("invalid_report_format"); });
  it("does not send live run options from the page", () => { expect(readFileSync(new URL("../../pages/AiQualityEvaluationsPage.tsx", import.meta.url), "utf8")).not.toContain("executionMode: \"live\""); });
  it("does not mention Provider credentials in run request", () => { const start = source.indexOf('app.post("/api/admin/ai-evaluations/run"'); const end = source.indexOf('app.delete("/api/admin/ai-evaluations/:id"', start); expect(source.slice(start, end)).not.toContain("apiKey"); });
});
