import { and, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import type { Db } from "../client";
import {
  aiProviderConfigs,
  aiProviderCredentials,
  aiCredentialDailyLimits,
  aiCredentialDailyReservations,
  aiCredentialDailyUsage
} from "../schema";
import {
  DEFAULT_DAILY_LEDGER_TIMEZONE,
  localDateKey,
  normalizeTimezone,
  nextDailyReset
} from "./timezone.util";
import { newId, nowIso } from "./util";

type LimitRow = typeof aiCredentialDailyLimits.$inferSelect;
type UsageRow = typeof aiCredentialDailyUsage.$inferSelect;
type ReservationRow = typeof aiCredentialDailyReservations.$inferSelect;

export type CredentialDailyCostSource = "priced" | "unconfigured";

export interface ReserveCredentialDailyInput {
  requestId: string;
  attempt: number;
  credentialId: string;
  providerConfigId: string;
  providerModel: string;
  estimatedTokens: number;
  estimatedCostMicroUsd: number;
  now?: Date;
}

export interface ReserveCredentialDailyResult {
  allowed: boolean;
  reservationKey?: string;
  reason?:
    | "limit_disabled"
    | "credential_daily_token_exhausted"
    | "credential_daily_cost_exhausted"
    | "duplicate_pending"
    | "already_settled"
    | "already_released";
  existingStatus?: "pending" | "settled" | "released";
}

export interface SettleCredentialDailyInput {
  reservationKey: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  actualCostMicroUsd: number;
  costSource: CredentialDailyCostSource;
  now?: Date;
}

/**
 * Per-credential daily quota ledger for OpenAI keys.
 *
 * Reservation state machine (mirrors aiTokenPoolReservationRepo):
 *   pending  --settle-->  settled   (decrement reserved by est, increment used by actual)
 *   pending  --release--> released  (decrement reserved by est)
 *   settled  --settle-->  settled   (NOOP: idempotent)
 *   released --release--> released  (NOOP: idempotent)
 *
 * The daily reset is performed INSIDE the reserve transaction so reset +
 * check + increment is one atomic operation. NULL limits mean unlimited.
 */
export function makeAiCredentialDailyUsageRepo(db: Db) {
  return {
    /** Find the limit configuration for a credential (if any). */
    findLimit(credentialId: string): LimitRow | undefined {
      return db.select().from(aiCredentialDailyLimits)
        .where(eq(aiCredentialDailyLimits.credentialId, credentialId)).get();
    },

    listOpenAiCredentialIds(): Array<{ credentialId: string; providerConfigId: string }> {
      return db.select({
        credentialId: aiProviderCredentials.id,
        providerConfigId: aiProviderCredentials.providerConfigId
      })
        .from(aiProviderCredentials)
        .innerJoin(aiProviderConfigs, eq(aiProviderConfigs.id, aiProviderCredentials.providerConfigId))
        .where(and(
          eq(aiProviderConfigs.provider, "openai"),
          isNull(aiProviderCredentials.deletedAt),
          isNull(aiProviderConfigs.deletedAt)
        )).all();
    },

    updateLimit(credentialId: string, patch: {
      dailyTokenLimit?: number | null;
      dailyCostLimitMicroUsd?: number | null;
      timezone?: string;
      warningThreshold?: number;
      enabled?: boolean;
    }): LimitRow | undefined {
      const existing = db.select().from(aiCredentialDailyLimits)
        .where(eq(aiCredentialDailyLimits.credentialId, credentialId)).get();
      const ts = nowIso();
      if (!existing) {
        const timezone = normalizeTimezone(patch.timezone ?? DEFAULT_DAILY_LEDGER_TIMEZONE);
        const id = newId("aicdl");
        db.insert(aiCredentialDailyLimits).values({
          id,
          credentialId,
          dailyTokenLimit: patch.dailyTokenLimit ?? null,
          dailyCostLimitMicroUsd: patch.dailyCostLimitMicroUsd ?? null,
          timezone,
          warningThreshold: patch.warningThreshold ?? 80,
          enabled: patch.enabled ?? false,
          resetAt: nextDailyReset(new Date(), timezone),
          createdAt: ts,
          updatedAt: ts
        }).run();
        return db.select().from(aiCredentialDailyLimits).where(eq(aiCredentialDailyLimits.id, id)).get();
      }
      const set: Record<string, unknown> = { updatedAt: ts };
      if (patch.dailyTokenLimit !== undefined) set.dailyTokenLimit = patch.dailyTokenLimit;
      if (patch.dailyCostLimitMicroUsd !== undefined) set.dailyCostLimitMicroUsd = patch.dailyCostLimitMicroUsd;
      if (patch.timezone !== undefined) {
        const timezone = normalizeTimezone(patch.timezone);
        set.timezone = timezone;
        set.resetAt = nextDailyReset(new Date(), timezone);
      }
      if (patch.warningThreshold !== undefined) set.warningThreshold = patch.warningThreshold;
      if (patch.enabled !== undefined) set.enabled = patch.enabled;
      db.update(aiCredentialDailyLimits).set(set).where(eq(aiCredentialDailyLimits.id, existing.id)).run();
      return db.select().from(aiCredentialDailyLimits).where(eq(aiCredentialDailyLimits.id, existing.id)).get();
    },

    reserve(input: ReserveCredentialDailyInput, now = input.now ?? new Date()): ReserveCredentialDailyResult {
      const estimated = Math.max(0, Math.floor(input.estimatedTokens));
      const estCost = Math.max(0, Math.floor(input.estimatedCostMicroUsd));
      const reservationKey = `${input.requestId}:${input.attempt}:${input.credentialId}:${input.providerModel}`;
      return db.transaction((tx) => {
        // Idempotency: if a reservation for this key already exists, honour its state.
        const existing = tx.select().from(aiCredentialDailyReservations)
          .where(eq(aiCredentialDailyReservations.reservationKey, reservationKey)).get();
        if (existing) {
          if (existing.status === "pending") {
            return { allowed: true, reservationKey, existingStatus: "pending" };
          }
          return {
            allowed: false,
            reservationKey,
            reason: existing.status === "settled" ? "already_settled" : "already_released",
            existingStatus: existing.status as "settled" | "released"
          };
        }

        const limit = tx.select().from(aiCredentialDailyLimits)
          .where(eq(aiCredentialDailyLimits.credentialId, input.credentialId)).get();
        // No configured limit OR disabled: treat as unlimited (still record the
        // reservation so settle/release stay consistent). This keeps behaviour
        // identical to pre-upgrade for unconfigured/disabled credentials.
        const enforcing = Boolean(limit && limit.enabled);
        const timezone = limit?.timezone ?? DEFAULT_DAILY_LEDGER_TIMEZONE;
        const usageDate = localDateKey(now, timezone);
        const resetAt = limit ? limit.resetAt : nextDailyReset(now, timezone);

        // Find or create the usage row for this credential + local day.
        let usage = tx.select().from(aiCredentialDailyUsage).where(and(
          eq(aiCredentialDailyUsage.credentialId, input.credentialId),
          eq(aiCredentialDailyUsage.usageDate, usageDate)
        )).get();
        const ts = now.toISOString();
        if (!usage) {
          const id = newId("aicdu");
          tx.insert(aiCredentialDailyUsage).values({
            id,
            credentialId: input.credentialId,
            usageDate,
            timezone,
            providerConfigId: input.providerConfigId,
            providerModel: input.providerModel,
            inputTokens: 0,
            cachedInputTokens: 0,
            outputTokens: 0,
            reasoningTokens: 0,
            totalTokens: 0,
            usedTokens: 0,
            reservedTokens: 0,
            estimatedCostMicroUsd: 0,
            actualCostMicroUsd: 0,
            reservedCostMicroUsd: 0,
            requestCount: 0,
            costSource: "unconfigured",
            resetAt,
            createdAt: ts,
            updatedAt: ts
          }).run();
          usage = tx.select().from(aiCredentialDailyUsage).where(eq(aiCredentialDailyUsage.id, id)).get()!;
        } else if (usage.resetAt <= ts) {
          // Atomic daily reset inside the reserve transaction.
          tx.update(aiCredentialDailyUsage).set({
            usedTokens: 0,
            reservedTokens: 0,
            estimatedCostMicroUsd: 0,
            actualCostMicroUsd: 0,
            reservedCostMicroUsd: 0,
            requestCount: 0,
            resetAt: nextDailyReset(now, timezone),
            updatedAt: ts
          }).where(eq(aiCredentialDailyUsage.id, usage.id)).run();
          usage = tx.select().from(aiCredentialDailyUsage).where(eq(aiCredentialDailyUsage.id, usage.id)).get()!;
        }

        if (enforcing && limit) {
          // Token limit check (NULL = unlimited).
          if (limit.dailyTokenLimit !== null) {
            const tokenOk = tx.update(aiCredentialDailyUsage)
              .set({ reservedTokens: sql`${aiCredentialDailyUsage.reservedTokens} + ${estimated}`, updatedAt: ts })
              .where(and(
                eq(aiCredentialDailyUsage.id, usage.id),
                sql`${aiCredentialDailyUsage.usedTokens} + ${aiCredentialDailyUsage.reservedTokens} + ${estimated} <= ${limit.dailyTokenLimit}`
              )).run();
            if (tokenOk.changes !== 1) {
              return { allowed: false, reason: "credential_daily_token_exhausted" };
            }
          } else {
            tx.update(aiCredentialDailyUsage)
              .set({ reservedTokens: sql`${aiCredentialDailyUsage.reservedTokens} + ${estimated}`, updatedAt: ts })
              .where(eq(aiCredentialDailyUsage.id, usage.id)).run();
          }

          // Cost limit check (NULL = unlimited). Compensating rollback on failure.
          if (limit.dailyCostLimitMicroUsd !== null) {
            const costOk = tx.update(aiCredentialDailyUsage)
              .set({ reservedCostMicroUsd: sql`${aiCredentialDailyUsage.reservedCostMicroUsd} + ${estCost}`, updatedAt: ts })
              .where(and(
                eq(aiCredentialDailyUsage.id, usage.id),
                sql`${aiCredentialDailyUsage.actualCostMicroUsd} + ${aiCredentialDailyUsage.reservedCostMicroUsd} + ${estCost} <= ${limit.dailyCostLimitMicroUsd}`
              )).run();
            if (costOk.changes !== 1) {
              // Compensating rollback of the token reservation.
              tx.update(aiCredentialDailyUsage)
                .set({ reservedTokens: sql`max(0, ${aiCredentialDailyUsage.reservedTokens} - ${estimated})`, updatedAt: ts })
                .where(eq(aiCredentialDailyUsage.id, usage.id)).run();
              return { allowed: false, reason: "credential_daily_cost_exhausted" };
            }
          } else {
            tx.update(aiCredentialDailyUsage)
              .set({ reservedCostMicroUsd: sql`${aiCredentialDailyUsage.reservedCostMicroUsd} + ${estCost}`, updatedAt: ts })
              .where(eq(aiCredentialDailyUsage.id, usage.id)).run();
          }
        } else {
          // Not enforcing: still track reserved counters for visibility.
          tx.update(aiCredentialDailyUsage)
            .set({
              reservedTokens: sql`${aiCredentialDailyUsage.reservedTokens} + ${estimated}`,
              reservedCostMicroUsd: sql`${aiCredentialDailyUsage.reservedCostMicroUsd} + ${estCost}`,
              updatedAt: ts
            })
            .where(eq(aiCredentialDailyUsage.id, usage.id)).run();
        }

        const id = newId("aicdr");
        tx.insert(aiCredentialDailyReservations).values({
          id,
          reservationKey,
          requestId: input.requestId,
          attempt: input.attempt,
          credentialId: input.credentialId,
          providerConfigId: input.providerConfigId,
          providerModel: input.providerModel,
          usageDate,
          estimatedTokens: estimated,
          estimatedCostMicroUsd: estCost,
          status: "pending",
          costStatus: "unconfigured",
          createdAt: ts,
          updatedAt: ts
        }).run();
        return { allowed: true, reservationKey };
      });
    },

    settle(input: SettleCredentialDailyInput, now = input.now ?? new Date()): { ok: boolean; reservationKey: string } {
      const ts = now.toISOString();
      db.transaction((tx) => {
        const reservation = tx.select().from(aiCredentialDailyReservations)
          .where(eq(aiCredentialDailyReservations.reservationKey, input.reservationKey)).get();
        if (!reservation || reservation.status !== "pending") return;
        const usage = tx.select().from(aiCredentialDailyUsage).where(and(
          eq(aiCredentialDailyUsage.credentialId, reservation.credentialId),
          eq(aiCredentialDailyUsage.usageDate, reservation.usageDate)
        )).get();
        if (usage) {
          const actual = Math.max(0, Math.floor(input.totalTokens));
          const actualCost = Math.max(0, Math.floor(input.actualCostMicroUsd));
          tx.update(aiCredentialDailyUsage).set({
            reservedTokens: sql`max(0, ${aiCredentialDailyUsage.reservedTokens} - ${reservation.estimatedTokens})`,
            reservedCostMicroUsd: sql`max(0, ${aiCredentialDailyUsage.reservedCostMicroUsd} - ${reservation.estimatedCostMicroUsd})`,
            usedTokens: sql`${aiCredentialDailyUsage.usedTokens} + ${actual}`,
            inputTokens: sql`${aiCredentialDailyUsage.inputTokens} + ${Math.max(0, Math.floor(input.inputTokens))}`,
            cachedInputTokens: sql`${aiCredentialDailyUsage.cachedInputTokens} + ${Math.max(0, Math.floor(input.cachedInputTokens))}`,
            outputTokens: sql`${aiCredentialDailyUsage.outputTokens} + ${Math.max(0, Math.floor(input.outputTokens))}`,
            reasoningTokens: sql`${aiCredentialDailyUsage.reasoningTokens} + ${Math.max(0, Math.floor(input.reasoningTokens))}`,
            totalTokens: sql`${aiCredentialDailyUsage.totalTokens} + ${actual}`,
            actualCostMicroUsd: sql`${aiCredentialDailyUsage.actualCostMicroUsd} + ${actualCost}`,
            requestCount: sql`${aiCredentialDailyUsage.requestCount} + 1`,
            providerModel: reservation.providerModel,
            costSource: input.costSource,
            lastUsedAt: ts,
            updatedAt: ts
          }).where(eq(aiCredentialDailyUsage.id, usage.id)).run();
        }
        tx.update(aiCredentialDailyReservations).set({
          status: "settled",
          actualTokens: Math.max(0, Math.floor(input.totalTokens)),
          actualCostMicroUsd: Math.max(0, Math.floor(input.actualCostMicroUsd)),
          overage: Math.max(0, Math.floor(input.totalTokens)) > reservation.estimatedTokens,
          costStatus: input.costSource,
          settledAt: ts,
          updatedAt: ts
        }).where(eq(aiCredentialDailyReservations.id, reservation.id)).run();
      });
      return { ok: true, reservationKey: input.reservationKey };
    },

    release(reservationKey: string, now: Date = new Date()): { ok: boolean; reservationKey: string } {
      const ts = now.toISOString();
      db.transaction((tx) => {
        const reservation = tx.select().from(aiCredentialDailyReservations)
          .where(eq(aiCredentialDailyReservations.reservationKey, reservationKey)).get();
        if (!reservation || reservation.status !== "pending") return;
        const usage = tx.select().from(aiCredentialDailyUsage).where(and(
          eq(aiCredentialDailyUsage.credentialId, reservation.credentialId),
          eq(aiCredentialDailyUsage.usageDate, reservation.usageDate)
        )).get();
        if (usage) {
          tx.update(aiCredentialDailyUsage).set({
            reservedTokens: sql`max(0, ${aiCredentialDailyUsage.reservedTokens} - ${reservation.estimatedTokens})`,
            reservedCostMicroUsd: sql`max(0, ${aiCredentialDailyUsage.reservedCostMicroUsd} - ${reservation.estimatedCostMicroUsd})`,
            updatedAt: ts
          }).where(eq(aiCredentialDailyUsage.id, usage.id)).run();
        }
        tx.update(aiCredentialDailyReservations).set({
          status: "released",
          releasedAt: ts,
          updatedAt: ts
        }).where(eq(aiCredentialDailyReservations.id, reservation.id)).run();
      });
      return { ok: true, reservationKey };
    },

    /** Today's usage rows for a set of OpenAI credentials (for the Quota Center). */
    listTodayForCredentials(credentialIds: string[], now: Date = new Date()): UsageRow[] {
      if (credentialIds.length === 0) return [];
      return db.select().from(aiCredentialDailyUsage)
        .where(and(
          inArray(aiCredentialDailyUsage.credentialId, credentialIds),
          gte(aiCredentialDailyUsage.usageDate, localDateKey(now, DEFAULT_DAILY_LEDGER_TIMEZONE))
        )).all();
    },

    /** All usage rows for a credential within [from, to] date range (inclusive). */
    listHistory(credentialId: string, from: string, to: string): UsageRow[] {
      return db.select().from(aiCredentialDailyUsage)
        .where(and(
          eq(aiCredentialDailyUsage.credentialId, credentialId),
          gte(aiCredentialDailyUsage.usageDate, from),
          lte(aiCredentialDailyUsage.usageDate, to)
        )).all()
        .sort((a, b) => b.usageDate.localeCompare(a.usageDate));
    },

    /** Latest reservation for a credential (for detail view). */
    latestReservation(credentialId: string): ReservationRow | undefined {
      return db.select().from(aiCredentialDailyReservations)
        .where(eq(aiCredentialDailyReservations.credentialId, credentialId))
        .orderBy(sql`${aiCredentialDailyReservations.createdAt} DESC`)
        .limit(1).get();
    },

    /** Release stale pending reservations older than the threshold (crash recovery). */
    releaseStalePending(thresholdIso: string, now: Date = new Date()): number {
      const ts = now.toISOString();
      let count = 0;
      db.transaction((tx) => {
        const stale = tx.select().from(aiCredentialDailyReservations)
          .where(and(
            eq(aiCredentialDailyReservations.status, "pending"),
            lte(aiCredentialDailyReservations.createdAt, thresholdIso)
          )).all();
        for (const reservation of stale) {
          const usage = tx.select().from(aiCredentialDailyUsage).where(and(
            eq(aiCredentialDailyUsage.credentialId, reservation.credentialId),
            eq(aiCredentialDailyUsage.usageDate, reservation.usageDate)
          )).get();
          if (usage) {
            tx.update(aiCredentialDailyUsage).set({
              reservedTokens: sql`max(0, ${aiCredentialDailyUsage.reservedTokens} - ${reservation.estimatedTokens})`,
              reservedCostMicroUsd: sql`max(0, ${aiCredentialDailyUsage.reservedCostMicroUsd} - ${reservation.estimatedCostMicroUsd})`,
              updatedAt: ts
            }).where(eq(aiCredentialDailyUsage.id, usage.id)).run();
          }
          tx.update(aiCredentialDailyReservations).set({
            status: "released",
            releasedAt: ts,
            updatedAt: ts
          }).where(eq(aiCredentialDailyReservations.id, reservation.id)).run();
          count += 1;
        }
      });
      return count;
    }
  };
}

export type AiCredentialDailyUsageRepo = ReturnType<typeof makeAiCredentialDailyUsageRepo>;
