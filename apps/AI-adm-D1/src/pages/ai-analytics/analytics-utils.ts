import { ApiHttpError } from "../../api";

export function microUsdToUsd(micro: number): number {
  return Math.round(micro) / 1_000_000;
}

export function formatUsd(micro: number): string {
  const usd = microUsdToUsd(micro);
  return usd.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

/**
 * Precise USD formatting for micro-amounts (spec §4.6): show 6 decimal places
 * so small per-request costs (fractions of a cent) are legible.
 */
export function formatUsdPrecise(micro: number): string {
  const usd = microUsdToUsd(micro);
  return `$${usd.toFixed(6)}`;
}

export function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("zh-Hant");
}

export function todayIsoDate(): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function daysAgoIsoDate(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export const STATUS_LABELS: Record<string, string> = {
  success: "成功",
  fallback: "已 Fallback",
  failed: "失敗",
  timeout: "逾時",
  rejected: "拒絕",
  pending: "處理中"
};

export const STATUS_DOT_CLASS: Record<string, string> = {
  success: "green",
  fallback: "yellow",
  failed: "red",
  timeout: "red",
  rejected: "red",
  pending: "gray"
};

export const FALLBACK_REASON_LABELS: Record<string, string> = {
  no_active_credential: "沒有可用 Credential",
  no_default_model: "沒有預設模型",
  model_not_enabled: "模型未啟用或不存在",
  quota_exhausted: "模型配額已用完",
  credential_cooldown: "Credential 冷卻中",
  provider_disabled: "Provider 已停用",
  provider_request_failed: "Provider 請求失敗"
};

export const SUBJECT_LABELS: Record<string, string> = {
  math: "數學",
  science: "自然",
  programming: "程式",
  language: "語文",
  humanities: "文科",
  general: "綜合",
  unknown: "未知"
};

export function friendlyError(error: unknown): string {
  if (error instanceof ApiHttpError) {
    if (error.status === 401) return "管理 API 驗證失敗，請確認 Admin Token。";
    if (error.status === 403) return "目前帳號沒有存取管理分析的權限。";
    if (error.status === 503) return "管理 API 尚未完成安全設定或暫時無法使用。";
    if (error.status === 400) return `查詢參數不合法：${error.message}`;
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}
