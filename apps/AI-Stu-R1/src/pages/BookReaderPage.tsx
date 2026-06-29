import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent
} from "react";
import { Link, useParams } from "react-router-dom";
import type { BookChapter, ReaderOutlineNode, ReaderOutlineSource } from "@ai-smartbook/schema";
import { studentClient, type BookDetail } from "../studentClient";
import type { StudentBook } from "../bookDisplay";
import { ReaderTopBar } from "../components/ReaderTopBar";
import { ReaderTabs, READER_TABS, type ReaderTabKey } from "../components/ReaderTabs";
import { ChapterSidebar } from "../components/ChapterSidebar";
import {
  PdfReaderToolbar,
  RATIO_AI_WIDTH,
  RATIO_TOC_WIDTH,
  type ReaderRatio
} from "../components/PdfReaderToolbar";
import { ProtectedPdfViewer } from "../components/ProtectedPdfViewer";
import { ChatPanel } from "../components/ChatPanel";
import { SmartNotesPanel } from "../components/SmartNotesPanel";
import { ProgressPanel } from "../components/ProgressPanel";
import { LearningGridPanel } from "../components/LearningGridPanel";
import { TabPlaceholder } from "../components/TabPlaceholder";

const QUICK_PROMPTS = [
  "整理這頁重點",
  "用例子解釋",
  "本章有考題？",
  "解析第一題",
  "關鍵字找考題"
];

// Resizable pane bounds (desktop). PDF area is flexible (min-width in CSS).
const TOC_MIN = 220;
const TOC_MAX = 420;
const TOC_DEFAULT = 260;
const AI_MIN = 300;
const AI_MAX = 560;
const AI_DEFAULT = 380;
const TOC_WIDTH_KEY = "smartbook.reader.tocWidth";
const AI_WIDTH_KEY = "smartbook.reader.aiWidth";
const OUTER_LAYOUT_KEY = "smartbook.reader.outerLayout";
const LAYOUT_RATIO_KEY = "smartbook.reader.layoutRatio";
const OUTER_GUTTER_MIN = 16;
const OUTER_GUTTER_MAX = 520;
const MOBILE_TOUCH_TOP_ZONE = 0.2;
const MOBILE_TOUCH_BOTTOM_ZONE = 0.8;
const MOBILE_TOUCH_LEFT_ZONE = 0.3;
const MOBILE_TOUCH_RIGHT_ZONE = 0.7;
const MOBILE_TOUCH_TAP_DELTA = 14;
const MOBILE_TOUCH_TAP_DURATION = 450;
const MOBILE_NOTICE_DURATION = 1500;
const MOBILE_TOUCH_IGNORE_SELECTOR = [
  "button",
  "a",
  "input",
  "select",
  "textarea",
  '[role="button"]',
  ".pdf-text-layer",
  ".reader-page-jump-bar",
  ".reader-mobile-action-bar",
  ".reader-mobile-overlay",
  ".reader-mobile-sheet",
  ".reader-topbar",
  ".pdf-toolbar",
  ".pdf-select-bar",
  ".reader-note-panel",
  ".text-selection-toolbar"
].join(", ");
type MobileReaderPanel = "toc" | "ai" | "notes" | "progress" | "grid";

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function readStoredWidth(key: string, fallback: number, min: number, max: number): number {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? clamp(n, min, max) : fallback;
  } catch {
    return fallback;
  }
}

function readStoredRatio(): ReaderRatio {
  try {
    const raw = localStorage.getItem(LAYOUT_RATIO_KEY);
    return raw === "6:4" || raw === "1:1" || raw === "4:6" ? raw : "6:4";
  } catch {
    return "6:4";
  }
}

function defaultOuterGutter(): number {
  if (typeof window === "undefined") return 80;
  return clamp(Math.floor((window.innerWidth - 1280) / 2), OUTER_GUTTER_MIN, OUTER_GUTTER_MAX);
}

function readStoredOuterLayout(): { leftGutter: number; rightGutter: number } {
  try {
    const fallback = defaultOuterGutter();
    const raw = localStorage.getItem(OUTER_LAYOUT_KEY);
    if (!raw) return { leftGutter: fallback, rightGutter: fallback };
    const parsed = JSON.parse(raw) as { leftGutter?: unknown; rightGutter?: unknown };
    const left = typeof parsed.leftGutter === "number" ? parsed.leftGutter : fallback;
    const right = typeof parsed.rightGutter === "number" ? parsed.rightGutter : fallback;
    return {
      leftGutter: clamp(left, OUTER_GUTTER_MIN, OUTER_GUTTER_MAX),
      rightGutter: clamp(right, OUTER_GUTTER_MIN, OUTER_GUTTER_MAX)
    };
  } catch {
    const fallback = defaultOuterGutter();
    return { leftGutter: fallback, rightGutter: fallback };
  }
}

function studentSessionKey(bookId: string): string {
  return `smartbook.chatSession.${bookId}`;
}

