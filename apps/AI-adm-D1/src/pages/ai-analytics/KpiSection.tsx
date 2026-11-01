import type { AiAnalyticsState } from "./useAiAnalytics";
import { KpiCard } from "./Charts";
import { formatUsd } from "./analytics-utils";

export function KpiSection({ state }: { state: AiAnalyticsState }) {
  const { summary, successRate } = state;
  return (
    <>
      {/* KPI cards */}
      <div className="admin-stat-grid">
        <KpiCard label="今日問答" value={summary?.totalRequests ?? 0} />
        <KpiCard
          label="成功率"
          value={`${successRate}%`}
          meta={`成功 ${summary?.successCount ?? 0} / 失敗 ${summary?.failedCount ?? 0}`}
        />
        <KpiCard
          label="平均耗時"
          value={`${summary?.avgLatencyMs ?? 0} ms`}
          meta={`Fallback ${summary?.fallbackCount ?? 0} 次`}
        />
        <KpiCard
          label="Token 用量"
          value={`${((summary?.totalInputTokens ?? 0) + (summary?.totalOutputTokens ?? 0)).toLocaleString()}`}
          meta={`輸入 ${summary?.totalInputTokens ?? 0} / 輸出 ${summary?.totalOutputTokens ?? 0}`}
        />
        <KpiCard
          label="預估花費"
          value={formatUsd(summary?.totalEstimatedCostMicroUsd ?? 0)}
          meta="今日累計（估算）"
        />
        <KpiCard
          label="預算使用率"
          value={`${summary?.budgetUtilisationPercentage ?? 0}%`}
          meta={
            (summary?.budgetUtilisationPercentage ?? 0) >= 100
              ? "已達上限"
              : (summary?.budgetUtilisationPercentage ?? 0) >= 80
                ? "接近上限"
                : "正常"
          }
        />
      </div>
    </>
  );
}
