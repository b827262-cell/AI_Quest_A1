import type { AiAnalyticsState } from "./useAiAnalytics";
import { AdminPageHeader } from "../../components/admin/AdminPageHeader";

export function AnalyticsHeader({ state }: { state: AiAnalyticsState }) {
  const { from, setFrom, to, setTo, busy, setPage, loadOverview } = state;
  return (
    <>
      <AdminPageHeader
        title="AI 執行分析"
        subtitle="AI Gateway 的請求紀錄、Provider 使用比例、成本與預算使用情形。"
        actions={
          <div className="admin-toolbar-inline">
            <label className="admin-range-label">
              从
              <input
                type="date"
                value={from}
                onChange={(e) => {
                  setFrom(e.target.value);
                  setPage(1);
                }}
              />
            </label>
            <label className="admin-range-label">
              到
              <input
                type="date"
                value={to}
                onChange={(e) => {
                  setTo(e.target.value);
                  setPage(1);
                }}
              />
            </label>
            <button type="button" className="admin-btn" onClick={loadOverview} disabled={busy}>
              {busy ? "載入中…" : "重新整理"}
            </button>
          </div>
        }
      />
    </>
  );
}