function flattenOutline(nodes: ReaderOutlineNode[]): ReaderOutlineNode[] {
  const flat: ReaderOutlineNode[] = [];
  function walk(items: ReaderOutlineNode[]) {
    for (const item of items) {
      flat.push(item);
      walk(item.children);
    }
  }
  walk(nodes);
  return flat;
}

function chaptersToFallbackOutline(chapters: BookChapter[]): ReaderOutlineNode[] {
  const nodes = chapters
    .slice()
    .sort((a, b) => a.orderIndex - b.orderIndex)
      .map((chapter) => ({
        id: chapter.id,
        title: chapter.title,
        level: Math.max(1, (chapter.level ?? 0) + 1),
        page: chapter.pageStart ?? null,
        pdfPage: chapter.pageStart ?? null,
        displayPage: chapter.pageStart != null ? String(chapter.pageStart) : null,
        children: [],
        source: (chapter.source === "pdf_outline" ? "pdf_outline" : "chapter_table") as ReaderOutlineNode["source"]
      }));

  const stack: ReaderOutlineNode[] = [];
  const roots: ReaderOutlineNode[] = [];

  for (const node of nodes) {
    while (stack.length > 0 && stack[stack.length - 1].level >= node.level) {
      stack.pop();
    }

    if (stack.length === 0) {
      roots.push(node);
    } else {
      stack[stack.length - 1].children.push(node);
    }

    stack.push(node);
  }

  return roots;
}

/** Draggable vertical split handle. Reports pointer dx so the parent clamps. */
function PaneSplitter({
  onResize,
  label,
  className = ""
}: {
  onResize: (dx: number) => void;
  label: string;
  className?: string;
}) {
  const dragging = useRef(false);
  const lastX = useRef(0);

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    dragging.current = true;
    lastX.current = e.clientX;
    e.currentTarget.setPointerCapture(e.pointerId);
    document.body.classList.add("reader-resizing");
  }
  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    if (!dragging.current) return;
    const dx = e.clientX - lastX.current;
    lastX.current = e.clientX;
    if (dx !== 0) onResize(dx);
  }
  function onPointerUp(e: PointerEvent<HTMLDivElement>) {
    if (!dragging.current) return;
    dragging.current = false;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    document.body.classList.remove("reader-resizing");
  }

  return (
    <div
      className={`reader-split ${className}`.trim()}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <span className="reader-split-grip" />
    </div>
  );
}

function OuterResizeHandle({
  onResize,
  label
}: {
  onResize: (dx: number) => void;
  label: string;
}) {
  return (
    <PaneSplitter onResize={onResize} label={label} className="outer" />
  );
}

