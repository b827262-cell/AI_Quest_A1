import { priceFor } from "@ai-smartbook/ai/browser";
import type { CredentialStatus } from "./types";

export function formatDate(value: string | null): string {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? "—" : parsed.toLocaleString("zh-TW");
}

export function formatPriceCol(
  pricing: ReturnType<typeof priceFor>,
  field: "input" | "output" | "cached"
): string {
  if (pricing.serviceTier === "unavailable") return "未提供";
  if (pricing.serviceTier === "free") return "免費";
  const value =
    field === "input"
      ? pricing.inputPriceUsdPerMillion
      : field === "output"
        ? pricing.outputPriceUsdPerMillion
        : pricing.cachedInputPriceUsdPerMillion;
  return `$${value.toFixed(2)}`;
}

export function resetCountdown(value: string, now: number): string {
  const seconds = Math.ceil((new Date(value).getTime() - now) / 1000);
  if (!Number.isFinite(seconds) || seconds <= 0) return "即將重置";
  return `約 ${seconds} 秒後重置`;
}

export function resetTime(value: string, timezone?: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return "—";
  try {
    return new Intl.DateTimeFormat("zh-TW", {
      dateStyle: "short",
      timeStyle: "medium",
      timeZone: timezone
    }).format(parsed);
  } catch {
    return formatDate(value);
  }
}

export function statusLabel(status: CredentialStatus): string {
  return status === "active" ? "Active" : status === "standby" ? "Standby" : "Disabled";
}
