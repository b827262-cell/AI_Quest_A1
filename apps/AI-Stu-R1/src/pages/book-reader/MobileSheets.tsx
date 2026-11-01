import type { ReactNode } from "react";
import type { ReaderOutlineNode, ReaderOutlineSource } from "@ai-smartbook/schema";
import { BookRagPanel } from "../../components/BookRagPanel";
import { ChapterSidebar } from "../../components/ChapterSidebar";
import { ChatPanel } from "../../components/ChatPanel";
import { LearningGridPanel } from "../../components/LearningGridPanel";
import { ProgressPanel } from "../../components/ProgressPanel";
import { SmartNotesPanel } from "../../components/SmartNotesPanel";
import { QUICK_PROMPTS } from "./constants";

function MobileSheet({
  open,
  sheetClassName,
  label,
  title,
  onClose,
  children
}: {
  open: boolean;
  sheetClassName: string;
  label: string;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  if (!open) return null;

  return (
    <div className="reader-mobile-overlay" onClick={onClose}>
      <aside
        className={`reader-mobile-sheet ${sheetClassName}`}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="reader-mobile-sheet-head">
          <h4>{title}</h4>
          <button type="button" className="reader-mobile-close" onClick={onClose}>
            關閉
          </button>
        </div>
        <div className="reader-mobile-sheet-body">{children}</div>
      </aside>
    </div>
  );
}

export function MobileTocSheet({
  open,
  onClose,
  outline,
  activeNodeId,
  outlineSource,
  onSelect
}: {
  open: boolean;
  onClose: () => void;
  outline: ReaderOutlineNode[];
  activeNodeId: string | null;
  outlineSource: ReaderOutlineSource;
  onSelect: (nodeId: string | null) => void;
}) {
  return (
    <MobileSheet
      open={open}
      sheetClassName="reader-mobile-toc"
      label="章節目錄"
      title="章節目錄"
      onClose={onClose}
    >
      <ChapterSidebar
        outline={outline}
        activeNodeId={activeNodeId}
        outlineSource={outlineSource}
        onSelect={onSelect}
      />
    </MobileSheet>
  );
}

export function MobileChatSheet({
  open,
  onClose,
  bookId,
  chapterId,
  prefill,
  onSaveAnswer
}: {
  open: boolean;
  onClose: () => void;
  bookId: string;
  chapterId: string | null;
  prefill: { text: string; nonce: number } | null;
  onSaveAnswer: (content: string) => void;
}) {
  return (
    <MobileSheet
      open={open}
      sheetClassName="reader-mobile-chat"
      label="AI 問答"
      title="AI 問答"
      onClose={onClose}
    >
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
    </MobileSheet>
  );
}

export function MobileNotesSheet({
  open,
  onClose,
  bookId,
  pageNumber,
  chapterId,
  chapterTitle,
  refreshKey
}: {
  open: boolean;
  onClose: () => void;
  bookId: string;
  pageNumber: number | null;
  chapterId: string | null;
  chapterTitle: string | null;
  refreshKey: number;
}) {
  return (
    <MobileSheet
      open={open}
      sheetClassName="reader-mobile-notes"
      label="智能筆記"
      title="智能筆記"
      onClose={onClose}
    >
      <SmartNotesPanel
        bookId={bookId}
        pageNumber={pageNumber}
        chapterId={chapterId}
        chapterTitle={chapterTitle}
        refreshKey={refreshKey}
        compact
      />
    </MobileSheet>
  );
}

export function MobileProgressSheet({
  open,
  onClose,
  bookId,
  sessionId,
  pdfPage,
  pageCount,
  chapterId,
  chapterTitle
}: {
  open: boolean;
  onClose: () => void;
  bookId: string;
  sessionId: string | null;
  pdfPage: number | null;
  pageCount: number | null;
  chapterId: string | null;
  chapterTitle: string | null;
}) {
  return (
    <MobileSheet
      open={open}
      sheetClassName="reader-mobile-progress"
      label="閱讀進度"
      title="閱讀進度"
      onClose={onClose}
    >
      {sessionId ? (
        <ProgressPanel
          bookId={bookId}
          sessionId={sessionId}
          pdfPage={pdfPage}
          pageCount={pageCount}
          chapterId={chapterId}
          chapterTitle={chapterTitle}
        />
      ) : (
        <p className="muted progress-panel-status">
          等待閱讀工作階段建立中…
        </p>
      )}
    </MobileSheet>
  );
}

export function MobileGridSheet({
  open,
  onClose,
  bookId,
  sessionId,
  chapterId,
  chapterTitle,
  onJumpToPage
}: {
  open: boolean;
  onClose: () => void;
  bookId: string;
  sessionId: string | null;
  chapterId: string | null;
  chapterTitle: string | null;
  onJumpToPage: (page: number) => void;
}) {
  return (
    <MobileSheet
      open={open}
      sheetClassName="reader-mobile-grid"
      label="5×5 學習格"
      title="5×5 學習格"
      onClose={onClose}
    >
      {sessionId ? (
        <LearningGridPanel
          bookId={bookId}
          sessionId={sessionId}
          chapterId={chapterId}
          chapterTitle={chapterTitle}
          onJumpToPage={(page) => {
            onJumpToPage(page);
            onClose();
          }}
        />
      ) : (
        <p className="muted learning-grid-status">
          等待閱讀工作階段建立中…
        </p>
      )}
    </MobileSheet>
  );
}
