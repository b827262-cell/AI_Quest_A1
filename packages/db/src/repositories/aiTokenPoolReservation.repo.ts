import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../client";
import { aiModelDailyLimits, aiTokenPoolReservations, aiTokenPools } from "../schema";
import { newId } from "./util";

type ReservationRow = typeof aiTokenPoolReservations.$inferSelect;

export const DEFAULT_TOKEN_POOL_TIMEZONE = "Asia/Taipei";

function localParts(date: Date, timezone: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { year: Number(value.year), month: Number(value.month), day: Number(value.day) };
}

/** Convert a local midnight to UTC, including DST-aware timezones. */
function localMidnightUtc(year: number, month: number, day: number, timezone: string): Date {
  const target = Date.UTC(year, month - 1, day);
  let candidate = target;
  for (let i = 0; i < 4; i += 1) {
    const parts = localParts(new Date(candidate), timezone);
    const observedAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day);
    candidate = target - (observedAsUtc - candidate);
  }
  return new Date(candidate);
}

function nextDailyReset(now: Date, timezone: string): string {
  const current = localParts(now, timezone);
  const nextDay = new Date(Date.UTC(current.year, current.month - 1, current.day + 1));
  return localMidnightUtc(nextDay.getUTCFullYear(), nextDay.getUTCMonth() + 1, nextDay.getUTCDate(), timezone).toISOString();
}

export interface ReserveTokenPoolInput {
  reservationKey: string;
  requestId: string;
  attemptId: string;
  poolId: string;
  logicalModelId: string;
  estimatedTokens: number;
  now?: Date;
}

export interface ReserveTokenPoolResult {
  allowed: boolean;
  reservationId?: string;
  /** Utilization ratio of the pool (0..1+). */
  utilizationRatio: number;
  reason?:
    | "pool_disabled"
    | "pool_not_found"
    | "model_limit_not_configured"
    | "token_pool_exhausted"
    | "model_daily_limit_exhausted"
    | "already_released"
    | "duplicate_pending";
  existingStatus?: "pending" | "settled" | "released";
}

export interface SettleTokenPoolResult {
  ok: boolean;
  overage: boolean;
  actualTokens: number;
  estimatedTokens: number;
  status: "pending" | "settled" | "released";
}

/**
 * Reservation ledger for the Token Pool, with a concurrency-safe state machine.
 *
 * State transitions:
 *   pending  --settle-->  settled   (decrement reserved by est, increment used by actual)
 *   pending  --release--> released  (decrement reserved by est)
 *   settled  --settle-->  settled   (NOOP: idempotent, returns existing, no double-count)
 *   released --release--> released  (NOOP: idempotent, returns success, no re-refund)
 *   settled  --release--> settled   (NOOP: never refunds after settle)
 *   released --settle-->  released  (NOOP: never re-charges after release)
 *
 * The daily reset is performed INSIDE the reserve transaction (never as a
 * standalone call) so the reset + check + increment is one atomic operation.
 * This closes the cross-midnight race between resetIfDue() and reserve().
 */
