import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AdminCard } from "../components/admin/AdminCard";
import { AdminErrorCard } from "../components/admin/AdminErrorCard";
import { AdminPageHeader } from "../components/admin/AdminPageHeader";
import { examSnapshotApi } from "../api";
import {
  EXAM_SNAPSHOT_STATUS_LABELS,
  examSnapshotErrorLabel,
  formatExamSnapshotCount,
  formatExamSnapshotTime,
  taipeiDateKey,
  type ExamSnapshotClient,
  type ExamSnapshotRow,
  type ExamSnapshotYear
} from "../exam-snapshots-contract";

/** Slot D real wiring: the page reads and writes the two admin exam-snapshot endpoints. */
export function ExamSnapshotsPage({ client = examSnapshotApi }: { client?: ExamSnapshotClient }) {
  const [snapshots, setSnapshots] = useState<ExamSnapshotRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshingYear, setRefreshingYear] = useState<ExamSnapshotYear | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const requestSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setError("");
    try {
      const response = await client.listSnapshots();
      if (seq !== requestSeq.current) return;
      setSnapshots(response.snapshots);
    } catch (cause) {
      if (seq !== requestSeq.current) return;
      setError(cause instanceof Error ? cause.message : "快照資料載入失敗");
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const totals = useMemo(() => ({
    records: snapshots.reduce((sum, snapshot) => sum + (snapshot.row_count ?? 0), 0),
    pendingYears: snapshots.filter((snapshot) => snapshot.status !== "fresh").length,
    lastSnapshotAt: snapshots.map((snapshot) => snapshot.last_snapshot_at).filter((value): value is string => value !== null).sort().at(-1) ?? null
  }), [snapshots]);

  async function refreshToday(year: ExamSnapshotYear) {
    setRefreshingYear(year);
    setError("");
    setMessage("");
    // 每日一次：同一年度在同一個台北日裡重複點擊會沿用同一份快照。
    const idempotencyKey = `exam-snapshot-${year}-${taipeiDateKey(new Date())}`;
    try {
      const result = await client.refreshTodaySnapshot(year, idempotencyKey);
      setSnapshots((current) => {
        const replaced = current.map((snapshot) => (snapshot.year === year ? result.snapshot : snapshot));
        return replaced.some((snapshot) => snapshot.year === year)
          ? replaced
          : [...replaced, result.snapshot].sort((a, b) => a.year.localeCompare(b.year));
      });
      setMessage(result.reused
        ? `${year} 年度今日已有快照，已沿用既有結果。`
        : result.status === "failed" || result.status === "unavailable"
          ? `${year} 年度今日快照更新失敗${examSnapshotErrorLabel(result.snapshot.last_error) ? `（${examSnapshotErrorLabel(result.snapshot.last_error)}）` : ""}，未寫入任何資料。`
          : `${year} 年度今日快照已更新，本次寫入 ${formatExamSnapshotCount(result.changed_count)} 筆，目前共 ${formatExamSnapshotCount(result.snapshot.row_count)} 筆。`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `${year} 年度快照更新失敗`);
      // A rejected refresh must leave the table showing the last real database read.
      await load();
    } finally {
      setRefreshingYear(null);
    }
  }

  if (loading) return <p role="status">高普考資料快照載入中…</p>;
  if (error && snapshots.length === 0) {
    return <AdminErrorCard title="高普考資料快照無法載入" description={error} onRetry={() => void load()} />;
  }

  return (
    <div>
      <AdminPageHeader
        title="高普考資料快照"
        subtitle="查看各年度試題資料快照的更新時間、筆數與狀態，並手動更新今日快照。"
        actions={
          <button className="admin-btn secondary" type="button" disabled={refreshingYear !== null} onClick={() => void load()}>
            重新整理
          </button>
        }
      />

      <div className="exam-snapshot-notice" role="note">
        資料來源為 ec.ibrain.com.tw 的 115 / 116 高普考公開課程頁面；更新一律依 content_hash 覆蓋寫入，內容未變的年度不會重複覆寫。資料庫或來源不可用時會明確顯示失敗狀態，不會顯示假的成功。
      </div>

      {message && <p className="admin-inline-success" role="status">{message}</p>}
      {error && <p className="admin-inline-error" role="alert">{error}</p>}

      <div className="evaluation-summary-grid">
        <div className="evaluation-summary-card"><span>快照總筆數</span><strong>{formatExamSnapshotCount(totals.records)}</strong></div>
        <div className="evaluation-summary-card"><span>待更新年度</span><strong>{totals.pendingYears === 0 ? "全部完成" : `${totals.pendingYears} 個年度`}</strong></div>
        <div className="evaluation-summary-card"><span>最後快照時間</span><strong>{formatExamSnapshotTime(totals.lastSnapshotAt)}</strong></div>
      </div>

      <AdminCard title="年度快照">
        {snapshots.length === 0 ? (
          <p className="muted">尚無快照資料。</p>
        ) : (
          <div className="admin-table-wrap">
            <table className="admin-table-compact">
              <thead>
                <tr>
                  <th scope="col">年度</th>
                  <th scope="col">最後快照時間</th>
                  <th scope="col">筆數</th>
                  <th scope="col">狀態</th>
                  <th scope="col">更新今日快照</th>
                </tr>
              </thead>
              <tbody>
                {snapshots.map((snapshot) => (
                  <tr key={snapshot.year}>
                    <td>{snapshot.year} 年高普考</td>
                    <td>{formatExamSnapshotTime(snapshot.last_snapshot_at)}</td>
                    <td>{formatExamSnapshotCount(snapshot.row_count)}</td>
                    <td>
                      <span
                        className={`exam-snapshot-status exam-snapshot-status-${snapshot.status}`}
                        title={examSnapshotErrorLabel(snapshot.last_error) ?? undefined}
                      >
                        {EXAM_SNAPSHOT_STATUS_LABELS[snapshot.status]}
                      </span>
                    </td>
                    <td>
                      <button
                        className="admin-btn admin-btn-sm"
                        type="button"
                        disabled={refreshingYear !== null}
                        aria-busy={refreshingYear === snapshot.year}
                        onClick={() => void refreshToday(snapshot.year)}
                      >
                        {refreshingYear === snapshot.year ? "更新中…" : "更新今日快照"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted">狀態依「最後快照時間是否屬於今日」推導；跨日後會自動回到待更新，不需要額外排程寫入。</p>
      </AdminCard>
    </div>
  );
}
