import { and, eq, isNull, or } from "drizzle-orm";
import type { Db } from "../client";
import { aiCredentialModelQuotas, aiProviderCredentials } from "../schema";
import { newId } from "./util";

export type QuotaUsageSource = "provider_response" | "system_estimated";
export type CredentialModelQuota = typeof aiCredentialModelQuotas.$inferSelect;
export type QuotaLimits = {
  rpmLimit?: number | null;
  tpmLimit?: number | null;
  rpdLimit?: number | null;
};
export type QuotaReservation = {
  quotaId: string;
  credentialId: string;
  model: string;
  reservedTokens: number;
  minuteResetAt: string;
  dailyResetAt: string;
};

export const DEFAULT_QUOTA_TIMEZONE = "Asia/Taipei";

function validTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

export function assertQuotaTimezone(value: string): string {
  const timezone = value.trim() || DEFAULT_QUOTA_TIMEZONE;
  if (!validTimezone(timezone)) throw new Error("invalid quota timezone");
  return timezone;
}

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

function nextMinuteReset(now: Date): string {
  return new Date(Math.floor(now.getTime() / 60_000) * 60_000 + 60_000).toISOString();
}

export function initialQuotaPeriods(now: Date, timezone = DEFAULT_QUOTA_TIMEZONE): Pick<CredentialModelQuota, "minuteResetAt" | "dailyResetAt"> {
  return { minuteResetAt: nextMinuteReset(now), dailyResetAt: nextDailyReset(now, timezone) };
}

function periodValues(row: CredentialModelQuota, now: Date): Pick<CredentialModelQuota, "requestsThisMinute" | "tokensThisMinute" | "requestsToday" | "minuteResetAt" | "dailyResetAt"> {
  const minuteExpired = row.minuteResetAt <= now.toISOString();
  const dailyExpired = row.dailyResetAt <= now.toISOString();
  return {
    requestsThisMinute: minuteExpired ? 0 : row.requestsThisMinute,
    tokensThisMinute: minuteExpired ? 0 : row.tokensThisMinute,
    requestsToday: dailyExpired ? 0 : row.requestsToday,
    minuteResetAt: minuteExpired ? nextMinuteReset(now) : row.minuteResetAt,
    dailyResetAt: dailyExpired ? nextDailyReset(now, row.resetTimezone) : row.dailyResetAt
  };
}

function usageSource(value: string | undefined): QuotaUsageSource {
  return value === "provider_response" ? "provider_response" : "system_estimated";
}

