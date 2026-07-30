import { eq } from "drizzle-orm";
import type { Db } from "../client";
import { aiTokenPools } from "../schema";
import { newId, nowIso } from "./util";

type Row = typeof aiTokenPools.$inferSelect;

export interface TokenPoolSnapshot {
  id: string;
  name: string;
  poolType: string;
  timezone: string;
  dailyLimit: number;
  usedTokens: number;
  reservedTokens: number;
  /** Settled + reserved, never exceeds dailyLimit in a healthy pool. */
  committedTokens: number;
  remaining: number;
  /** Remaining capacity minus the sum of member model hard caps (>= 0). */
  unallocatedCapacity: number;
  /** Utilization ratio in 0..1+ (committed / dailyLimit). */
  utilizationRatio: number;
  warningThreshold: number;
  throttleThreshold: number;
  criticalThreshold: number;
  resetAt: string;
  enabled: boolean;
}

/**
 * Daily Token Pool repository.
 *
 * Pools are a daily-usage dimension (dimension 1), completely separate from
 * the single-request Context Window (dimension 4). The daily reset boundary
 * is timezone-aware (default Asia/Taipei); the actual reset happens atomically
 * inside aiTokenPoolReservationRepo.reserve(), never as a standalone call.
 */
export function makeAiTokenPoolRepo(db: Db) {
  return {
    list(): Row[] {
      return db.select().from(aiTokenPools).all();
    },

    findById(id: string): Row | undefined {
      return db.select().from(aiTokenPools).where(eq(aiTokenPools.id, id)).get();
    },

    findByType(poolType: string): Row | undefined {
      return db.select().from(aiTokenPools).where(eq(aiTokenPools.poolType, poolType)).get();
    },

    create(input: {
      name: string;
      poolType: string;
      timezone?: string;
      dailyLimit: number;
      warningThreshold?: number;
      throttleThreshold?: number;
      criticalThreshold?: number;
      resetAt: string;
      enabled?: boolean;
    }): Row {
      const ts = nowIso();
      const row: Row = {
        id: newId("aitp"),
        name: input.name,
        poolType: input.poolType,
        timezone: input.timezone ?? "Asia/Taipei",
        dailyLimit: input.dailyLimit,
        usedTokens: 0,
        reservedTokens: 0,
        warningThreshold: input.warningThreshold ?? 60,
        throttleThreshold: input.throttleThreshold ?? 80,
        criticalThreshold: input.criticalThreshold ?? 90,
        resetAt: input.resetAt,
        enabled: input.enabled ?? true,
        createdAt: ts,
        updatedAt: ts
      };
      db.insert(aiTokenPools).values(row).run();
      return row;
    },

    update(
      id: string,
      patch: Partial<{
        name: string;
        timezone: string;
        dailyLimit: number;
        warningThreshold: number;
        throttleThreshold: number;
        criticalThreshold: number;
        enabled: boolean;
      }>
    ): Row | undefined {
      const existing = db.select().from(aiTokenPools).where(eq(aiTokenPools.id, id)).get();
      if (!existing) return undefined;
      db.update(aiTokenPools)
        .set({ ...patch, updatedAt: nowIso() })
        .where(eq(aiTokenPools.id, id))
        .run();
      return db.select().from(aiTokenPools).where(eq(aiTokenPools.id, id)).get();
    },

    /** Raw totals for a pool (used by the reservation repo's atomic checks). */
    totals(id: string): { usedTokens: number; reservedTokens: number; dailyLimit: number; resetAt: string; enabled: boolean } | undefined {
      const row = db
        .select({
          usedTokens: aiTokenPools.usedTokens,
          reservedTokens: aiTokenPools.reservedTokens,
          dailyLimit: aiTokenPools.dailyLimit,
          resetAt: aiTokenPools.resetAt,
          enabled: aiTokenPools.enabled
        })
        .from(aiTokenPools)
        .where(eq(aiTokenPools.id, id))
        .get();
      return row;
    }
  };
}

export type AiTokenPoolRepo = ReturnType<typeof makeAiTokenPoolRepo>;
