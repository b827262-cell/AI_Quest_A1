import { useRef, type PointerEvent, type RefObject } from "react";
import {
  MOBILE_TOUCH_BOTTOM_ZONE,
  MOBILE_TOUCH_IGNORE_SELECTOR,
  MOBILE_TOUCH_LEFT_ZONE,
  MOBILE_TOUCH_RIGHT_ZONE,
  MOBILE_TOUCH_TAP_DELTA,
  MOBILE_TOUCH_TAP_DURATION,
  MOBILE_TOUCH_TOP_ZONE
} from "./constants";
import { clamp } from "./layout";

/**
 * Mobile tap zones over the PDF: bottom opens the page jump bar, top toggles
 * the action bar, left/right edges page back and forward, centre toggles the
 * action bar. Ignored while a control or a text selection owns the gesture.
 */
export function useMobileTouchNavigation({
  isMobile,
  hasPdf,
  touchZoneRef,
  onPrevPage,
  onNextPage,
  onToggleControls,
  onTogglePageJumpBar
}: {
  isMobile: boolean;
  hasPdf: boolean;
  touchZoneRef: RefObject<HTMLDivElement | null>;
  onPrevPage: () => void;
  onNextPage: () => void;
  onToggleControls: () => void;
  onTogglePageJumpBar: () => void;
}) {
  const touchStartRef = useRef<{ x: number; y: number; t: number } | null>(null);

  function hasIgnoredMobileTouchTarget(target: EventTarget | null): boolean {
    return target instanceof Element && target.closest(MOBILE_TOUCH_IGNORE_SELECTOR) != null;
  }

  function hasSelectedText(): boolean {
    return (window.getSelection()?.toString() ?? "").trim().length > 0;
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (!isMobile || !hasPdf) return;
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

  function onPointerUp(event: PointerEvent<HTMLDivElement>) {
    const zone = touchZoneRef.current;
    const start = touchStartRef.current;
    touchStartRef.current = null;

    if (!isMobile || !zone || !start || !hasPdf) return;
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
      onTogglePageJumpBar();
      return;
    }
    if (ny <= MOBILE_TOUCH_TOP_ZONE) {
      onToggleControls();
      return;
    }
    if (nx <= MOBILE_TOUCH_LEFT_ZONE) {
      onPrevPage();
      return;
    }
    if (nx >= MOBILE_TOUCH_RIGHT_ZONE) {
      onNextPage();
      return;
    }
    onToggleControls();
  }

  function onPointerCancel() {
    touchStartRef.current = null;
  }

  return { onPointerDown, onPointerUp, onPointerCancel };
}
