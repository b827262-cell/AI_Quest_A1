import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { createRepositories } from "../src/repositories";
import { runMigrations } from "../src/migrate";
import { schema } from "../src/schema";

function setup() {
  const sqlite = new Database(":memory:");
  runMigrations(sqlite);
  return createRepositories(drizzle(sqlite, { schema }));
}

describe("student pilot control repository", () => {
  let repos: ReturnType<typeof setup>;
  beforeEach(() => { repos = setup(); });

  it("starts without an enabled pilot", () => expect(repos.aiMultiModelPilot.getSettings()).toBeUndefined());
  it("stores disabled settings safely", () => { const row = repos.aiMultiModelPilot.saveSettings({ enabled: false, trafficPercentage: 0, allowedTaskCategories: [], allowVerification: true, allowAdjudication: false, maxModelCallsPerRequest: 2, pilotVersion: "v1", stopPolicy: { minimumRequestCount: 10, consecutiveWindows: 2 } }); expect(row.enabled).toBe(false); });
  it("round trips task categories", () => { repos.aiMultiModelPilot.saveSettings({ enabled: false, trafficPercentage: 0, allowedTaskCategories: ["mathematics"], allowVerification: true, allowAdjudication: false, maxModelCallsPerRequest: 2, pilotVersion: "v1", stopPolicy: { minimumRequestCount: 10, consecutiveWindows: 2 } }); expect(repos.aiMultiModelPilot.getSettings()?.allowedTaskCategories).toEqual(["mathematics"]); });
  it("round trips stop policy", () => { repos.aiMultiModelPilot.saveSettings({ enabled: false, trafficPercentage: 0, allowedTaskCategories: [], allowVerification: true, allowAdjudication: false, maxModelCallsPerRequest: 2, pilotVersion: "v1", stopPolicy: { minimumRequestCount: 12, consecutiveWindows: 3, unresolvedRateThreshold: 0.2 } }); expect(repos.aiMultiModelPilot.getSettings()?.stopPolicy).toMatchObject({ minimumRequestCount: 12, consecutiveWindows: 3, unresolvedRateThreshold: 0.2 }); });
  it("updates the singleton idempotently", () => { const first = repos.aiMultiModelPilot.saveSettings({ enabled: false, trafficPercentage: 0, allowedTaskCategories: [], allowVerification: true, allowAdjudication: false, maxModelCallsPerRequest: 2, pilotVersion: "v1", stopPolicy: { minimumRequestCount: 10, consecutiveWindows: 2 } }); const second = repos.aiMultiModelPilot.saveSettings({ enabled: false, trafficPercentage: 1, allowedTaskCategories: ["knowledge"], allowVerification: true, allowAdjudication: false, maxModelCallsPerRequest: 2, pilotVersion: "v2", stopPolicy: { minimumRequestCount: 20, consecutiveWindows: 2 } }); expect(second.id).toBe(first.id); expect(second.pilotVersion).toBe("v2"); });
  it("stores readiness review as safe booleans", () => { repos.aiMultiModelPilot.saveSettings({ enabled: false, trafficPercentage: 0, allowedTaskCategories: [], allowVerification: true, allowAdjudication: false, maxModelCallsPerRequest: 2, pilotVersion: "v1", stopPolicy: { minimumRequestCount: 10, consecutiveWindows: 2 } }); repos.aiMultiModelPilot.saveReadinessReview({ testSuitePassed: true, apiKey: "must-not-be-returned" }, "admin"); expect(repos.aiMultiModelPilot.getSettings()?.readinessReview).toMatchObject({ testSuitePassed: true }); });
  it("records pilot metrics by a unique window", () => { const row = repos.aiMultiModelPilot.recordWindow({ windowKey: "pilot:2026-07-27T00", trafficClass: "pilot", requestCount: 10, verificationCount: 5, totalTokens: 90 }); expect(row.requestCount).toBe(10); expect(row.trafficClass).toBe("pilot"); });
  it("does not duplicate a metric window", () => { const input = { windowKey: "pilot:duplicate", trafficClass: "pilot" as const, requestCount: 1 }; const first = repos.aiMultiModelPilot.recordWindow(input); const second = repos.aiMultiModelPilot.recordWindow({ ...input, requestCount: 9 }); expect(second.id).toBe(first.id); expect(second.requestCount).toBe(1); });
  it("keeps non-pilot metrics separate", () => { repos.aiMultiModelPilot.recordWindow({ windowKey: "production:1", trafficClass: "non_pilot", requestCount: 4 }); repos.aiMultiModelPilot.recordWindow({ windowKey: "pilot:1", trafficClass: "pilot", requestCount: 2 }); expect(repos.aiMultiModelPilot.listMetrics().map((row) => row.trafficClass)).toEqual(["pilot", "non_pilot"]); });
  it("clamps negative aggregate values", () => { const row = repos.aiMultiModelPilot.recordWindow({ windowKey: "pilot:negative", trafficClass: "pilot", requestCount: -4, totalTokens: -2 }); expect(row.requestCount).toBe(0); expect(row.totalTokens).toBe(0); });
  it("marks the pilot stopped without changing historical metrics", () => { repos.aiMultiModelPilot.saveSettings({ enabled: true, trafficPercentage: 1, allowedTaskCategories: ["mathematics"], allowVerification: true, allowAdjudication: false, maxModelCallsPerRequest: 2, pilotVersion: "v1", stopPolicy: { minimumRequestCount: 10, consecutiveWindows: 2 } }); repos.aiMultiModelPilot.recordWindow({ windowKey: "pilot:history", trafficClass: "pilot", requestCount: 1 }); repos.aiMultiModelPilot.markAutoStopped("threshold_exceeded"); expect(repos.aiMultiModelPilot.getSettings()).toMatchObject({ enabled: false, trafficPercentage: 0, autoStopReason: "threshold_exceeded" }); expect(repos.aiMultiModelPilot.listMetrics()).toHaveLength(1); });
  it("does not store question or answer fields", () => { const row = repos.aiMultiModelPilot.recordWindow({ windowKey: "pilot:safe", trafficClass: "pilot", requestCount: 1 }); expect(row).not.toHaveProperty("question"); expect(row).not.toHaveProperty("answer"); expect(row).not.toHaveProperty("prompt"); });
  it("retains only aggregate latency", () => { const row = repos.aiMultiModelPilot.recordWindow({ windowKey: "pilot:latency", trafficClass: "pilot", p50LatencyMs: 10, p95LatencyMs: 20 }); expect(row.p50LatencyMs).toBe(10); expect(row.p95LatencyMs).toBe(20); });
});
