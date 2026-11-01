import { useEffect, useState } from "react";

/** Viewport breakpoints plus the shared `reader-resizing` body-class cleanup. */
export function useReaderViewport() {
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window === "undefined" ? 1024 : window.innerWidth
  );

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

  return {
    isMobile: viewportWidth <= 768,
    isTablet: viewportWidth >= 769 && viewportWidth <= 1024
  };
}
