import { useEffect, useRef, useState, type RefObject } from "react";
import type { ReaderTabKey } from "../../components/ReaderTabs";
import type { MobileReaderPanel } from "./constants";

type ReaderRightPanel = "ai" | "notes" | "progress" | "grid" | null;

/**
 * Mobile-only reader chrome: the active bottom sheet, the action bar / page jump
 * bar visibility, the fixed-viewport CSS variables (keyboard offsets) and the
 * body scroll lock.
 *
 * The effects here keep the order they have in the pre-split BookReaderPage:
 * desktop chrome reset, overlay body class, keyboard metrics, reading scroll
 * lock. The chrome measurement effect lives in `useMobileReaderMetrics` because
 * the original page ran it after the pagination effects.
 */
export function useMobileReaderShell({
  isMobile,
  activeTab
}: {
  isMobile: boolean;
  activeTab: ReaderTabKey;
}) {
  const [mobilePanel, setMobilePanel] = useState<MobileReaderPanel | null>(null);
  const [showMobileControls, setShowMobileControls] = useState(true);
  const [showPageJumpBar, setShowPageJumpBar] = useState(false);
  const outerLayoutRef = useRef<HTMLDivElement>(null);
  const readerMainRef = useRef<HTMLDivElement>(null);
  const actionBarRef = useRef<HTMLDivElement>(null);

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

  return {
    mobilePanel,
    setMobilePanel,
    showMobileControls,
    setShowMobileControls,
    showPageJumpBar,
    setShowPageJumpBar,
    outerLayoutRef,
    readerMainRef,
    actionBarRef
  };
}

/**
 * Measure the reader chrome height (top of .reader-main) and the bottom action
 * bar so the fixed mobile PDF viewport sits exactly between them. Re-measures
 * on resize / orientation / chrome layout changes (e.g. toolbar wrapping).
 */
export function useMobileReaderMetrics({
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
}: {
  isMobile: boolean;
  activeTab: ReaderTabKey;
  mobilePanel: MobileReaderPanel | null;
  rightPanel: ReaderRightPanel;
  selectionMode: boolean;
  pdfPage: number;
  pdfBlob: Blob | null;
  outerLayoutRef: RefObject<HTMLDivElement | null>;
  readerMainRef: RefObject<HTMLDivElement | null>;
  actionBarRef: RefObject<HTMLDivElement | null>;
}) {
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
}