export function makeAiCredentialModelQuotaRepo(db: Db) {
  const find = (id: string) => db.select().from(aiCredentialModelQuotas).where(eq(aiCredentialModelQuotas.id, id)).get();
  const findForCredential = (credentialId: string, model: string) => db.select().from(aiCredentialModelQuotas)
    .where(eq(aiCredentialModelQuotas.credentialId, credentialId))
    .all()
    .find((row) => row.model.toLocaleLowerCase() === model.trim().toLocaleLowerCase());

  function refresh(row: CredentialModelQuota, now = new Date()): CredentialModelQuota {
    const values = periodValues(row, now);
    if (values.minuteResetAt === row.minuteResetAt && values.dailyResetAt === row.dailyResetAt) return row;
    db.update(aiCredentialModelQuotas).set({ ...values, updatedAt: now.toISOString() }).where(eq(aiCredentialModelQuotas.id, row.id)).run();
    return find(row.id)!;
  }

  return {
    list(credentialId: string) {
      return db.select().from(aiCredentialModelQuotas).where(eq(aiCredentialModelQuotas.credentialId, credentialId)).all()
        .map((row) => refresh(row)).sort((a, b) => a.model.localeCompare(b.model));
    },
    find(id: string) {
      const row = find(id);
      return row ? refresh(row) : undefined;
    },
    findForCredential(credentialId: string, model: string) {
      const row = findForCredential(credentialId, model);
      return row ? refresh(row) : undefined;
    },
    create(input: {
      credentialId: string;
      model: string;
      rpmLimit?: number | null;
      tpmLimit?: number | null;
      rpdLimit?: number | null;
      resetTimezone?: string;
      enabled?: boolean;
      isDefault?: boolean;
      currency?: string | null;
      serviceTier?: string | null;
      inputPriceUsdPerMillion?: number | null;
      outputPriceUsdPerMillion?: number | null;
      cachedInputPriceUsdPerMillion?: number | null;
      cacheStorageUsdPerMillionTokenHour?: number | null;
      pricingEffectiveAt?: string | null;
      pricingSource?: string | null;
      pricingUnavailable?: boolean;
    }) {
      const model = input.model.trim();
      if (!model) throw new Error("model is required");
      const timezone = assertQuotaTimezone(input.resetTimezone ?? DEFAULT_QUOTA_TIMEZONE);
      const now = new Date();
      const createdAt = now.toISOString();
      const id = newId("aiq");
      const enabled = input.enabled ?? true;
      const existing = db.select().from(aiCredentialModelQuotas)
        .where(eq(aiCredentialModelQuotas.credentialId, input.credentialId)).all();
      const makeDefault = input.isDefault === true || !existing.some((row) => row.enabled && row.isDefault);
      if (makeDefault && !enabled) throw new Error("default model must be enabled");
      const periods = initialQuotaPeriods(now, timezone);
      db.transaction((tx) => {
        if (makeDefault) {
          tx.update(aiCredentialModelQuotas).set({ isDefault: false, updatedAt: createdAt })
            .where(eq(aiCredentialModelQuotas.credentialId, input.credentialId)).run();
        }
        tx.insert(aiCredentialModelQuotas).values({
          id, credentialId: input.credentialId, model,
          rpmLimit: input.rpmLimit ?? null, tpmLimit: input.tpmLimit ?? null, rpdLimit: input.rpdLimit ?? null,
          requestsThisMinute: 0, tokensThisMinute: 0, requestsToday: 0,
          minuteResetAt: periods.minuteResetAt, dailyResetAt: periods.dailyResetAt,
          resetTimezone: timezone, usageSource: "system_estimated",
          // Pricing config (spec §5.1).
          currency: input.currency ?? null,
          serviceTier: input.serviceTier ?? null,
          inputPriceUsdPerMillion: input.inputPriceUsdPerMillion ?? null,
          outputPriceUsdPerMillion: input.outputPriceUsdPerMillion ?? null,
          cachedInputPriceUsdPerMillion: input.cachedInputPriceUsdPerMillion ?? null,
          cacheStorageUsdPerMillionTokenHour: input.cacheStorageUsdPerMillionTokenHour ?? null,
          pricingEffectiveAt: input.pricingEffectiveAt ?? null,
          pricingSource: input.pricingSource ?? null,
          pricingUnavailable: input.pricingUnavailable ?? false,
          enabled,
          isDefault: makeDefault, createdAt, updatedAt: createdAt
        }).run();
        if (makeDefault) {
          tx.update(aiProviderCredentials).set({ model, updatedAt: createdAt })
            .where(eq(aiProviderCredentials.id, input.credentialId)).run();
        }
      });
      return find(id)!;
    },
    update(id: string, patch: Partial<{
      model: string;
      rpmLimit: number | null;
      tpmLimit: number | null;
      rpdLimit: number | null;
      resetTimezone: string;
      enabled: boolean;
      isDefault: boolean;
      currency: string | null;
      serviceTier: string | null;
      inputPriceUsdPerMillion: number | null;
      outputPriceUsdPerMillion: number | null;
      cachedInputPriceUsdPerMillion: number | null;
      cacheStorageUsdPerMillionTokenHour: number | null;
      pricingEffectiveAt: string | null;
      pricingSource: string | null;
      pricingUnavailable: boolean;
    }>) {
      const current = find(id);
      if (!current) return undefined;
      const model = patch.model === undefined ? current.model : patch.model.trim();
      if (!model) throw new Error("model is required");
      const timezone = patch.resetTimezone === undefined ? current.resetTimezone : assertQuotaTimezone(patch.resetTimezone);
      const timezoneChanged = timezone !== current.resetTimezone;
      const now = new Date();
      const values = periodValues({ ...current, resetTimezone: timezone }, now);
      const enabled = patch.enabled === undefined ? current.enabled : patch.enabled;
      const makeDefault = patch.isDefault === true || (current.isDefault && patch.isDefault !== false);
      if (current.isDefault && (!enabled || patch.isDefault === false)) {
        throw new Error("default model must be replaced before it can be disabled or removed");
      }
      if (makeDefault && !enabled) throw new Error("default model must be enabled");
      db.transaction((tx) => {
        if (makeDefault) {
          tx.update(aiCredentialModelQuotas).set({ isDefault: false, updatedAt: now.toISOString() })
            .where(eq(aiCredentialModelQuotas.credentialId, current.credentialId)).run();
        }
        tx.update(aiCredentialModelQuotas).set({
          model,
          rpmLimit: patch.rpmLimit === undefined ? current.rpmLimit : patch.rpmLimit,
          tpmLimit: patch.tpmLimit === undefined ? current.tpmLimit : patch.tpmLimit,
          rpdLimit: patch.rpdLimit === undefined ? current.rpdLimit : patch.rpdLimit,
          resetTimezone: timezone,
          minuteResetAt: values.minuteResetAt,
          dailyResetAt: timezoneChanged ? nextDailyReset(now, timezone) : values.dailyResetAt,
          requestsThisMinute: values.requestsThisMinute,
          tokensThisMinute: values.tokensThisMinute,
          requestsToday: values.requestsToday,
          // Pricing config (spec §5.1). Editing prices here changes future
          // requests only — historical usage logs keep their frozen snapshot.
          currency: patch.currency === undefined ? current.currency : patch.currency,
          serviceTier: patch.serviceTier === undefined ? current.serviceTier : patch.serviceTier,
          inputPriceUsdPerMillion: patch.inputPriceUsdPerMillion === undefined ? current.inputPriceUsdPerMillion : patch.inputPriceUsdPerMillion,
          outputPriceUsdPerMillion: patch.outputPriceUsdPerMillion === undefined ? current.outputPriceUsdPerMillion : patch.outputPriceUsdPerMillion,
          cachedInputPriceUsdPerMillion: patch.cachedInputPriceUsdPerMillion === undefined ? current.cachedInputPriceUsdPerMillion : patch.cachedInputPriceUsdPerMillion,
          cacheStorageUsdPerMillionTokenHour: patch.cacheStorageUsdPerMillionTokenHour === undefined ? current.cacheStorageUsdPerMillionTokenHour : patch.cacheStorageUsdPerMillionTokenHour,
          pricingEffectiveAt: patch.pricingEffectiveAt === undefined ? current.pricingEffectiveAt : patch.pricingEffectiveAt,
          pricingSource: patch.pricingSource === undefined ? current.pricingSource : patch.pricingSource,
          pricingUnavailable: patch.pricingUnavailable === undefined ? current.pricingUnavailable : patch.pricingUnavailable,
          enabled,
          isDefault: makeDefault,
          updatedAt: now.toISOString()
        }).where(eq(aiCredentialModelQuotas.id, id)).run();
        if (makeDefault) {
          tx.update(aiProviderCredentials).set({ model, updatedAt: now.toISOString() })
            .where(eq(aiProviderCredentials.id, current.credentialId)).run();
        }
      });
      return find(id);
    },
    setDefault(id: string) {
      const current = find(id);
      if (!current) return undefined;
      if (!current.enabled) throw new Error("disabled model cannot be default");
      const now = new Date().toISOString();
      db.transaction((tx) => {
        tx.update(aiCredentialModelQuotas).set({ isDefault: false, updatedAt: now })
          .where(eq(aiCredentialModelQuotas.credentialId, current.credentialId)).run();
        tx.update(aiCredentialModelQuotas).set({ isDefault: true, updatedAt: now })
          .where(eq(aiCredentialModelQuotas.id, current.id)).run();
        tx.update(aiProviderCredentials).set({ model: current.model, updatedAt: now })
          .where(eq(aiProviderCredentials.id, current.credentialId)).run();
      });
      return find(id);
    },
    remove(id: string) {
      const current = find(id);
      if (current?.isDefault) throw new Error("default model must be replaced before it can be disabled or removed");
      return db.delete(aiCredentialModelQuotas).where(eq(aiCredentialModelQuotas.id, id)).run().changes > 0;
    },
    defaultForCredential(credentialId: string) {
      const row = db.select().from(aiCredentialModelQuotas)
        .where(eq(aiCredentialModelQuotas.credentialId, credentialId)).all()
        .find((candidate) => candidate.enabled && candidate.isDefault);
      return row ? refresh(row) : undefined;
    },
    modelsForCredential(credentialId: string) {
      const rows = db.select().from(aiCredentialModelQuotas)
        .where(eq(aiCredentialModelQuotas.credentialId, credentialId)).all()
        .filter((row) => row.enabled)
        .map((row) => refresh(row));
      return rows.sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.model.localeCompare(b.model));
    },
    /**
     * Return only safe routing information. This deliberately does not expose
     * credential material or provider error bodies to the gateway caller.
     */
    diagnose(credentialId: string, requestedModel?: string): {
      available: boolean;
      model?: string;
      reason?: "no_default_model" | "model_not_enabled" | "quota_exhausted";
    } {
      const rows = db.select().from(aiCredentialModelQuotas)
        .where(eq(aiCredentialModelQuotas.credentialId, credentialId)).all()
        .map((row) => refresh(row));
      if (rows.length === 0) return { available: true };
      const exhausted = (row: CredentialModelQuota) =>
        (row.rpmLimit !== null && row.requestsThisMinute >= row.rpmLimit)
        || (row.tpmLimit !== null && row.tokensThisMinute >= row.tpmLimit)
        || (row.rpdLimit !== null && row.requestsToday >= row.rpdLimit);
      if (requestedModel?.trim()) {
        const row = rows.find((candidate) => candidate.model.toLocaleLowerCase() === requestedModel.trim().toLocaleLowerCase());
        if (!row || !row.enabled) return { available: false, reason: "model_not_enabled" };
        if (exhausted(row)) return { available: false, model: row.model, reason: "quota_exhausted" };
        return { available: true, model: row.model };
      }
      const enabled = rows.filter((row) => row.enabled);
      const defaultRow = enabled.find((row) => row.isDefault);
      if (!defaultRow) return { available: false, reason: "no_default_model" };
      if (!exhausted(defaultRow)) return { available: true, model: defaultRow.model };
      const alternate = enabled.find((row) => !exhausted(row));
      return alternate
        ? { available: true, model: alternate.model }
        : { available: false, model: defaultRow.model, reason: "quota_exhausted" };
    },
    /**
     * Atomically reserves one request and a conservative token estimate. A
     * missing row means the model has no configured limit and is allowed.
     */
    reserve(credentialId: string, model: string, estimatedTokens: number, now = new Date()): { allowed: boolean; reservation?: QuotaReservation } {
      return db.transaction((tx) => {
        const credential = tx.select({ id: aiProviderCredentials.id }).from(aiProviderCredentials)
          .where(and(
            eq(aiProviderCredentials.id, credentialId),
            isNull(aiProviderCredentials.deletedAt),
            or(eq(aiProviderCredentials.status, "active"), eq(aiProviderCredentials.status, "standby"))
          )).get();
        if (!credential) return { allowed: false };
        const row = tx.select().from(aiCredentialModelQuotas)
          .where(eq(aiCredentialModelQuotas.credentialId, credentialId)).all()
          .find((candidate) => candidate.model.toLocaleLowerCase() === model.trim().toLocaleLowerCase());
        // Once a credential has an explicit model list, an unconfigured model
        // must not bypass that list. Credentials with no quota rows remain
        // compatible with legacy data and are treated as unlimited/unknown.
        if (!row) {
          const hasConfiguredModels = tx.select({ id: aiCredentialModelQuotas.id })
            .from(aiCredentialModelQuotas)
            .where(eq(aiCredentialModelQuotas.credentialId, credentialId)).get();
          return { allowed: !hasConfiguredModels };
        }
        if (!row.enabled) return { allowed: false };
        const periods = periodValues(row, now);
        if (periods.minuteResetAt !== row.minuteResetAt || periods.dailyResetAt !== row.dailyResetAt) {
          tx.update(aiCredentialModelQuotas).set({ ...periods, updatedAt: now.toISOString() }).where(eq(aiCredentialModelQuotas.id, row.id)).run();
        }
        const tokens = Math.max(0, Math.floor(estimatedTokens));
        if ((row.rpmLimit !== null && periods.requestsThisMinute >= row.rpmLimit)
          || (row.tpmLimit !== null && periods.tokensThisMinute + tokens > row.tpmLimit)
          || (row.rpdLimit !== null && periods.requestsToday >= row.rpdLimit)) return { allowed: false };
        tx.update(aiCredentialModelQuotas).set({
          requestsThisMinute: periods.requestsThisMinute + 1,
          tokensThisMinute: periods.tokensThisMinute + tokens,
          requestsToday: periods.requestsToday + 1,
          updatedAt: now.toISOString()
        }).where(eq(aiCredentialModelQuotas.id, row.id)).run();
        return {
          allowed: true,
          reservation: {
            quotaId: row.id, credentialId, model: row.model, reservedTokens: tokens,
            minuteResetAt: periods.minuteResetAt, dailyResetAt: periods.dailyResetAt
          }
        };
      });
    },
    /** Set the reservation to actual provider usage after a successful call. */
    settle(reservation: QuotaReservation, actualTokens: number, source: QuotaUsageSource = "system_estimated", now = new Date()) {
      return db.transaction((tx) => {
        const row = tx.select().from(aiCredentialModelQuotas).where(eq(aiCredentialModelQuotas.id, reservation.quotaId)).get();
        if (!row) return;
        const periods = periodValues(row, now);
        const sameMinute = periods.minuteResetAt === reservation.minuteResetAt;
        const delta = Math.max(0, Math.floor(actualTokens)) - reservation.reservedTokens;
        tx.update(aiCredentialModelQuotas).set({
          ...periods,
          tokensThisMinute: sameMinute ? Math.max(0, periods.tokensThisMinute + delta) : periods.tokensThisMinute,
          usageSource: usageSource(source),
          updatedAt: now.toISOString()
        }).where(eq(aiCredentialModelQuotas.id, row.id)).run();
      });
    },
    /** Roll back token reservation and optionally the RPM/RPD request count. */
    release(reservation: QuotaReservation, countRequest: boolean, now = new Date()) {
      return db.transaction((tx) => {
        const row = tx.select().from(aiCredentialModelQuotas).where(eq(aiCredentialModelQuotas.id, reservation.quotaId)).get();
        if (!row) return;
        const periods = periodValues(row, now);
        const sameMinute = periods.minuteResetAt === reservation.minuteResetAt;
        const sameDay = periods.dailyResetAt === reservation.dailyResetAt;
        tx.update(aiCredentialModelQuotas).set({
          ...periods,
          requestsThisMinute: countRequest && sameMinute ? Math.max(0, periods.requestsThisMinute) : sameMinute ? Math.max(0, periods.requestsThisMinute - 1) : periods.requestsThisMinute,
          tokensThisMinute: sameMinute ? Math.max(0, periods.tokensThisMinute - reservation.reservedTokens) : periods.tokensThisMinute,
          requestsToday: countRequest && sameDay ? Math.max(0, periods.requestsToday) : sameDay ? Math.max(0, periods.requestsToday - 1) : periods.requestsToday,
          updatedAt: now.toISOString()
        }).where(eq(aiCredentialModelQuotas.id, row.id)).run();
      });
    }
  };
}

export type AiCredentialModelQuotaRepo = ReturnType<typeof makeAiCredentialModelQuotaRepo>;
