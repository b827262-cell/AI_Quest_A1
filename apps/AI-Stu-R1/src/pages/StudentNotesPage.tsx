import { useCallback, useEffect, useState } from "react";
import { studentClient } from "../studentClient";
import type { StudentNote } from "@ai-smartbook/schema";
import { useConfirm } from "../components/useConfirm";
import { StudentAiAssistant } from "../components/student-ai/StudentAiAssistant";

/** Prefill payload handed to the embedded assistant for a note follow-up. */
interface AskPrefill {
  text: string;
  nonce: number;
}

/** Split a comma-separated tag input into trimmed, non-empty tags. */
function parseTags(raw: string): string[] {
  return raw
    .split(/[,，]/)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

/**
 * 我的課業筆記本（R24 `/notes`）：獨立筆記清單頁。
 * 走 `/api/student/notes`（studentClient）讀取/編輯/刪除，支援關鍵字搜尋（q）、
 * 標籤 chip 篩選（tag，含「全部」重置）、行內編輯 title/content/tags，以及
 * 「針對此筆記追問」把筆記帶入內嵌 StudentAiAssistant。全部純文字渲染。
 */
export function StudentNotesPage() {
  const [notes, setNotes] = useState<StudentNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [query, setQuery] = useState("");
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [knownTags, setKnownTags] = useState<string[]>([]);
  const [reloadToken, setReloadToken] = useState(0);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editContent, setEditContent] = useState("");
  const [editTags, setEditTags] = useState("");
  const [askPrefill, setAskPrefill] = useState<AskPrefill | null>(null);
  const confirmAction = useConfirm();

  const reload = useCallback(() => setReloadToken((token) => token + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    studentClient
      .listStudentNotes({
        tag: activeTag ?? undefined,
        q: query.trim() || undefined,
        limit: 100
      })
      .then((result) => {
        if (cancelled) return;
        setNotes(result.notes);
        // Chips accumulate across loads so a search that filters tags out
        // never disables a chip the learner just used.
        setKnownTags((prev) => {
          const next = new Set(prev);
          for (const note of result.notes) {
            for (const tag of note.tags ?? []) next.add(tag);
          }
          return [...next].sort((a, b) => a.localeCompare(b, "zh-Hant"));
        });
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeTag, query, reloadToken]);

  function submitSearch() {
    setQuery(searchInput.trim());
  }

  function startEditing(note: StudentNote) {
    setEditingId(note.id);
    setEditTitle(note.title ?? "");
    setEditContent(note.content ?? "");
    setEditTags((note.tags ?? []).join(","));
    setNotice("");
    setError("");
  }

  function cancelEditing() {
    setEditingId(null);
    setEditTitle("");
    setEditContent("");
    setEditTags("");
  }

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

  function saveEditing(note: StudentNote) {
    void run(async () => {
      await studentClient.updateStudentNote(note.id, {
        title: editTitle.trim() || undefined,
        content: editContent.trim(),
        tags: parseTags(editTags)
      });
      cancelEditing();
      setNotice("✅ 已更新筆記");
      reload();
    });
  }

  function removeNote(note: StudentNote) {
    void confirmAction({
      title: "刪除筆記",
      message: "刪除這則課業筆記？此操作無法復原。",
      tone: "danger"
    }).then((confirmed) => {
      if (!confirmed) return;
      void run(async () => {
        // The delete carries the version the learner actually saw; a concurrent
        // writer yields deleted=false, which we surface and recover from.
        const result = await studentClient.deleteStudentNote(note.id, note.syncVersion);
        if (!result.deleted) {
          setError("這則筆記剛被其他裝置更新（版本衝突），已重新載入最新狀態，請再試一次。");
        } else {
          setNotice("已刪除筆記");
        }
        reload();
      });
    });
  }

  function askAboutNote(note: StudentNote) {
    const summary = (note.content ?? "").trim().slice(0, 80);
    const title = note.title?.trim() || "未命名筆記";
    setAskPrefill({
      text: summary ? `請針對我的筆記「${title}」進一步說明：${summary}` : `請針對我的筆記「${title}」進一步說明。`,
      nonce: Date.now()
    });
  }

  return (
    <section
      className="student-notes-page"
      aria-labelledby="student-notes-page-heading"
      data-testid="student-notes-page"
    >
      <h2 id="student-notes-page-heading">我的課業筆記本</h2>
      <p className="muted">集中管理你的課業筆記：搜尋、標籤篩選、行內編輯，或針對任一筆記追問。</p>

      <form
        className="student-notes-search"
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          submitSearch();
        }}
      >
        <input
          type="text"
          className="student-notes-search-input"
          data-testid="notes-search-input"
          aria-label="搜尋筆記"
          placeholder="搜尋標題、內容或標籤…"
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
        />
        <button type="submit" className="student-notes-search-submit" data-testid="notes-search-submit">
          搜尋
        </button>
      </form>

      <div className="student-notes-tags" data-testid="notes-tag-filter" role="group" aria-label="標籤篩選">
        <button
          type="button"
          className={`student-notes-tag-chip${activeTag === null ? " active" : ""}`}
          data-testid="notes-tag-all"
          onClick={() => setActiveTag(null)}
        >
          全部
        </button>
        {knownTags.map((tag) => (
          <button
            key={tag}
            type="button"
            className={`student-notes-tag-chip${activeTag === tag ? " active" : ""}`}
            data-testid={`notes-tag-chip-${tag}`}
            aria-pressed={activeTag === tag}
            onClick={() => setActiveTag((current) => (current === tag ? null : tag))}
          >
            {tag}
          </button>
        ))}
      </div>

      {error ? <p className="student-notes-error error-text" role="alert">{error}</p> : null}
      {notice ? <p className="student-notes-saved" role="status" data-testid="student-notes-saved">{notice}</p> : null}

      <ul className="student-notes-list" data-testid="student-notes-page-list">
        {loading ? (
          <li className="muted" data-testid="student-notes-loading">載入中…</li>
        ) : error ? null : notes.length === 0 ? (
          <li className="muted" data-testid="student-notes-empty">
            {query || activeTag ? "沒有符合篩選條件的筆記。" : "還沒有課業筆記。可以用課業助教把解答存成 AI 筆記。"}
          </li>
        ) : (
          notes.map((note) => (
            <li key={note.id} className="student-notes-item" data-testid="student-notes-item">
              {editingId === note.id ? (
                <div className="student-notes-edit" data-testid="student-notes-edit">
                  <input
                    type="text"
                    className="student-notes-input"
                    data-testid="notes-edit-title"
                    aria-label="筆記標題"
                    value={editTitle}
                    onChange={(event) => setEditTitle(event.target.value)}
                  />
                  <textarea
                    className="student-notes-textarea"
                    data-testid="notes-edit-content"
                    aria-label="筆記內容"
                    rows={4}
                    value={editContent}
                    onChange={(event) => setEditContent(event.target.value)}
                  />
                  <input
                    type="text"
                    className="student-notes-input"
                    data-testid="notes-edit-tags"
                    aria-label="筆記標籤（逗號分隔）"
                    placeholder="標籤（逗號分隔），例如：物理, 公式"
                    value={editTags}
                    onChange={(event) => setEditTags(event.target.value)}
                  />
                  <div className="student-notes-edit-actions">
                    <button
                      type="button"
                      className="student-notes-edit-save"
                      data-testid="notes-edit-save"
                      onClick={() => void saveEditing(note)}
                      disabled={busy}
                    >
                      儲存
                    </button>
                    <button
                      type="button"
                      className="student-notes-edit-cancel"
                      data-testid="notes-edit-cancel"
                      onClick={cancelEditing}
                      disabled={busy}
                    >
                      取消
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="student-notes-item-head">
                    <span className={`notes-type-badge ${note.type}`}>
                      {note.type === "ai_answer" ? "AI 解答" : note.type === "canvas" ? "手寫" : "文字"}
                    </span>
                    {note.title ? <strong className="student-notes-item-title">{note.title}</strong> : null}
                    <span className="muted">{note.createdAt.slice(0, 10)}</span>
                    <span className="student-notes-item-actions">
                      <button
                        type="button"
                        className="student-notes-edit"
                        data-testid="notes-edit"
                        onClick={() => startEditing(note)}
                        disabled={busy}
                        aria-label={`編輯筆記 ${note.title || note.id}`}
                      >
                        編輯
                      </button>
                      <button
                        type="button"
                        className="student-notes-ask"
                        data-testid="notes-ask"
                        onClick={() => askAboutNote(note)}
                        aria-label={`針對此筆記追問 ${note.title || note.id}`}
                      >
                        針對此筆記追問
                      </button>
                      <button
                        type="button"
                        className="student-notes-delete"
                        data-testid="notes-delete"
                        onClick={() => removeNote(note)}
                        disabled={busy}
                        aria-label={`刪除筆記 ${note.title || note.id}`}
                      >
                        刪除
                      </button>
                    </span>
                  </div>
                  {note.content ? <p className="student-notes-item-body">{note.content}</p> : null}
                  {(note.tags ?? []).length > 0 ? (
                    <p className="student-notes-item-tags">
                      {(note.tags ?? []).map((tag) => (
                        <span key={tag} className="student-notes-item-tag">#{tag}</span>
                      ))}
                    </p>
                  ) : null}
                </>
              )}
            </li>
          ))
        )}
      </ul>

      {askPrefill ? (
        <div className="student-notes-ask-panel" data-testid="student-notes-ask-panel">
          <h3>針對此筆記追問</h3>
          <StudentAiAssistant
            prefill={askPrefill}
            bookId={null}
            chapterId={null}
            pageNumber={null}
            onClose={() => setAskPrefill(null)}
            onNoteSaved={() => {
              setNotice("✅ 追問解答已存為課業筆記");
              reload();
            }}
          />
        </div>
      ) : null}
    </section>
  );
}
