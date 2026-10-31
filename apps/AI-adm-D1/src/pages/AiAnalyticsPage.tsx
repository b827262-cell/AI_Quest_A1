import { AdminErrorCard } from "../components/admin/AdminErrorCard";
import { useAiAnalytics } from "./ai-analytics/useAiAnalytics";
import { AnalyticsHeader } from "./ai-analytics/AnalyticsHeader";
import { KpiSection } from "./ai-analytics/KpiSection";
import { ChartsSection } from "./ai-analytics/ChartsSection";
import { RequestLogTable } from "./ai-analytics/RequestLogTable";
import { BudgetPolicies } from "./ai-analytics/BudgetPolicies";
import { RequestDetailDrawer } from "./ai-analytics/RequestDetailDrawer";
import { UsageDetailDrawer } from "./ai-analytics/UsageDetailDrawer";

export function AiAnalyticsPage() {
  const state = useAiAnalytics();
  const { error, summary, loadOverview, detail, setSelectedRequestId, usageDetailRequestId, usageDetail, usageDetailBusy, setUsageDetailRequestId } = state;
  if (error && !summary) return <AdminErrorCard description={error} onRetry={loadOverview} />;
  return (
    <>
      <AnalyticsHeader state={state} />
      {error && <div className="admin-inline-error" role="alert">{error}</div>}
      <KpiSection state={state} />
      <ChartsSection state={state} />
      <RequestLogTable state={state} />
      <BudgetPolicies state={state} />
      {detail && <RequestDetailDrawer detail={detail} onClose={() => setSelectedRequestId(null)} />}
      {usageDetailRequestId && <UsageDetailDrawer detail={usageDetail} busy={usageDetailBusy} onClose={() => setUsageDetailRequestId(null)} />}
    </>
  );
}
