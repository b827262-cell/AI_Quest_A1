import { useEffect, useState } from "react";
import { adminApi, type AdminLearningHistoryDetail, type AdminLearningHistorySummary } from "../api";
import { AdminCard } from "../components/admin/AdminCard";
import { AdminPageHeader } from "../components/admin/AdminPageHeader";

const PAGE_SIZE = 25;
const formatTime = (value: string | null | undefined) => value ? new Date(value).toLocaleString("zh-TW") : "—";

export function AdminLearningHistoryPage() {
  const [searchDraft, setSearchDraft] = useState("");
  const [q, setQ] = useState("");
  const [strategy, setStrategy] = useState("");
  const [sourceType, setSourceType] = useState("");
  const [status, setStatus] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<AdminLearningHistorySummary[]>([]);
  const [total, setTotal] = useState(0);
  const [detail, setDetail] = useState<AdminLearningHistoryDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    void adminApi.listLearningHistory({ q, strategy, sourceType, status, from, to, offset: page * PAGE_SIZE, limit: PAGE_SIZE })
      .then((result) => { if (active) { setRows(result.entries); setTotal(result.total); } })
      .catch((err: unknown) => { if (active) setError(err instanceof Error ? err.message : "讀取失敗"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [q, strategy, sourceType, status, from, to, page]);

  async function showDetail(row: AdminLearningHistorySummary) {
    setDetail(null);
    try {
      const result = await adminApi.getLearningHistoryDetail(row.studentId, row.id);
      setDetail(result.entry);
    } catch (err) {
      setError(err instanceof Error ? err.message : "詳情讀取失敗");
    }
  }

  return <div>
    <AdminPageHeader title="學習紀錄管理" subtitle="檢視已登入學員同步的紀錄；訪客裝置上的資料須由學員明確匯入" />
    <AdminCard title={`學習紀錄（${total}）`}>
      <form onSubmit={(event) => { event.preventDefault(); setPage(0); setQ(searchDraft.trim()); }} aria-label="搜尋學習紀錄">
        <label>問題或學生 <input value={searchDraft} maxLength={100} onChange={(event) => setSearchDraft(event.target.value)} /></label>
        <button type="submit">搜尋</button>
        <label>解答方式 <select value={strategy} onChange={(event) => { setPage(0); setStrategy(event.target.value); }}><option value="">全部</option><option value="google-ai">搜尋好朋友</option><option value="api">API</option></select></label>
        <label>來源型態 <select value={sourceType} onChange={(event) => { setPage(0); setSourceType(event.target.value); }}><option value="">全部</option><option value="manual">手動</option><option value="image">圖片</option><option value="file">文件</option></select></label>
        <label>狀態 <select value={status} onChange={(event) => { setPage(0); setStatus(event.target.value); }}><option value="">全部</option><option value="active">已同步</option><option value="deleted">已刪除</option></select></label>
        <label>開始日期 <input type="date" value={from} onChange={(event) => { setPage(0); setFrom(event.target.value); }} /></label>
        <label>結束日期 <input type="date" value={to} onChange={(event) => { setPage(0); setTo(event.target.value); }} /></label>
      </form>
      {error ? <p role="alert">{error}</p> : null}
      {loading ? <p>載入中…</p> : <div className="admin-table-wrap"><table className="admin-table">
        <thead><tr><th>提問時間</th><th>學生／匿名狀態</th><th>問題摘要</th><th>解答方式</th><th>來源型態</th><th>原始回答</th><th>答案摘要</th><th>同步時間</th><th>同步／刪除狀態</th><th>詳情</th></tr></thead>
        <tbody>{rows.map((row) => <tr key={`${row.studentId}:${row.id}`}>
          <td>{formatTime(row.askedAt)}</td><td>{row.student}</td><td>{row.questionSummary}</td>
          <td>{row.strategy === "google-ai" ? "搜尋好朋友" : "API"}</td><td>{row.sourceType}</td>
          <td>{row.hasRawAnswer ? "已保存" : "未保存"}</td><td>{row.answerSummary || "—"}</td>
          <td>{formatTime(row.updatedAt)}</td><td>{row.deletedAt ? "已刪除" : "已同步"}</td>
          <td><button type="button" onClick={() => void showDetail(row)}>查看</button></td>
        </tr>)}</tbody>
      </table>{!rows.length ? <p>沒有符合條件的紀錄。</p> : null}</div>}
      <div className="admin-pagination">
        <button type="button" disabled={page === 0} onClick={() => setPage((value) => value - 1)}>上一頁</button>
        <span>第 {page + 1} 頁，共 {Math.max(1, Math.ceil(total / PAGE_SIZE))} 頁</span>
        <button type="button" disabled={(page + 1) * PAGE_SIZE >= total} onClick={() => setPage((value) => value + 1)}>下一頁</button>
      </div>
    </AdminCard>
    {detail ? <AdminCard title="學習紀錄詳情">
      <button type="button" onClick={() => setDetail(null)}>關閉詳情</button>
      <dl><dt>學生</dt><dd>{detail.student}</dd><dt>提問時間</dt><dd>{formatTime(detail.askedAt)}</dd><dt>問題</dt><dd>{detail.question}</dd><dt>分類</dt><dd>{detail.category}</dd><dt>解答方式</dt><dd>{detail.strategy}</dd><dt>來源型態</dt><dd>{detail.sourceType}</dd><dt>同步版本</dt><dd>{detail.syncVersion}</dd></dl>
      <h3>答案</h3><pre>{detail.answer || "—"}</pre>
      <h3>原始回答</h3><pre>{detail.rawAnswer || "—"}</pre>
      <h3>整理後回答</h3><pre>{detail.organizedAnswer || "—"}</pre>
      {detail.sourceUrl ? <p><a href={detail.sourceUrl} target="_blank" rel="noopener noreferrer">開啟來源連結</a></p> : null}
      <p>原始回答擷取：{formatTime(detail.rawAnswerCapturedAt)}；刪除：{formatTime(detail.deletedAt)}</p>
    </AdminCard> : null}
  </div>;
}
