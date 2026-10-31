import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { AdminChapter, Book } from "@ai-smartbook/schema";
import { adminApi } from "../api";
import { AdminPageHeader } from "../components/admin/AdminPageHeader";
import { AdminCard } from "../components/admin/AdminCard";
import { AdminErrorCard } from "../components/admin/AdminErrorCard";
import { useConfirm } from "../components/useConfirm";

const STATUS_LABEL: Record<string, { text: string; cls: string }> = {
  linked: { text: "已連結", cls: "parsed" },
  unlinked: { text: "未連結", cls: "draft" },
  missing_content: { text: "無可用內容", cls: "archived" },
  page_range_invalid: { text: "頁碼範圍錯誤", cls: "failed" }
};

interface EditState {
  title: string;
  pageStart: string;
  pageEnd: string;
  level: string;
}

export function ChaptersPage() {
  const { bookId = "" } = useParams();
  const navigate = useNavigate();
  const [book, setBook] = useState<Book | null>(null);
  const [chapters, setChapters] = useState<AdminChapter[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [edit, setEdit] = useState<EditState>({ title: "", pageStart: "", pageEnd: "", level: "0" });
  const [newCh, setNewCh] = useState<EditState>({ title: "", pageStart: "", pageEnd: "", level: "0" });
  const confirmAction = useConfirm();

  const load = useCallback(() => {
    setError("");
    return Promise.all([adminApi.getBook(bookId), adminApi.getChapters(bookId)])
      .then(([b, c]) => {
        setBook(b.book);
        setChapters(c.chapters);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [bookId]);

  useEffect(() => {
    void load();
  }, [load]);

  function num(v: string): number | null {
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
  }

  async function run(fn: () => Promise<unknown>, okMsg = "") {
    setBusy(true);
    setError("");
    setMsg("");
    try {
      await fn();
      await load();
      if (okMsg) setMsg(okMsg);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function startEdit(c: AdminChapter) {
    setEditing(c.id);
    setEdit({
      title: c.title,
      pageStart: c.pageStart != null ? String(c.pageStart) : "",
      pageEnd: c.pageEnd != null ? String(c.pageEnd) : "",
      level: String(c.level ?? 0)
    });
  }

  async function onDeleteChapter(chapter: AdminChapter) {
    const confirmed = await confirmAction({
      title: "確認刪除章節",
      message: "確定刪除此章節嗎？",
      tone: "danger"
    });
    if (!confirmed) return;
    await run(() => adminApi.deleteChapter(bookId, chapter.id), "已刪除章節");
  }

  if (error && chapters.length === 0 && !book) {
    return (
      <div>
        <AdminPageHeader title="書本章節管理" actions={<Link className="admin-btn ghost" to="/admin/books">返回書本列表</Link>} />
        <AdminErrorCard
          title="章節資料讀取失敗"
          description="後端目前無法回應，請確認 API Server 是否啟動，或稍後重新整理。"
          code={error}
          onRetry={() => void load()}
        />
      </div>
    );
  }

  return (
    <div>
      <AdminPageHeader
        title="書本章節管理"
        actions={
          <>
            <Link className="admin-btn ghost" to="/admin/books">返回書本列表</Link>
            <Link className="admin-btn" to={`/admin/books/${bookId}/files`}>
              Open Files Workflow
            </Link>
            <button className="admin-btn secondary" disabled={busy} onClick={() => void run(() => adminApi.linkChapterContent(bookId), "已重新連結內容")}>
              重新連結內容
            </button>
          </>
        }
      />

      {error && <p className="error">{error}</p>}
      {msg && <p className="muted">{msg}</p>}

      <AdminCard title="書本資訊">
        {!book ? (
          <p className="muted">載入中…</p>
        ) : (
          <div className="admin-info-grid">
            <div><span className="muted">書名</span><strong>{book.title}</strong></div>
            <div><span className="muted">類科</span><strong>{book.category || "未分類"}</strong></div>
            <div><span className="muted">作者</span><strong>{book.subtitle || "—"}</strong></div>
            <div><span className="muted">章節數</span><strong>{chapters.length}</strong></div>
            <div><span className="muted">狀態</span><span className={`badge ${book.status}`}>{book.status}</span></div>
          </div>
        )}
      </AdminCard>

      <AdminCard title={`章節列表（${chapters.length}）`}>
        {chapters.length === 0 ? (
          <p className="muted">尚未建立章節，請先到 Files 頁完成 outline preview 與 Apply，再於此頁管理結果。</p>
        ) : (
          <div className="admin-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>章節標題</th>
                  <th>頁碼</th>
                  <th>層級</th>
                  <th>來源</th>
                  <th>對應內容</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {chapters.map((c, i) => {
                  const st = STATUS_LABEL[c.contentLinkStatus] ?? STATUS_LABEL.unlinked;
                  const isEdit = editing === c.id;
                  return (
                    <tr key={c.id}>
                      <td>{i + 1}</td>
                      <td>
                        {isEdit ? (
                          <input value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} />
                        ) : (
                          c.title
                        )}
                      </td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        {isEdit ? (
                          <span style={{ display: "inline-flex", gap: 4 }}>
                            <input style={{ width: 56 }} value={edit.pageStart} onChange={(e) => setEdit({ ...edit, pageStart: e.target.value })} />
                            <input style={{ width: 56 }} value={edit.pageEnd} onChange={(e) => setEdit({ ...edit, pageEnd: e.target.value })} />
                          </span>
                        ) : c.pageStart != null ? (
                          `${c.pageStart}${c.pageEnd != null ? `–${c.pageEnd}` : ""}`
                        ) : (
                          "—"
                        )}
                      </td>
                      <td>{isEdit ? <input style={{ width: 48 }} value={edit.level} onChange={(e) => setEdit({ ...edit, level: e.target.value })} /> : `L${(c.level ?? 0) + 1}`}</td>
                      <td className="muted">{c.source}</td>
                      <td>
                        <span className={`badge ${st.cls}`}>{st.text}</span>
                        {c.linkedContentCount > 0 ? <span className="muted"> {c.linkedContentCount} 段</span> : null}
                      </td>
                      <td>
                        <div className="admin-row-actions">
                          {isEdit ? (
                            <>
                              <button className="admin-link-btn" disabled={busy} onClick={() => void run(() => adminApi.updateChapter(bookId, c.id, {
                                title: edit.title,
                                pageStart: num(edit.pageStart),
                                pageEnd: num(edit.pageEnd),
                                level: num(edit.level) ?? 0
                              }), "已儲存章節").then(() => setEditing(null))}>儲存</button>
                              <button className="admin-link-btn" onClick={() => setEditing(null)}>取消</button>
                            </>
                          ) : (
                            <>
                              <button className="admin-link-btn" onClick={() => startEdit(c)}>編輯</button>
                              <button className="admin-link-btn" disabled={busy} onClick={() => void onDeleteChapter(c)}>刪除</button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </AdminCard>

      <AdminCard title="新增章節">
        <div className="row" style={{ gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
          <div><label>標題</label><input style={{ width: 220 }} value={newCh.title} onChange={(e) => setNewCh({ ...newCh, title: e.target.value })} /></div>
          <div><label>起始頁</label><input style={{ width: 80 }} value={newCh.pageStart} onChange={(e) => setNewCh({ ...newCh, pageStart: e.target.value })} /></div>
          <div><label>結束頁</label><input style={{ width: 80 }} value={newCh.pageEnd} onChange={(e) => setNewCh({ ...newCh, pageEnd: e.target.value })} /></div>
          <div><label>層級</label><input style={{ width: 60 }} value={newCh.level} onChange={(e) => setNewCh({ ...newCh, level: e.target.value })} /></div>
          <button className="admin-btn" disabled={busy || !newCh.title.trim()} onClick={() => void run(() => adminApi.createChapter(bookId, {
            title: newCh.title.trim(),
            orderIndex: chapters.length,
            pageStart: num(newCh.pageStart),
            pageEnd: num(newCh.pageEnd),
            level: num(newCh.level) ?? 0
          }), "已新增章節").then(() => setNewCh({ title: "", pageStart: "", pageEnd: "", level: "0" }))}>新增</button>
        </div>
      </AdminCard>

      <div className="admin-inline-link">
        <button className="admin-link-btn" onClick={() => navigate(`/admin/books/${bookId}/qa`)}>
          前往「書本 Q&A / 知識問答」 →
        </button>
      </div>
    </div>
  );
}
