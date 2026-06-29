import { useEffect, useState, type KeyboardEvent } from "react";
import type { ReaderOutlineNode } from "@ai-smartbook/schema";

/** Quick layout preset: PDF area vs AI area. PDF is the first value. */
export type ReaderRatio = "6:4" | "1:1" | "4:6";

export const READER_RATIOS: ReaderRatio[] = ["6:4", "1:1", "4:6"];

/** AI pane width (px) each ratio preset maps to (within the AI min/max range). */
export const RATIO_AI_WIDTH: Record<ReaderRatio, number> = {
  "6:4": 320,
  "1:1": 440,
  "4:6": 560
};

export const RATIO_TOC_WIDTH: Record<ReaderRatio, number> = {
  "6:4": 240,
  "1:1": 300,
  "4:6": 260
};

/** Discrete zoom percentages applied to the PDF.js render scale. Default 100. */
export const ZOOM_OPTIONS = [50, 75, 90, 100, 110, 125, 150, 175, 200];

/**
 * PDF-native reader toolbar. Every control drives the protected PDF viewer
 * state (chapter page jump, page step, render zoom, layout, collapse). The
 * ratio buttons are quick presets for the AI pane width; users can also drag
 * the split handles for fine control.
 *
 * DOWNLOAD / PRINT PROTECTION NOTE (best-effort only):
 * - No native browser PDF toolbar is shown (PDF.js canvas render, not iframe).
 * - @media print CSS hides this viewer during Ctrl+P (see styles.css).
 * - Context menu is suppressed on the canvas area (see ProtectedPdfViewer).
 * - These measures are best-effort: browser-level screenshots, DevTools,
 *   and OS-level capture cannot be prevented by frontend code alone.
 */
