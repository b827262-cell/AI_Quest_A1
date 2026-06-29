import { useCallback, useEffect, useState } from "react";
import { studentClient, type ReaderProgressSummary } from "../studentClient";

function formatUpdatedAt(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("zh-TW", {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    });
  } catch {
    return iso;
  }
}

/**
 * Reader progress panel. Fetches and displays the student's reading progress
 * for the current book/session. Provides "mark page complete" and "mark chapter
 * complete" actions. All API calls go through /api/student/* via studentClient.
 *
 * Requires a live pdfSessionId — only rendered by BookReaderPage once the
 * session is established.
 */
export function ProgressPanel({
  bookId,
  sessionId,
  pdfPage,
  pageCount,
  chapterId,
  chapterTitle,
  onCollapse
}: {
  bookId: string;
  sessionId: string;
  pdfPage: number | null;
  pageCount: number | null;
  chapterId: string | null;
  chapterTitle: string | null;
  onCollapse?: () => void;
}) {
  const [summary, setSummary] = useState<ReaderProgressSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [actionBusy, setActionBusy] = useState(false);
  const [notice, setNotice] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    setError("");
    studentClient
      .getBookProgressSummary(bookId, sessionId)
      .then(setSummary)
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : String(e))
      )
      .finally(() => setLoading(false));
  }, [bookId, sessionId]);

  useEffect(() => {
    load();
  }, [load]);

  function showNotice(msg: string) {
    setNotice(msg);
    window.setTimeout(() => setNotice(""), 3000);
  }

  async function runAction(
    action: () => Promise<ReaderProgressSummary>,
    successMsg: string
  ) {
    setActionBusy(true);
    setError("");
    try {
      const updated = await action();
      setSummary(updated);
      showNotice(successMsg);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setActionBusy(false);
    }
  }

  function onMarkPageComplete() {
    if (!pdfPage) return;
    void runAction(
      () =>
        studentClient.completeReaderAction(
          bookId,
          {
            actionType: "current_page",
            page: pdfPage,
            chapterId: chapterId ?? undefined,
            source: "reader_toolbar"
          },
          sessionId
        ),
      `第 ${pdfPage} 頁已標記完成 ✓`
    );
  }

  function onMarkChapterComplete() {
    if (!chapterId) return;
    void runAction(
      () =>
        studentClient.completeReaderAction(
          bookId,
          {
            actionType: "current_chapter",
            chapterId,
            page: pdfPage ?? undefined,
            source: "reader_toolbar"
          },
          sessionId
        ),
      "本章已標記完成 ✓"
    );
  }

  const pct = summary?.completionPercentage ?? null;
  const completedCount = summary?.completedPagesCount ?? 0;
  const hasStarted =
    summary != null &&
    (summary.updatedAt != null || summary.completedPagesCount > 0);

  return (
    <div className="progress-panel">
      <div className="progress-panel-head">
        <h4>閱讀進度</h4>
        {onCollapse && (
          <button type="button" className="notes-btn small" onClick={onCollapse}>
            收合
          </button>
        )}
      </div>

      {loading && (
        <p className="muted progress-panel-status">載入進度中…</p>
      )}

      {!loading && error && (
        <div className="progress-panel-error">
          <p className="error-text">{error}</p>
          <button type="button" className="notes-btn" onClick={load}>
            重試
          </button>
        </div>
      )}

      {!loading && !error && !hasStarted && (
        <p className="muted progress-panel-status">
          尚未開始閱讀記錄，翻頁後自動記錄進度。
        </p>
      )}

      {!loading && !error && summary != null && (
        <div className="progress-panel-body">
          {pct != null && (
            <div className="progress-bar-wrap">
              <div className="progress-bar-track">
                <div
                  className="progress-bar-fill"
                  style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
                  aria-hidden="true"
                />
              </div>
              <span className="progress-bar-pct">{pct}%</span>
            </div>
          )}

          <dl className="progress-stats">
            <div className="progress-stat-row">
              <dt>目前頁</dt>
              <dd>
                {summary.currentPage != null
                  ? `第 ${summary.currentPage} 頁${
                      pageCount != null ? ` / ${pageCount}` : ""
                    }`
                  : "—"}
              </dd>
            </div>
            <div className="progress-stat-row">
              <dt>已完成頁數</dt>
              <dd>{completedCount} 頁</dd>
            </div>
            {chapterTitle && (
              <div className="progress-stat-row">
                <dt>目前章節</dt>
                <dd className="progress-stat-chapter">{chapterTitle}</dd>
              </div>
            )}
            <div className="progress-stat-row">
              <dt>最後更新</dt>
              <dd>{formatUpdatedAt(summary.updatedAt)}</dd>
            </div>
          </dl>

          {notice && <p className="progress-notice">{notice}</p>}

          <div className="progress-actions">
            <button
              type="button"
              className="notes-btn primary"
              disabled={actionBusy || !pdfPage}
              onClick={onMarkPageComplete}
              title={pdfPage ? `標記第 ${pdfPage} 頁已完成` : "需先載入 PDF"}
            >
              ✓ 標記本頁完成
            </button>
            {chapterId && (
              <button
                type="button"
                className="notes-btn"
                disabled={actionBusy}
                onClick={onMarkChapterComplete}
              >
                ✓ 標記本章完成
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
