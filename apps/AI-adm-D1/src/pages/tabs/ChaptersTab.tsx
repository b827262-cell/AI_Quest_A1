import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { BookChapter } from "@ai-smartbook/schema";
import { adminApi } from "../../api";

export function ChaptersTab({ bookId }: { bookId: string }) {
  const [chapters, setChapters] = useState<BookChapter[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const reload = useCallback(async () => {
    try {
      const d = await adminApi.getChapters(bookId);
      setChapters(d.chapters);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [bookId]);
  useEffect(() => {
    void reload();
  }, [reload]);

  async function onSummarize(chapterId: string) {
    setBusy(true);
    setError("");
    try {
      await adminApi.summarizeChapter(bookId, chapterId);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="card row between">
        <div>
          <h3 style={{ margin: 0 }}>章節（{chapters.length}）</h3>
          <p className="muted" style={{ margin: "4px 0 0" }}>
            Applied chapter results are managed from the Files tab after preview and apply.
          </p>
        </div>
        <Link className="btn" to={`/admin/books/${bookId}/files`}>
          Open Files Workflow
        </Link>
      </div>
      {error && <p className="error">{error}</p>}

      {chapters.map((c) => (
        <div className="card" key={c.id}>
          <div className="row between">
            <strong>
              {c.orderIndex + 1}. {c.title}
            </strong>
            <button className="btn secondary" onClick={() => onSummarize(c.id)} disabled={busy}>
              AI 摘要
            </button>
          </div>
          <p className="muted" style={{ marginBottom: 0 }}>
            {c.summary || "（尚無摘要）"}
          </p>
        </div>
      ))}
    </div>
  );
}
