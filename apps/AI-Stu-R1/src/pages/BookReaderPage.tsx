import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useParams } from "react-router-dom";
import type { BookChapter, ReaderOutlineNode, ReaderOutlineSource } from "@ai-smartbook/schema";
import { studentClient, type BookDetail } from "../studentClient";
import type { StudentBook } from "../bookDisplay";
import { ReaderTopBar } from "../components/ReaderTopBar";
import { ReaderTabs, READER_TABS, type ReaderTabKey } from "../components/ReaderTabs";
import { ChapterSidebar } from "../components/ChapterSidebar";
import { PdfReaderToolbar } from "../components/PdfReaderToolbar";
import { TabPlaceholder } from "../components/TabPlaceholder";
import { useNotice } from "../components/useConfirm";
import type { MobileReaderPanel } from "./book-reader/constants";
import { chaptersToFallbackOutline, flattenOutline } from "./book-reader/layout";
import { OuterResizeHandle } from "./book-reader/OuterResizeHandle";
import { PaneSplitter } from "./book-reader/PaneSplitter";
import { PdfColumn } from "./book-reader/PdfColumn";
import { SelectionBar } from "./book-reader/SelectionBar";
import { DesktopRightPanels } from "./book-reader/DesktopRightPanels";
import { MobileActionBar } from "./book-reader/MobileActionBar";
import {
  MobileChatSheet,
  MobileGridSheet,
  MobileNotesSheet,
  MobileProgressSheet,
  MobileTocSheet
} from "./book-reader/MobileSheets";
import { useReaderViewport } from "./book-reader/useReaderViewport";
import { useReaderLayout } from "./book-reader/useReaderLayout";
import { useReaderPagination } from "./book-reader/useReaderPagination";
import { useMobileReaderMetrics, useMobileReaderShell } from "./book-reader/useMobileReaderShell";
import { useProtectedPdfSession, useProtectedPdfState } from "./book-reader/useProtectedPdf";
import { useMobileTouchNavigation } from "./book-reader/useMobileTouchNavigation";