export function BookReaderPage() {
  const { bookId = "" } = useParams();
  const initialOuterLayout = useMemo(() => readStoredOuterLayout(), []);
  const [book, setBook] = useState<BookDetail | null>(null);
  const [outline, setOutline] = useState<ReaderOutlineNode[]>([]);
  const [outlineSource, setOutlineSource] = useState<ReaderOutlineSource>("fallback");
  const [selectedOutlineId, setSelectedOutlineId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<ReaderTabKey>("smart-book");
  const [collapsed, setCollapsed] = useState(false);
  // The right column shows the AI Q&A, Smart Notes, or Progress panel — mutually
  // exclusive so the PDF grows when all are collapsed.
  const [rightPanel, setRightPanel] = useState<"ai" | "notes" | "progress" | "grid" | null>("ai");
  const [tocWidth, setTocWidth] = useState(() =>
    readStoredWidth(TOC_WIDTH_KEY, TOC_DEFAULT, TOC_MIN, TOC_MAX)
  );
  const [aiWidth, setAiWidth] = useState(() =>
    readStoredWidth(AI_WIDTH_KEY, AI_DEFAULT, AI_MIN, AI_MAX)
  );
  const [leftGutter, setLeftGutter] = useState(initialOuterLayout.leftGutter);
  const [rightGutter, setRightGutter] = useState(initialOuterLayout.rightGutter);
  const [layoutRatio, setLayoutRatio] = useState<ReaderRatio>(() => readStoredRatio());
  const [zoom, setZoom] = useState(100);
  // PDF physical page is the canonical navigation source of truth.
  const [pdfPage, setPdfPage] = useState(1);
  const [pageCount, setPageCount] = useState<number | null>(null);
  const [notesRefreshKey, setNotesRefreshKey] = useState(0);
  // PDF text selection: drag-select text to copy / save as note / ask AI.
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedText, setSelectedText] = useState("");
  const [pageHasText, setPageHasText] = useState(true);
  const [copyNotice, setCopyNotice] = useState("");
  const [mobileNotice, setMobileNotice] = useState("");
  const [mobilePageInput, setMobilePageInput] = useState("");
  const [mobileBarPageInput, setMobileBarPageInput] = useState("1");
  const [showMobileControls, setShowMobileControls] = useState(true);
  const [showPageJumpBar, setShowPageJumpBar] = useState(false);
  const [aiPrefill, setAiPrefill] = useState<{ text: string; nonce: number } | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [pdfBlob, setPdfBlob] = useState<Blob | null>(null);
  const [pdfSessionId, setPdfSessionId] = useState<string | null>(null);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [pdfError, setPdfError] = useState("");
  const [watermarkStamp, setWatermarkStamp] = useState("");
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window === "undefined" ? 1024 : window.innerWidth
  );
  const [mobilePanel, setMobilePanel] = useState<MobileReaderPanel | null>(null);
  const chatRef = useRef<HTMLDivElement>(null);
  const autoSaveTimerRef = useRef<number | null>(null);
  const outerLayoutRef = useRef<HTMLDivElement>(null);
  const readerMainRef = useRef<HTMLDivElement>(null);
  const actionBarRef = useRef<HTMLDivElement>(null);
  const pageJumpInputRef = useRef<HTMLInputElement>(null);
  const touchZoneRef = useRef<HTMLDivElement>(null);
  const touchStartRef = useRef<{ x: number; y: number; t: number } | null>(null);
  const mobileNoticeTimerRef = useRef<number | null>(null);
  const isMobile = viewportWidth <= 768;
  const isTablet = viewportWidth >= 769 && viewportWidth <= 1024;

  // Ensure reader-resizing is cleaned up on unmount, blur, or pointerup outside
  useEffect(() => {
    const cleanup = () => document.body.classList.remove("reader-resizing");
    window.addEventListener("blur", cleanup);
    window.addEventListener("pointerup", cleanup);
    window.addEventListener("visibilitychange", cleanup);
    return () => {
      window.removeEventListener("blur", cleanup);
      window.removeEventListener("pointerup", cleanup);
      window.removeEventListener("visibilitychange", cleanup);
      cleanup();
    };
  }, []);

  // Persist pane widths so the layout survives reloads.
  useEffect(() => {
    function onResize() {
      setViewportWidth(window.innerWidth);
    }
    window.addEventListener("resize", onResize);
    onResize();
    return () => {
      window.removeEventListener("resize", onResize);
    };
  }, []);

  useEffect(() => {
    if (!isMobile) {
      setMobilePanel(null);
      setShowMobileControls(true);
      setShowPageJumpBar(false);
      return;
    }
    return;
  }, [isMobile]);

  useEffect(() => {
    if (!isMobile || mobilePanel == null) return;
    document.body.classList.add("reader-mobile-overlay-open");
    return () => {
      document.body.classList.remove("reader-mobile-overlay-open");
    };
  }, [isMobile, mobilePanel]);

  // Keep virtual keyboard offsets available for mobile layout (page jump/input
  // overlays should stay above Android soft keyboards).
  useEffect(() => {
    const root = outerLayoutRef.current;
    if (!root || !isMobile) {
      if (root) {
        root.style.removeProperty("--reader-keyboard-bottom");
        root.style.removeProperty("--reader-visual-height");
      }
      return;
    }
    const rootStyle = root.style;
    const visualViewport = window.visualViewport;

    if (!visualViewport) {
      root.style.setProperty("--reader-keyboard-bottom", "0px");
      root.style.setProperty("--reader-visual-height", `${window.innerHeight}px`);
      return;
    }

    function updateKeyboardMetrics() {
      const activeViewport = window.visualViewport;
      if (!activeViewport) return;

      const keyboardBottom = Math.max(0, Math.round(window.innerHeight - activeViewport.height));
      rootStyle.setProperty("--reader-keyboard-bottom", `${keyboardBottom}px`);
      rootStyle.setProperty("--reader-visual-height", `${Math.round(activeViewport.height)}px`);
    }

    updateKeyboardMetrics();
    visualViewport.addEventListener("resize", updateKeyboardMetrics);
    visualViewport.addEventListener("scroll", updateKeyboardMetrics);
    window.addEventListener("orientationchange", updateKeyboardMetrics);
    return () => {
      visualViewport.removeEventListener("resize", updateKeyboardMetrics);
      visualViewport.removeEventListener("scroll", updateKeyboardMetrics);
      window.removeEventListener("orientationchange", updateKeyboardMetrics);
    };
  }, [isMobile]);

  // Lock the page body scroll while reading on mobile so the body never becomes
  // the PDF scroll container (the pinned .pdf-canvas-frame owns scrolling).
  const isMobileReading = isMobile && activeTab === "smart-book";
  useEffect(() => {
    if (!isMobileReading) return;
    document.body.classList.add("reader-reading-mobile");
    return () => document.body.classList.remove("reader-reading-mobile");
  }, [isMobileReading]);

  useEffect(() => {
    if (!showPageJumpBar || !isMobile) return;
    setMobilePageInput(String(pdfPage));
    const raf = requestAnimationFrame(() => {
      pageJumpInputRef.current?.focus();
      pageJumpInputRef.current?.select();
    });
    return () => cancelAnimationFrame(raf);
  }, [isMobile, pdfPage, showPageJumpBar]);

  useEffect(() => {
    if (!showPageJumpBar || !isMobile) return;
    const onPointerDown = (event: globalThis.PointerEvent) => {
      const target = event.target as EventTarget | null;
      const element = target instanceof Element ? target : null;
      if (!element) return;
      const inJumpBar = element.closest(".reader-page-jump-bar") != null;
      const inJumpInput = pageJumpInputRef.current?.contains(element) ?? false;
      if (inJumpBar || inJumpInput) return;
      setShowPageJumpBar(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [isMobile, showPageJumpBar]);

  useEffect(() => {
    return () => {
      if (mobileNoticeTimerRef.current != null) {
        clearTimeout(mobileNoticeTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    setMobileBarPageInput(String(pdfPage));
  }, [pdfPage]);

  // Measure the reader chrome height (top of .reader-main) and the bottom action
  // bar so the fixed mobile PDF viewport sits exactly between them. Re-measures
  // on resize / orientation / chrome layout changes (e.g. toolbar wrapping).
  useEffect(() => {
    const root = outerLayoutRef.current;
    if (!root) return;
    if (!isMobile) {
      root.style.removeProperty("--mobile-reader-top");
      root.style.removeProperty("--mobile-reader-bottom");
      return;
    }
    const measure = () => {
      const top = readerMainRef.current?.getBoundingClientRect().top;
      if (top != null && Number.isFinite(top)) {
        // Clamp to a safe band: a document-flow/scrolled measurement can return
        // an absurd value (e.g. 1191px) that would push the fixed mobile PDF
        // viewport / snapshot off-screen and collapse its max-height to 0.
        const safeTop = Math.min(Math.max(Math.round(top), 120), 220);
        root.style.setProperty("--mobile-reader-top", `${safeTop}px`);
      }
      const barH = actionBarRef.current?.getBoundingClientRect().height;
      if (barH != null && Number.isFinite(barH) && barH > 0) {
        root.style.setProperty("--mobile-reader-bottom", `${Math.round(barH)}px`);
      }
    };
    measure();
    const raf = requestAnimationFrame(measure);
    const settle = window.setTimeout(measure, 200);
    const workbench = readerMainRef.current?.parentElement;
    const ro = new ResizeObserver(measure);
    if (workbench) ro.observe(workbench);
    if (actionBarRef.current) ro.observe(actionBarRef.current);
    window.addEventListener("resize", measure);
    window.addEventListener("orientationchange", measure);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(settle);
      ro.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("orientationchange", measure);
    };
  }, [isMobile, activeTab, mobilePanel, rightPanel, selectionMode, pdfPage, pdfBlob]);

  useEffect(() => {
    try {
      localStorage.setItem(TOC_WIDTH_KEY, String(tocWidth));
    } catch {
      /* ignore */
    }
  }, [tocWidth]);
  useEffect(() => {
    try {
      localStorage.setItem(AI_WIDTH_KEY, String(aiWidth));
    } catch {
      /* ignore */
    }
  }, [aiWidth]);
  useEffect(() => {
    try {
      localStorage.setItem(OUTER_LAYOUT_KEY, JSON.stringify({ leftGutter, rightGutter }));
    } catch {
      /* ignore */
    }
  }, [leftGutter, rightGutter]);
  useEffect(() => {
    try {
      localStorage.setItem(LAYOUT_RATIO_KEY, layoutRatio);
    } catch {
      /* ignore */
    }
  }, [layoutRatio]);

  // Reset per-book view state when switching books.
  useEffect(() => {
    setSelectedOutlineId(null);
    setOutline([]);
    setOutlineSource("fallback");
    setActiveTab("smart-book");
    setPdfPage(1);
    setPageCount(null);
    setPdfError("");
    setMobileNotice("");
    if (mobileNoticeTimerRef.current != null) {
      clearTimeout(mobileNoticeTimerRef.current);
      mobileNoticeTimerRef.current = null;
    }
    setShowPageJumpBar(false);
    setShowMobileControls(true);
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

  useEffect(() => {
    setPdfBlob(null);
    setPdfLoading(false);
    setPdfError("");
    setPdfSessionId(null);
    setWatermarkStamp("");
  }, [bookId]);

  useEffect(() => {
    if (!bookId || !book?.pdfFileId) return;

    const pdfFileId = book.pdfFileId;
    let disposed = false;

    async function loadProtectedPdf(savedSessionId?: string | null) {
      const ensured = await studentClient.ensureBookSession(bookId, savedSessionId ?? undefined);
      if (disposed) return;
      localStorage.setItem(studentSessionKey(bookId), ensured.sessionId);
      setPdfSessionId(ensured.sessionId);
      setWatermarkStamp(new Date().toLocaleString());
      const blob = await studentClient.getProtectedPdfBlob(bookId, pdfFileId, ensured.sessionId);
      if (disposed) return;
      setPdfBlob(blob);
    }

    async function run() {
      setPdfLoading(true);
      setPdfError("");
      const savedSessionId = localStorage.getItem(studentSessionKey(bookId));
      try {
        await loadProtectedPdf(savedSessionId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (savedSessionId && /invalid session/i.test(message)) {
          localStorage.removeItem(studentSessionKey(bookId));
          try {
            await loadProtectedPdf(null);
            return;
          } catch (retryErr) {
            if (!disposed) {
              setPdfError(retryErr instanceof Error ? retryErr.message : String(retryErr));
            }
            return;
          }
        }
        if (!disposed) setPdfError(message);
      } finally {
        if (!disposed) setPdfLoading(false);
      }
    }

    void run();

    return () => {
      disposed = true;
    };
  }, [bookId, book?.pdfFileId]);

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
    "iBrain 智匯",
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
      window.alert("已存成筆記，可於「智能筆記」分頁查看。");
    } catch (e) {
      window.alert(`存成筆記失敗：${e instanceof Error ? e.message : String(e)}`);
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
      window.alert(`加入筆記失敗：${e instanceof Error ? e.message : String(e)}`);
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

  function setMobileNoticeMessage(message: string, duration = MOBILE_NOTICE_DURATION) {
    if (!isMobile) return;
    setMobileNotice(message);
    if (mobileNoticeTimerRef.current != null) {
      clearTimeout(mobileNoticeTimerRef.current);
    }
    mobileNoticeTimerRef.current = window.setTimeout(() => {
      setMobileNotice("");
    }, duration);
    if (navigator.vibrate) {
      navigator.vibrate(20);
    }
  }

  function toggleMobileControls() {
    setShowMobileControls((current) => !current);
  }

  function toggleMobilePageJumpBar() {
    if (!book?.pdfFileId) return;
    setShowPageJumpBar((current) => !current);
    setShowMobileControls(true);
  }

  function jumpToPage(page: number) {
    const clamped = clamp(page, 1, pageCount ?? Number.MAX_SAFE_INTEGER);
    if (isMobile && pageCount != null) {
      if (page < 1) {
        setMobileNoticeMessage("已到達第一頁");
      } else if (page > pageCount) {
        setMobileNoticeMessage("已到達最後一頁");
      }
    }
    setPdfPage(clamped);
  }

  function applyMobilePageJump() {
    const raw = mobilePageInput.trim();
    if (!raw) {
      setShowPageJumpBar(false);
      return;
    }
    const target = Number(raw);
    if (!Number.isInteger(target)) {
      setMobileNoticeMessage("頁碼格式錯誤");
      return;
    }
    jumpToPage(target);
    setShowPageJumpBar(false);
  }

  function onMobilePageJumpKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      applyMobilePageJump();
    }
  }

  function applyMobileBarJump() {
    const raw = mobileBarPageInput.trim();
    if (!raw) {
      setMobileBarPageInput(String(pdfPage));
      return;
    }
    const target = Number(raw);
    if (!Number.isInteger(target)) {
      setMobileNoticeMessage("頁碼格式錯誤");
      return;
    }
    jumpToPage(target);
  }

  function onMobileBarJumpKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") applyMobileBarJump();
  }

  function hasIgnoredMobileTouchTarget(target: EventTarget | null): boolean {
    return target instanceof Element && target.closest(MOBILE_TOUCH_IGNORE_SELECTOR) != null;
  }

  function hasSelectedText(): boolean {
    return (window.getSelection()?.toString() ?? "").trim().length > 0;
  }

  function onPdfTouchZonePointerDown(event: PointerEvent<HTMLDivElement>) {
    if (!isMobile || !book?.pdfFileId) return;
    if (event.pointerType !== "touch" && event.pointerType !== "pen") return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const activeElement = document.activeElement;
    const editableElement =
      activeElement instanceof HTMLInputElement || activeElement instanceof HTMLTextAreaElement
        ? activeElement
        : activeElement instanceof HTMLElement && activeElement.isContentEditable
          ? activeElement
          : null;
    if (editableElement && target.closest(".reader-page-jump-bar") == null) {
      editableElement.blur();
      touchStartRef.current = null;
      return;
    }
    if (hasIgnoredMobileTouchTarget(target) || hasSelectedText()) {
      return;
    }
    touchStartRef.current = {
      x: event.clientX,
      y: event.clientY,
      t: performance.now()
    };
  }

  function onPdfTouchZonePointerUp(event: PointerEvent<HTMLDivElement>) {
    const zone = touchZoneRef.current;
    const start = touchStartRef.current;
    touchStartRef.current = null;

    if (!isMobile || !zone || !start || !book?.pdfFileId) return;
    if (event.pointerType !== "touch" && event.pointerType !== "pen") return;
    if (performance.now() - start.t > MOBILE_TOUCH_TAP_DURATION) return;
    const diffX = Math.abs(event.clientX - start.x);
    const diffY = Math.abs(event.clientY - start.y);
    if (diffX > MOBILE_TOUCH_TAP_DELTA || diffY > MOBILE_TOUCH_TAP_DELTA) return;

    if (hasIgnoredMobileTouchTarget(event.target) || hasSelectedText()) {
      return;
    }

    const rect = zone.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const nx = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    const ny = clamp((event.clientY - rect.top) / rect.height, 0, 1);

    if (ny >= MOBILE_TOUCH_BOTTOM_ZONE) {
      toggleMobilePageJumpBar();
      return;
    }
    if (ny <= MOBILE_TOUCH_TOP_ZONE) {
      toggleMobileControls();
      return;
    }
    if (nx <= MOBILE_TOUCH_LEFT_ZONE) {
      prevPage();
      return;
    }
    if (nx >= MOBILE_TOUCH_RIGHT_ZONE) {
      nextPage();
      return;
    }
    toggleMobileControls();
  }

  function onPdfTouchZonePointerCancel() {
    touchStartRef.current = null;
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

  const prevPage = () =>
    setPdfPage((current) => {
      if (current <= 1) {
        setMobileNoticeMessage("已到達第一頁");
        return 1;
      }
      return current - 1;
    });
  const nextPage = () =>
    setPdfPage((current) => {
      if (pageCount != null && current >= pageCount) {
        setMobileNoticeMessage("已到達最後一頁");
        return current;
      }
      return current + 1;
    });
  const resizeToc = (dx: number) => setTocWidth((w) => clamp(w + dx, TOC_MIN, TOC_MAX));
  const resizeAi = (dx: number) => setAiWidth((w) => clamp(w - dx, AI_MIN, AI_MAX));
  const fullWidth = leftGutter <= OUTER_GUTTER_MIN + 4 && rightGutter <= OUTER_GUTTER_MIN + 4;

  function toggleFullWidth() {
    if (fullWidth) {
      const restored = defaultOuterGutter();
      setLeftGutter(restored);
      setRightGutter(restored);
      return;
    }
    setLeftGutter(OUTER_GUTTER_MIN);
    setRightGutter(OUTER_GUTTER_MIN);
  }

  function applyLayoutRatio(nextRatio: ReaderRatio) {
    setLayoutRatio(nextRatio);
    setTocWidth(RATIO_TOC_WIDTH[nextRatio]);
    setAiWidth(RATIO_AI_WIDTH[nextRatio]);
  }

  function resizeLeftOuter(dx: number) {
    const next = clamp(leftGutter + dx, OUTER_GUTTER_MIN, OUTER_GUTTER_MAX);
    const applied = next - leftGutter;
    if (applied === 0) return;
    setLeftGutter(next);
    if (!collapsed) {
      setTocWidth((width) => clamp(width - applied, TOC_MIN, TOC_MAX));
    }
  }

  function resizeRightOuter(dx: number) {
    const next = clamp(rightGutter - dx, OUTER_GUTTER_MIN, OUTER_GUTTER_MAX);
    const applied = rightGutter - next;
    if (applied === 0) return;
    setRightGutter(next);
    if (rightPanel !== null) {
      setAiWidth((width) => clamp(width + applied, AI_MIN, AI_MAX));
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

            {selectionMode && (
              <div className="pdf-select-bar">
                {selectedText ? (
                  <>
                    <span className="pdf-select-info">
                      已選取 {selectedText.length} 字
                    </span>
                    <button type="button" className="tool-btn" onClick={() => void onCopySelection()}>
                      複製
                    </button>
                    <button type="button" className="tool-btn" onClick={() => void onSelectionToNote()}>
                      加入筆記
                    </button>
                    <button type="button" className="tool-btn ask" onClick={onAskAiAboutSelection}>
                      問AI重點
                    </button>
                    {copyNotice ? <span className="pdf-select-info">{copyNotice}</span> : null}
                  </>
                ) : (
                  <span className="pdf-select-info muted">
                    {pageHasText
                      ? "拖曳選取 PDF 文字後，可複製 / 加入筆記 / 問AI重點。"
                      : "此頁目前無可選取文字，可能是掃描圖像 PDF。"}
                  </span>
                )}
              </div>
            )}

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

              <section className="reader-pdf-col">
                <div
                  className="reader-mobile-touch-zone"
                  ref={touchZoneRef}
                  onPointerDown={isMobile ? onPdfTouchZonePointerDown : undefined}
                  onPointerUp={isMobile ? onPdfTouchZonePointerUp : undefined}
                  onPointerCancel={isMobile ? onPdfTouchZonePointerCancel : undefined}
                >
                  {isMobile && book.pdfFileId ? (
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
                  {!book.pdfFileId ? (
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
                      onPageCount={setPageCount}
                      onError={setPdfError}
                      onSelectedText={setSelectedText}
                      onPageHasText={setPageHasText}
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
                        onClick={prevPage}
                        aria-label="上一頁"
                      >
                        ◀
                      </button>
                      <span className="reader-page-jump-label">
                        第 {book.pdfFileId ? pdfPage : 0} / {pageCount != null ? pageCount : "?"} 頁
                      </span>
                      <input
                        ref={pageJumpInputRef}
                        className="reader-page-jump-input"
                        type="text"
                        value={mobilePageInput}
                        inputMode="numeric"
                        pattern="[0-9]*"
                        onChange={(event) => setMobilePageInput(event.target.value.replace(/\D/g, ""))}
                        onKeyDown={onMobilePageJumpKeyDown}
                        onPointerDown={(event) => event.stopPropagation()}
                      />
                      <button
                        type="button"
                        className="reader-page-jump-btn"
                        onClick={() => applyMobilePageJump()}
                        aria-label="跳至頁碼"
                      >
                        跳
                      </button>
                      <button
                        type="button"
                        className="reader-page-jump-btn"
                        onClick={nextPage}
                        aria-label="下一頁"
                      >
                        ▶
                      </button>
                    </div>
                  ) : null}
                  {mobileNotice ? <div className="reader-mobile-toast">{mobileNotice}</div> : null}
                </div>
              </section>

              {!isMobile && rightPanel !== null && (
                <PaneSplitter onResize={resizeAi} label="調整 PDF 與右側面板寬度" />
              )}
              {!isMobile && rightPanel === "ai" && (
                <div className="reader-chat-col" ref={chatRef} style={{ width: aiWidth }}>
                  <ChatPanel
                    bookId={bookId}
                    chapterId={safeActiveChapter ?? undefined}
                    title="AI 問答"
                    subtitle="點擊左側章節可限定提問範圍"
                    quickPrompts={QUICK_PROMPTS}
                    inputPlaceholder="問 AI 問題（支援貼上圖片）..."
                    onSaveAnswer={saveAiAnswerAsNote}
                    prefill={aiPrefill}
                  />
                </div>
              )}
              {!isMobile && rightPanel === "notes" && (
                <div className="reader-notes-col" style={{ width: aiWidth }}>
                  <SmartNotesPanel
                    bookId={bookId}
                    pageNumber={book.pdfFileId ? pdfPage : null}
                    chapterId={safeActiveChapter}
                    chapterTitle={activeChapterTitle}
                    refreshKey={notesRefreshKey}
                    compact
                    onCollapse={() => setRightPanel(null)}
                  />
                </div>
              )}
              {!isMobile && rightPanel === "progress" && (
                <div className="reader-progress-col" style={{ width: aiWidth }}>
                  {pdfSessionId ? (
                    <ProgressPanel
                      bookId={bookId}
                      sessionId={pdfSessionId}
                      pdfPage={book.pdfFileId ? pdfPage : null}
                      pageCount={pageCount}
                      chapterId={safeActiveChapter}
                      chapterTitle={activeChapterTitle}
                      onCollapse={() => setRightPanel(null)}
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
                      chapterId={safeActiveChapter}
                      chapterTitle={activeChapterTitle}
                      onJumpToPage={jumpToPage}
                      onCollapse={() => setRightPanel(null)}
                    />
                  ) : (
                    <p className="muted learning-grid-status">
                      等待閱讀工作階段建立中…
                    </p>
                  )}
                </div>
              )}
            </div>

            {isMobileTocOpen ? (
              <div className="reader-mobile-overlay" onClick={closeMobilePanel}>
                <aside
                  className="reader-mobile-sheet reader-mobile-toc"
                  role="dialog"
                  aria-modal="true"
                  aria-label="章節目錄"
                  onClick={(event) => event.stopPropagation()}
                >
                  <div className="reader-mobile-sheet-head">
                    <h4>章節目錄</h4>
                    <button type="button" className="reader-mobile-close" onClick={closeMobilePanel}>
                      關閉
                    </button>
                  </div>
                  <div className="reader-mobile-sheet-body">
                    <ChapterSidebar
                      outline={outline}
                      activeNodeId={activeOutlineId}
                      outlineSource={outlineSource}
                      onSelect={selectOutlineNode}
                    />
                  </div>
                </aside>
              </div>
            ) : null}

            {isMobileChatOpen ? (
              <div className="reader-mobile-overlay" onClick={closeMobilePanel}>
                <aside
                  className="reader-mobile-sheet reader-mobile-chat"
                  role="dialog"
                  aria-modal="true"
                  aria-label="AI 問答"
                  onClick={(event) => event.stopPropagation()}
                >
                  <div className="reader-mobile-sheet-head">
                    <h4>AI 問答</h4>
                    <button type="button" className="reader-mobile-close" onClick={closeMobilePanel}>
                      關閉
                    </button>
                  </div>
                  <div className="reader-mobile-sheet-body">
                    <ChatPanel
                      bookId={bookId}
                      chapterId={safeActiveChapter ?? undefined}
                      title="AI 問答"
                      subtitle="點擊左側章節可限定提問範圍"
                      quickPrompts={QUICK_PROMPTS}
                      inputPlaceholder="問 AI 問題（支援貼上圖片）..."
                      onSaveAnswer={saveAiAnswerAsNote}
                      prefill={aiPrefill}
                    />
                  </div>
                </aside>
              </div>
            ) : null}

            {isMobileNotesOpen ? (
              <div className="reader-mobile-overlay" onClick={closeMobilePanel}>
                <aside
                  className="reader-mobile-sheet reader-mobile-notes"
                  role="dialog"
                  aria-modal="true"
                  aria-label="智能筆記"
                  onClick={(event) => event.stopPropagation()}
                >
                  <div className="reader-mobile-sheet-head">
                    <h4>智能筆記</h4>
                    <button
                      type="button"
                      className="reader-mobile-close"
                      onClick={closeMobilePanel}
                    >
                      關閉
                    </button>
                  </div>
                  <div className="reader-mobile-sheet-body">
                    <SmartNotesPanel
                      bookId={bookId}
                      pageNumber={book.pdfFileId ? pdfPage : null}
                      chapterId={safeActiveChapter}
                      chapterTitle={activeChapterTitle}
                      refreshKey={notesRefreshKey}
                      compact
                    />
                  </div>
                </aside>
              </div>
            ) : null}

            {isMobileProgressOpen ? (
              <div className="reader-mobile-overlay" onClick={closeMobilePanel}>
                <aside
                  className="reader-mobile-sheet reader-mobile-progress"
                  role="dialog"
                  aria-modal="true"
                  aria-label="閱讀進度"
                  onClick={(event) => event.stopPropagation()}
                >
                  <div className="reader-mobile-sheet-head">
                    <h4>閱讀進度</h4>
                    <button
                      type="button"
                      className="reader-mobile-close"
                      onClick={closeMobilePanel}
                    >
                      關閉
                    </button>
                  </div>
                  <div className="reader-mobile-sheet-body">
                    {pdfSessionId ? (
                      <ProgressPanel
                        bookId={bookId}
                        sessionId={pdfSessionId}
                        pdfPage={book.pdfFileId ? pdfPage : null}
                        pageCount={pageCount}
                        chapterId={safeActiveChapter}
                        chapterTitle={activeChapterTitle}
                      />
                    ) : (
                      <p className="muted progress-panel-status">
                        等待閱讀工作階段建立中…
                      </p>
                    )}
                  </div>
                </aside>
              </div>
            ) : null}

            {isMobileGridOpen ? (
              <div className="reader-mobile-overlay" onClick={closeMobilePanel}>
                <aside
                  className="reader-mobile-sheet reader-mobile-grid"
                  role="dialog"
                  aria-modal="true"
                  aria-label="5×5 學習格"
                  onClick={(event) => event.stopPropagation()}
                >
                  <div className="reader-mobile-sheet-head">
                    <h4>5×5 學習格</h4>
                    <button
                      type="button"
                      className="reader-mobile-close"
                      onClick={closeMobilePanel}
                    >
                      關閉
                    </button>
                  </div>
                  <div className="reader-mobile-sheet-body">
                    {pdfSessionId ? (
                      <LearningGridPanel
                        bookId={bookId}
                        sessionId={pdfSessionId}
                        chapterId={safeActiveChapter}
                        chapterTitle={activeChapterTitle}
                        onJumpToPage={(page) => {
                          jumpToPage(page);
                          closeMobilePanel();
                        }}
                      />
                    ) : (
                      <p className="muted learning-grid-status">
                        等待閱讀工作階段建立中…
                      </p>
                    )}
                  </div>
                </aside>
              </div>
            ) : null}
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
      {isMobile ? (
        <div
          className={`reader-mobile-action-bar ${showMobileControls ? "" : "is-hidden"}`.trim()}
          ref={actionBarRef}
        >
          {book.pdfFileId ? (
            <div
              className="reader-mobile-page-controls"
              data-testid="mobile-page-jump"
              onPointerDown={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                className="reader-mobile-page-btn"
                data-testid="mobile-prev-page"
                onClick={prevPage}
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
                onChange={(e) => setMobileBarPageInput(e.target.value.replace(/\D/g, ""))}
                onKeyDown={onMobileBarJumpKeyDown}
                onFocus={(e) => e.currentTarget.select()}
                aria-label="輸入頁碼"
              />
              <button
                type="button"
                className="reader-mobile-page-btn"
                onClick={applyMobileBarJump}
                aria-label="跳至頁碼"
              >
                跳
              </button>
              <button
                type="button"
                className="reader-mobile-page-btn"
                data-testid="mobile-next-page"
                onClick={nextPage}
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
              className={`reader-mobile-action-btn ${isMobileTocOpen ? "active" : ""}`}
              onClick={() => openMobilePanel("toc")}
            >
              目錄
            </button>
            <button
              type="button"
              className={`reader-mobile-action-btn ${isMobileChatOpen ? "active" : ""}`}
              onClick={() => revealAiPanelWithPrefill(null)}
            >
              問AI
            </button>
            <button
              type="button"
              className={`reader-mobile-action-btn ${isMobileNotesOpen ? "active" : ""}`}
              onClick={() => openMobilePanel("notes")}
            >
              筆記
            </button>
            <button
              type="button"
              className={`reader-mobile-action-btn ${isMobileProgressOpen ? "active" : ""}`}
              onClick={toggleProgress}
            >
              進度
            </button>
            <button
              type="button"
              className={`reader-mobile-action-btn ${isMobileGridOpen ? "active" : ""}`}
              onClick={toggleGrid}
            >
              5×5
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
