import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type KeyboardEvent,
  type SetStateAction
} from "react";
import { MOBILE_NOTICE_DURATION } from "./constants";
import { clamp } from "./layout";

/**
 * PDF page navigation state shared by the toolbar, the mobile jump bar, the
 * mobile action bar and the mobile touch zones.
 *
 * The mobile chrome visibility (`showMobileControls` / `showPageJumpBar`) is
 * owned by `useMobileReaderShell` so its reset effect can run before these
 * effects, exactly like the pre-split page did.
 */
export function useReaderPagination({
  isMobile,
  hasPdf,
  showPageJumpBar,
  setShowPageJumpBar,
  setShowMobileControls
}: {
  isMobile: boolean;
  hasPdf: boolean;
  showPageJumpBar: boolean;
  setShowPageJumpBar: Dispatch<SetStateAction<boolean>>;
  setShowMobileControls: Dispatch<SetStateAction<boolean>>;
}) {
  // PDF physical page is the canonical navigation source of truth.
  const [pdfPage, setPdfPage] = useState(1);
  const [pageCount, setPageCount] = useState<number | null>(null);
  const [mobilePageInput, setMobilePageInput] = useState("");
  const [mobileBarPageInput, setMobileBarPageInput] = useState("1");
  const [mobileNotice, setMobileNotice] = useState("");
  const pageJumpInputRef = useRef<HTMLInputElement>(null);
  const mobileNoticeTimerRef = useRef<number | null>(null);

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
    if (!hasPdf) return;
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

  /** Reset the per-book navigation state when the reader switches books. */
  function resetPageState() {
    setPdfPage(1);
    setPageCount(null);
    setMobileNotice("");
    if (mobileNoticeTimerRef.current != null) {
      clearTimeout(mobileNoticeTimerRef.current);
      mobileNoticeTimerRef.current = null;
    }
    setShowPageJumpBar(false);
    setShowMobileControls(true);
  }

  return {
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
  };
}
