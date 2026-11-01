export const QUICK_PROMPTS = [
  "整理這頁重點",
  "用例子解釋",
  "本章有考題？",
  "解析第一題",
  "關鍵字找考題"
];

// Resizable pane bounds (desktop). PDF area is flexible (min-width in CSS).
export const TOC_MIN = 220;
export const TOC_MAX = 420;
export const TOC_DEFAULT = 260;
export const AI_MIN = 300;
export const AI_MAX = 560;
export const AI_DEFAULT = 380;
export const TOC_WIDTH_KEY = "smartbook.reader.tocWidth";
export const AI_WIDTH_KEY = "smartbook.reader.aiWidth";
export const OUTER_LAYOUT_KEY = "smartbook.reader.outerLayout";
export const LAYOUT_RATIO_KEY = "smartbook.reader.layoutRatio";
export const OUTER_GUTTER_MIN = 16;
export const OUTER_GUTTER_MAX = 520;
export const MOBILE_TOUCH_TOP_ZONE = 0.2;
export const MOBILE_TOUCH_BOTTOM_ZONE = 0.8;
export const MOBILE_TOUCH_LEFT_ZONE = 0.3;
export const MOBILE_TOUCH_RIGHT_ZONE = 0.7;
export const MOBILE_TOUCH_TAP_DELTA = 14;
export const MOBILE_TOUCH_TAP_DURATION = 450;
export const MOBILE_NOTICE_DURATION = 1500;
export const MOBILE_TOUCH_IGNORE_SELECTOR = [
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

export type MobileReaderPanel = "toc" | "ai" | "notes" | "progress" | "grid";
