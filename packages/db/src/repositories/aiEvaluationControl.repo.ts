import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../client";
import {
  aiEvaluationBudgetReservations,
  aiEvaluationDailyUsage,
  aiEvaluationPreflights,
  aiEvaluationSettings,
  aiEvaluationTokenPools
} from "../schema";
import { newId, nowIso } from "./util";

export interface EvaluationSettingsInput {
  enabled: boolean;
  evaluationPoolId?: string;
  allowedDatasetIds: string[];
  allowedLogicalModelIds: string[];
  allowedProviderIds: string[];
  maxCasesPerRun: number;
  maxTokensPerRun: number;
  maxTokensPerDay: number;
  maxConcurrentRuns: number;
  requireDryRun: boolean;
  requireExplicitConfirmation: boolean;
  updatedByAdminId?: string;
}

function parseList(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : [];
  } catch {
    return [];
  }
}

export function makeAiEvaluationControlRepo(db: Db) {
  return {
    getSettings() {
      const row = db.select().from(aiEvaluationSettings).where(eq(aiEvaluationSettings.id, "default")).get();
      if (!row) return undefined;
      return {
        ...row,
        allowedDatasetIds: parseList(row.allowedDatasetIdsJson),
        allowedLogicalModelIds: parseList(row.allowedLogicalModelIdsJson),
        allowedProviderIds: parseList(row.allowedProviderIdsJson)
      };
    },

    saveSettings(input: EvaluationSettingsInput) {
      const now = nowIso();
      db.insert(aiEvaluationSettings).values({
        id: "default",
        enabled: input.enabled,
        evaluationPoolId: input.evaluationPoolId ?? null,
        allowedDatasetIdsJson: JSON.stringify(input.allowedDatasetIds),
        allowedLogicalModelIdsJson: JSON.stringify(input.allowedLogicalModelIds),
        allowedProviderIdsJson: JSON.stringify(input.allowedProviderIds),
        maxCasesPerRun: input.maxCasesPerRun,
        maxTokensPerRun: input.maxTokensPerRun,
        maxTokensPerDay: input.maxTokensPerDay,
        maxConcurrentRuns: input.maxConcurrentRuns,
        requireDryRun: input.requireDryRun,
        requireExplicitConfirmation: input.requireExplicitConfirmation,
        updatedAt: now,
        updatedByAdminId: input.updatedByAdminId ?? null
      }).onConflictDoUpdate({ target: aiEvaluationSettings.id, set: {
        enabled: input.enabled,
        evaluationPoolId: input.evaluationPoolId ?? null,
        allowedDatasetIdsJson: JSON.stringify(input.allowedDatasetIds),
        allowedLogicalModelIdsJson: JSON.stringify(input.allowedLogicalModelIds),
        allowedProviderIdsJson: JSON.stringify(input.allowedProviderIds),
        maxCasesPerRun: input.maxCasesPerRun,
        maxTokensPerRun: input.maxTokensPerRun,
        maxTokensPerDay: input.maxTokensPerDay,
        maxConcurrentRuns: input.maxConcurrentRuns,
        requireDryRun: input.requireDryRun,
        requireExplicitConfirmation: input.requireExplicitConfirmation,
        updatedAt: now,
        updatedByAdminId: input.updatedByAdminId ?? null
      }}).run();
      return this.getSettings()!;
    },

    createPool(input: { id?: string; name: string; capacityTokens: number; enabled?: boolean; trafficClass?: "evaluation" }) {
      const now = nowIso();
      const row = {
        id: input.id ?? newId("aievp"), name: input.name,
        capacityTokens: input.capacityTokens, trafficClass: input.trafficClass ?? "evaluation", usedTokens: 0, reservedTokens: 0,
        enabled: input.enabled ?? false, createdAt: now, updatedAt: now
      };
      db.insert(aiEvaluationTokenPools).values(row).onConflictDoNothing().run();
      return db.select().from(aiEvaluationTokenPools).where(eq(aiEvaluationTokenPools.id, row.id)).get()!;
    },

    findPool(id: string) { return db.select().from(aiEvaluationTokenPools).where(eq(aiEvaluationTokenPools.id, id)).get(); },

    poolSnapshot(id: string) {
      const row = this.findPool(id);
      if (!row) return undefined;
      return { ...row, remainingTokens: Math.max(0, row.capacityTokens - row.usedTokens - row.reservedTokens) };
    },

    dailySnapshot(usageDate: string, dailyLimit: number) {
      const row = db.select().from(aiEvaluationDailyUsage).where(eq(aiEvaluationDailyUsage.usageDate, usageDate)).get();
      return { usageDate, consumedTokens: row?.consumedTokens ?? 0, reservedTokens: row?.reservedTokens ?? 0, remainingTokens: Math.max(0, dailyLimit - (row?.consumedTokens ?? 0) - (row?.reservedTokens ?? 0)) };
    },

    reserve(input: { runId: string; requestId: string; poolId: string; usageDate: string; estimatedTokens: number; dailyLimit: number }) {
      const estimated = Math.max(1, Math.floor(input.estimatedTokens));
      return db.transaction((tx) => {
        const existing = tx.select().from(aiEvaluationBudgetReservations).where(eq(aiEvaluationBudgetReservations.requestId, input.requestId)).get();
        if (existing) {
          if (existing.status === "pending") return { allowed: true, reservationId: existing.id, existingStatus: existing.status } as const;
          return { allowed: false, reason: existing.status === "settled" ? "already_settled" : "already_released" } as const;
        }
        const pool = tx.select().from(aiEvaluationTokenPools).where(eq(aiEvaluationTokenPools.id, input.poolId)).get();
        if (!pool || !pool.enabled) return { allowed: false, reason: "evaluation_pool_unavailable" } as const;
        tx.insert(aiEvaluationDailyUsage).values({ usageDate: input.usageDate, consumedTokens: 0, reservedTokens: 0, updatedAt: nowIso() }).onConflictDoNothing().run();
        const now = nowIso();
        const poolUpdate = tx.update(aiEvaluationTokenPools).set({ reservedTokens: sql`${aiEvaluationTokenPools.reservedTokens} + ${estimated}`, updatedAt: now })
          .where(and(eq(aiEvaluationTokenPools.id, input.poolId), sql`${aiEvaluationTokenPools.usedTokens} + ${aiEvaluationTokenPools.reservedTokens} + ${estimated} <= ${aiEvaluationTokenPools.capacityTokens}`)).run();
        if (poolUpdate.changes !== 1) return { allowed: false, reason: "evaluation_pool_exhausted" } as const;
        const dailyUpdate = tx.update(aiEvaluationDailyUsage).set({ reservedTokens: sql`${aiEvaluationDailyUsage.reservedTokens} + ${estimated}`, updatedAt: now })
          .where(and(eq(aiEvaluationDailyUsage.usageDate, input.usageDate), sql`${aiEvaluationDailyUsage.consumedTokens} + ${aiEvaluationDailyUsage.reservedTokens} + ${estimated} <= ${input.dailyLimit}`)).run();
        if (dailyUpdate.changes !== 1) {
          tx.update(aiEvaluationTokenPools).set({ reservedTokens: sql`max(0, ${aiEvaluationTokenPools.reservedTokens} - ${estimated})`, updatedAt: now }).where(eq(aiEvaluationTokenPools.id, input.poolId)).run();
          return { allowed: false, reason: "daily_budget_exhausted" } as const;
        }
        const id = newId("aievr");
        tx.insert(aiEvaluationBudgetReservations).values({ id, runId: input.runId, requestId: input.requestId, poolId: input.poolId, usageDate: input.usageDate, estimatedTokens: estimated, actualTokens: null, status: "pending", createdAt: now, settledAt: null, releasedAt: null }).run();
        return { allowed: true, reservationId: id } as const;
      });
    },

    settle(reservationId: string, actualTokens: number) {
      const actual = Math.max(0, Math.floor(actualTokens));
      return db.transaction((tx) => {
        const reservation = tx.select().from(aiEvaluationBudgetReservations).where(eq(aiEvaluationBudgetReservations.id, reservationId)).get();
        if (!reservation || reservation.status !== "pending") return { ok: Boolean(reservation), status: reservation?.status ?? "missing" } as const;
        const now = nowIso();
        tx.update(aiEvaluationTokenPools).set({ reservedTokens: sql`max(0, ${aiEvaluationTokenPools.reservedTokens} - ${reservation.estimatedTokens})`, usedTokens: sql`${aiEvaluationTokenPools.usedTokens} + ${actual}`, updatedAt: now }).where(eq(aiEvaluationTokenPools.id, reservation.poolId)).run();
        tx.update(aiEvaluationDailyUsage).set({ reservedTokens: sql`max(0, ${aiEvaluationDailyUsage.reservedTokens} - ${reservation.estimatedTokens})`, consumedTokens: sql`${aiEvaluationDailyUsage.consumedTokens} + ${actual}`, updatedAt: now }).where(eq(aiEvaluationDailyUsage.usageDate, reservation.usageDate)).run();
        tx.update(aiEvaluationBudgetReservations).set({ actualTokens: actual, status: "settled", settledAt: now }).where(and(eq(aiEvaluationBudgetReservations.id, reservationId), eq(aiEvaluationBudgetReservations.status, "pending"))).run();
        return { ok: true, status: "settled" as const };
      });
    },

    release(reservationId: string) {
      return db.transaction((tx) => {
        const reservation = tx.select().from(aiEvaluationBudgetReservations).where(eq(aiEvaluationBudgetReservations.id, reservationId)).get();
        if (!reservation || reservation.status !== "pending") return { ok: Boolean(reservation), status: reservation?.status ?? "missing" } as const;
        const now = nowIso();
        tx.update(aiEvaluationTokenPools).set({ reservedTokens: sql`max(0, ${aiEvaluationTokenPools.reservedTokens} - ${reservation.estimatedTokens})`, updatedAt: now }).where(eq(aiEvaluationTokenPools.id, reservation.poolId)).run();
        tx.update(aiEvaluationDailyUsage).set({ reservedTokens: sql`max(0, ${aiEvaluationDailyUsage.reservedTokens} - ${reservation.estimatedTokens})`, updatedAt: now }).where(eq(aiEvaluationDailyUsage.usageDate, reservation.usageDate)).run();
        tx.update(aiEvaluationBudgetReservations).set({ status: "released", releasedAt: now }).where(and(eq(aiEvaluationBudgetReservations.id, reservationId), eq(aiEvaluationBudgetReservations.status, "pending"))).run();
        return { ok: true, status: "released" as const };
      });
    },

    pendingReservations(runId: string) {
      return db.select().from(aiEvaluationBudgetReservations).where(and(eq(aiEvaluationBudgetReservations.runId, runId), eq(aiEvaluationBudgetReservations.status, "pending"))).all();
    },

    createPreflight(input: {
      adminId: string; datasetId: string; datasetVersion: number; selectedCaseCount: number; maxTokenBudget: number;
      logicalModelIds: string[]; providerIds: string[]; estimatedMinimumModelCalls: number; estimatedMaximumModelCalls: number;
      estimatedMaximumTokens: number; evaluationPoolRemainingTokens: number; dailyRemainingTokens: number;
      blockers: string[]; warnings: string[]; confirmationDigest?: string; allowed: boolean; expiresAt: string;
    }) {
      const now = nowIso(); const id = newId("aievf");
      db.insert(aiEvaluationPreflights).values({ id, adminId: input.adminId, datasetId: input.datasetId, datasetVersion: input.datasetVersion, selectedCaseCount: input.selectedCaseCount, maxTokenBudget: input.maxTokenBudget, logicalModelIdsJson: JSON.stringify(input.logicalModelIds), providerIdsJson: JSON.stringify(input.providerIds), estimatedMinimumModelCalls: input.estimatedMinimumModelCalls, estimatedMaximumModelCalls: input.estimatedMaximumModelCalls, estimatedMaximumTokens: input.estimatedMaximumTokens, evaluationPoolRemainingTokens: input.evaluationPoolRemainingTokens, dailyRemainingTokens: input.dailyRemainingTokens, blockersJson: JSON.stringify(input.blockers), warningsJson: JSON.stringify(input.warnings), confirmationDigest: input.confirmationDigest ?? null, allowed: input.allowed, expiresAt: input.expiresAt, usedAt: null, createdAt: now }).run();
      return db.select().from(aiEvaluationPreflights).where(eq(aiEvaluationPreflights.id, id)).get()!;
    },
    findPreflight(id: string) { return db.select().from(aiEvaluationPreflights).where(eq(aiEvaluationPreflights.id, id)).get(); },
    consumePreflight(id: string, now = nowIso()) { return db.update(aiEvaluationPreflights).set({ usedAt: now }).where(and(eq(aiEvaluationPreflights.id, id), sql`${aiEvaluationPreflights.usedAt} IS NULL`)).run().changes === 1; },
    updatePreflightDigest(id: string, digest: string) { db.update(aiEvaluationPreflights).set({ confirmationDigest: digest }).where(eq(aiEvaluationPreflights.id, id)).run(); }
  };
}

export type AiEvaluationControlRepo = ReturnType<typeof makeAiEvaluationControlRepo>;
