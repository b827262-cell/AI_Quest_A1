import { asc, eq } from "drizzle-orm";
import type { Db } from "../client";
import { aiMultiModelPilotMetrics, aiMultiModelPilotSettings } from "../schema";
import { newId, nowIso } from "./util";

type PilotCategory = "programming" | "mathematics" | "knowledge";
type PilotStopPolicy = {
  providerFailureRateThreshold?: number;
  unresolvedRateThreshold?: number;
  budgetRejectionRateThreshold?: number;
  p95LatencyThresholdMs?: number;
  minimumRequestCount: number;
  consecutiveWindows: number;
};

function parseList(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : [];
  } catch { return []; }
}

function parsePolicy(value: string): PilotStopPolicy {
  try {
    const parsed = JSON.parse(value) as Partial<PilotStopPolicy>;
    return {
      ...(typeof parsed.providerFailureRateThreshold === "number" ? { providerFailureRateThreshold: parsed.providerFailureRateThreshold } : {}),
      ...(typeof parsed.unresolvedRateThreshold === "number" ? { unresolvedRateThreshold: parsed.unresolvedRateThreshold } : {}),
      ...(typeof parsed.budgetRejectionRateThreshold === "number" ? { budgetRejectionRateThreshold: parsed.budgetRejectionRateThreshold } : {}),
      ...(typeof parsed.p95LatencyThresholdMs === "number" ? { p95LatencyThresholdMs: parsed.p95LatencyThresholdMs } : {}),
      minimumRequestCount: typeof parsed.minimumRequestCount === "number" ? parsed.minimumRequestCount : 1,
      consecutiveWindows: typeof parsed.consecutiveWindows === "number" ? parsed.consecutiveWindows : 1
    };
  } catch { return { minimumRequestCount: 1, consecutiveWindows: 1 }; }
}

function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
}

