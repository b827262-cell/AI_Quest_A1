import type { RefObject } from "react";
import { BookRagPanel } from "../../components/BookRagPanel";
import { ChatPanel } from "../../components/ChatPanel";
import { LearningGridPanel } from "../../components/LearningGridPanel";
import { ProgressPanel } from "../../components/ProgressPanel";
import { SmartNotesPanel } from "../../components/SmartNotesPanel";
import { PaneSplitter } from "./PaneSplitter";
import { QUICK_PROMPTS } from "./constants";

/** Desktop right column: AI Q&A, Smart Notes, reading progress or learning grid. */
export function DesktopRightPanels({
  isMobile,
  rightPanel,
  aiWidth,
  chatRef,
  bookId,
  chapterId,
  chapterTitle,
  pdfPage,
  hasPdf,
  pageCount,
  pdfSessionId,
  notesRefreshKey,
  prefill,
  onSaveAnswer,
  onCollapse,
  onJumpToPage,
  onResize
}: {
  isMobile: boolean;
  rightPanel: "ai" | "notes" | "progress" | "grid" | null;
  aiWidth: number;
  chatRef: RefObject<HTMLDivElement | null>;
  bookId: string;
  chapterId: string | null;
  chapterTitle: string | null;
  pdfPage: number;
  hasPdf: boolean;
  pageCount: number | null;
  pdfSessionId: string | null;
  notesRefreshKey: number;
  prefill: { text: string; nonce: number } | null;
  onSaveAnswer: (content: string) => void;
  onCollapse: () => void;
  onJumpToPage: (page: number) => void;
  onResize: (dx: number) => void;
}) {
  return (
    <>
      {!isMobile && rightPanel !== null && (
        <PaneSplitter onResize={onResize} label="調整 PDF 與右側面板寬度" />
      )}
      {!isMobile && rightPanel === "ai" && (
        <div className="reader-chat-col" ref={chatRef} style={{ width: aiWidth }}>
          <ChatPanel
            bookId={bookId}
            chapterId={chapterId ?? undefined}
            title="AI 問答"
            subtitle="點擊左側章節可限定提問範圍"
            quickPrompts={QUICK_PROMPTS}
            inputPlaceholder="問 AI 問題（支援貼上圖片）..."
            onSaveAnswer={onSaveAnswer}
            prefill={prefill}
          />
          <BookRagPanel bookId={bookId} />
        </div>
      )}
      {!isMobile && rightPanel === "notes" && (
        <div className="reader-notes-col" style={{ width: aiWidth }}>
          <SmartNotesPanel
            bookId={bookId}
            pageNumber={hasPdf ? pdfPage : null}
            chapterId={chapterId}
            chapterTitle={chapterTitle}
            refreshKey={notesRefreshKey}
            compact
            onCollapse={onCollapse}
          />
        </div>
      )}
      {!isMobile && rightPanel === "progress" && (
        <div className="reader-progress-col" style={{ width: aiWidth }}>
          {pdfSessionId ? (
            <ProgressPanel
              bookId={bookId}
              sessionId={pdfSessionId}
              pdfPage={hasPdf ? pdfPage : null}
              pageCount={pageCount}
              chapterId={chapterId}
              chapterTitle={chapterTitle}
              onCollapse={onCollapse}
            />
          ) : (
            <p className="muted progress-panel-status">
              等待閱讀工作階段建立中…
            </p>
          )}
        </div>
      )}
      {!isMobile && rightPanel === "grid" && (
        <div className="reader-grid-col" style={{ width: aiWidth }}>
          {pdfSessionId ? (
            <LearningGridPanel
              bookId={bookId}
              sessionId={pdfSessionId}
              chapterId={chapterId}
              chapterTitle={chapterTitle}
              onJumpToPage={onJumpToPage}
              onCollapse={onCollapse}
            />
          ) : (
            <p className="muted learning-grid-status">
              等待閱讀工作階段建立中…
            </p>
          )}
        </div>
      )}
    </>
  );
}
