import { useEffect, useState } from "react";
import { microUsdToUsd } from "./analytics-utils";
import type { AiBudgetPolicyRow } from "../../api";

export function BudgetPolicyRow({
  policy,
  saving,
  onSave
}: {
  policy: AiBudgetPolicyRow;
  saving: boolean;
  onSave: (
    id: string,
    patch: {
      dailyTokenLimit?: number;
      dailyCostLimitUsd?: number;
      warningPercentage?: number;
      enabled?: boolean;
    }
  ) => void;
}) {
  const [tokenLimit, setTokenLimit] = useState(String(policy.dailyTokenLimit));
  const [costUsd, setCostUsd] = useState(
    String(microUsdToUsd(policy.dailyCostLimitMicroUsd))
  );
  const [warnPct, setWarnPct] = useState(String(policy.warningPercentage));
  const [enabled, setEnabled] = useState(policy.enabled);

  // Re-sync if the row identity changes after a save.
  useEffect(() => {
    setTokenLimit(String(policy.dailyTokenLimit));
    setCostUsd(String(microUsdToUsd(policy.dailyCostLimitMicroUsd)));
    setWarnPct(String(policy.warningPercentage));
    setEnabled(policy.enabled);
  }, [policy.id, policy.dailyTokenLimit, policy.dailyCostLimitMicroUsd, policy.warningPercentage, policy.enabled]);

  const scopeLabel = `${policy.scopeType}/${policy.scopeKey}`;

  return (
    <tr>
      <td>
        <code className="admin-mono">{scopeLabel}</code>
      </td>
      <td>
        <input
          type="number"
          min="0"
          step="1"
          className="admin-input-sm"
          value={tokenLimit}
          onChange={(e) => setTokenLimit(e.target.value)}
        />
      </td>
      <td>
        <input
          type="number"
          min="0"
          step="0.1"
          className="admin-input-sm"
          value={costUsd}
          onChange={(e) => setCostUsd(e.target.value)}
        />
      </td>
      <td>
        <input
          type="number"
          min="0"
          max="100"
          step="1"
          className="admin-input-sm"
          value={warnPct}
          onChange={(e) => setWarnPct(e.target.value)}
        />
      </td>
      <td>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
      </td>
      <td>
        <button
          type="button"
          className="admin-btn ghost"
          disabled={saving}
          onClick={() =>
            onSave(policy.id, {
              dailyTokenLimit: Number(tokenLimit),
              dailyCostLimitUsd: Number(costUsd),
              warningPercentage: Number(warnPct),
              enabled
            })
          }
        >
          {saving ? "儲存中…" : "儲存"}
        </button>
      </td>
    </tr>
  );
}