export function makeAiMultiModelPilotRepo(db: Db) {
  return {
    getSettings() {
      const row = db.select().from(aiMultiModelPilotSettings).where(eq(aiMultiModelPilotSettings.id, "default")).get();
      if (!row) return undefined;
      return { ...row, allowedTaskCategories: parseList(row.allowedTaskCategoriesJson) as PilotCategory[], stopPolicy: parsePolicy(row.stopPolicyJson), readinessReview: parseObject(row.readinessReviewJson) };
    },
    saveSettings(input: {
      enabled: boolean;
      trafficPercentage: number;
      allowedTaskCategories: PilotCategory[];
      allowVerification: boolean;
      allowAdjudication: boolean;
      maxModelCallsPerRequest: number;
      pilotVersion: string;
      stopPolicy: PilotStopPolicy;
      readinessReview?: Record<string, unknown>;
      updatedByAdminId?: string;
    }) {
      const now = nowIso();
      db.insert(aiMultiModelPilotSettings).values({
        id: "default", enabled: input.enabled, trafficPercentage: input.trafficPercentage,
        allowedTaskCategoriesJson: JSON.stringify(input.allowedTaskCategories), allowVerification: input.allowVerification,
        allowAdjudication: input.allowAdjudication, maxModelCallsPerRequest: input.maxModelCallsPerRequest,
        pilotVersion: input.pilotVersion, stopPolicyJson: JSON.stringify(input.stopPolicy), readinessReviewJson: JSON.stringify(input.readinessReview ?? {}), autoStoppedAt: null,
        autoStopReason: null, updatedAt: now, updatedByAdminId: input.updatedByAdminId ?? null
      }).onConflictDoUpdate({ target: aiMultiModelPilotSettings.id, set: {
        enabled: input.enabled, trafficPercentage: input.trafficPercentage,
        allowedTaskCategoriesJson: JSON.stringify(input.allowedTaskCategories), allowVerification: input.allowVerification,
        allowAdjudication: input.allowAdjudication, maxModelCallsPerRequest: input.maxModelCallsPerRequest,
        pilotVersion: input.pilotVersion, stopPolicyJson: JSON.stringify(input.stopPolicy), readinessReviewJson: JSON.stringify(input.readinessReview ?? {}), autoStoppedAt: null,
        autoStopReason: null, updatedAt: now, updatedByAdminId: input.updatedByAdminId ?? null
      }}).run();
      return this.getSettings()!;
    },
    saveReadinessReview(review: Record<string, unknown>, updatedByAdminId?: string) {
      const current = this.getSettings();
      if (!current) return undefined;
      const now = nowIso();
      db.update(aiMultiModelPilotSettings).set({ readinessReviewJson: JSON.stringify(review), updatedAt: now, updatedByAdminId: updatedByAdminId ?? null }).where(eq(aiMultiModelPilotSettings.id, "default")).run();
      return this.getSettings();
    },
    markAutoStopped(reason: string, stoppedAt = nowIso()) {
      db.update(aiMultiModelPilotSettings).set({ enabled: false, trafficPercentage: 0, autoStoppedAt: stoppedAt, autoStopReason: reason.slice(0, 160), updatedAt: stoppedAt }).where(eq(aiMultiModelPilotSettings.id, "default")).run();
      return this.getSettings();
    },
    listMetrics(limit = 100) {
      return db.select().from(aiMultiModelPilotMetrics).orderBy(asc(aiMultiModelPilotMetrics.windowKey)).limit(Math.min(1000, Math.max(1, Math.floor(limit)))).all();
    },
    recordWindow(input: {
      windowKey: string;
      trafficClass: "pilot" | "non_pilot";
      requestCount?: number;
      primaryOnlyCount?: number;
      verificationCount?: number;
      adjudicationCount?: number;
      conflictCount?: number;
      unresolvedCount?: number;
      providerFailureCount?: number;
      budgetRejectionCount?: number;
      contextWindowRejectionCount?: number;
      totalModelCalls?: number;
      totalTokens?: number;
      p50LatencyMs?: number;
      p95LatencyMs?: number;
    }) {
      const now = nowIso();
      const values = {
        requestCount: Math.max(0, Math.floor(input.requestCount ?? 0)), primaryOnlyCount: Math.max(0, Math.floor(input.primaryOnlyCount ?? 0)),
        verificationCount: Math.max(0, Math.floor(input.verificationCount ?? 0)), adjudicationCount: Math.max(0, Math.floor(input.adjudicationCount ?? 0)),
        conflictCount: Math.max(0, Math.floor(input.conflictCount ?? 0)), unresolvedCount: Math.max(0, Math.floor(input.unresolvedCount ?? 0)),
        providerFailureCount: Math.max(0, Math.floor(input.providerFailureCount ?? 0)), budgetRejectionCount: Math.max(0, Math.floor(input.budgetRejectionCount ?? 0)),
        contextWindowRejectionCount: Math.max(0, Math.floor(input.contextWindowRejectionCount ?? 0)), totalModelCalls: Math.max(0, Math.floor(input.totalModelCalls ?? 0)),
        totalTokens: Math.max(0, Math.floor(input.totalTokens ?? 0)), p50LatencyMs: Math.max(0, input.p50LatencyMs ?? 0), p95LatencyMs: Math.max(0, input.p95LatencyMs ?? 0)
      };
      const existing = db.select().from(aiMultiModelPilotMetrics).where(eq(aiMultiModelPilotMetrics.windowKey, input.windowKey)).get();
      if (existing) return existing;
      db.insert(aiMultiModelPilotMetrics).values({ id: newId("aipm"), windowKey: input.windowKey, trafficClass: input.trafficClass, ...values, createdAt: now, updatedAt: now }).run();
      return db.select().from(aiMultiModelPilotMetrics).where(eq(aiMultiModelPilotMetrics.windowKey, input.windowKey)).get()!;
    }
  };
}

export type AiMultiModelPilotRepo = ReturnType<typeof makeAiMultiModelPilotRepo>;
