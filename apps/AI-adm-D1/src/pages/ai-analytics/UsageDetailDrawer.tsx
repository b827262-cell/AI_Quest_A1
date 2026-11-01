import type { AiUsageDetail } from "../../api";
import { formatUsdPrecise, FALLBACK_REASON_LABELS } from "./analytics-utils";

export function UsageDetailDrawer({
  detail,
  busy,
  onClose
}: {
  detail: AiUsageDetail | null;
  busy: boolean;
  onClose: () => void;
}) {
  return (
    <div className="admin-drawer-overlay" onClick={onClose}>
      <section
        className="admin-drawer admin-drawer-wide"
        role="dialog"
        aria-label="完整問答明細"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="admin-drawer-head">
          <h3>完整問答明細</h3>
          <button type="button" className="admin-btn ghost" onClick={onClose}>
            關閉
          </button>
        </header>

        {busy ? (
          <p className="muted">載入中…</p>
        ) : !detail ? (
          <p className="muted">找不到此請求的使用量資料。</p>
        ) : (
          <>
            <dl className="admin-drawer-meta">
              <dt>Request ID</dt>
              <dd>
                <code className="admin-mono">{detail.requestId}</code>
              </dd>
              <dt>Provider / Model</dt>
              <dd>
                {detail.provider} / {detail.model}
              </dd>
              <dt>來源模式</dt>
              <dd>{detail.mode}</dd>
              <dt>狀態</dt>
              <dd>
                {detail.status}
                {detail.fallbackReason
                  ? `（${FALLBACK_REASON_LABELS[detail.fallbackReason] ?? "Fallback 原因"}）`
                  : ""}
              </dd>
              <dt>耗時</dt>
              <dd>{detail.latencyMs} ms</dd>
              <dt>結束原因</dt>
              <dd>{detail.finishReason ?? "—"}</dd>
            </dl>

            {/* Full question + answer (spec §4.4). Plain text => XSS-safe. */}
            <h4>問題</h4>
            <pre className="admin-drawer-qa">{detail.questionText || "（無）"}</pre>
            <h4>回答</h4>
            <pre className="admin-drawer-qa">{detail.answerText || "（無）"}</pre>

            {/* Token breakdown (spec §4.4). */}
            <h4>Token 用量</h4>
            <table className="admin-table admin-table-compact admin-breakdown-table">
              <thead>
                <tr>
                  <th>項目</th>
                  <th>Token</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Input（非快取）</td>
                  <td>{detail.inputTokens?.toLocaleString() ?? "—"}</td>
                </tr>
                <tr>
                  <td>Cache hit（快取命中）</td>
                  <td>{detail.cachedInputTokens?.toLocaleString() ?? "—"}</td>
                </tr>
                <tr>
                  <td>Output</td>
                  <td>{detail.outputTokens?.toLocaleString() ?? "—"}</td>
                </tr>
                <tr>
                  <td>Thinking（推理）</td>
                  <td>{detail.thinkingTokens?.toLocaleString() ?? "—"}</td>
                </tr>
                <tr>
                  <td>合計</td>
                  <td>{detail.totalTokens?.toLocaleString() ?? "—"}</td>
                </tr>
              </tbody>
            </table>
            <p className="muted">Token 來源：{detail.usageSource ?? "—"}</p>

            {/* Cost breakdown (spec §4.4, §4.6). 6 decimals for micro-amounts. */}
            <h4>費用明細（USD）</h4>
            <table className="admin-table admin-table-compact admin-breakdown-table">
              <thead>
                <tr>
                  <th>項目</th>
                  <th>金額 (USD)</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Input cost</td>
                  <td>{formatUsdPrecise(detail.inputCostMicrousd)}</td>
                </tr>
                <tr>
                  <td>Cached input cost</td>
                  <td>{formatUsdPrecise(detail.cachedInputCostMicrousd)}</td>
                </tr>
                <tr>
                  <td>Output cost</td>
                  <td>{formatUsdPrecise(detail.outputCostMicrousd)}</td>
                </tr>
                <tr>
                  <td>總費用</td>
                  <td>{formatUsdPrecise(detail.totalCostMicrousd)}</td>
                </tr>
              </tbody>
            </table>
            <p className="muted">
              費用來源：{detail.pricingSource ?? "—"}
              {detail.pricingVersion ? `（版本 ${detail.pricingVersion}）` : ""}
            </p>

            <p className="admin-drawer-privacy muted">
              完整問答僅能由此明細取得；列表僅顯示預覽。基於隱私考量，不顯示原始 IP、API Key 或完整 System Prompt。
            </p>
          </>
        )}
      </section>
    </div>
  );
}
