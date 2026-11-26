import { useCallback, useEffect, useState } from "react";
import { studentClient } from "../../studentClient";
import type { StudentNote } from "@ai-smartbook/schema";
import { useConfirm } from "../useConfirm";

/**
 * Dashboard「我的課業筆記」區塊：最近課業筆記列表 + 新增手動筆記 + 刪除筆記。
 * 所有讀寫走 /api/student/notes（studentClient），狀態含 loading / empty / error /
 * note-saved（由外部 refreshKey + savedNotice 驅動，與 StudentAiAssistant 聯動）。
 */
export function StudentNotesSection({
  refreshKey = 0,
  savedNotice = null,
  onCountChange
}: {
  refreshKey?: number;
  savedNotice?: string | null;
  onCountChange?: (count: number) => void;
}) {
  const [notes, setNotes] = useState<StudentNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [newTitle, setNewTitle] = useState("");
  const [newContent, setNewContent] = useState("");
  const confirmAction = useConfirm();

  const load = useCallback(() => {
    setLoading(true);
    studentClient
      .listStudentNotes({ limit: 10 })
      .then((result) => {
        setNotes(result.notes);
        onCountChange?.(result.notes.length);
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setLoading(false));
    // onCountChange is a stable state setter in both tests and the dashboard.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  // A note saved from the assistant (or the reader) refreshes the list and
  // surfaces the note-saved status here.
  useEffect(() => {
    if (savedNotice) {
      setNotice(savedNotice);
      const timer = window.setTimeout(() => setNotice(""), 4000);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [savedNotice, refreshKey]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function addManualNote() {
    const content = newContent.trim();
    if (!content) return;
    void run(async () => {
      await studentClient.createStudentNote({
        type: "text",
        title: newTitle.trim() || undefined,
        content
      });
      setNewTitle("");
      setNewContent("");
      setNotice("✅ 已新增課業筆記");
      load();
    });
  }

  async function removeNote(note: StudentNote) {
    const confirmed = await confirmAction({
      title: "刪除筆記",
      message: "刪除這則課業筆記？",
      tone: "danger"
    });
    if (!confirmed) return;
    void run(async () => {
      const result = await studentClient.deleteStudentNote(note.id, note.syncVersion);
      // `deleted: false` = a concurrent writer bumped the version (the note was
      // updated or revived). Reload the freshest rows and tell the learner.
      if (!result.deleted) {
        setError("這則筆記剛被其他裝置更新（版本衝突），已重新載入最新狀態；請再試一次。");
      } else if (notice) {
        setNotice("");
      }
      load();
    });
  }

  return (
    <section className="student-notes-section" aria-labelledby="student-notes-heading" data-testid="student-notes-section">
      <h3 id="student-notes-heading">我的課業筆記</h3>

      <div className="student-notes-compose">
        <input
          className="student-notes-input"
          placeholder="標題（可留空）"
          value={newTitle}
          onChange={(event) => setNewTitle(event.target.value)}
          aria-label="新筆記標題"
        />
        <textarea
          className="student-notes-textarea"
          placeholder="輸入課業筆記內容…"
          value={newContent}
          onChange={(event) => setNewContent(event.target.value)}
          aria-label="新筆記內容"
          rows={2}
        />
        <button
          type="button"
          className="student-notes-add"
          data-testid="student-notes-add"
          onClick={() => void addManualNote()}
          disabled={busy || !newContent.trim()}
        >
          新增手動筆記
        </button>
      </div>

      {error ? <p className="student-notes-error error-text" role="alert">{error}</p> : null}
      {notice ? <p className="student-notes-saved" role="status" data-testid="student-notes-saved">{notice}</p> : null}

      <ul className="student-notes-list">
        {loading ? (
          <li className="muted" data-testid="student-notes-loading">載入中…</li>
        ) : notes.length === 0 ? (
          <li className="muted" data-testid="student-notes-empty">還沒有課業筆記。可以用上方課業助教把解答存成 AI 筆記，或在這裡新增手動筆記。</li>
        ) : (
          notes.map((note) => (
            <li key={note.id} className="student-notes-item" data-testid="student-notes-item">
              <div className="student-notes-item-head">
                <span className={`notes-type-badge ${note.type}`}>
                  {note.type === "ai_answer" ? "AI 解答" : note.type === "canvas" ? "手寫" : "文字"}
                </span>
                {note.title ? <strong className="student-notes-item-title">{note.title}</strong> : null}
                <span className="muted">{note.createdAt.slice(0, 10)}</span>
                <button
                  type="button"
                  className="student-notes-delete"
                  onClick={() => void removeNote(note)}
                  disabled={busy}
                  aria-label={`刪除筆記 ${note.title || note.id}`}
                >
                  刪除
                </button>
              </div>
              {note.content ? <p className="student-notes-item-body">{note.content}</p> : null}
            </li>
          ))
        )}
      </ul>
    </section>
  );
}
