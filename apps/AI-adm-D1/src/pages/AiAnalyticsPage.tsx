import { useCallback, useEffect, useState } from "react";
import {
  adminApi,
  type AiAnalyticsSummary,
  type AiAnalyticsDailyRow,
  type AiAnalyticsProviderRow,
  type AiAnalyticsSubjectRow,
  type AiRequestLogRow,
  type AiRequestLogDetail,
  type AiRequestLogQuery,
  type AiRequestLogSort,
  type AiUsageDetail,
  ApiHttpError,
  type AiBudgetPolicyRow
} from "../api";
import { AdminPageHeader } from "../components/admin/AdminPageHeader";
import { AdminCard } from "../components/admin/AdminCard";
import { AdminErrorCard } from "../components/admin/AdminErrorCard";

/**
 * AI 執行分析. Surfaces the Phase 2 AI Gateway analytics: KPI cards, daily
 * trend, provider/subject breakdowns, the request-log table with filters +
 * detail drawer, and the budget policy editor.
 *
 * Charts use plain inline SVG (no chart library) to stay consistent with the
 * existing AdminDashboardPage TrendChart and to honour the "no large new
 * dependency" constraint (spec §10, §13.7).
 */

function microUsdToUsd(micro: number): number {
  return Math.round(micro) / 1_000_000;
}

