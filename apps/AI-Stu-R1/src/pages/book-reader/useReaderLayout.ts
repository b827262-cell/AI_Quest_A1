import { useEffect, useMemo, useState } from "react";
import {
  RATIO_AI_WIDTH,
  RATIO_TOC_WIDTH,
  type ReaderRatio
} from "../../components/PdfReaderToolbar";
import {
  AI_DEFAULT,
  AI_MAX,
  AI_MIN,
  AI_WIDTH_KEY,
  LAYOUT_RATIO_KEY,
  OUTER_GUTTER_MAX,
  OUTER_GUTTER_MIN,
  OUTER_LAYOUT_KEY,
  TOC_DEFAULT,
  TOC_MAX,
  TOC_MIN,
  TOC_WIDTH_KEY
} from "./constants";
import {
  clamp,
  defaultOuterGutter,
  readStoredOuterLayout,
  readStoredRatio,
  readStoredWidth
} from "./layout";

/**
 * Pane widths, outer gutters and the PDF/AI ratio preset. Every value is
 * persisted to localStorage so the reader layout survives reloads.
 */
export function useReaderLayout({
  collapsed,
  rightPanel
}: {
  collapsed: boolean;
  rightPanel: "ai" | "notes" | "progress" | "grid" | null;
}) {
  const initialOuterLayout = useMemo(() => readStoredOuterLayout(), []);
  const [tocWidth, setTocWidth] = useState(() =>
    readStoredWidth(TOC_WIDTH_KEY, TOC_DEFAULT, TOC_MIN, TOC_MAX)
  );
  const [aiWidth, setAiWidth] = useState(() =>
    readStoredWidth(AI_WIDTH_KEY, AI_DEFAULT, AI_MIN, AI_MAX)
  );
  const [leftGutter, setLeftGutter] = useState(initialOuterLayout.leftGutter);
  const [rightGutter, setRightGutter] = useState(initialOuterLayout.rightGutter);
  const [layoutRatio, setLayoutRatio] = useState<ReaderRatio>(() => readStoredRatio());

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

  return {
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
  };
}
