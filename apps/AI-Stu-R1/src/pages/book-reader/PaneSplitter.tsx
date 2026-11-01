import { useRef, type PointerEvent } from "react";

/** Draggable vertical split handle. Reports pointer dx so the parent clamps. */
export function PaneSplitter({
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