export function BookReaderPage() {
  const { bookId = "" } = useParams();
  const notice = useNotice();
  // Effects 1-2: reader-resizing cleanup and viewport width tracking.
  const { isMobile, isTablet } = useReaderViewport();
  const [book, setBook] = useState<BookDetail | null>(null);
  const [outline, setOutline] = useState<ReaderOutlineNode[]>([]);
  const [outlineSource, setOutlineSource] = useState<ReaderOutlineSource>("fallback");
  const [selectedOutlineId, setSelectedOutlineId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<ReaderTabKey>("smart-book");
  const [collapsed, setCollapsed] = useState(false);
  // The right column shows the AI Q&A, Smart Notes, or Progress panel — mutually
  // exclusive so the PDF grows when all are collapsed.
  const [rightPanel, setRightPanel] = useState<"ai" | "notes" | "progress" | "grid" | null>("ai");
  const [zoom, setZoom] = useState(100);
  const [notesRefreshKey, setNotesRefreshKey] = useState(0);
  // PDF text selection: drag-select text to copy / save as note / ask AI.
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedText, setSelectedText] = useState("");
  const [pageHasText, setPageHasText] = useState(true);
  const [copyNotice, setCopyNotice] = useState("");
  const [aiPrefill, setAiPrefill] = useState<{ text: string; nonce: number } | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const chatRef = useRef<HTMLDivElement>(null);
  const autoSaveTimerRef = useRef<number | null>(null);
  const touchZoneRef = useRef<HTMLDivElement>(null);
  const hasPdf = Boolean(book?.pdfFileId);
  // State only: the PDF effects stay at their original position further down.
  const {
    pdfBlob,
    setPdfBlob,
    pdfSessionId,
    setPdfSessionId,
    pdfLoading,
    setPdfLoading,
    pdfError,
    setPdfError,
    watermarkStamp,
    setWatermarkStamp
  } = useProtectedPdfState();

  // Effects 3-6: desktop chrome reset, overlay body class, keyboard metrics and
  // the mobile reading scroll lock.
  const {
    mobilePanel,
    setMobilePanel,
    showMobileControls,
    setShowMobileControls,
    showPageJumpBar,
    setShowPageJumpBar,
    outerLayoutRef,
    readerMainRef,
    actionBarRef
  } = useMobileReaderShell({ isMobile, activeTab });

  // Effects 7-10: jump-bar focus, outside-pointer close, notice cleanup and the
  // action-bar page input sync.
  const {
    pdfPage,
    setPdfPage,
    pageCount,
    setPageCount,
    mobilePageInput,
    setMobilePageInput,
    mobileBarPageInput,
    setMobileBarPageInput,
    mobileNotice,
    pageJumpInputRef,
    jumpToPage,
    prevPage,
    nextPage,
    applyMobilePageJump,
    onMobilePageJumpKeyDown,
    applyMobileBarJump,
    onMobileBarJumpKeyDown,
    toggleMobileControls,
    toggleMobilePageJumpBar,
    resetPageState
  } = useReaderPagination({
    isMobile,
    hasPdf,
    showPageJumpBar,
    setShowPageJumpBar,
    setShowMobileControls
  });

  // Effect 11: measure the reader chrome height for the fixed mobile viewport.
  useMobileReaderMetrics({
    isMobile,
    activeTab,
    mobilePanel,
    rightPanel,
    selectionMode,
    pdfPage,
    pdfBlob,
    outerLayoutRef,
    readerMainRef,
    actionBarRef
  });

  // Effects 12-15: persist pane widths, outer gutters and the layout ratio.
  const {
    tocWidth,
    aiWidth,
    leftGutter,
    rightGutter,
    layoutRatio,
    fullWidth,
    resizeToc,
    resizeAi,
    toggleFullWidth,
    applyLayoutRatio,
    resizeLeftOuter,
    resizeRightOuter
  } = useReaderLayout({ collapsed, rightPanel });

  // Reset per-book view state when switching books.
  useEffect(() => {
    setSelectedOutlineId(null);
    setOutline([]);
    setOutlineSource("fallback");
    setActiveTab("smart-book");
    setPdfError("");
    resetPageState();
  }, [bookId]);

  useEffect(() => {
    setLoading(true);
    studentClient
      .getBook(bookId)
      .then((b) => setBook(b.book))
      .catch((e) => setError(String(e.message)))
      .finally(() => setLoading(false));
  }, [bookId]);

  useEffect(() => {
    if (!book) return;
    let disposed = false;
    studentClient
      .getOutline(book.id)
      .then((result) => {
        if (disposed) return;
        setOutline(result.outline);
        setOutlineSource(result.source);
      })
      .catch(() => {
        if (disposed) return;
        setOutline(chaptersToFallbackOutline(book.chapters ?? []));
        setOutlineSource("fallback");
      });
    return () => {
      disposed = true;
    };
  }, [book]);

  // Effects 19-20: reset the PDF state per book and load the protected blob.
  useProtectedPdfSession({
    bookId,
    book,
    setPdfBlob,
    setPdfSessionId,
    setPdfLoading,
    setPdfError,
    setWatermarkStamp
  });

  // Debounced auto-save: record page_view 1.5s after each page change.
  // Fire-and-forget — errors are intentionally suppressed so a backend hiccup
  // never disrupts reading. Chapter is inferred server-side from the page number.
  useEffect(() => {
    if (!pdfSessionId || !book?.pdfFileId) return;
    if (autoSaveTimerRef.current != null) window.clearTimeout(autoSaveTimerRef.current);
    autoSaveTimerRef.current = window.setTimeout(() => {
      void studentClient
        .saveBookProgress(
          bookId,
          { page: pdfPage, eventType: "page_view", source: "auto_page_change" },
          pdfSessionId
        )
        .catch(() => { /* intentionally silent */ });
    }, 1500);
    return () => {
      if (autoSaveTimerRef.current != null) {
        window.clearTimeout(autoSaveTimerRef.current);
        autoSaveTimerRef.current = null;
      }
    };
  }, [pdfPage, pdfSessionId, book?.pdfFileId, bookId]);

  // No effects here: pure pointer handlers for the mobile PDF tap zones.
  const {
    onPointerDown: onPdfTouchZonePointerDown,
    onPointerUp: onPdfTouchZonePointerUp,
    onPointerCancel: onPdfTouchZonePointerCancel
  } = useMobileTouchNavigation({
    isMobile,
    hasPdf,
    touchZoneRef,
    onPrevPage: prevPage,
    onNextPage: nextPage,
    onToggleControls: toggleMobileControls,
    onTogglePageJumpBar: toggleMobilePageJumpBar
  });

  if (loading) return <p className="muted reader-state">載入中…</p>;
  if (error) return <p className="error-text reader-state">{error}</p>;
  if (!book) return <p className="muted reader-state">找不到這本書。</p>;

  const chapters: BookChapter[] = book.chapters ?? [];
  const flatOutline = flattenOutline(outline);
  const pageMappedOutline = flatOutline.filter((node) => node.page != null);
  const activeOutlineNode =
    [...pageMappedOutline]
      .filter((node) => (node.page ?? 0) <= pdfPage)
      .sort((a, b) => (b.page ?? 0) - (a.page ?? 0))[0] ??
    flatOutline.find((node) => node.id === selectedOutlineId) ??
    null;
  const activeOutlineId = activeOutlineNode?.id ?? null;
  const activeChapter =
    activeOutlineNode != null
      ? chapters.find((chapter) => chapter.id === activeOutlineNode.id) ??
        chapters.find((chapter) => chapter.pageStart != null && chapter.pageStart === activeOutlineNode.page) ??
        null
      : null;
  const safeActiveChapter = activeChapter?.id ?? null;
  const activeChapterTitle = activeOutlineNode?.title ?? activeChapter?.title ?? null;
  const watermarkText = [
    "iBrain AI",
    pdfSessionId ? `session ${pdfSessionId}` : "session pending",
    book.title || book.id,
    watermarkStamp || new Date().toLocaleDateString()
  ].join(" · ");
  const isMobileChatOpen = isMobile ? mobilePanel === "ai" : false;
  const isMobileNotesOpen = isMobile ? mobilePanel === "notes" : false;
  const isMobileTocOpen = isMobile ? mobilePanel === "toc" : false;
  const isMobileProgressOpen = isMobile ? mobilePanel === "progress" : false;
  const isMobileGridOpen = isMobile ? mobilePanel === "grid" : false;

  function openMobilePanel(panel: MobileReaderPanel) {
    if (!isMobile) return;
    setMobilePanel((current) => (current === panel ? null : panel));
    setShowMobileControls(true);
    setShowPageJumpBar(false);
  }
  function closeMobilePanel() {
    if (isMobile) {
      setMobilePanel(null);
      setShowPageJumpBar(false);
    }
  }

  function setPanelForContext(panel: "ai" | "notes" | null) {
    if (isMobile) {
      setMobilePanel(panel);
      setShowMobileControls(true);
      setShowPageJumpBar(false);
      return;
    }
    setRightPanel(panel);
  }

  function revealAiPanelWithPrefill(prefill: { text: string; nonce: number } | null) {
    setPanelForContext("ai");
    setAiPrefill(prefill);
    if (!isMobile) {
      requestAnimationFrame(() =>
        chatRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" })
      );
    }
  }

  async function saveAiAnswerAsNote(content: string) {
    if (!book) return;
    const firstLine = content.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "AI 解答";
    try {
      await studentClient.createNote(bookId, {
        type: "ai_answer",
        title: firstLine.slice(0, 40),
        content,
        chapterId: safeActiveChapter,
        pageNumber: book.pdfFileId ? pdfPage : null
      });
      setNotesRefreshKey((k) => k + 1);
      void notice({ title: "已存成筆記", message: "已存成筆記，可於「智能筆記」分頁查看。" });
    } catch (e) {
      void notice({ title: "存成筆記失敗", message: `存成筆記失敗：${e instanceof Error ? e.message : String(e)}` });
    }
  }

  // ---- PDF text selection actions ----------------------------------------
  // TODO: Future permission flags may include:
  // - allowTextSelection
  // - allowCopy
  // - allowAskAIWithSelection
  // - allowSaveSelectionToNote
  function selectionSourcePrefix(): string {
    const parts = [book?.title, activeChapterTitle, book?.pdfFileId ? `P${pdfPage}` : null].filter(
      (p): p is string => !!p
    );
    return `來源：${parts.join(" / ")}`;
  }

  async function onCopySelection() {
    const text = selectedText.trim();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopyNotice("已複製到剪貼簿");
    } catch {
      // Fallback when the Clipboard API is blocked (permission / insecure ctx).
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(ta);
        setCopyNotice(ok ? "已複製到剪貼簿" : "無法複製，請手動選取後 Ctrl+C");
      } catch {
        setCopyNotice("無法複製，請手動選取後 Ctrl+C");
      }
    }
    window.setTimeout(() => setCopyNotice(""), 2500);
  }

  async function onSelectionToNote() {
    const text = selectedText.trim();
    if (!text || !book) return;
    setPanelForContext("notes");
    const title = `PDF 摘錄 - ${activeChapterTitle ?? (book.pdfFileId ? `第 ${pdfPage} 頁` : "內容")}`;
    const content = `${selectionSourcePrefix()}\n\n${text}`;
    try {
      await studentClient.createNote(bookId, {
        type: "text",
        title: title.slice(0, 80),
        content,
        chapterId: safeActiveChapter,
        pageNumber: book.pdfFileId ? pdfPage : null
      });
      setNotesRefreshKey((k) => k + 1);
      setSelectedText("");
    } catch (e) {
      void notice({ title: "加入筆記失敗", message: `加入筆記失敗：${e instanceof Error ? e.message : String(e)}` });
    }
  }

  function onAskAiAboutSelection() {
    const text = selectedText.trim();
    if (!text) return;
    revealAiPanelWithPrefill({
      text: `請整理以下 PDF 圈選文字的重點，並用條列方式說明：\n\n${text}`,
      nonce: Date.now()
    });
  }

  // Toolbar "加入筆記" button: saves selected text if present, otherwise opens notes panel.
  // TODO: When allowSaveSelectionToNote permission flag is added, gate this here.
  function onToolbarAddToNotes() {
    if (selectedText.trim()) {
      void onSelectionToNote();
    } else {
      setPanelForContext("notes");
    }
  }

  function selectOutlineNode(nodeId: string | null) {
    setSelectedOutlineId(nodeId);
    if (!nodeId) {
      setPdfPage(1);
    } else {
      const node = flatOutline.find((candidate) => candidate.id === nodeId);
      if (node?.page != null) jumpToPage(node.page);
    }
    if (isMobile) {
      closeMobilePanel();
    }
  }

  // Open the AI Q&A panel (collapsing Smart Notes) and scroll it into view.
  function scrollToChat() {
    revealAiPanelWithPrefill(null);
  }

  // Toggle the reading progress panel (desktop right column or mobile sheet).
  function toggleProgress() {
    if (isMobile) {
      setMobilePanel((p) => (p === "progress" ? null : "progress"));
      setShowMobileControls(true);
      setShowPageJumpBar(false);
    } else {
      setRightPanel((p) => (p === "progress" ? null : "progress"));
    }
  }

  // Toggle the 5×5 learning grid panel (desktop right column or mobile sheet).
  function toggleGrid() {
    if (isMobile) {
      setMobilePanel((p) => (p === "grid" ? null : "grid"));
      setShowMobileControls(true);
      setShowPageJumpBar(false);
    } else {
      setRightPanel((p) => (p === "grid" ? null : "grid"));
    }
  }

  return (
    <div
      ref={outerLayoutRef}
      className={`reader-outer-layout ${isMobile ? "reader-layout-mobile" : isTablet ? "reader-layout-tablet" : ""}`.trim()}
      style={
        {
          "--reader-left-gutter": `${leftGutter}px`,
          "--reader-right-gutter": `${rightGutter}px`
        } as CSSProperties
      }
    >
      <div className="reader-outer-gutter left" aria-hidden="true" />
      <OuterResizeHandle
        onResize={resizeLeftOuter}
        label="調整左側空白與閱讀器寬度"
      />
      <div className="reader-workbench">
        <ReaderTopBar book={book as StudentBook} onToggleHistory={scrollToChat} />
        <ReaderTabs
          active={mobilePanel === "notes" ? "smart-note" : activeTab}
          onChange={(tab) => {
            if (tab === "smart-note") {
              setActiveTab("smart-book");
              setPanelForContext("notes");
            } else {
              setActiveTab(tab);
            }
          }}
        />

        {activeTab === "smart-book" ? (
          <>
            <PdfReaderToolbar
              outlineNodes={flatOutline}
              activeNodeId={activeOutlineId}
              onSelectOutlineNode={selectOutlineNode}
              fullWidth={fullWidth}
              onToggleFullWidth={toggleFullWidth}
              tocCollapsed={collapsed}
              onToggleToc={() => {
                if (isMobile) {
                  openMobilePanel("toc");
                  return;
                }
                setCollapsed((v) => !v);
              }}
              selectionMode={selectionMode}
              onToggleSelection={() => {
                setSelectionMode((v) => !v);
                setSelectedText("");
              }}
              aiOpen={isMobile ? isMobileChatOpen : rightPanel === "ai"}
              onToggleAi={() => {
                if (isMobile) {
                  openMobilePanel("ai");
                } else {
                  setRightPanel((p) => (p === "ai" ? null : "ai"));
                }
              }}
              notesOpen={isMobile ? isMobileNotesOpen : rightPanel === "notes"}
              onToggleNotes={() => {
                if (isMobile) {
                  openMobilePanel("notes");
                } else {
                  setRightPanel((p) => (p === "notes" ? null : "notes"));
                }
              }}
              zoom={zoom}
              onZoom={setZoom}
              ratio={layoutRatio}
              onRatio={applyLayoutRatio}
              page={book.pdfFileId ? pdfPage : null}
              pageCount={pageCount}
              onJumpPage={jumpToPage}
              onPrevPage={prevPage}
              onNextPage={nextPage}
              onAskAi={scrollToChat}
              selectedText={selectedText}
              onAddToNotes={onToolbarAddToNotes}
              progressOpen={isMobile ? isMobileProgressOpen : rightPanel === "progress"}
              onToggleProgress={toggleProgress}
              gridOpen={isMobile ? isMobileGridOpen : rightPanel === "grid"}
              onToggleGrid={toggleGrid}
            />

            <SelectionBar
              open={selectionMode}
              selectedText={selectedText}
              copyNotice={copyNotice}
              pageHasText={pageHasText}
              onCopySelection={onCopySelection}
              onSelectionToNote={onSelectionToNote}
              onAskAiAboutSelection={onAskAiAboutSelection}
            />

            <div className="reader-main" ref={readerMainRef}>
              {!isMobile && !collapsed && (
                <ChapterSidebar
                  outline={outline}
                  activeNodeId={activeOutlineId}
                  outlineSource={outlineSource}
                  onSelect={selectOutlineNode}
                  width={tocWidth}
                />
              )}
              {!isMobile && !collapsed && (
                <PaneSplitter onResize={resizeToc} label="調整章節與 PDF 寬度" />
              )}

              <PdfColumn
                isMobile={isMobile}
                hasPdf={hasPdf}
                pdfLoading={pdfLoading}
                pdfError={pdfError}
                pdfBlob={pdfBlob}
                pdfPage={pdfPage}
                zoom={zoom}
                watermarkText={watermarkText}
                selectionMode={selectionMode}
                showPageJumpBar={showPageJumpBar}
                mobilePageInput={mobilePageInput}
                pageCount={pageCount}
                mobileNotice={mobileNotice}
                touchZoneRef={touchZoneRef}
                pageJumpInputRef={pageJumpInputRef}
                onPointerDown={onPdfTouchZonePointerDown}
                onPointerUp={onPdfTouchZonePointerUp}
                onPointerCancel={onPdfTouchZonePointerCancel}
                onPageCount={setPageCount}
                onPdfError={setPdfError}
                onSelectedText={setSelectedText}
                onPageHasText={setPageHasText}
                onPrevPage={prevPage}
                onNextPage={nextPage}
                onApplyPageJump={applyMobilePageJump}
                onPageInputChange={setMobilePageInput}
                onPageJumpKeyDown={onMobilePageJumpKeyDown}
              />

              <DesktopRightPanels
                isMobile={isMobile}
                rightPanel={rightPanel}
                aiWidth={aiWidth}
                chatRef={chatRef}
                bookId={bookId}
                chapterId={safeActiveChapter}
                chapterTitle={activeChapterTitle}
                pdfPage={pdfPage}
                hasPdf={hasPdf}
                pageCount={pageCount}
                pdfSessionId={pdfSessionId}
                notesRefreshKey={notesRefreshKey}
                prefill={aiPrefill}
                onSaveAnswer={saveAiAnswerAsNote}
                onCollapse={() => setRightPanel(null)}
                onJumpToPage={jumpToPage}
                onResize={resizeAi}
              />
            </div>

            <MobileTocSheet
              open={isMobileTocOpen}
              onClose={closeMobilePanel}
              outline={outline}
              activeNodeId={activeOutlineId}
              outlineSource={outlineSource}
              onSelect={selectOutlineNode}
            />

            <MobileChatSheet
              open={isMobileChatOpen}
              onClose={closeMobilePanel}
              bookId={bookId}
              chapterId={safeActiveChapter}
              prefill={aiPrefill}
              onSaveAnswer={saveAiAnswerAsNote}
            />

            <MobileNotesSheet
              open={isMobileNotesOpen}
              onClose={closeMobilePanel}
              bookId={bookId}
              pageNumber={hasPdf ? pdfPage : null}
              chapterId={safeActiveChapter}
              chapterTitle={activeChapterTitle}
              refreshKey={notesRefreshKey}
            />

            <MobileProgressSheet
              open={isMobileProgressOpen}
              onClose={closeMobilePanel}
              bookId={bookId}
              sessionId={pdfSessionId}
              pdfPage={hasPdf ? pdfPage : null}
              pageCount={pageCount}
              chapterId={safeActiveChapter}
              chapterTitle={activeChapterTitle}
            />

            <MobileGridSheet
              open={isMobileGridOpen}
              onClose={closeMobilePanel}
              bookId={bookId}
              sessionId={pdfSessionId}
              chapterId={safeActiveChapter}
              chapterTitle={activeChapterTitle}
              onJumpToPage={jumpToPage}
            />
          </>
        ) : (
          <TabPlaceholder label={READER_TABS.find((t) => t.key === activeTab)?.label ?? ""} />
        )}

      </div>
      <OuterResizeHandle
        onResize={resizeRightOuter}
        label="調整右側空白與閱讀器寬度"
      />
      <div className="reader-outer-gutter right" aria-hidden="true" />
      <MobileActionBar
        isMobile={isMobile}
        showMobileControls={showMobileControls}
        hasPdf={hasPdf}
        pdfPage={pdfPage}
        pageCount={pageCount}
        mobileBarPageInput={mobileBarPageInput}
        isTocOpen={isMobileTocOpen}
        isChatOpen={isMobileChatOpen}
        isNotesOpen={isMobileNotesOpen}
        isProgressOpen={isMobileProgressOpen}
        isGridOpen={isMobileGridOpen}
        barRef={actionBarRef}
        onPrevPage={prevPage}
        onNextPage={nextPage}
        onBarInputChange={setMobileBarPageInput}
        onBarJumpKeyDown={onMobileBarJumpKeyDown}
        onApplyBarJump={applyMobileBarJump}
        onOpenPanel={openMobilePanel}
        onRevealAi={() => revealAiPanelWithPrefill(null)}
        onToggleProgress={toggleProgress}
        onToggleGrid={toggleGrid}
      />
    </div>
  );
}
