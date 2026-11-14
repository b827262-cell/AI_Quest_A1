import { useEffect, useState } from "react";
import type { BookChapter } from "@ai-smartbook/schema";
import { adminApi, type AdminBookNote } from "../../api";

function formatTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

/** Only allow same-origin, http(s) or inline raster data-image URLs for preview.
 *  data: URLs are restricted to bitmap formats (no svg+xml / javascript:). */
export function safeImageUrl(url: string | null): string | null {
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  if (/^\//.test(url)) return url;
  if (/^data:image\/(png|jpeg|jpg|webp|gif);/i.test(url)) return url;
  return null;
}

const TYPE_OPTIONS = [
  { value: "", label: "全部" },
  { value: "text", label: "text" },
  { value: "ai_answer", label: "ai_answer" },
  { value: "canvas", label: "canvas" }
];

export function StudentNotesTab({ bookId }: { bookId: string }) {
  const [chapters, setChapters] = useState<BookChapter[]>([]);
  const [chapterId, setChapterId] = useState("");
  const [type, setType] = useState("");
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [notes, setNotes] = useState<AdminBookNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    adminApi
      .getBook(bookId)
      .then((d) => {
        if (active) setChapters(d.chapters);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [bookId]);

  // Debounce the keyword so typing does not fire a request per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    adminApi
      .getBookNotes(bookId, {
        chapterId: chapterId || undefined,
        type: type || undefined,
        q: debouncedQuery || undefined
      })
      .then((d) => {
        if (active) setNotes(d.notes);
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
  }, [bookId, chapterId, type, debouncedQuery]);

  async function handleDelete(noteId: string) {
    try {
      await adminApi.deleteBookNote(bookId, noteId);
      setNotes((prev) => prev.filter((n) => n.id !== noteId));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div>
      <div className="card">
        <div className="row" style={{ gap: 16, flexWrap: "wrap", alignItems: "flex-end" }}>
          <div>
            <label style={{ display: "block" }}>章節</label>
            <select value={chapterId} onChange={(e) => setChapterId(e.target.value)}>
              <option value="">全部章節</option>
              {chapters.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.orderIndex + 1}. {c.title}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label style={{ display: "block" }}>類型</label>
            <select value={type} onChange={(e) => setType(e.target.value)}>
              {TYPE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label style={{ display: "block" }}>關鍵字</label>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜尋標題或內容"
              style={{ width: 240 }}
            />
          </div>
        </div>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>學生筆記（{notes.length}）</h3>
        {loading ? (
          <p className="muted">載入中…</p>
        ) : error ? (
          <p className="error">{error}</p>
        ) : notes.length === 0 ? (
          <p className="muted">尚無符合條件的筆記。</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>標題</th>
                <th>章節</th>
                <th>頁碼</th>
                <th>類型</th>
                <th>內容</th>
                <th>建立時間</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {notes.map((n) => {
                const imageUrl = safeImageUrl(n.canvasImageUrl);
                return (
                  <tr key={n.id}>
                    <td>{n.title}</td>
                    <td>{n.chapterTitle ?? "—"}</td>
                    <td>{n.pageNumber ?? "—"}</td>
                    <td><span className="badge">{n.type}</span></td>
                    <td style={{ maxWidth: 420 }}>
                      {n.content ? (
                        <span>{n.content}</span>
                      ) : (
                        <span className="muted">（無文字內容）</span>
                      )}
                      {imageUrl ? (
                        <div style={{ marginTop: 6 }}>
                          <img
                            src={imageUrl}
                            alt={`筆記圖片：${n.title}`}
                            style={{ maxWidth: 240, maxHeight: 160, borderRadius: 6, display: "block" }}
                          />
                        </div>
                      ) : null}
                    </td>
                    <td className="muted">{formatTime(n.createdAt)}</td>
                    <td>
                      <button
                        type="button"
                        className="btn secondary"
                        onClick={() => void handleDelete(n.id)}
                      >
                        刪除
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
