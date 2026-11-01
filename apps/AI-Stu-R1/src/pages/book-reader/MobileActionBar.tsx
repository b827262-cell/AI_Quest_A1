import type { KeyboardEvent, RefObject } from "react";
import { Link } from "react-router-dom";
import type { MobileReaderPanel } from "./constants";

/** Fixed mobile action bar: page controls plus the panel shortcuts. */
export function MobileActionBar({
  isMobile,
  showMobileControls,
  hasPdf,
  pdfPage,
  pageCount,
  mobileBarPageInput,
  isTocOpen,
  isChatOpen,
  isNotesOpen,
  isProgressOpen,
  isGridOpen,
  barRef,
  onPrevPage,
  onNextPage,
  onBarInputChange,
  onBarJumpKeyDown,
  onApplyBarJump,
  onOpenPanel,
  onRevealAi,
  onToggleProgress,
  onToggleGrid
}: {
  isMobile: boolean;
  showMobileControls: boolean;
  hasPdf: boolean;
  pdfPage: number;
  pageCount: number | null;
  mobileBarPageInput: string;
  isTocOpen: boolean;
  isChatOpen: boolean;
  isNotesOpen: boolean;
  isProgressOpen: boolean;
  isGridOpen: boolean;
  barRef: RefObject<HTMLDivElement | null>;
  onPrevPage: () => void;
  onNextPage: () => void;
  onBarInputChange: (value: string) => void;
  onBarJumpKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  onApplyBarJump: () => void;
  onOpenPanel: (panel: MobileReaderPanel) => void;
  onRevealAi: () => void;
  onToggleProgress: () => void;
  onToggleGrid: () => void;
}) {
  if (!isMobile) return null;

  return (
    <div
      className={`reader-mobile-action-bar ${showMobileControls ? "" : "is-hidden"}`.trim()}
      ref={barRef}
    >
      {hasPdf ? (
        <div
          className="reader-mobile-page-controls"
          data-testid="mobile-page-jump"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="reader-mobile-page-btn"
            data-testid="mobile-prev-page"
            onClick={onPrevPage}
            disabled={pdfPage <= 1}
            aria-label="上一頁"
          >
            ◀
          </button>
          <span className="reader-mobile-page-label">
            {pdfPage}{pageCount != null ? ` / ${pageCount}` : ""}
          </span>
          <input
            className="reader-mobile-page-input"
            data-testid="mobile-page-input"
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            value={mobileBarPageInput}
            onChange={(e) => onBarInputChange(e.target.value.replace(/\D/g, ""))}
            onKeyDown={onBarJumpKeyDown}
            onFocus={(e) => e.currentTarget.select()}
            aria-label="輸入頁碼"
          />
          <button
            type="button"
            className="reader-mobile-page-btn"
            onClick={onApplyBarJump}
            aria-label="跳至頁碼"
          >
            跳
          </button>
          <button
            type="button"
            className="reader-mobile-page-btn"
            data-testid="mobile-next-page"
            onClick={onNextPage}
            disabled={pageCount != null && pdfPage >= pageCount}
            aria-label="下一頁"
          >
            ▶
          </button>
        </div>
      ) : null}
      <div className="reader-mobile-action-buttons">
        <Link to="/books" className="reader-mobile-action-btn">
          返回
        </Link>
        <button
          type="button"
          className={`reader-mobile-action-btn ${isTocOpen ? "active" : ""}`}
          onClick={() => onOpenPanel("toc")}
        >
          目錄
        </button>
        <button
          type="button"
          className={`reader-mobile-action-btn ${isChatOpen ? "active" : ""}`}
          onClick={() => onRevealAi()}
        >
          問AI
        </button>
        <button
          type="button"
          className={`reader-mobile-action-btn ${isNotesOpen ? "active" : ""}`}
          onClick={() => onOpenPanel("notes")}
        >
          筆記
        </button>
        <button
          type="button"
          className={`reader-mobile-action-btn ${isProgressOpen ? "active" : ""}`}
          onClick={onToggleProgress}
        >
          進度
        </button>
        <button
          type="button"
          className={`reader-mobile-action-btn ${isGridOpen ? "active" : ""}`}
          onClick={onToggleGrid}
        >
          5×5
        </button>
      </div>
    </div>
  );
}
