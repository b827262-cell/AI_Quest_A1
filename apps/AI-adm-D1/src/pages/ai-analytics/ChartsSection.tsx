import type { AiAnalyticsState } from "./useAiAnalytics";
import { AdminCard } from "../../components/admin/AdminCard";
import { DailyTrendChart, ProviderPie, SubjectBars, ProviderTable } from "./Charts";

export function ChartsSection({ state }: { state: AiAnalyticsState }) {
  const { daily, providers, subjects } = state;
  return (
    <>
      {/* Charts */}
      <div className="admin-chart-grid">
        <AdminCard title="每日問答趨勢">
          <DailyTrendChart points={daily} />
        </AdminCard>
        <AdminCard title="Provider 使用比例">
          <ProviderPie rows={providers} />
        </AdminCard>
        <AdminCard title="科目分類比例">
          <SubjectBars rows={subjects} />
        </AdminCard>
        <AdminCard title="Provider 成本與耗時">
          <ProviderTable rows={providers} />
        </AdminCard>
      </div>
    </>
  );
}
