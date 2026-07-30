import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../client";
import {
  aiEvaluationAlertPolicies,
  aiEvaluationAlerts,
  aiEvaluationGovernanceSettings,
  aiEvaluationIssues,
  aiEvaluationMetrics,
  aiEvaluationRetentionRuns,
  aiEvaluationRuns,
  aiEvaluationScheduleRuns,
  aiEvaluationSchedules
} from "../schema";
import { newId, nowIso } from "./util";

function json<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

export function makeAiEvaluationGovernanceRepo(db: Db) {
  return {
    getSettings() {
      const row = db.select().from(aiEvaluationGovernanceSettings).where(eq(aiEvaluationGovernanceSettings.id, "default")).get();
      if (!row) return undefined;
      return { ...row, retention: json<Record<string, unknown>>(row.retentionJson, {}), regressionAlert: json<Record<string, unknown>>(row.regressionAlertJson, {}), budgetAlert: json<Record<string, unknown>>(row.budgetAlertJson, {}) };
    },
    saveSettings(input: { retention: Record<string, unknown>; regressionAlert: Record<string, unknown>; budgetAlert: Record<string, unknown>; schedulerEnabled: boolean; updatedByAdminId?: string }) {
      const now = nowIso();
      db.insert(aiEvaluationGovernanceSettings).values({ id: "default", retentionJson: JSON.stringify(input.retention), regressionAlertJson: JSON.stringify(input.regressionAlert), budgetAlertJson: JSON.stringify(input.budgetAlert), schedulerEnabled: input.schedulerEnabled, updatedAt: now, updatedByAdminId: input.updatedByAdminId ?? null })
        .onConflictDoUpdate({ target: aiEvaluationGovernanceSettings.id, set: { retentionJson: JSON.stringify(input.retention), regressionAlertJson: JSON.stringify(input.regressionAlert), budgetAlertJson: JSON.stringify(input.budgetAlert), schedulerEnabled: input.schedulerEnabled, updatedAt: now, updatedByAdminId: input.updatedByAdminId ?? null } }).run();
      return this.getSettings()!;
    },
    listSchedules() { return db.select().from(aiEvaluationSchedules).orderBy(asc(aiEvaluationSchedules.createdAt)).all(); },
    findSchedule(id: string) { return db.select().from(aiEvaluationSchedules).where(eq(aiEvaluationSchedules.id, id)).get(); },
    createSchedule(input: { id?: string; enabled: boolean; datasetId: string; datasetVersion: number; executionMode: "fixture" | "mock_orchestrator"; cadence: "daily" | "weekly"; scheduledTime: string; timezone: string; baselinePolicy: "latest_comparable" | "fixed"; fixedBaselineRunId?: string; }) {
      const now = nowIso();
      const id = input.id ?? newId("aievs");
      db.insert(aiEvaluationSchedules).values({ id, enabled: input.enabled, datasetId: input.datasetId, datasetVersion: input.datasetVersion, executionMode: input.executionMode, cadence: input.cadence, scheduledTime: input.scheduledTime, timezone: input.timezone, baselinePolicy: input.baselinePolicy, fixedBaselineRunId: input.fixedBaselineRunId ?? null, createdAt: now, updatedAt: now }).run();
      return this.findSchedule(id)!;
    },
    updateSchedule(id: string, input: Partial<{ enabled: boolean; datasetId: string; datasetVersion: number; executionMode: "fixture" | "mock_orchestrator"; cadence: "daily" | "weekly"; scheduledTime: string; timezone: string; baselinePolicy: "latest_comparable" | "fixed"; fixedBaselineRunId?: string }>) {
      const current = this.findSchedule(id);
      if (!current) return undefined;
      db.update(aiEvaluationSchedules).set({ ...input, fixedBaselineRunId: input.fixedBaselineRunId ?? (input.baselinePolicy === "latest_comparable" ? null : current.fixedBaselineRunId), updatedAt: nowIso() }).where(eq(aiEvaluationSchedules.id, id)).run();
      return this.findSchedule(id);
    },
    deleteSchedule(id: string) { return db.delete(aiEvaluationSchedules).where(eq(aiEvaluationSchedules.id, id)).run().changes > 0; },
    claimScheduleWindow(input: { scheduleId: string; scheduledWindow: string; idempotencyKey: string }) {
      const now = nowIso();
      const result = db.insert(aiEvaluationScheduleRuns).values({ id: newId("aievsr"), scheduleId: input.scheduleId, scheduledWindow: input.scheduledWindow, idempotencyKey: input.idempotencyKey, status: "running", runId: null, attemptCount: 1, safeErrorCode: null, startedAt: now, completedAt: null }).onConflictDoNothing().run();
      if (result.changes === 1) return db.select().from(aiEvaluationScheduleRuns).where(eq(aiEvaluationScheduleRuns.idempotencyKey, input.idempotencyKey)).get();
      const failed = db.select().from(aiEvaluationScheduleRuns).where(and(eq(aiEvaluationScheduleRuns.scheduleId, input.scheduleId), eq(aiEvaluationScheduleRuns.scheduledWindow, input.scheduledWindow), eq(aiEvaluationScheduleRuns.status, "failed"))).get();
      if (!failed || failed.attemptCount >= 2) return undefined;
      db.update(aiEvaluationScheduleRuns).set({ status: "running", attemptCount: failed.attemptCount + 1, safeErrorCode: null, startedAt: now, completedAt: null }).where(and(eq(aiEvaluationScheduleRuns.id, failed.id), eq(aiEvaluationScheduleRuns.status, "failed"))).run();
      return db.select().from(aiEvaluationScheduleRuns).where(eq(aiEvaluationScheduleRuns.id, failed.id)).get();
    },
    completeScheduleWindow(id: string, runId: string) { db.update(aiEvaluationScheduleRuns).set({ status: "completed", runId, completedAt: nowIso() }).where(and(eq(aiEvaluationScheduleRuns.id, id), eq(aiEvaluationScheduleRuns.status, "running"))).run(); return db.select().from(aiEvaluationScheduleRuns).where(eq(aiEvaluationScheduleRuns.id, id)).get(); },
    failScheduleWindow(id: string, safeErrorCode: string) { db.update(aiEvaluationScheduleRuns).set({ status: "failed", safeErrorCode: safeErrorCode.slice(0, 80), completedAt: nowIso() }).where(and(eq(aiEvaluationScheduleRuns.id, id), eq(aiEvaluationScheduleRuns.status, "running"))).run(); return db.select().from(aiEvaluationScheduleRuns).where(eq(aiEvaluationScheduleRuns.id, id)).get(); },
    listScheduleRuns(scheduleId?: string) { return db.select().from(aiEvaluationScheduleRuns).where(scheduleId ? eq(aiEvaluationScheduleRuns.scheduleId, scheduleId) : undefined).orderBy(desc(aiEvaluationScheduleRuns.startedAt)).limit(100).all(); },
    getAlertPolicy() { return db.select().from(aiEvaluationAlertPolicies).where(eq(aiEvaluationAlertPolicies.id, "default")).get(); },
    saveAlertPolicy(input: { enabled: boolean; minimumSampleSize: number; passRateDropPercentagePoints?: number; categoryPassRateDropPercentagePoints?: number; unresolvedRateIncreasePercentagePoints?: number; conflictRateIncreasePercentagePoints?: number; averageModelCallsIncrease?: number; p95LatencyIncreaseMs?: number; consecutiveFailuresRequired: number; evaluationPoolRemainingThreshold?: number; dailyBudgetRemainingThreshold?: number; updatedByAdminId?: string }) {
      const now = nowIso();
      const row = { id: "default", ...input, passRateDropPercentagePoints: input.passRateDropPercentagePoints ?? null, categoryPassRateDropPercentagePoints: input.categoryPassRateDropPercentagePoints ?? null, unresolvedRateIncreasePercentagePoints: input.unresolvedRateIncreasePercentagePoints ?? null, conflictRateIncreasePercentagePoints: input.conflictRateIncreasePercentagePoints ?? null, averageModelCallsIncrease: input.averageModelCallsIncrease ?? null, p95LatencyIncreaseMs: input.p95LatencyIncreaseMs ?? null, evaluationPoolRemainingThreshold: input.evaluationPoolRemainingThreshold ?? null, dailyBudgetRemainingThreshold: input.dailyBudgetRemainingThreshold ?? null, updatedAt: now, updatedByAdminId: input.updatedByAdminId ?? null };
      db.insert(aiEvaluationAlertPolicies).values(row).onConflictDoUpdate({ target: aiEvaluationAlertPolicies.id, set: { ...row, id: undefined } }).run();
      return this.getAlertPolicy()!;
    },
    listAlerts(status?: "open" | "acknowledged" | "resolved") { return db.select().from(aiEvaluationAlerts).where(status ? eq(aiEvaluationAlerts.status, status) : undefined).orderBy(desc(aiEvaluationAlerts.createdAt)).limit(100).all(); },
    createAlert(input: { runId?: string; scheduleId?: string; type: string; severity: "info" | "warning" | "critical"; safeSummary: string }) {
      const existing = db.select().from(aiEvaluationAlerts).where(and(input.runId ? eq(aiEvaluationAlerts.runId, input.runId) : sql`${aiEvaluationAlerts.runId} IS NULL`, eq(aiEvaluationAlerts.type, input.type), sql`${aiEvaluationAlerts.status} <> 'resolved'`)).get();
      if (existing) return existing;
      const id = newId("aiea");
      db.insert(aiEvaluationAlerts).values({ id, runId: input.runId ?? null, scheduleId: input.scheduleId ?? null, type: input.type, severity: input.severity, status: "open", safeSummary: input.safeSummary.slice(0, 240), createdAt: nowIso(), acknowledgedAt: null, resolvedAt: null }).run();
      return db.select().from(aiEvaluationAlerts).where(eq(aiEvaluationAlerts.id, id)).get()!;
    },
    acknowledgeAlert(id: string) { db.update(aiEvaluationAlerts).set({ status: "acknowledged", acknowledgedAt: nowIso() }).where(and(eq(aiEvaluationAlerts.id, id), eq(aiEvaluationAlerts.status, "open"))).run(); return db.select().from(aiEvaluationAlerts).where(eq(aiEvaluationAlerts.id, id)).get(); },
    resolveAlert(id: string) { db.update(aiEvaluationAlerts).set({ status: "resolved", resolvedAt: nowIso() }).where(sql`${aiEvaluationAlerts.id} = ${id} AND ${aiEvaluationAlerts.status} <> 'resolved'`).run(); return db.select().from(aiEvaluationAlerts).where(eq(aiEvaluationAlerts.id, id)).get(); },
    createRetentionPreview(input: { id?: string; candidateIds: string[]; candidateDigest: string; expiresAt: string; createdByAdminId?: string }) {
      const id = input.id ?? newId("aie-ret");
      db.insert(aiEvaluationRetentionRuns).values({ id, status: "previewed", candidateIdsJson: JSON.stringify(input.candidateIds), candidateDigest: input.candidateDigest, expiresAt: input.expiresAt, deletedCount: 0, safeErrorCode: null, createdByAdminId: input.createdByAdminId ?? null, createdAt: nowIso(), completedAt: null }).run();
      return db.select().from(aiEvaluationRetentionRuns).where(eq(aiEvaluationRetentionRuns.id, id)).get()!;
    },
    findRetentionPreview(id: string) { return db.select().from(aiEvaluationRetentionRuns).where(eq(aiEvaluationRetentionRuns.id, id)).get(); },
    executeRetentionPreview(id: string, candidateIds: string[], candidateDigest: string, now = nowIso()) {
      return db.transaction((tx) => {
        const preview = tx.select().from(aiEvaluationRetentionRuns).where(eq(aiEvaluationRetentionRuns.id, id)).get();
        if (!preview || preview.status !== "previewed" || preview.candidateDigest !== candidateDigest || Date.parse(preview.expiresAt) <= Date.parse(now)) return { deleted: 0, reason: "preview_invalid" } as const;
        const stored = json<string[]>(preview.candidateIdsJson, []);
        if (JSON.stringify(stored) !== JSON.stringify(candidateIds)) return { deleted: 0, reason: "candidate_set_changed" } as const;
        if (candidateIds.length > 0) {
          const referenced = tx.select({ id: aiEvaluationRuns.id }).from(aiEvaluationRuns).where(inArray(aiEvaluationRuns.baselineRunId, candidateIds)).get();
          if (referenced) return { deleted: 0, reason: "baseline_reference_changed" } as const;
          tx.delete(aiEvaluationMetrics).where(inArray(aiEvaluationMetrics.runId, candidateIds)).run();
          tx.delete(aiEvaluationIssues).where(inArray(aiEvaluationIssues.runId, candidateIds)).run();
          tx.delete(aiEvaluationRuns).where(inArray(aiEvaluationRuns.id, candidateIds)).run();
        }
        tx.update(aiEvaluationRetentionRuns).set({ status: "executed", deletedCount: candidateIds.length, completedAt: now }).where(and(eq(aiEvaluationRetentionRuns.id, id), eq(aiEvaluationRetentionRuns.status, "previewed"))).run();
        return { deleted: candidateIds.length, reason: "executed" } as const;
      });
    }
  };
}

export type AiEvaluationGovernanceRepo = ReturnType<typeof makeAiEvaluationGovernanceRepo>;
