import { useEffect, useRef, useState } from "react";
import type { ReaderTabKey } from "../../components/ReaderTabs";
import type { MobileReaderPanel } from "./constants";

/**
 * Mobile-only reader chrome: the active bottom sheet, the fixed-viewport CSS
 * variables (keyboard + chrome offsets) and the body scroll lock.
 */
export function useMobileReaderShell({
  isMobile,
  activeTab,
  rightPanel,
  selectionMode,
  pdfPage,
  pdfBlob,
  onDesktopChromeReset
}: {
  isMobile: boolean;
  activeTab: ReaderTabKey;
  rightPanel: "ai" | "notes" | "progress" | "grid" | null;
  selectionMode: boolean;
  pdfPage: number;
  pdfBlob: Blob | null;
  onDesktopChromeReset: () => void;
}) {
  const [mobilePanel, setMobilePanel] = useState<MobileReaderPanel | null>(null);
  const outerLayoutRef = useRef<HTMLDivElement>(null);
  const readerMainRef = useRef<HTMLDivElement>(null);
  const actionBarRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isMobile) {
      setMobilePanel(null);
      onDesktopChromeReset();
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

  return { mobilePanel, setMobilePanel, outerLayoutRef, readerMainRef, actionBarRef };
}
