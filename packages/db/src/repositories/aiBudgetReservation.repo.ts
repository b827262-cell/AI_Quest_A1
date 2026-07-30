import { and, eq, sql } from "drizzle-orm";
import type { AiBudgetScopeType } from "@ai-smartbook/schema";
import type { Db } from "../client";
import { aiBudgetReservations, aiDailyUsage } from "../schema";
import { newId, nowIso } from "./util";

export type ReserveBudgetInput = {
  requestId: string;
  provider: string;
  model: string;
  date: string;
  estimatedTokens: number;
  estimatedCostMicroUsd: number;
  dailyTokenLimit: number;
  dailyCostLimitMicroUsd: number;
};

export type SettleBudgetInput = {
  date: string;
  scopeType: AiBudgetScopeType;
  scopeKey: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostMicroUsd: number;
  actualCostMicroUsd: number;
};

/**
 * Reservation ledger and global usage update share one SQLite transaction.
 * This closes the pre-check → provider-call race without holding a database
 * lock while an upstream HTTP request is running.
 */
export function makeAiBudgetReservationRepo(db: Db) {
  return {
    reserve(input: ReserveBudgetInput): {
      allowed: boolean;
      reservationId?: string;
      utilisation: number;
      reason?: string;
    } {
      return db.transaction((tx) => {
        const existing = tx
          .select()
          .from(aiDailyUsage)
          .where(
            and(
              eq(aiDailyUsage.date, input.date),
              eq(aiDailyUsage.scopeType, "global"),
              eq(aiDailyUsage.scopeKey, "default")
            )
          )
          .get();
        const row = existing ?? {
          id: newId("aid"),
          date: input.date,
          scopeType: "global" as const,
          scopeKey: "default",
          requestCount: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          estimatedCostMicroUsd: 0,
          actualCostMicroUsd: 0,
          reservedTokens: 0,
          reservedCostMicroUsd: 0,
          updatedAt: nowIso()
        };
        if (!existing) tx.insert(aiDailyUsage).values(row).run();

        const tokenLimitCondition = input.dailyTokenLimit > 0
          ? sql`${aiDailyUsage.totalTokens} + ${aiDailyUsage.reservedTokens} + ${input.estimatedTokens} <= ${input.dailyTokenLimit}`
          : sql`1 = 1`;
        const costLimitCondition = input.dailyCostLimitMicroUsd > 0
          ? sql`${aiDailyUsage.estimatedCostMicroUsd} + ${aiDailyUsage.reservedCostMicroUsd} + ${input.estimatedCostMicroUsd} <= ${input.dailyCostLimitMicroUsd}`
          : sql`1 = 1`;
        const updated = tx
          .update(aiDailyUsage)
          .set({
            reservedTokens: sql`${aiDailyUsage.reservedTokens} + ${input.estimatedTokens}`,
            reservedCostMicroUsd: sql`${aiDailyUsage.reservedCostMicroUsd} + ${input.estimatedCostMicroUsd}`,
            updatedAt: nowIso()
          })
          .where(
            and(
              eq(aiDailyUsage.id, row.id),
              tokenLimitCondition,
              costLimitCondition
            )
          )
          .run();

        const utilisation = Math.max(
          input.dailyTokenLimit > 0
            ? (row.totalTokens + row.reservedTokens + input.estimatedTokens) / input.dailyTokenLimit
            : 0,
          input.dailyCostLimitMicroUsd > 0
            ? (row.estimatedCostMicroUsd + row.reservedCostMicroUsd + input.estimatedCostMicroUsd) /
              input.dailyCostLimitMicroUsd
            : 0
        );
        if (updated.changes !== 1) {
          return {
            allowed: false,
            utilisation,
            reason: "daily budget reservation would exceed the configured limit"
          };
        }

        const reservationId = newId("airsv");
        const ts = nowIso();
        tx.insert(aiBudgetReservations).values({
          id: reservationId,
          requestId: input.requestId,
          provider: input.provider,
          model: input.model,
          date: input.date,
          estimatedTokens: input.estimatedTokens,
          estimatedCostMicroUsd: input.estimatedCostMicroUsd,
          status: "pending",
          createdAt: ts,
          updatedAt: ts
        }).run();
        return { allowed: true, reservationId, utilisation };
      });
    },

    release(reservationId: string): void {
      db.transaction((tx) => {
        const reservation = tx.select().from(aiBudgetReservations)
          .where(eq(aiBudgetReservations.id, reservationId)).get();
        if (!reservation || reservation.status !== "pending") return;
        const ts = nowIso();
        tx.update(aiBudgetReservations)
          .set({ status: "released", updatedAt: ts })
          .where(eq(aiBudgetReservations.id, reservationId)).run();
        tx.update(aiDailyUsage)
          .set({
            reservedTokens: sql`max(0, ${aiDailyUsage.reservedTokens} - ${reservation.estimatedTokens})`,
            reservedCostMicroUsd: sql`max(0, ${aiDailyUsage.reservedCostMicroUsd} - ${reservation.estimatedCostMicroUsd})`,
            updatedAt: ts
          })
          .where(and(
            eq(aiDailyUsage.date, reservation.date),
            eq(aiDailyUsage.scopeType, "global"),
            eq(aiDailyUsage.scopeKey, "default")
          )).run();
      });
    },

    settle(reservationId: string, input: SettleBudgetInput): void {
      db.transaction((tx) => {
        const reservation = tx.select().from(aiBudgetReservations)
          .where(eq(aiBudgetReservations.id, reservationId)).get();
        if (!reservation || reservation.status !== "pending") return;
        const ts = nowIso();
        tx.update(aiBudgetReservations)
          .set({ status: "settled", updatedAt: ts })
          .where(eq(aiBudgetReservations.id, reservationId)).run();
        incrementUsage(tx, reservation.date, "global", "default", input, {
          reservedTokens: reservation.estimatedTokens,
          reservedCostMicroUsd: reservation.estimatedCostMicroUsd,
          updatedAt: ts
        });
        if (input.scopeType !== "global") {
          incrementUsage(tx, reservation.date, input.scopeType, input.scopeKey, input, {
            reservedTokens: 0,
            reservedCostMicroUsd: 0,
            updatedAt: ts
          });
        }
      });
    }
  };
}

