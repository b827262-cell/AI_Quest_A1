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

export function localParts(date: Date, timezone: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(value.year),
    month: Number(value.month),
    day: Number(value.day),
    hour: Number(value.hour === "24" ? 0 : value.hour),
    minute: Number(value.minute),
    second: Number(value.second)
  };
}

/** Daily date key (YYYY-MM-DD) in the given timezone. */
export function localDateKey(date: Date, timezone: string): string {
  const { year, month, day } = localParts(date, timezone);
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

function localDateOrdinal(date: Date, timezone: string): number {
  const { year, month, day } = localParts(date, timezone);
  return Date.UTC(year, month - 1, day);
}

/**
 * Convert the start of a local calendar date to UTC.
 *
 * Binary-searching the local date boundary also handles zones where a clock
 * change skips 00:00 (the day starts at 01:00) and historical skipped dates.
 */
export function localMidnightUtc(year: number, month: number, day: number, timezone: string): Date {
  const target = Date.UTC(year, month - 1, day, 0, 0, 0);
  let lower = target - 36 * 60 * 60 * 1000;
  let upper = target + 36 * 60 * 60 * 1000;

  while (lower < upper) {
    const midpoint = lower + Math.floor((upper - lower) / 2);
    if (localDateOrdinal(new Date(midpoint), timezone) < target) {
      lower = midpoint + 1;
    } else {
      upper = midpoint;
    }
  }

  return new Date(lower);
}

/** ISO timestamp of the next local midnight after `now`. */
export function nextDailyReset(now: Date, timezone: string): string {
  const current = localParts(now, timezone);
  const nextDay = new Date(Date.UTC(current.year, current.month - 1, current.day + 1));
  return localMidnightUtc(nextDay.getUTCFullYear(), nextDay.getUTCMonth() + 1, nextDay.getUTCDate(), timezone).toISOString();
}
