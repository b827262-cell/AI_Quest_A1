import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const server = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
const service = readFileSync(new URL("./pilot-service.ts", import.meta.url), "utf8");
const page = readFileSync(new URL("../../pages/AiQualityEvaluationsPage.tsx", import.meta.url), "utf8");

describe("Phase 5A pilot gate contract", () => {
  it("exposes live readiness", () => expect(server).toContain('/api/admin/ai-evaluations/live-readiness'));
  it("exposes production readiness", () => expect(server).toContain('/api/admin/ai-pilot/production-readiness'));
  it("exposes readiness review", () => expect(server).toContain('/api/admin/ai-pilot/readiness-review'));
  it("exposes pilot settings", () => expect(server).toContain('/api/admin/ai-pilot/settings'));
  it("exposes the admin kill switch", () => expect(server).toContain('/api/admin/ai-pilot/disable'));
  it("exposes aggregate pilot metrics", () => expect(server).toContain('/api/admin/ai-pilot/metrics'));
  it("protects pilot routes with the admin guard", () => { const start = server.indexOf('/api/admin/ai-pilot'); expect(server.slice(start, start + 7000)).toContain("requireAdminAccess(req, res)"); });
  it("requires production readiness before enabling", () => expect(service).toContain("production_readiness_required"));
  it("uses deterministic assignment", () => expect(service).toContain("assignPilot(subjectId, current, category)"));
  it("does not assign before a readiness review", () => expect(service).toContain('productionReadiness().status === "ready_for_pilot"'));
  it("records a critical auto-stop alert", () => expect(service).toContain('severity: "critical"'));
  it("does not expose credentials from the service", () => expect(service).not.toMatch(/apiKey|authorization|encryptedApiKey/));
  it("shows offline and pilot gate language in the page", () => expect(page).toContain("沿用既有流程"));
  it("shows the immediate stop control", () => expect(page).toContain("立即停用 Pilot"));
  it("shows readiness blockers", () => expect(page).toContain("Readiness Blockers"));
  it("keeps the smoke test at three cases", () => expect(page).toContain('useState("3")'));
  it("does not add a student-side live provider call", () => expect(page).not.toContain("apiKey"));
});
