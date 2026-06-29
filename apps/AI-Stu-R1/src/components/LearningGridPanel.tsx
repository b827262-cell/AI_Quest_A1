import { useCallback, useEffect, useState } from "react";
import { studentClient, type KnowledgePoint } from "../studentClient";
import { buildLearningGridCells } from "../learningGrid";

type FilterMode = "all" | "chapter";

function difficultyLabel(d: KnowledgePoint["difficulty"]): string {
  if (d === "basic") return "基礎";
  if (d === "intermediate") return "中階";
  return "進階";
}

function importanceLabel(i: KnowledgePoint["importance"]): string {
  if (i === "low") return "一般";
  if (i === "medium") return "重要";
  return "關鍵";
}

export function LearningGridPanel({
  bookId,
  sessionId,
  chapterId,
  chapterTitle,
  onJumpToPage,
  onCollapse
}: {
  bookId: string;
  sessionId: string;
  chapterId: string | null;
  chapterTitle: string | null;
  onJumpToPage: (page: number) => void;
  onCollapse?: () => void;
}) {
  const [points, setPoints] = useState<KnowledgePoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filterMode, setFilterMode] = useState<FilterMode>(chapterId ? "chapter" : "all");
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [notice, setNotice] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    setError("");
    setSelectedIdx(null);
    const params = filterMode === "chapter" && chapterId ? { chapterId } : undefined;
    studentClient
      .getKnowledgePoints(bookId, params, sessionId)
      .then((res) => setPoints(res.points))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [bookId, sessionId, filterMode, chapterId]);

  useEffect(() => {
    load();
  }, [load]);

  function showNotice(msg: string) {
    setNotice(msg);
    window.setTimeout(() => setNotice(""), 3000);
  }

  async function handleComplete(point: KnowledgePoint) {
    if (actionBusy) return;
    setActionBusy(true);
    try {
      const result = await studentClient.completeKnowledgePoint(bookId, point.id, sessionId);
      setPoints((prev) => prev.map((p) => (p.id === result.point.id ? result.point : p)));
      showNotice("已標記完成 ✓");
    } catch (e: unknown) {
      showNotice(e instanceof Error ? e.message : "操作失敗，請重試");
    } finally {
      setActionBusy(false);
    }
  }

  function switchFilter(next: FilterMode) {
    if (next !== filterMode) setFilterMode(next);
  }

  const cells = buildLearningGridCells(points, 5);
  const selectedCell = selectedIdx != null ? (cells[selectedIdx] ?? null) : null;
  const selectedPoint = selectedCell?.point ?? null;
  const completedCount = points.filter((p) => p.status === "completed").length;
  const allDone = points.length > 0 && completedCount === points.length;

  return (
    <div className="learning-grid-panel">
      <div className="learning-grid-panel-head">
        <h4>5×5 學習格</h4>
        {onCollapse && (
          <button type="button" className="notes-btn small" onClick={onCollapse}>
            收合
          </button>
        )}
      </div>

      <div className="learning-grid-filter-bar">
        <button
          type="button"
          className={`learning-grid-filter-tab${filterMode === "all" ? " active" : ""}`}
          onClick={() => switchFilter("all")}
        >
          全部
        </button>
        {chapterId && (
          <button
            type="button"
            className={`learning-grid-filter-tab${filterMode === "chapter" ? " active" : ""}`}
            onClick={() => switchFilter("chapter")}
          >
            {chapterTitle ?? "本章"}
          </button>
        )}
      </div>

      {loading && <p className="muted learning-grid-status">載入學習格中…</p>}

      {!loading && error && (
        <div className="learning-grid-error">
          <p className="error-text">{error}</p>
          <button type="button" className="notes-btn" onClick={load}>
            重試
          </button>
        </div>
      )}

      {!loading && !error && points.length === 0 && (
        <p className="muted learning-grid-status">
          {filterMode === "chapter" && chapterId ? "本章尚無知識點。" : "此書尚無知識點。"}
        </p>
      )}

      {!loading && !error && points.length > 0 && (
        <>
          {allDone && (
            <p className="learning-grid-all-done">全部知識點已完成 ✓</p>
          )}

          <div className="learning-grid" aria-label="知識點學習格">
            {cells.map((cell, idx) => (
              <button
                key={cell.cellIndex}
                type="button"
                className={`learning-grid-cell ${cell.status}${selectedIdx === idx ? " selected" : ""}`}
                onClick={() => {
                  if (cell.point) setSelectedIdx(idx);
                }}
                disabled={cell.status === "empty"}
                title={cell.point?.title ?? `格子 ${cell.cellIndex}`}
                aria-label={cell.point?.title ?? `空格 ${cell.cellIndex}`}
                aria-pressed={selectedIdx === idx}
              >
                <span className="learning-grid-cell-index">{cell.cellIndex}</span>
                {cell.status === "completed" && (
                  <span className="learning-grid-cell-check" aria-hidden="true">✓</span>
                )}
              </button>
            ))}
          </div>

          <p className="muted learning-grid-count">
            {completedCount} / {points.length} 已完成
            {points.length > 25 ? "（顯示前 25 筆）" : ""}
          </p>

          {selectedPoint && (
            <div className="learning-grid-detail">
              <div className="learning-grid-detail-head">
                <strong className="learning-grid-detail-title">{selectedPoint.title}</strong>
                <button
                  type="button"
                  className="learning-grid-detail-close"
                  onClick={() => setSelectedIdx(null)}
                  aria-label="關閉詳情"
                >
                  ×
                </button>
              </div>

              <div className="learning-grid-detail-badges">
                <span className={`learning-grid-badge difficulty-${selectedPoint.difficulty}`}>
                  {difficultyLabel(selectedPoint.difficulty)}
                </span>
                <span className={`learning-grid-badge importance-${selectedPoint.importance}`}>
                  {importanceLabel(selectedPoint.importance)}
                </span>
                {selectedPoint.status === "completed" && (
                  <span className="learning-grid-badge done">已完成</span>
                )}
              </div>

              {selectedPoint.summary && (
                <p className="learning-grid-detail-summary">{selectedPoint.summary}</p>
              )}

              {selectedPoint.sourcePageStart != null && (
                <p className="muted learning-grid-detail-page">
                  來源：P{selectedPoint.sourcePageStart}
                  {selectedPoint.sourcePageEnd != null &&
                  selectedPoint.sourcePageEnd !== selectedPoint.sourcePageStart
                    ? `–${selectedPoint.sourcePageEnd}`
                    : ""}
                </p>
              )}

              {notice && <p className="learning-grid-notice">{notice}</p>}

              <div className="learning-grid-detail-actions">
                {selectedPoint.sourcePageStart != null && (
                  <button
                    type="button"
                    className="notes-btn"
                    onClick={() => {
                      const page = selectedPoint.sourcePageStart;
                      if (page != null) onJumpToPage(page);
                    }}
                  >
                    跳到來源頁
                  </button>
                )}
                {selectedPoint.status !== "completed" && (
                  <button
                    type="button"
                    className="notes-btn primary"
                    disabled={actionBusy}
                    onClick={() => void handleComplete(selectedPoint)}
                  >
                    {actionBusy ? "處理中…" : "✓ 標記完成"}
                  </button>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
