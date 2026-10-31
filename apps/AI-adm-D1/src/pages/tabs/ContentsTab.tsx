import { useEffect, useState } from "react";
import type { BookContent } from "@ai-smartbook/schema";
import { adminApi } from "../../api";
import { useConfirm } from "../../components/useConfirm";

export function ContentsTab({ bookId }: { bookId: string }) {
  const [contents, setContents] = useState<BookContent[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  const confirmAction = useConfirm();

  function reload() {
    adminApi
      .getContents(bookId)
      .then((d) => setContents(d.contents))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }

  useEffect(() => {
    reload();
  }, [bookId]);

  async function onClear() {
    const confirmed = await confirmAction({
      title: "確認清空內容",
      message: `確定清空這本書的 ${contents.length} 段內容？`,
      tone: "danger"
    });
    if (!confirmed) return;

    setBusy(true);
    setMsg("");
    setError("");
    try {
      await adminApi.clearContents(bookId);
      setMsg("已清空內容段落");
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <div className="row between" style={{ marginBottom: 12, alignItems: "center" }}>
        <h3 style={{ margin: 0 }}>內容段落（{contents.length}）</h3>
        <button className="btn secondary" onClick={onClear} disabled={busy || contents.length === 0}>
          一鍵清空內容
        </button>
      </div>
      {msg && <p className="muted">{msg}</p>}
      {error && <p className="error">{error}</p>}
      {contents.length === 0 ? (
        <p className="muted">尚無內容，請先上傳 PDF 並解析。</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th style={{ width: 60 }}>#</th>
              <th style={{ width: 60 }}>頁</th>
              <th>內容</th>
            </tr>
          </thead>
          <tbody>
            {contents.map((c) => (
              <tr key={c.id}>
                <td>{c.orderIndex}</td>
                <td>{c.pageNumber ?? "-"}</td>
                <td>{c.contentText}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