function incrementUsage(
  tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
  date: string,
  scopeType: AiBudgetScopeType,
  scopeKey: string,
  input: SettleBudgetInput,
  reservation: { reservedTokens: number; reservedCostMicroUsd: number; updatedAt: string }
): void {
  const existing = tx.select().from(aiDailyUsage).where(and(
    eq(aiDailyUsage.date, date),
    eq(aiDailyUsage.scopeType, scopeType),
    eq(aiDailyUsage.scopeKey, scopeKey)
  )).get();
  if (existing) {
    tx.update(aiDailyUsage).set({
      requestCount: existing.requestCount + 1,
      inputTokens: existing.inputTokens + input.inputTokens,
      outputTokens: existing.outputTokens + input.outputTokens,
      totalTokens: existing.totalTokens + input.totalTokens,
      estimatedCostMicroUsd: existing.estimatedCostMicroUsd + input.estimatedCostMicroUsd,
      actualCostMicroUsd: existing.actualCostMicroUsd + input.actualCostMicroUsd,
      reservedTokens: Math.max(0, existing.reservedTokens - reservation.reservedTokens),
      reservedCostMicroUsd: Math.max(0, existing.reservedCostMicroUsd - reservation.reservedCostMicroUsd),
      updatedAt: reservation.updatedAt
    }).where(eq(aiDailyUsage.id, existing.id)).run();
    return;
  }
  tx.insert(aiDailyUsage).values({
    id: newId("aid"),
    date,
    scopeType,
    scopeKey,
    requestCount: 1,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    totalTokens: input.totalTokens,
    estimatedCostMicroUsd: input.estimatedCostMicroUsd,
    actualCostMicroUsd: input.actualCostMicroUsd,
    reservedTokens: 0,
    reservedCostMicroUsd: 0,
    updatedAt: reservation.updatedAt
  }).run();
}

export type AiBudgetReservationRepo = ReturnType<typeof makeAiBudgetReservationRepo>;
