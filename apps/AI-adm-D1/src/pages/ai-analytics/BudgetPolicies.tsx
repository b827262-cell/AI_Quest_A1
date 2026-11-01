import type { AiAnalyticsState } from "./useAiAnalytics";
import { AdminCard } from "../../components/admin/AdminCard";
import { BudgetPolicyRow } from "./BudgetPolicyRow";

export function BudgetPolicies({ state }: { state: AiAnalyticsState }) {
  const { policiesBusy, policies, policySavingId, handlePolicySave } = state;
  return (
    <>
      {/* Budget policies */}
      <AdminCard title="預算策略">
        <p className="admin-card-kicker">
          以下限制定義每日 Token 與成本上限；達到 100% 時將拒絕新的付費模型請求（Mock 不計費）。
        </p>
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>範圍</th>
                <th>每日 Token 上限</th>
                <th>每日成本上限 (USD)</th>
                <th>警告門檻 (%)</th>
                <th>啟用</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {policiesBusy ? (
                <tr>
                  <td colSpan={6} className="muted" style={{ textAlign: "center" }}>載入中…</td>
                </tr>
              ) : policies.map((policy) => (
                <BudgetPolicyRow
                  key={policy.id}
                  policy={policy}
                  saving={policySavingId === policy.id}
                  onSave={handlePolicySave}
                />
              ))}
              {policies.length === 0 && (
                <tr>
                  <td colSpan={6} className="muted" style={{ textAlign: "center" }}>
                    尚未建立預算策略。
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </AdminCard>
    </>
  );
}
