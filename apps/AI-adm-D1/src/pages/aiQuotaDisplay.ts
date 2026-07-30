export type QuotaDisplayRow = {
  rpmLimit: number | null;
  tpmLimit: number | null;
  rpdLimit: number | null;
  requestsThisMinute: number;
  tokensThisMinute: number;
  requestsToday: number;
  enabled: boolean;
};

export function formatQuotaCount(value: number): string {
  const safe = Math.max(0, Math.floor(value));
  if (safe < 1_000) return String(safe);
  if (safe < 1_000_000) return `${(safe / 1_000).toFixed(safe % 1_000 === 0 ? 0 : 1)}K`;
  if (safe < 1_000_000_000) return `${(safe / 1_000_000).toFixed(safe % 1_000_000 === 0 ? 0 : 1)}M`;
  return `${(safe / 1_000_000_000).toFixed(safe % 1_000_000_000 === 0 ? 0 : 1)}B`;
}

export function quotaMetric(used: number, limit: number | null): { value: string; remaining: string } {
  const safeUsed = Math.max(0, Math.floor(used));
  return {
    value: limit === null ? `${formatQuotaCount(safeUsed)} / 未設定` : `${formatQuotaCount(safeUsed)} / ${formatQuotaCount(limit)}`,
    remaining: limit === null ? "未設定" : formatQuotaCount(Math.max(0, limit - safeUsed))
  };
}

export function quotaStatus(quota: QuotaDisplayRow): { label: string; className: string } {
  if (!quota.enabled) return { label: "停用", className: "admin-quota-disabled" };
  const metrics: Array<[number, number | null]> = [
    [quota.requestsThisMinute, quota.rpmLimit],
    [quota.tokensThisMinute, quota.tpmLimit],
    [quota.requestsToday, quota.rpdLimit]
  ];
  if (metrics.some(([used, limit]) => limit !== null && used >= limit)) {
    return { label: "已達上限", className: "admin-quota-exhausted" };
  }
  if (metrics.some(([used, limit]) => limit !== null && used / limit >= 0.8)) {
    return { label: "接近上限", className: "admin-quota-warning" };
  }
  return { label: "啟用", className: "admin-quota-enabled" };
}

/**
 * Label for the token/usage *source* (spec §7.1).
 *
 * IMPORTANT: `provider_response` means "token usage read from the provider's
 * API response" — it is NOT the provider's official account quota. A provider
 * response reports per-request token consumption, never the remaining RPD/TPM
 * quota on the Cloud Project/billing account. Label accordingly so admins do
 * not confuse usage telemetry with official quota.
 */
export function usageSourceLabel(source: "provider_response" | "system_estimated"): string {
  return source === "provider_response" ? "Provider 回應用量（非官方配額）" : "系統估算";
}

/**
 * Distinguish Provider official quota from system quota (spec §7.1, §7.4).
 * - The daily-reset counters maintained by THIS system (requests/tokens today)
 *   are "系統每日重置" — an internal policy boundary, never Provider official.
 * - A provider's real RPD/TPM is aggregated per Cloud Project and not knowable
 *   from a single API key, so we never label our local counter as such.
 */
export const SYSTEM_DAILY_RESET_LABEL = "系統每日重置";
export const PROVIDER_QUOTA_LABEL = "Provider 官方配額（帳戶層級，非單一 Key）";

/**
 * Compute the Gemini RPD daily-reset boundary in Pacific time and render it in
 * Asia/Taipei for display (spec §7.3). Gemini's RPD quota resets at local
 * midnight in the Cloud Project's region; we approximate the Pacific reset and
 * convert to Taipei, honouring US DST (PDT/PST).
 *
 * Returns the Taipei-local wall-clock string of the reset boundary for the
 * given reference date's "next" midnight-in-Pacific.
 */
export function pacificResetToTaipeiDisplay(reference: Date = new Date()): string {
  // Midnight Pacific for the reference day.
  const pacificMidnight = midnightInTimezone(reference, "America/Los_Angeles");
  const taipei = new Date(pacificMidnight.getTime() + 24 * 60 * 60 * 1000);
  // Format the *display* instant in Asia/Taipei (DST-correct via Intl).
  return new Intl.DateTimeFormat("zh-Hant", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(taipei);
}

/** Return the midnight (00:00 local) instant for a date in a given IANA zone. */
function midnightInTimezone(date: Date, timeZone: string): Date {
  // Find the wall-clock date in the zone, then construct midnight UTC for that
  // date and walk to the zone's actual midnight (handles DST offsets up to ±1d).
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const ymd = Object.fromEntries(parts.map((p) => [p.type, p.value])) as {
    year: string;
    month: string;
    day: string;
  };
  const utcMidnight = Date.UTC(+ymd.year, +ymd.month - 1, +ymd.day, 0, 0, 0);
  // The offset (in ms) between the zone and UTC at that instant.
  const offsetMs = zoneOffsetMs(timeZone, new Date(utcMidnight));
  return new Date(utcMidnight - offsetMs);
}

/** The UTC offset (ms) of an IANA zone at a given instant (DST-aware). */
function zoneOffsetMs(timeZone: string, instant: Date): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "shortOffset"
  });
  const parts = dtf.formatToParts(instant);
  const tz = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  // Parse e.g. "GMT+8", "GMT-7", "GMT+5:30".
  const match = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(tz);
  if (!match) return 0;
  const sign = match[1] === "+" ? 1 : -1;
  const hours = parseInt(match[2], 10);
  const minutes = match[3] ? parseInt(match[3], 10) : 0;
  return sign * (hours * 60 + minutes) * 60 * 1000;
}
