import type { AiAnalyticsState } from "./useAiAnalytics";
import { AdminCard } from "../../components/admin/AdminCard";
import { formatUsd, formatTime, STATUS_LABELS, STATUS_DOT_CLASS, FALLBACK_REASON_LABELS, SUBJECT_LABELS } from "./analytics-utils";
import type { AiRequestLogSort } from "../../api";

export function RequestLogTable({ state }: { state: AiAnalyticsState }) {
  const { logsBusy, filterProvider, setFilterProvider, filterSubject, setFilterSubject, filterStatus, setFilterStatus, filterSource, setFilterSource, sort, setSort, page, setPage, logRows, logTotal, setSelectedRequestId, setUsageDetailRequestId, totalPages } = state;
  return (
    <>
      {/* Request log table */}
      <AdminCard
        title="請求紀錄"
        actions={
          <div className="admin-toolbar-inline">
            <select
              value={filterProvider}
              onChange={(e) => {
                setFilterProvider(e.target.value);
                setPage(1);
              }}
            >
              <option value="">全部 Provider</option>
              <option value="mock">mock</option>
              <option value="gemini">gemini</option>
              <option value="openai">openai</option>
              <option value="kimi">kimi</option>
              <option value="qwen">qwen</option>
            </select>
            <select
              value={filterSubject}
              onChange={(e) => {
                setFilterSubject(e.target.value);
                setPage(1);
              }}
            >
              <option value="">全部科目</option>
              {Object.entries(SUBJECT_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
            <select
              value={filterStatus}
              onChange={(e) => {
                setFilterStatus(e.target.value);
                setPage(1);
              }}
            >
              <option value="">全部狀態</option>
              {Object.entries(STATUS_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
            <select
              value={filterSource}
              onChange={(e) => {
                setFilterSource(e.target.value);
                setPage(1);
              }}
            >
              <option value="">全部來源</option>
              <option value="guest">訪客</option>
              <option value="student">學員</option>
              <option value="book_qa">教材問答</option>
              <option value="admin">管理</option>
            </select>
            <select
              value={sort}
              onChange={(e) => {
                setSort(e.target.value as AiRequestLogSort);
                setPage(1);
              }}
            >
              <option value="newest">最新優先</option>
              <option value="oldest">最舊優先</option>
              <option value="latency">耗時優先</option>
            </select>
          </div>
        }
      >
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>時間</th>
                <th>Request ID</th>
                <th>問答內容</th>
                <th>科目</th>
                <th>Provider</th>
                <th>Model</th>
                <th>Token</th>
                <th>費用</th>
                <th>耗時</th>
                <th>狀態</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {logsBusy ? (
                <tr>
                  <td colSpan={11} className="muted" style={{ textAlign: "center" }}>載入中…</td>
                </tr>
              ) : logRows.length === 0 ? (
                <tr>
                  <td colSpan={11} className="muted" style={{ textAlign: "center" }}>
                    所選範圍內尚無 AI 請求紀錄。
                  </td>
                </tr>
              ) : (
                logRows.map((row) => (
                  <tr
                    key={row.id}
                    className="admin-table-row-clickable"
                    onClick={() => setSelectedRequestId(row.requestId)}
                  >
                    <td>{formatTime(row.createdAt)}</td>
                    <td>
                      <code className="admin-mono" title={row.requestId}>
                        {row.requestId.slice(0, 16)}{row.requestId.length > 16 ? "…" : ""}
                      </code>
                    </td>
                    {/* 問答內容: question + answer previews (spec §4.1, §4.2). */}
                    <td className="admin-cell-qa">
                      <div className="admin-qa-line admin-qa-question" title={row.questionPreview}>
                        <span className="admin-qa-tag">問</span>
                        <span className="admin-qa-text">{row.questionPreview}</span>
                      </div>
                      <div className="admin-qa-line admin-qa-answer" title={row.answerPreview}>
                        <span className="admin-qa-tag">答</span>
                        <span className="admin-qa-text">{row.answerPreview || "（無回答）"}</span>
                      </div>
                    </td>
                    <td>{SUBJECT_LABELS[row.subject] ?? row.subject}</td>
                    <td>{row.routingProvider}</td>
                    <td>{row.routingModel ?? "—"}</td>
                    <td>{row.totalTokens?.toLocaleString() ?? "—"}</td>
                    <td>{formatUsd(row.estimatedCostMicroUsd ?? 0)}</td>
                    <td>{row.latencyMs} ms</td>
                    <td>
                      <span
                        className={`admin-status-dot ${STATUS_DOT_CLASS[row.status] ?? "gray"}`}
                        title={row.errorCode ?? undefined}
                      />{" "}
                      {STATUS_LABELS[row.status] ?? row.status}
                      {row.fallbackReason ? `（${FALLBACK_REASON_LABELS[row.fallbackReason] ?? "Fallback 原因"}）` : ""}
                    </td>
                    <td>
                      {/* stopPropagation so the row-click (request detail) and the
                          full-Q&A button (usage detail) are independent. */}
                      <button
                        type="button"
                        className="admin-btn ghost admin-btn-sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          setUsageDetailRequestId(row.requestId);
                        }}
                      >
                        查看完整問答
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <div className="admin-table-footer">
          <span className="muted">
            共 {logTotal} 筆 / 第 {page} 頁，共 {totalPages} 頁
          </span>
          <div className="admin-table-pagination">
            <button
              type="button"
              className="admin-btn ghost"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              上一頁
            </button>
            <button
              type="button"
              className="admin-btn ghost"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            >
              下一頁
            </button>
          </div>
        </div>
      </AdminCard>
    </>
  );
}
