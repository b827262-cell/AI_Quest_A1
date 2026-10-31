import type { AiAnalyticsDailyRow, AiAnalyticsProviderRow, AiAnalyticsSubjectRow } from "../../api";
import { formatUsd, SUBJECT_LABELS } from "./analytics-utils";

export function KpiCard({ label, value, meta }: { label: string; value: string | number; meta?: string }) {
  return (
    <section className="admin-card admin-stat-card">
      <p className="admin-stat-label">{label}</p>
      <span className="admin-stat-value">{value}</span>
      {meta && <p className="admin-stat-meta">{meta}</p>}
    </section>
  );
}

export function DailyTrendChart({ points }: { points: AiAnalyticsDailyRow[] }) {
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

export function ProviderPie({ rows }: { rows: AiAnalyticsProviderRow[] }) {
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

export function SubjectBars({ rows }: { rows: AiAnalyticsSubjectRow[] }) {
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

export function ProviderTable({ rows }: { rows: AiAnalyticsProviderRow[] }) {
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