function formatUsd(micro: number): string {
  const usd = microUsdToUsd(micro);
  return usd.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

/**
 * Precise USD formatting for micro-amounts (spec §4.6): show 6 decimal places
 * so small per-request costs (fractions of a cent) are legible.
 */
function formatUsdPrecise(micro: number): string {
  const usd = microUsdToUsd(micro);
  return `$${usd.toFixed(6)}`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("zh-Hant");
}

function todayIsoDate(): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function daysAgoIsoDate(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

const STATUS_LABELS: Record<string, string> = {
  success: "成功",
  fallback: "已 Fallback",
  failed: "失敗",
  timeout: "逾時",
  rejected: "拒絕",
  pending: "處理中"
};

const STATUS_DOT_CLASS: Record<string, string> = {
  success: "green",
  fallback: "yellow",
  failed: "red",
  timeout: "red",
  rejected: "red",
  pending: "gray"
};

const FALLBACK_REASON_LABELS: Record<string, string> = {
  no_active_credential: "沒有可用 Credential",
  no_default_model: "沒有預設模型",
  model_not_enabled: "模型未啟用或不存在",
  quota_exhausted: "模型配額已用完",
  credential_cooldown: "Credential 冷卻中",
  provider_disabled: "Provider 已停用",
  provider_request_failed: "Provider 請求失敗"
};

const SUBJECT_LABELS: Record<string, string> = {
  math: "數學",
  science: "自然",
  programming: "程式",
  language: "語文",
  humanities: "文科",
  general: "綜合",
  unknown: "未知"
};

function friendlyError(error: unknown): string {
  if (error instanceof ApiHttpError) {
    if (error.status === 401) return "管理 API 驗證失敗，請確認 Admin Token。";
    if (error.status === 403) return "目前帳號沒有存取管理分析的權限。";
    if (error.status === 503) return "管理 API 尚未完成安全設定或暫時無法使用。";
    if (error.status === 400) return `查詢參數不合法：${error.message}`;
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

export function AiAnalyticsPage() {
  const [from, setFrom] = useState<string>(daysAgoIsoDate(13));
  const [to, setTo] = useState<string>(todayIsoDate());
  const [summary, setSummary] = useState<AiAnalyticsSummary | null>(null);
  const [daily, setDaily] = useState<AiAnalyticsDailyRow[]>([]);
  const [providers, setProviders] = useState<AiAnalyticsProviderRow[]>([]);
  const [subjects, setSubjects] = useState<AiAnalyticsSubjectRow[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [logsBusy, setLogsBusy] = useState(false);
  const [policiesBusy, setPoliciesBusy] = useState(false);

  // Request log table state
  const [filterProvider, setFilterProvider] = useState("");
  const [filterSubject, setFilterSubject] = useState("");
  const [filterStatus, setFilterStatus] = useState("");
  const [filterSource, setFilterSource] = useState("");
  const [sort, setSort] = useState<AiRequestLogSort>("newest");
  const [page, setPage] = useState(1);
  const [limit] = useState(25);
  const [logRows, setLogRows] = useState<AiRequestLogRow[]>([]);
  const [logTotal, setLogTotal] = useState(0);
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AiRequestLogDetail | null>(null);
  // Full Q&A + token/cost detail (spec §4.3). Loaded only when the user clicks
  // "查看完整問答"; the list endpoint exposes previews only (spec §3.1).
  const [usageDetailRequestId, setUsageDetailRequestId] = useState<string | null>(null);
  const [usageDetail, setUsageDetail] = useState<AiUsageDetail | null>(null);
  const [usageDetailBusy, setUsageDetailBusy] = useState(false);

  // Budget policies
  const [policies, setPolicies] = useState<AiBudgetPolicyRow[]>([]);
  const [policySavingId, setPolicySavingId] = useState<string | null>(null);

  const loadOverview = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const [s, d, p, subj] = await Promise.all([
        adminApi.getAiAnalyticsSummary(),
        adminApi.getAiAnalyticsDaily(from, to),
        adminApi.getAiAnalyticsProviders(from, to),
        adminApi.getAiAnalyticsSubjects(from, to)
      ]);
      setSummary(s);
      setDaily(d);
      setProviders(p);
      setSubjects(subj);
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }, [from, to]);

  const loadLogs = useCallback(async () => {
    setLogsBusy(true);
    try {
      const query: AiRequestLogQuery = {
        from,
        to,
        sort,
        page,
        limit
      };
      if (filterProvider) query.provider = filterProvider;
      if (filterSubject) query.subject = filterSubject;
      if (filterStatus) query.status = filterStatus;
      if (filterSource) query.requestSource = filterSource;
      const result = await adminApi.listAiRequests(query);
      setLogRows(result.rows);
      setLogTotal(result.total);
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setLogsBusy(false);
    }
  }, [from, to, filterProvider, filterSubject, filterStatus, filterSource, sort, page, limit]);

  const loadPolicies = useCallback(async () => {
    setPoliciesBusy(true);
    try {
      const result = await adminApi.listAiBudgetPolicies();
      setPolicies(result.policies);
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setPoliciesBusy(false);
    }
  }, []);

  useEffect(() => {
    loadOverview();
  }, [loadOverview]);

  useEffect(() => {
    loadLogs();
  }, [loadLogs]);

  useEffect(() => {
    loadPolicies();
  }, [loadPolicies]);

  useEffect(() => {
    if (!selectedRequestId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    adminApi
      .getAiRequestDetail(selectedRequestId)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch((e) => {
        if (!cancelled) setError(friendlyError(e));
      });
    return () => {
      cancelled = true;
    };
  }, [selectedRequestId]);

  // Load the full Q&A + token/cost detail when the user opens the full drawer.
  useEffect(() => {
    if (!usageDetailRequestId) {
      setUsageDetail(null);
      return;
    }
    let cancelled = false;
    setUsageDetailBusy(true);
    adminApi
      .getAiUsageDetail(usageDetailRequestId)
      .then((d) => {
        if (!cancelled) setUsageDetail(d);
      })
      .catch((e) => {
        if (!cancelled) setError(friendlyError(e));
      })
      .finally(() => {
        if (!cancelled) setUsageDetailBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [usageDetailRequestId]);

  const totalPages = Math.max(1, Math.ceil(logTotal / limit));

  const handlePolicySave = useCallback(
    async (id: string, patch: {
      dailyTokenLimit?: number;
      dailyCostLimitUsd?: number;
      warningPercentage?: number;
      enabled?: boolean;
    }) => {
      setPolicySavingId(id);
      try {
        const updated = await adminApi.updateAiBudgetPolicy(id, patch);
        setPolicies((prev) => prev.map((p) => (p.id === id ? updated.policy : p)));
      } catch (e) {
        setError(friendlyError(e));
      } finally {
        setPolicySavingId(null);
      }
    },
    []
  );

  if (error && !summary) {
    return <AdminErrorCard description={error} onRetry={loadOverview} />;
  }

  const successRate =
    summary && summary.totalRequests > 0
      ? Math.round((summary.successCount / summary.totalRequests) * 1000) / 10
      : 0;

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

      {error && (
        <div className="admin-inline-error" role="alert">
          {error}
        </div>
      )}

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

      {/* Detail drawer */}
      {detail && (
        <RequestDetailDrawer
          detail={detail}
          onClose={() => setSelectedRequestId(null)}
        />
      )}

      {/* Full Q&A + token/cost detail drawer (spec §4.3, §4.4) */}
      {usageDetailRequestId && (
        <UsageDetailDrawer
          detail={usageDetail}
          busy={usageDetailBusy}
          onClose={() => setUsageDetailRequestId(null)}
        />
      )}
    </>
  );
}

function KpiCard({ label, value, meta }: { label: string; value: string | number; meta?: string }) {
  return (
    <section className="admin-card admin-stat-card">
      <p className="admin-stat-label">{label}</p>
      <span className="admin-stat-value">{value}</span>
      {meta && <p className="admin-stat-meta">{meta}</p>}
    </section>
  );
}

function DailyTrendChart({ points }: { points: AiAnalyticsDailyRow[] }) {
  const width = 640;
  const height = 220;
  const paddingX = 36;
  const paddingY = 24;
  const innerWidth = width - paddingX * 2;
  const innerHeight = height - paddingY * 2;
  const max = Math.max(1, ...points.map((p) => p.requestCount));
  const labelEvery = Math.max(1, Math.ceil(points.length / 8));

  if (points.length === 0) {
    return <p className="muted">所選範圍內尚無 AI 問答資料。</p>;
  }

  const coords = points.map((point, index) => {
    const x = paddingX + (innerWidth / Math.max(points.length - 1, 1)) * index;
    const y = height - paddingY - (point.requestCount / max) * innerHeight;
    return { ...point, x, y };
  });
  const path = coords.map((c, i) => `${i === 0 ? "M" : "L"} ${c.x} ${c.y}`).join(" ");
  const ticks = Array.from({ length: 5 }, (_, i) => Math.round((max / 4) * i));

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="admin-trend-chart" role="img" aria-label="每日 AI 問答趨勢圖">
      {ticks.map((tick) => {
        const y = height - paddingY - (tick / max) * innerHeight;
        return (
          <g key={tick}>
            <line x1="36" y1={y} x2={width - 36} y2={y} className="admin-chart-grid-line" />
            <text x="12" y={y + 4} className="admin-chart-axis-text">{tick}</text>
          </g>
        );
      })}
      {coords.map((c, i) =>
        i % labelEvery === 0 ? (
          <text key={`${c.date}-label`} x={c.x} y={height - 4} textAnchor="middle" className="admin-chart-axis-text">
            {c.date.slice(5)}
          </text>
        ) : null
      )}
      <path d={path} className="admin-chart-path" />
      {coords.map((c) => (
        <g key={c.date}>
          <circle cx={c.x} cy={c.y} r="4" className="admin-chart-point" />
        </g>
      ))}
    </svg>
  );
}

function ProviderPie({ rows }: { rows: AiAnalyticsProviderRow[] }) {
  const total = rows.reduce((a, r) => a + r.requestCount, 0);
  if (total === 0) return <p className="muted">尚無 Provider 使用資料。</p>;
  const radius = 70;
  const cx = 90;
  const cy = 90;
  const innerR = 38;
  let cumulative = 0;
  const slices = rows.map((r) => {
    const fraction = r.requestCount / total;
    const startAngle = cumulative * 2 * Math.PI;
    cumulative += fraction;
    const endAngle = cumulative * 2 * Math.PI;
    return { provider: r.provider, fraction, startAngle, endAngle };
  });

  return (
    <div className="admin-chart-pie-wrap">
      <svg viewBox="0 0 180 180" className="admin-chart-pie" role="img" aria-label="Provider 使用比例">
        {slices.map((s, i) => (
          <path
            key={s.provider}
            d={donutSlicePath(cx, cy, radius, innerR, s.startAngle, s.endAngle)}
            className={`admin-chart-slice admin-chart-slice-${i % 5}`}
          />
        ))}
        <text x={cx} y={cy - 4} textAnchor="middle" className="admin-chart-pie-total">
          {total}
        </text>
        <text x={cx} y={cy + 12} textAnchor="middle" className="admin-chart-axis-text">
          請求
        </text>
      </svg>
      <ul className="admin-chart-legend">
        {rows.map((r, i) => (
          <li key={r.provider}>
            <span className={`admin-chart-dot admin-chart-slice-${i % 5}`} />
            {r.provider} — {r.requestCount} ({Math.round((r.requestCount / total) * 100)}%)
          </li>
        ))}
      </ul>
    </div>
  );
}

function donutSlicePath(
  cx: number,
  cy: number,
  outerR: number,
  innerR: number,
  startAngle: number,
  endAngle: number
): string {
  const x1 = cx + outerR * Math.sin(startAngle);
  const y1 = cy - outerR * Math.cos(startAngle);
  const x2 = cx + outerR * Math.sin(endAngle);
  const y2 = cy - outerR * Math.cos(endAngle);
  const x3 = cx + innerR * Math.sin(endAngle);
  const y3 = cy - innerR * Math.cos(endAngle);
  const x4 = cx + innerR * Math.sin(startAngle);
  const y4 = cy - innerR * Math.cos(startAngle);
  const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;
  return [
    `M ${x1} ${y1}`,
    `A ${outerR} ${outerR} 0 ${largeArc} 1 ${x2} ${y2}`,
    `L ${x3} ${y3}`,
    `A ${innerR} ${innerR} 0 ${largeArc} 0 ${x4} ${y4}`,
    "Z"
  ].join(" ");
}

function SubjectBars({ rows }: { rows: AiAnalyticsSubjectRow[] }) {
  const total = rows.reduce((a, r) => a + r.requestCount, 0);
  if (total === 0) return <p className="muted">尚無科目分類資料。</p>;
  const max = Math.max(1, ...rows.map((r) => r.requestCount));
  return (
    <ul className="admin-chart-barlist">
      {rows.map((r) => (
        <li key={r.subject}>
          <span className="admin-chart-bar-label">{SUBJECT_LABELS[r.subject] ?? r.subject}</span>
          <span
            className="admin-chart-bar"
            style={{ width: `${Math.max(4, (r.requestCount / max) * 100)}%` }}
          />
          <span className="admin-chart-bar-value">{r.requestCount}</span>
        </li>
      ))}
    </ul>
  );
}

function ProviderTable({ rows }: { rows: AiAnalyticsProviderRow[] }) {
  if (rows.length === 0) return <p className="muted">尚無 Provider 資料。</p>;
  return (
    <div className="admin-table-wrap">
      <table className="admin-table admin-table-compact">
        <thead>
          <tr>
            <th>Provider</th>
            <th>請求數</th>
            <th>Token</th>
            <th>成本</th>
            <th>平均耗時</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.provider}>
              <td>{r.provider}</td>
              <td>{r.requestCount}</td>
              <td>{r.totalTokens.toLocaleString()}</td>
              <td>{formatUsd(r.estimatedCostMicroUsd)}</td>
              <td>{r.avgLatencyMs} ms</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BudgetPolicyRow({
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

function RequestDetailDrawer({
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

/**
 * Full Q&A + token/cost detail drawer (spec §4.3–§4.6).
 *
 * Renders the complete question and answer plus the full token breakdown
 * (Input / Cache hit / Output / Thinking / Total) and the cost breakdown
 * (each component + total in USD with 6 decimals). Answer text is rendered as
 * plain text — never via dangerouslySetInnerHTML — so stored XSS payloads are
 * inert (React escapes them). The token/cost sources are shown explicitly.
 */
function UsageDetailDrawer({
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
