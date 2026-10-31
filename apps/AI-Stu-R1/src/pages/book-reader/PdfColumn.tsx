import type { KeyboardEvent, PointerEvent, RefObject } from "react";
import { ProtectedPdfViewer } from "../../components/ProtectedPdfViewer";

/** PDF column: touch zones, viewer/status states, mobile page jump bar, toast. */
export function PdfColumn({
  isMobile,
  hasPdf,
  pdfLoading,
  pdfError,
  pdfBlob,
  pdfPage,
  zoom,
  watermarkText,
  selectionMode,
  showPageJumpBar,
  mobilePageInput,
  pageCount,
  mobileNotice,
  touchZoneRef,
  pageJumpInputRef,
  onPointerDown,
  onPointerUp,
  onPointerCancel,
  onPageCount,
  onPdfError,
  onSelectedText,
  onPageHasText,
  onPrevPage,
  onNextPage,
  onApplyPageJump,
  onPageInputChange,
  onPageJumpKeyDown
}: {
  isMobile: boolean;
  hasPdf: boolean;
  pdfLoading: boolean;
  pdfError: string;
  pdfBlob: Blob | null;
  pdfPage: number;
  zoom: number;
  watermarkText: string;
  selectionMode: boolean;
  showPageJumpBar: boolean;
  mobilePageInput: string;
  pageCount: number | null;
  mobileNotice: string;
  touchZoneRef: RefObject<HTMLDivElement | null>;
  pageJumpInputRef: RefObject<HTMLInputElement | null>;
  onPointerDown: (event: PointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: PointerEvent<HTMLDivElement>) => void;
  onPointerCancel: () => void;
  onPageCount: (count: number) => void;
  onPdfError: (message: string) => void;
  onSelectedText: (text: string) => void;
  onPageHasText: (hasText: boolean) => void;
  onPrevPage: () => void;
  onNextPage: () => void;
  onApplyPageJump: () => void;
  onPageInputChange: (value: string) => void;
  onPageJumpKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
}) {
  return (
    <section className="reader-pdf-col">
      <div
        className="reader-mobile-touch-zone"
        ref={touchZoneRef}
        onPointerDown={isMobile ? onPointerDown : undefined}
        onPointerUp={isMobile ? onPointerUp : undefined}
        onPointerCancel={isMobile ? onPointerCancel : undefined}
      >
        {isMobile && hasPdf ? (
          <>
            <div
              className="reader-mobile-touch-zone-half left"
              data-testid="mobile-touch-zone-left"
              aria-hidden="true"
            />
            <div
              className="reader-mobile-touch-zone-half right"
              data-testid="mobile-touch-zone-right"
              aria-hidden="true"
            />
          </>
        ) : null}
        {!hasPdf ? (
          <div className="reader-pdf-status-wrap">
            <p className="muted">尚未提供 PDF 教材。</p>
          </div>
        ) : pdfLoading ? (
          <div className="reader-pdf-status-wrap">
            <p className="muted">Loading protected PDF…</p>
          </div>
        ) : pdfError ? (
          <div className="reader-pdf-status-wrap">
            <p className="error-text">{pdfError}</p>
          </div>
        ) : pdfBlob ? (
          <ProtectedPdfViewer
            blob={pdfBlob}
            page={pdfPage}
            zoom={zoom}
            watermarkText={watermarkText}
            selectable={selectionMode}
            onPageCount={onPageCount}
            onError={onPdfError}
            onSelectedText={onSelectedText}
            onPageHasText={onPageHasText}
          />
        ) : (
          <div className="reader-pdf-status-wrap">
            <p className="muted">Protected PDF preview is not ready.</p>
          </div>
        )}
        {showPageJumpBar ? (
          <div className="reader-page-jump-bar" onPointerDown={(event) => event.stopPropagation()}>
            <button
              type="button"
              className="reader-page-jump-btn"
              onClick={onPrevPage}
              aria-label="上一頁"
            >
              ◀
            </button>
            <span className="reader-page-jump-label">
              第 {hasPdf ? pdfPage : 0} / {pageCount != null ? pageCount : "?"} 頁
            </span>
            <input
              ref={pageJumpInputRef}
              className="reader-page-jump-input"
              type="text"
              value={mobilePageInput}
              inputMode="numeric"
              pattern="[0-9]*"
              onChange={(event) => onPageInputChange(event.target.value.replace(/\D/g, ""))}
              onKeyDown={onPageJumpKeyDown}
              onPointerDown={(event) => event.stopPropagation()}
            />
            <button
              type="button"
              className="reader-page-jump-btn"
              onClick={() => onApplyPageJump()}
              aria-label="跳至頁碼"
            >
              跳
            </button>
            <button
              type="button"
              className="reader-page-jump-btn"
              onClick={onNextPage}
              aria-label="下一頁"
            >
              ▶
            </button>
          </div>
        ) : null}
        {mobileNotice ? <div className="reader-mobile-toast">{mobileNotice}</div> : null}
      </div>
    </section>
  );
}
