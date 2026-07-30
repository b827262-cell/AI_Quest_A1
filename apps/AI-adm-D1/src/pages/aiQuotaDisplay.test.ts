import { describe, expect, it } from "vitest";
import { formatQuotaCount, quotaMetric, quotaStatus, usageSourceLabel } from "./aiQuotaDisplay";

describe("AI credential quota display", () => {
  it("formats multiple model metrics with used, limit and non-negative remaining", () => {
    const flash = {
      rpm: quotaMetric(2, 15),
      tpm: quotaMetric(18_000, 250_000),
      rpd: quotaMetric(20, 500)
    };
    expect(flash.rpm).toEqual({ value: "2 / 15", remaining: "13" });
    expect(flash.tpm).toEqual({ value: "18K / 250K", remaining: "232K" });
    expect(flash.rpd).toEqual({ value: "20 / 500", remaining: "480" });
    expect(quotaMetric(99, 10).remaining).toBe("0");
    expect(formatQuotaCount(-10)).toBe("0");
  });

  it("shows 未設定 instead of zero for unknown limits", () => {
    expect(quotaMetric(7, null)).toEqual({ value: "7 / 未設定", remaining: "未設定" });
  });

  it("marks enabled, warning, exhausted and disabled quota states", () => {
    const base = { rpmLimit: 15, tpmLimit: 250_000, rpdLimit: 500, tokensThisMinute: 0, requestsToday: 0, enabled: true };
    expect(quotaStatus({ ...base, requestsThisMinute: 2 })).toMatchObject({ label: "啟用" });
    expect(quotaStatus({ ...base, requestsThisMinute: 12 })).toMatchObject({ label: "接近上限" });
    expect(quotaStatus({ ...base, requestsThisMinute: 15 })).toMatchObject({ label: "已達上限" });
    expect(quotaStatus({ ...base, requestsThisMinute: 0, enabled: false })).toMatchObject({ label: "停用" });
  });

  it("labels provider response usage separately from system estimates", () => {
    expect(usageSourceLabel("provider_response")).toBe("Provider 回應用量（非官方配額）");
    expect(usageSourceLabel("system_estimated")).toBe("系統估算");
  });
});
