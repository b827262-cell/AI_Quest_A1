import { and, eq } from "drizzle-orm";
import type { AiBudgetScopeType } from "@ai-smartbook/schema";
import type { Db } from "../client";
import { aiDailyUsage } from "../schema";
import { newId, nowIso } from "./util";

type Row = typeof aiDailyUsage.$inferSelect;

export type DailyUsageDelta = {
  date: string;
  scopeType: AiBudgetScopeType;
  scopeKey: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostMicroUsd: number;
  actualCostMicroUsd: number;
};

export function makeAiDailyUsageRepo(db: Db) {
  return {
    find(date: string, scopeType: AiBudgetScopeType, scopeKey: string): Row | undefined {
      return db
        .select()
        .from(aiDailyUsage)
        .where(
          and(
            eq(aiDailyUsage.date, date),
            eq(aiDailyUsage.scopeType, scopeType),
            eq(aiDailyUsage.scopeKey, scopeKey)
          )
        )
        .get();
    },

    /**
     * Atomically accumulate a usage delta into the day row (upsert + increment).
     * Uses integer micro-USD so totals stay exact (spec §13.10).
     */
    accumulate(delta: DailyUsageDelta): Row {
      const ts = nowIso();
      const existing = this.find(delta.date, delta.scopeType, delta.scopeKey);
      if (existing) {
        const patch: Partial<Row> = {
          requestCount: existing.requestCount + 1,
          inputTokens: existing.inputTokens + delta.inputTokens,
          outputTokens: existing.outputTokens + delta.outputTokens,
          totalTokens: existing.totalTokens + delta.totalTokens,
          estimatedCostMicroUsd: existing.estimatedCostMicroUsd + delta.estimatedCostMicroUsd,
          actualCostMicroUsd: existing.actualCostMicroUsd + delta.actualCostMicroUsd,
          updatedAt: ts
        };
        db.update(aiDailyUsage)
          .set(patch)
          .where(eq(aiDailyUsage.id, existing.id))
          .run();
        return { ...existing, ...patch } as Row;
      }
      const row: Row = {
        id: newId("aid"),
        date: delta.date,
        scopeType: delta.scopeType,
        scopeKey: delta.scopeKey,
        requestCount: 1,
        inputTokens: delta.inputTokens,
        outputTokens: delta.outputTokens,
        totalTokens: delta.totalTokens,
        estimatedCostMicroUsd: delta.estimatedCostMicroUsd,
        actualCostMicroUsd: delta.actualCostMicroUsd,
        reservedTokens: 0,
        reservedCostMicroUsd: 0,
        updatedAt: ts
      };
      db.insert(aiDailyUsage).values(row).run();
      return row;
    },

    /** Sum across all scopes for a given date (for global budget checks). */
    dailyGlobalTotals(date: string): {
      requestCount: number;
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      estimatedCostMicroUsd: number;
      actualCostMicroUsd: number;
      reservedTokens: number;
      reservedCostMicroUsd: number;
    } {
      const rows = db
        .select()
        .from(aiDailyUsage)
        .where(
          and(
            eq(aiDailyUsage.date, date),
            eq(aiDailyUsage.scopeType, "global"),
            eq(aiDailyUsage.scopeKey, "default")
          )
        )
        .all();
      // New databases have one global row. If a legacy database predates the
      // global row convention, retain a best-effort sum without double-counting
      // the global row together with per-source rows.
      const fallbackRows = rows.length > 0
        ? rows
        : db.select().from(aiDailyUsage).where(eq(aiDailyUsage.date, date)).all();
      return fallbackRows.reduce(
        (acc, r) => ({
          requestCount: acc.requestCount + r.requestCount,
          inputTokens: acc.inputTokens + r.inputTokens,
          outputTokens: acc.outputTokens + r.outputTokens,
          totalTokens: acc.totalTokens + r.totalTokens,
          estimatedCostMicroUsd: acc.estimatedCostMicroUsd + r.estimatedCostMicroUsd,
          actualCostMicroUsd: acc.actualCostMicroUsd + r.actualCostMicroUsd,
          reservedTokens: acc.reservedTokens + r.reservedTokens,
          reservedCostMicroUsd: acc.reservedCostMicroUsd + r.reservedCostMicroUsd
        }),
        {
          requestCount: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          estimatedCostMicroUsd: 0,
          actualCostMicroUsd: 0,
          reservedTokens: 0,
          reservedCostMicroUsd: 0
        }
      );
    }
  };
}

export type AiDailyUsageRepo = ReturnType<typeof makeAiDailyUsageRepo>;
