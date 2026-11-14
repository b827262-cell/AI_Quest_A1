import { useEffect, useState } from "react";
import { adminApi, type BookReadingProgressAnalytics } from "../../api";

function formatTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

function formatPercent(rate: number): string {
  if (!Number.isFinite(rate)) return "—";
  return `${(rate * 100).toFixed(1)}%`;
}

function csvCell(value: string | number): string {
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Pure CSV builder for chapter completion rates + per-page drop-off distribution. */
export function buildReadingProgressCsv(data: BookReadingProgressAnalytics): string {
  const lines: string[] = [];
  lines.push("章節完成率");
  lines.push("章節,完成人數,完成率");
  for (const c of data.chapterCompletionStats) {
    lines.push(
      [
        csvCell(`${c.orderIndex + 1}. ${c.title}`),
        csvCell(c.completedCount),
        csvCell(formatPercent(c.completionRate))
      ].join(",")
    );
  }
  lines.push("");
  lines.push("各頁停留與完成分布");
  lines.push("頁碼,目前停留讀者,已完成讀者");
  for (const p of data.pageDropoffDistribution) {
    lines.push(
      [
        csvCell(`第 ${p.page} 頁`),
        csvCell(p.currentReadersCount),
        csvCell(p.completedReadersCount)
      ].join(",")
    );
  }
  return lines.join("\n");
}

export function ReadingProgressTab({ bookId }: { bookId: string }) {
  const [data, setData] = useState<BookReadingProgressAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    adminApi
      .getBookReadingProgress(bookId)
      .then((d) => {
        if (active) setData(d);
      })
      .catch((e: unknown) => {
        if (active) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [bookId]);

  if (loading) return <p className="muted">載入中…</p>;
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">尚無閱讀分析資料。</p>;

  const metrics = [
    { label: "總連線數", value: data.totalSessions },
    { label: "活躍讀者數", value: data.activeReadersCount },
    { label: "平均完成頁數", value: data.averageCompletedPages }
  ];

  function handleExportCsv() {
    if (!data) return;
    const csv = buildReadingProgressCsv(data);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `reading-progress-${data.bookId}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <div>
      <div className="card">
        <div className="row between" style={{ marginBottom: 12 }}>
          <h3 style={{ margin: 0 }}>閱讀分析摘要</h3>
          <button className="btn" type="button" onClick={handleExportCsv}>匯出 CSV</button>
        </div>
        <div className="row" style={{ gap: 32, flexWrap: "wrap" }}>
          {metrics.map((m) => (
            <div key={m.label} style={{ minWidth: 140 }}>
              <div className="muted">{m.label}</div>
              <div style={{ fontSize: 28, fontWeight: 700 }}>{m.value}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>章節完成率統計</h3>
        {data.chapterCompletionStats.length === 0 ? (
          <p className="muted">尚無章節完成資料。</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>章節</th>
                <th>完成人數</th>
                <th>完成率</th>
              </tr>
            </thead>
            <tbody>
              {data.chapterCompletionStats.map((c) => (
                <tr key={c.chapterId}>
                  <td>{c.orderIndex + 1}. {c.title}</td>
                  <td>{c.completedCount}</td>
                  <td>{formatPercent(c.completionRate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>各頁停留與完成分布</h3>
        {data.pageDropoffDistribution.length === 0 ? (
          <p className="muted">尚無頁面進度資料。</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>頁碼</th>
                <th>目前停留讀者</th>
                <th>已完成讀者</th>
              </tr>
            </thead>
            <tbody>
              {data.pageDropoffDistribution.map((p) => (
                <tr key={p.page}>
                  <td>第 {p.page} 頁</td>
                  <td>{p.currentReadersCount}</td>
                  <td>{p.completedReadersCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>近期讀者進度</h3>
        {data.recentReaders.length === 0 ? (
          <p className="muted">尚無讀者進度資料。</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>工作階段</th>
                <th>目前頁碼</th>
                <th>完成頁數</th>
                <th>完成章節數</th>
                <th>最後更新</th>
              </tr>
            </thead>
            <tbody>
              {data.recentReaders.map((r) => (
                <tr key={r.sessionId}>
                  <td><code>{r.sessionId}</code></td>
                  <td>{r.currentPage ?? "—"}</td>
                  <td>{r.completedPagesCount}</td>
                  <td>{r.completedChaptersCount}</td>
                  <td className="muted">{formatTime(r.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
