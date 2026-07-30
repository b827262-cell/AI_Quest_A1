/**
 * Shared timezone helpers for daily-quota ledgers.
 *
 * The algorithm mirrors the proven implementations in
 * `aiCredentialModelQuota.repo.ts` and `aiTokenPoolReservation.repo.ts`
 * (DST-aware local-midnight fixpoint). New daily-ledger repos import from
 * here instead of duplicating the logic a third time.
 */

export const DEFAULT_DAILY_LEDGER_TIMEZONE = "Asia/Taipei";

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}

export function normalizeTimezone(timezone: string | null | undefined): string {
  const value = (timezone ?? "").trim() || DEFAULT_DAILY_LEDGER_TIMEZONE;
  if (!isValidTimezone(value)) throw new Error("invalid timezone");
  return value;
}

export function localParts(date: Date, timezone: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { year: Number(value.year), month: Number(value.month), day: Number(value.day) };
}

/** Daily date key (YYYY-MM-DD) in the given timezone. */
export function localDateKey(date: Date, timezone: string): string {
  const { year, month, day } = localParts(date, timezone);
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

/** Convert a local midnight to UTC, including DST-aware timezones. */
export function localMidnightUtc(year: number, month: number, day: number, timezone: string): Date {
  const target = Date.UTC(year, month - 1, day);
  let candidate = target;
  for (let i = 0; i < 4; i += 1) {
    const parts = localParts(new Date(candidate), timezone);
    const observedAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day);
    candidate = target - (observedAsUtc - candidate);
  }
  return new Date(candidate);
}

/** ISO timestamp of the next local midnight after `now`. */
export function nextDailyReset(now: Date, timezone: string): string {
  const current = localParts(now, timezone);
  const nextDay = new Date(Date.UTC(current.year, current.month - 1, current.day + 1));
  return localMidnightUtc(nextDay.getUTCFullYear(), nextDay.getUTCMonth() + 1, nextDay.getUTCDate(), timezone).toISOString();
}