export function makeAiTokenPoolReservationRepo(db: Db) {
  return {
    list() {
      return db.select().from(aiTokenPoolReservations).all();
    },
    /**
     * Atomically reserve token budget. Performs reset-if-due, idempotency
     * check, pool+model limit enforcement, and reservation insert in ONE
     * SQLite transaction.
     */
    reserve(input: ReserveTokenPoolInput): ReserveTokenPoolResult {
      const now = input.now ?? new Date();
      const estimated = Math.max(0, Math.floor(input.estimatedTokens));

      return db.transaction((tx) => {
        // --- Idempotency: a reservation with the same key already exists. ---
        const existing = tx
          .select()
          .from(aiTokenPoolReservations)
          .where(eq(aiTokenPoolReservations.reservationKey, input.reservationKey))
          .get();
        if (existing) {
          if (existing.status === "settled") {
            return {
              allowed: true,
              reservationId: existing.id,
              utilizationRatio: utilizationRatio(tx, input.poolId),
              existingStatus: "settled"
            };
          }
          if (existing.status === "released") {
            return {
              allowed: false,
              utilizationRatio: utilizationRatio(tx, input.poolId),
              reason: "already_released" as const,
              existingStatus: "released"
            };
          }
          // pending — already reserved, do not double-reserve.
          return {
            allowed: true,
            reservationId: existing.id,
            utilizationRatio: utilizationRatio(tx, input.poolId),
            reason: "duplicate_pending" as const,
            existingStatus: "pending"
          };
        }

        // --- Load pool + model limit. ---
        const pool = tx.select().from(aiTokenPools).where(eq(aiTokenPools.id, input.poolId)).get();
        if (!pool) {
          return { allowed: false, utilizationRatio: 0, reason: "pool_not_found" as const };
        }
        if (!pool.enabled) {
          return { allowed: false, utilizationRatio: utilizationRatio(tx, input.poolId), reason: "pool_disabled" as const };
        }
        const model = tx
          .select()
          .from(aiModelDailyLimits)
          .where(eq(aiModelDailyLimits.logicalModelId, input.logicalModelId))
          .get();
        if (!model) {
          return { allowed: false, utilizationRatio: utilizationRatio(tx, input.poolId), reason: "model_limit_not_configured" as const };
        }

        // --- Reset-if-due (inside the transaction). ---
        const nowIso = now.toISOString();
        const poolExpired = pool.resetAt <= nowIso;
        const modelExpired = model.dailyLimit > 0 && poolExpired; // model resets with its pool
        if (poolExpired) {
          tx.update(aiTokenPools)
            .set({ usedTokens: 0, reservedTokens: 0, resetAt: nextDailyReset(now, pool.timezone), updatedAt: nowIso })
            .where(eq(aiTokenPools.id, pool.id))
            .run();
        }
        if (modelExpired) {
          tx.update(aiModelDailyLimits)
            .set({ usedTokens: 0, reservedTokens: 0, updatedAt: nowIso })
            .where(eq(aiModelDailyLimits.id, model.id))
            .run();
        }

        // Re-read post-reset values for the atomic guard.
        const poolPost = tx.select().from(aiTokenPools).where(eq(aiTokenPools.id, pool.id)).get()!;

        // --- Atomic pool increment under limit. ---
        const poolLimitOk = sql`${aiTokenPools.usedTokens} + ${aiTokenPools.reservedTokens} + ${estimated} <= ${aiTokenPools.dailyLimit}`;
        const poolUpdate = tx
          .update(aiTokenPools)
          .set({ reservedTokens: sql`${aiTokenPools.reservedTokens} + ${estimated}`, updatedAt: nowIso })
          .where(and(eq(aiTokenPools.id, pool.id), poolLimitOk))
          .run();
        if (poolUpdate.changes !== 1) {
          return {
            allowed: false,
            utilizationRatio: utilizationizationFor(poolPost, estimated),
            reason: "token_pool_exhausted" as const
          };
        }

        // --- Atomic model increment under limit. ---
        const modelLimitOk = sql`${aiModelDailyLimits.usedTokens} + ${aiModelDailyLimits.reservedTokens} + ${estimated} <= ${aiModelDailyLimits.dailyLimit}`;
        const modelUpdate = tx
          .update(aiModelDailyLimits)
          .set({ reservedTokens: sql`${aiModelDailyLimits.reservedTokens} + ${estimated}`, updatedAt: nowIso })
            .where(and(eq(aiModelDailyLimits.id, model.id), modelLimitOk))
            .run();
        if (modelUpdate.changes !== 1) {
          // Roll back the pool reservation we just made.
          tx.update(aiTokenPools)
            .set({ reservedTokens: sql`max(0, ${aiTokenPools.reservedTokens} - ${estimated})`, updatedAt: nowIso })
            .where(eq(aiTokenPools.id, pool.id))
            .run();
          return {
            allowed: false,
            utilizationRatio: utilizationRatio(tx, input.poolId),
            reason: "model_daily_limit_exhausted" as const
          };
        }

        // --- Insert the reservation ledger row. ---
        const reservationId = newId("aitpr");
        const ts = nowIso;
        tx.insert(aiTokenPoolReservations)
          .values({
            id: reservationId,
            reservationKey: input.reservationKey,
            requestId: input.requestId,
            attemptId: input.attemptId,
            poolId: input.poolId,
            logicalModelId: input.logicalModelId,
            estimatedTokens: estimated,
            actualTokens: null,
            overage: false,
            status: "pending",
            settledAt: null,
            releasedAt: null,
            createdAt: ts,
            updatedAt: ts
          })
          .run();
        return {
          allowed: true,
          reservationId,
          utilizationRatio: utilizationizationFor(poolPost, estimated)
        };
      });
    },

    /**
     * Settle a reservation with actual provider usage. Idempotent: re-settling
     * a non-pending reservation is a NOOP that returns the existing state.
     * If actualTokens > estimatedTokens, the reservation is flagged overage.
     */
    settle(reservationId: string, actualTokens: number, now: Date = new Date()): SettleTokenPoolResult {
      const actual = Math.max(0, Math.floor(actualTokens));
      return db.transaction((tx) => {
        const reservation = tx
          .select()
          .from(aiTokenPoolReservations)
          .where(eq(aiTokenPoolReservations.id, reservationId))
          .get();
        if (!reservation) {
          return { ok: false, overage: false, actualTokens: actual, estimatedTokens: 0, status: "released" };
        }
        // Idempotent: settled/reserved reservations are never re-charged.
        if (reservation.status !== "pending") {
          return {
            ok: true,
            overage: reservation.overage,
            actualTokens: reservation.actualTokens ?? 0,
            estimatedTokens: reservation.estimatedTokens,
            status: reservation.status as "settled" | "released"
          };
        }
        const ts = now.toISOString();
        const overage = actual > reservation.estimatedTokens;
        tx.update(aiTokenPoolReservations)
          .set({ status: "settled", actualTokens: actual, overage, settledAt: ts, updatedAt: ts })
          .where(eq(aiTokenPoolReservations.id, reservationId))
          .run();
        // Pool: release the reserved estimate, charge the actual usage.
        tx.update(aiTokenPools)
          .set({
            reservedTokens: sql`max(0, ${aiTokenPools.reservedTokens} - ${reservation.estimatedTokens})`,
            usedTokens: sql`${aiTokenPools.usedTokens} + ${actual}`,
            updatedAt: ts
          })
          .where(eq(aiTokenPools.id, reservation.poolId))
          .run();
        // Model: same reconciliation.
        tx.update(aiModelDailyLimits)
          .set({
            reservedTokens: sql`max(0, ${aiModelDailyLimits.reservedTokens} - ${reservation.estimatedTokens})`,
            usedTokens: sql`${aiModelDailyLimits.usedTokens} + ${actual}`,
            updatedAt: ts
          })
          .where(eq(aiModelDailyLimits.logicalModelId, reservation.logicalModelId))
          .run();
        return { ok: true, overage, actualTokens: actual, estimatedTokens: reservation.estimatedTokens, status: "settled" };
      });
    },

    /**
     * Release a pending reservation (failed attempt). Idempotent: releasing a
     * non-pending reservation is a NOOP that never refunds.
     */
    release(reservationId: string, now: Date = new Date()): { ok: boolean; status: "pending" | "settled" | "released" } {
      return db.transaction((tx) => {
        const reservation = tx
          .select()
          .from(aiTokenPoolReservations)
          .where(eq(aiTokenPoolReservations.id, reservationId))
          .get();
        if (!reservation) return { ok: false, status: "released" };
        if (reservation.status !== "pending") {
          return { ok: true, status: reservation.status as "settled" | "released" };
        }
        const ts = now.toISOString();
        tx.update(aiTokenPoolReservations)
          .set({ status: "released", releasedAt: ts, updatedAt: ts })
          .where(eq(aiTokenPoolReservations.id, reservationId))
          .run();
        tx.update(aiTokenPools)
          .set({ reservedTokens: sql`max(0, ${aiTokenPools.reservedTokens} - ${reservation.estimatedTokens})`, updatedAt: ts })
          .where(eq(aiTokenPools.id, reservation.poolId))
          .run();
        tx.update(aiModelDailyLimits)
          .set({ reservedTokens: sql`max(0, ${aiModelDailyLimits.reservedTokens} - ${reservation.estimatedTokens})`, updatedAt: ts })
          .where(eq(aiModelDailyLimits.logicalModelId, reservation.logicalModelId))
          .run();
        return { ok: true, status: "released" };
      });
    },

    findById(reservationId: string): ReservationRow | undefined {
      return db
        .select()
        .from(aiTokenPoolReservations)
        .where(eq(aiTokenPoolReservations.id, reservationId))
        .get();
    },

    findByKey(reservationKey: string): ReservationRow | undefined {
      return db
        .select()
        .from(aiTokenPoolReservations)
        .where(eq(aiTokenPoolReservations.reservationKey, reservationKey))
        .get();
    },

    /** Pending reservations for a request (used to release before fallback). */
    findPendingByRequest(requestId: string): ReservationRow[] {
      return db
        .select()
        .from(aiTokenPoolReservations)
        .where(eq(aiTokenPoolReservations.requestId, requestId))
        .all()
        .filter((row) => row.status === "pending");
    },

    /** Settled reservations for a request (used by the logger for pool provenance). */
    findSettledByRequest(requestId: string): ReservationRow[] {
      return db
        .select()
        .from(aiTokenPoolReservations)
        .where(eq(aiTokenPoolReservations.requestId, requestId))
        .all()
        .filter((row) => row.status === "settled");
    }
  };
}

function utilizationRatio(
  tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
  poolId: string
): number {
  const pool = tx.select().from(aiTokenPools).where(eq(aiTokenPools.id, poolId)).get();
  if (!pool || pool.dailyLimit <= 0) return 0;
  return (pool.usedTokens + pool.reservedTokens) / pool.dailyLimit;
}

function utilizationizationFor(
  pool: { usedTokens: number; reservedTokens: number; dailyLimit: number },
  pendingEstimate: number
): number {
  if (pool.dailyLimit <= 0) return 0;
  return (pool.usedTokens + pool.reservedTokens + pendingEstimate) / pool.dailyLimit;
}

export type AiTokenPoolReservationRepo = ReturnType<typeof makeAiTokenPoolReservationRepo>;
