import { asc, eq } from "drizzle-orm";
import type { Db } from "../client";
import { aiModelDailyLimits } from "../schema";
import { nowIso } from "./util";

type Row = typeof aiModelDailyLimits.$inferSelect;

/**
 * Per logical-model daily token limit repository (dimension 3).
 *
 * `maxOutputTokens` is intentionally NOT stored here — it lives on
 * aiLogicalModels because it is a single-request Context Window concern
 * (dimension 4), not a daily quota concern.
 */
export function makeAiModelDailyLimitRepo(db: Db) {
  return {
    list(): Row[] {
      return db.select().from(aiModelDailyLimits).all();
    },

    findByLogicalModel(logicalModelId: string): Row | undefined {
      return db
        .select()
        .from(aiModelDailyLimits)
        .where(eq(aiModelDailyLimits.logicalModelId, logicalModelId))
        .get();
    },

    findByPool(poolId: string): Row[] {
      return db
        .select()
        .from(aiModelDailyLimits)
        .where(eq(aiModelDailyLimits.poolId, poolId))
        .all();
    },

    /** Enabled limits in a pool, ordered by priority (ascending = preferred). */
    listEnabledByPool(poolId: string): Row[] {
      return db
        .select()
        .from(aiModelDailyLimits)
        .where(eq(aiModelDailyLimits.poolId, poolId))
        .orderBy(asc(aiModelDailyLimits.priority), asc(aiModelDailyLimits.logicalModelId))
        .all()
        .filter((row) => row.enabled);
    },

    update(
      logicalModelId: string,
      patch: Partial<{
        poolId: string;
        dailyLimit: number;
        priority: number;
        fallbackLogicalModelId: string | null;
        enabled: boolean;
        allowSecondModelVerification: boolean;
      }>
    ): Row | undefined {
      const existing = this.findByLogicalModel(logicalModelId);
      if (!existing) return undefined;
      db.update(aiModelDailyLimits)
        .set({ ...patch, updatedAt: nowIso() })
        .where(eq(aiModelDailyLimits.id, existing.id))
        .run();
      return this.findByLogicalModel(logicalModelId);
    },

    /** Raw totals used by the reservation repo's atomic checks. */
    totals(logicalModelId: string): { usedTokens: number; reservedTokens: number; dailyLimit: number } | undefined {
      return db
        .select({
          usedTokens: aiModelDailyLimits.usedTokens,
          reservedTokens: aiModelDailyLimits.reservedTokens,
          dailyLimit: aiModelDailyLimits.dailyLimit
        })
        .from(aiModelDailyLimits)
        .where(eq(aiModelDailyLimits.logicalModelId, logicalModelId))
        .get();
    }
  };
}

export type AiModelDailyLimitRepo = ReturnType<typeof makeAiModelDailyLimitRepo>;
