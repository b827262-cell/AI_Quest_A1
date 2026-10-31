import { useCallback, useEffect, useMemo, useState } from "react";
import {
  adminApi,
  type AdminDashboardStats,
  type DailyConversationPoint,
  type DashboardRange,
  type StudentQuestion
} from "../api";
import { AdminPageHeader } from "../components/admin/AdminPageHeader";
import { useConfirm } from "../components/useConfirm";
import { AdminCard } from "../components/admin/AdminCard";
import { AdminErrorCard } from "../components/admin/AdminErrorCard";

const RANGE_OPTIONS: Array<{ key: DashboardRange; label: string }> = [
  { key: "week", label: "最近一週" },
  { key: "month", label: "最近一月" },
  { key: "all", label: "全部" }
];

function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("zh-Hant");
}

/** Top question keywords derived from the real question contents (decorative). */
function topKeywords(questions: StudentQuestion[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const q of questions) {
    for (const raw of q.content.split(/[\s,，。．.!?？！、:：;；()「」『』\[\]\/\\#*]+/)) {
      const token = raw.trim();
      if (token.length >= 2) counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
}

function subjectBreakdown(questions: StudentQuestion[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const q of questions) counts.set(q.subject, (counts.get(q.subject) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function TrendChart({ points }: { points: DailyConversationPoint[] }) {
  const width = 640;
  const height = 240;
  const paddingX = 36;
  const paddingY = 24;
  const innerWidth = width - paddingX * 2;
  const innerHeight = height - paddingY * 2;
  const max = Math.max(1, ...points.map((p) => p.count));
  const labelEvery = Math.max(1, Math.ceil(points.length / 8));

  if (points.length === 0) {
    return <p className="muted">所選範圍內尚無對話資料。</p>;
  }

  const coords = points.map((point, index) => {
    const x = paddingX + (innerWidth / Math.max(points.length - 1, 1)) * index;
    const y = height - paddingY - (point.count / max) * innerHeight;
    return { ...point, x, y };
  });
  const path = coords.map((c, i) => `${i === 0 ? "M" : "L"} ${c.x} ${c.y}`).join(" ");
  const ticks = Array.from({ length: 5 }, (_, i) => Math.round((max / 4) * i));

  return (
    <svg viewBox="0 0 640 240" className="admin-trend-chart" role="img" aria-label="每日對話趨勢圖">
      {ticks.map((tick) => {
        const y = height - paddingY - (tick / max) * innerHeight;
        return (
          <g key={tick}>
            <line x1="36" y1={y} x2="604" y2={y} className="admin-chart-grid-line" />
            <text x="12" y={y + 4} className="admin-chart-axis-text">{tick}</text>
          </g>
        );
      })}
      {coords.map((c, i) =>
        i % labelEvery === 0 ? (
          <text key={`${c.date}-label`} x={c.x} y="228" textAnchor="middle" className="admin-chart-axis-text">
            {c.date.slice(5)}
          </text>
        ) : null
      )}
      <path d={path} className="admin-chart-path" />
      {coords.map((c) => (
        <g key={c.date}>
          <circle cx={c.x} cy={c.y} r="5" className="admin-chart-point" />
          <text x={c.x} y={c.y - 12} textAnchor="middle" className="admin-chart-value">{c.count}</text>
        </g>
      ))}
    </svg>
  );
}

export function AdminDashboardPage() {
  const [range, setRange] = useState<DashboardRange>("month");
  const [stats, setStats] = useState<AdminDashboardStats | null>(null);
  const [questions, setQuestions] = useState<StudentQuestion[]>([]);
  const [subject, setSubject] = useState("全部科目");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const confirmAction = useConfirm();

  const loadStats = useCallback(
    (r: DashboardRange) =>
      adminApi
        .getDashboardStats(r)
        .then(setStats)
        .catch((e) => setError(e instanceof Error ? e.message : String(e))),
    []
  );

  const loadQuestions = useCallback(
    () =>
      adminApi
        .listStudentQuestions()
        .then((d) => setQuestions(d.questions))
        .catch((e) => setError(e instanceof Error ? e.message : String(e))),
    []
  );

  useEffect(() => {
    void loadStats(range);
  }, [range, loadStats]);

  useEffect(() => {
    void loadQuestions();
  }, [loadQuestions]);

  const subjectOptions = useMemo(
    () => ["全部科目", ...Array.from(new Set(questions.map((q) => q.subject)))],
    [questions]
  );
  const filteredRows = useMemo(
    () => (subject === "全部科目" ? questions : questions.filter((q) => q.subject === subject)),
    [questions, subject]
  );
  const keywords = useMemo(() => topKeywords(questions), [questions]);
  const subjects = useMemo(() => subjectBreakdown(questions), [questions]);
  const topSubject = subjects[0];

  async function reloadAll() {
    await Promise.all([loadStats(range), loadQuestions()]);
  }

  async function deleteOne(id: string) {
    const confirmed = await confirmAction({
      title: "確認刪除訊息紀錄",
      message: "確定要刪除此筆訊息紀錄嗎？此操作可能無法復原。",
      tone: "danger"
    });
    if (!confirmed) return;
    setBusy(true);
    try {
      await adminApi.deleteStudentQuestion(id);
      setSelected((s) => {
        const next = new Set(s);
        next.delete(id);
        return next;
      });
      await reloadAll();
    } finally {
      setBusy(false);
    }
  }

  async function deleteBatch() {
    if (selected.size === 0) return;
    const confirmed = await confirmAction({
      title: "確認刪除訊息紀錄",
      message: "確定要刪除此筆訊息紀錄嗎？此操作可能無法復原。",
      tone: "danger"
    });
    if (!confirmed) return;
    setBusy(true);
    try {
      await adminApi.deleteStudentQuestions([...selected]);
      setSelected(new Set());
      await reloadAll();
    } finally {
      setBusy(false);
    }
  }

  function toggle(id: string) {
    setSelected((s) => {
      const next = new Set(s);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  if (error) {
    return (
      <div>
        <AdminPageHeader title="管理後台" />
        <AdminErrorCard
          title="儀表板資料讀取失敗"
          description="後端目前無法回應，請確認 API Server 是否啟動，或稍後重新整理。"
          code={error}
          onRetry={() => void reloadAll()}
        />
      </div>
    );
  }

  const statCards = [
    { title: "總用戶數", value: stats?.totalUsers ?? "—", meta: "已建立的學生帳號" },
    { title: "活躍用戶", value: stats?.activeUsers ?? "—", meta: "最近 15 分鐘活動" },
    { title: "總對話數", value: stats?.totalConversations ?? "—", meta: "累計對話 session" },
    { title: "總訊息數", value: stats?.totalMessages ?? "—", meta: "提問 + 回覆累計" }
  ];

  return (
    <div>
      <AdminPageHeader
        title="管理後台"
        subtitle="總覽近期使用概況、問答趨勢與學生提問紀錄"
        actions={
          <div className="admin-segmented" aria-label="時間範圍篩選">
            {RANGE_OPTIONS.map((option) => (
              <button
                key={option.key}
                type="button"
                className={`admin-segmented-btn ${range === option.key ? "active" : ""}`}
                onClick={() => setRange(option.key)}
              >
                {option.label}
              </button>
            ))}
          </div>
        }
      />

      <section className="admin-dashboard-stats">
        {statCards.map((stat) => (
          <AdminCard key={stat.title} className="admin-stat-card">
            <p className="admin-stat-label">{stat.title}</p>
            <strong className="admin-stat-value">{stat.value}</strong>
            <p className="admin-stat-meta">{stat.meta}</p>
          </AdminCard>
        ))}
      </section>

      <div className="admin-dashboard-grid">
        <AdminCard title="每日對話趨勢" className="admin-dashboard-span-2">
          <p className="admin-card-kicker">
            依學生提問紀錄統計每日對話數（{RANGE_OPTIONS.find((r) => r.key === range)?.label}）
          </p>
          <div className="admin-chart-wrap">
            <div className="admin-chart-legend">
              <span className="admin-chart-dot" />
              <span>對話數</span>
            </div>
            <TrendChart points={stats?.dailyConversations ?? []} />
          </div>
        </AdminCard>

        <AdminCard title="熱門科目統計">
          <p className="admin-card-kicker">各科目的提問數量分布</p>
          {topSubject ? (
            <ul className="admin-subject-list">
              {subjects.map(([name, count]) => (
                <li key={name}>
                  <span>{name}</span>
                  <strong>{count} 次</strong>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">尚無提問資料。</p>
          )}
        </AdminCard>

        <AdminCard title="常見問題關鍵字" className="admin-dashboard-span-2">
          <p className="admin-card-kicker">學生最常提問的關鍵字（前 20 個）</p>
          {keywords.length === 0 ? (
            <p className="muted">尚無提問資料。</p>
          ) : (
            <div className="admin-keyword-cloud">
              {keywords.map(([label, count]) => (
                <span key={label} className="admin-keyword-chip">
                  {label} <strong>({count})</strong>
                </span>
              ))}
            </div>
          )}
        </AdminCard>
      </div>

      <AdminCard
        title="學生問題列表"
        actions={
          <div className="admin-table-toolbar">
            <label className="admin-select-field">
              <span className="sr-only">科目篩選</span>
              <select value={subject} onChange={(e) => setSubject(e.target.value)}>
                {subjectOptions.map((option) => (
                  <option key={option} value={option}>{option}</option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="admin-btn secondary"
              onClick={deleteBatch}
              disabled={busy || selected.size === 0}
            >
              批次刪除{selected.size > 0 ? `（${selected.size}）` : ""}
            </button>
          </div>
        }
      >
        <div className="admin-table-wrap">
          <table>
            <thead>
              <tr>
                <th></th>
                <th>學生</th>
                <th>科目</th>
                <th>問題內容</th>
                <th>提問時間</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.length === 0 ? (
                <tr><td colSpan={6} className="muted">尚無學生提問紀錄。</td></tr>
              ) : (
                filteredRows.map((q) => (
                  <tr key={q.id}>
                    <td>
                      <input
                        type="checkbox"
                        checked={selected.has(q.id)}
                        onChange={() => toggle(q.id)}
                        style={{ width: "auto" }}
                      />
                    </td>
                    <td>{q.student}</td>
                    <td>{q.subject}</td>
                    <td className="admin-question-cell">{q.content}</td>
                    <td className="muted">{formatTime(q.createdAt)}</td>
                    <td>
                      <button className="admin-link-btn" onClick={() => deleteOne(q.id)} disabled={busy}>
                        刪除
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <div className="admin-table-footer">
          <span>顯示 {filteredRows.length} 筆 / 共 {questions.length} 筆</span>
        </div>
      </AdminCard>
    </div>
  );
}
