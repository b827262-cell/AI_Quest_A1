import type { AiRequestLogDetail } from "../../api";
import { formatUsd, formatTime, STATUS_LABELS, STATUS_DOT_CLASS, FALLBACK_REASON_LABELS, SUBJECT_LABELS } from "./analytics-utils";

export function RequestDetailDrawer({
  detail,
  onClose
}: {
  detail: AiRequestLogDetail;
  onClose: () => void;
}) {
  return (
    <div className="admin-drawer-overlay" onClick={onClose}>
      <section
        className="admin-drawer"
        role="dialog"
        aria-label="請求詳細資料"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="admin-drawer-head">
          <h3>請求詳細資料</h3>
          <button type="button" className="admin-btn ghost" onClick={onClose}>
            關閉
          </button>
        </header>
        <dl className="admin-drawer-meta">
          <dt>Request ID</dt>
          <dd>
            <code className="admin-mono">{detail.requestId}</code>
          </dd>
          <dt>時間</dt>
          <dd>{formatTime(detail.createdAt)}</dd>
          <dt>來源</dt>
          <dd>{detail.requestSource}</dd>
          <dt>科目 / 任務 / 複雜度</dt>
          <dd>
            {SUBJECT_LABELS[detail.subject] ?? detail.subject} / {detail.taskType} /{" "}
            {detail.complexity}
          </dd>
          <dt>路由</dt>
          <dd>
            {detail.routingProvider}
            {detail.routingModel ? ` (${detail.routingModel})` : ""}
            <br />
            <span className="muted">{detail.routingReason}</span>
          </dd>
          <dt>Provider attempts</dt>
          <dd>{detail.providerAttempts.length > 0 ? detail.providerAttempts.join(" → ") : "—"}</dd>
          <dt>狀態</dt>
          <dd>
            <span
              className={`admin-status-dot ${STATUS_DOT_CLASS[detail.status] ?? "gray"}`}
            />{" "}
            {STATUS_LABELS[detail.status] ?? detail.status}
            {detail.errorCode ? ` (${detail.errorCode})` : ""}
            {detail.fallbackReason ? `：${FALLBACK_REASON_LABELS[detail.fallbackReason] ?? "Fallback 原因"}` : ""}
          </dd>
          <dt>耗時</dt>
          <dd>{detail.latencyMs} ms</dd>
        </dl>

        <h4>問題摘要</h4>
        <p className="admin-drawer-question">{detail.questionPreview}</p>
        <p className="muted">問題長度：{detail.questionLength} 字元</p>

        {detail.usage && (
          <>
            <h4>使用量</h4>
            <dl className="admin-drawer-meta">
              <dt>Provider / Model</dt>
              <dd>
                {detail.usage.provider} / {detail.usage.model}
              </dd>
              <dt>Token</dt>
              <dd>
                輸入 {detail.usage.inputTokens ?? "—"} / 輸出{" "}
                {detail.usage.outputTokens ?? "—"} / 合計{" "}
                {detail.usage.totalTokens ?? "—"}
              </dd>
              <dt>預估成本</dt>
              <dd>{formatUsd(detail.usage.estimatedCostMicroUsd)}</dd>
              <dt>結束原因</dt>
              <dd>{detail.usage.finishReason ?? "—"}</dd>
            </dl>
          </>
        )}

        <p className="admin-drawer-privacy muted">
          基於隱私考量，此頁面不顯示原始 IP、API Key 或完整 System Prompt。
        </p>
      </section>
    </div>
  );
}
