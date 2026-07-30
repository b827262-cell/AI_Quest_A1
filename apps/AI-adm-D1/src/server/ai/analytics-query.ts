import { dayRangeIso, todayTaipei } from "./analytics-service";

export function isValidDateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export type AnalyticsRangeResult =
  | { ok: true; fromIso: string; toIso: string }
  | { ok: false; error: string };

/** Validate date-only analytics filters in the project timezone (Asia/Taipei). */
export function parseAnalyticsRange(
  fromValue: unknown,
  toValue: unknown,
  today = todayTaipei()
): AnalyticsRangeResult {
  const from = typeof fromValue === "string" ? fromValue : today;
  const to = typeof toValue === "string" ? toValue : today;
  if (!isValidDateOnly(from) || !isValidDateOnly(to)) {
    return { ok: false, error: "from and to must be valid YYYY-MM-DD dates" };
  }
  if (from > to) return { ok: false, error: "from must not be after to" };
  const start = dayRangeIso(from);
  const end = dayRangeIso(to);
  return { ok: true, fromIso: start.fromIso, toIso: end.toIso };
}