export function PdfReaderToolbar({
  outlineNodes,
  activeNodeId,
  onSelectOutlineNode,
  fullWidth,
  onToggleFullWidth,
  tocCollapsed,
  onToggleToc,
  selectionMode,
  onToggleSelection,
  aiOpen,
  onToggleAi,
  notesOpen,
  onToggleNotes,
  zoom,
  onZoom,
  ratio,
  onRatio,
  page,
  pageCount,
  onJumpPage,
  onPrevPage,
  onNextPage,
  onAskAi,
  selectedText,
  onAddToNotes,
  progressOpen,
  onToggleProgress,
  gridOpen,
  onToggleGrid
}: {
  outlineNodes: ReaderOutlineNode[];
  activeNodeId: string | null;
  onSelectOutlineNode: (nodeId: string | null) => void;
  fullWidth: boolean;
  onToggleFullWidth: () => void;
  tocCollapsed: boolean;
  onToggleToc: () => void;
  selectionMode: boolean;
  onToggleSelection: () => void;
  aiOpen: boolean;
  onToggleAi: () => void;
  notesOpen: boolean;
  onToggleNotes: () => void;
  zoom: number;
  onZoom: (zoom: number) => void;
  ratio: ReaderRatio | null;
  onRatio: (ratio: ReaderRatio) => void;
  page: number | null;
  pageCount: number | null;
  onJumpPage: (page: number) => void;
  onPrevPage: () => void;
  onNextPage: () => void;
  onAskAi: () => void;
  /** Currently selected PDF text; enables the Add-to-Notes toolbar button. */
  selectedText?: string;
  /** Called when the user clicks Add-to-Notes. Parent decides to save selection or open notes panel. */
  onAddToNotes: () => void;
  /** Whether the progress panel is currently open. */
  progressOpen: boolean;
  /** Toggle the reading progress panel. */
  onToggleProgress: () => void;
  /** Whether the 5×5 learning grid panel is currently open. */
  gridOpen: boolean;
  /** Toggle the 5×5 learning grid panel. */
  onToggleGrid: () => void;
}) {
  const hasPdf = page != null;
  const atFirst = page == null || page <= 1;
  const atLast = page == null || (pageCount != null && page >= pageCount);
  const hasSelection = (selectedText ?? "").trim().length > 0;
  const [pageInput, setPageInput] = useState(page != null ? String(page) : "");
  const [pageError, setPageError] = useState("");

  useEffect(() => {
    setPageInput(page != null ? String(page) : "");
    setPageError("");
  }, [page]);

  function submitPageInput() {
    const raw = pageInput.trim();
    if (!raw) {
      setPageInput(page != null ? String(page) : "");
      setPageError("");
      return;
    }
    const parsed = Number(raw);
    if (!Number.isInteger(parsed)) {
      setPageError("頁碼格式錯誤");
      return;
    }
    const next = Math.max(1, pageCount != null ? Math.min(pageCount, parsed) : parsed);
    onJumpPage(next);
    setPageInput(String(next));
    setPageError(parsed === next ? "" : "頁碼已調整至可用範圍");
  }

  function onPageInputKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") submitPageInput();
  }

  return (
    <div className="pdf-toolbar">
      <button type="button" className="tool-btn" onClick={onToggleToc}>
        {tocCollapsed ? "▸ 展開章節" : "◂ 收合章節"}
      </button>

      <button
        type="button"
        className={`tool-btn ${fullWidth ? "active" : ""}`}
        onClick={onToggleFullWidth}
        title="切換閱讀器滿版 / 一般寬度"
      >
        {fullWidth ? "滿版" : "一般"}
      </button>

      <select
        className="tool-select"
        value={activeNodeId ?? ""}
        onChange={(e) => onSelectOutlineNode(e.target.value || null)}
        title="章節大綱（跳至 PDF 實體頁）"
      >
        <option value="">全部內容（第 1 頁）</option>
        {outlineNodes.map((node) => (
          <option key={node.id} value={node.id} disabled={node.page == null}>
            {"　".repeat(Math.max(0, node.level - 1))}
            {node.title}
            {node.page != null ? `（P${node.page}）` : ""}
          </option>
        ))}
      </select>

      <div className="tool-pagenav" title="PDF 實體頁導覽">
        <button type="button" className="tool-btn" onClick={onPrevPage} disabled={atFirst}>
          ◀
        </button>
        <span className="tool-page">
          {hasPdf ? `P${page}` : "—"}
          {pageCount != null ? ` / ${pageCount}` : ""}
        </span>
        <input
          className={`tool-page-input ${pageError ? "invalid" : ""}`}
          type="text"
          value={pageInput}
          inputMode="numeric"
          pattern="[0-9]*"
          aria-label="輸入 PDF 頁碼"
          title={pageError || "輸入 PDF 頁碼後按 Enter"}
          onChange={(event) => setPageInput(event.target.value.replace(/\D/g, ""))}
          onKeyDown={onPageInputKeyDown}
          onBlur={() => {
            if (pageInput.trim() === "") setPageInput(page != null ? String(page) : "");
          }}
          disabled={!hasPdf}
        />
        <button type="button" className="tool-btn" onClick={onNextPage} disabled={atLast}>
          ▶
        </button>
      </div>

      <label className="tool-zoom">
        <span className="tool-zoom-label">縮放</span>
        <select
          className="tool-select"
          value={zoom}
          onChange={(e) => onZoom(Number(e.target.value))}
        >
          {ZOOM_OPTIONS.map((z) => (
            <option key={z} value={z}>
              {z}%
            </option>
          ))}
        </select>
      </label>

      <button
        type="button"
        className={`tool-btn ${selectionMode ? "active" : ""}`}
        onClick={onToggleSelection}
        title="文字選取：拖曳選取 PDF 文字後可複製 / 加入筆記 / 問AI重點"
      >
        🔖 {selectionMode ? "結束選取" : "文字選取"}
      </button>

      <button
        type="button"
        className={`tool-btn ${notesOpen ? "active" : ""}`}
        onClick={onToggleNotes}
        title="智能筆記"
      >
        📝 {notesOpen ? "收合筆記" : "智能筆記"}
      </button>

      {/* Add-to-Notes: saves selected text as a note, or opens the notes panel */}
      <button
        type="button"
        className={`tool-btn ${hasSelection ? "ask" : ""}`}
        onClick={onAddToNotes}
        title={
          hasSelection
            ? `將選取的 ${(selectedText ?? "").trim().length} 字加入筆記`
            : "開啟智能筆記面板"
        }
      >
        {hasSelection ? `加入筆記 (${(selectedText ?? "").trim().length}字)` : "加入筆記"}
      </button>

      {/*
        ── Placeholder actions (not yet implemented) ──────────────────────────
        These buttons are intentionally disabled until the backend endpoints
        are available. DO NOT remove the disabled attribute without also
        providing a working handler and a corresponding API route.
      */}

      {/* TODO: Screenshot Ask AI — needs backend vision/OCR endpoint
          Planned: POST /api/student/books/:bookId/screenshot-ask
          Accept a canvas/blob snapshot, run OCR, send to AI for explanation */}
      <button
        type="button"
        className="tool-btn tool-btn-placeholder"
        disabled
        title="截圖問AI：即將推出（需後端 OCR / 視覺 API）"
      >
        截圖問AI
      </button>

      {/* TODO: Knowledge Points — needs endpoint to return chapter key concepts
          Planned: GET /api/student/books/:bookId/chapters/:chapterId/knowledge-points */}
      <button
        type="button"
        className="tool-btn tool-btn-placeholder"
        disabled
        title="知識點：即將推出（需後端知識點 API）"
      >
        知識點
      </button>

      {/* 5×5 Learning Grid — visual overview of knowledge point completion */}
      <button
        type="button"
        className={`tool-btn grid-toggle-btn${gridOpen ? " active" : ""}`}
        onClick={onToggleGrid}
        title="5×5 學習格：視覺化知識點掌握進度"
        disabled={!hasPdf}
      >
        5×5
      </button>

      {/* Reading progress toggle — opens the progress panel / bottom sheet */}
      <button
        type="button"
        className={`tool-btn progress-toggle-btn ${progressOpen ? "active" : ""}`}
        onClick={onToggleProgress}
        title="閱讀進度：標記本頁 / 章完成，查看完成百分比"
        disabled={!hasPdf}
      >
        進度
      </button>

      <span className="tool-spacer" />

      <div className="tool-ratio" title="PDF 與 AI 區域比例（快速調整 AI 寬度）">
        {READER_RATIOS.map((r) => (
          <button
            key={r}
            type="button"
            className={ratio === r ? "active" : ""}
            onClick={() => onRatio(r)}
          >
            {r}
          </button>
        ))}
      </div>

      <button type="button" className="tool-btn" onClick={onToggleAi}>
        {aiOpen ? "收合AI" : "展開AI"}
      </button>

      <button type="button" className="tool-btn ask" onClick={onAskAi}>
        問AI
      </button>
    </div>
  );
}
