import { useEffect, useId, useRef, type ReactNode } from "react";

export type ConfirmDialogTone = "default" | "danger";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  /** Pass null to render a single-button notice (native alert equivalent). */
  cancelLabel?: string | null;
  tone?: ConfirmDialogTone;
  onConfirm: () => void;
  onCancel: () => void;
}

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Accessible modal used for both confirmations and notices.
 *
 * Focus moves into the dialog on open (cancel first for destructive actions)
 * and returns to the previously focused element on close. Escape cancels, and
 * Tab is kept inside the dialog while it is open.
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "確定",
  cancelLabel = "取消",
  tone = "default",
  onConfirm,
  onCancel
}: ConfirmDialogProps) {
  const titleId = useId();
  const messageId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const initial = tone === "danger" ? cancelRef.current : confirmRef.current;
    initial?.focus();
    return () => {
      restoreFocusRef.current?.focus();
    };
  }, [open, tone]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const current = document.activeElement;
      if (event.shiftKey && (current === first || !dialog.contains(current))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (current === last || !dialog.contains(current))) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onCancel]);

  if (!open) return null;

  const buttonBase = {
    border: "1px solid #cbd5e1",
    borderRadius: 8,
    padding: "8px 18px",
    fontSize: 14,
    cursor: "pointer"
  } as const;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        background: "rgba(15, 23, 42, 0.55)"
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
        style={{
          width: "min(480px, 100%)",
          background: "#fff",
          borderRadius: 12,
          boxShadow: "0 20px 50px rgba(15, 23, 42, 0.3)",
          padding: "20px 22px",
          color: "#0f172a"
        }}
      >
        <h2 id={titleId} style={{ margin: 0, fontSize: 18 }}>
          {title}
        </h2>
        <div id={messageId} style={{ marginTop: 10, whiteSpace: "pre-wrap", lineHeight: 1.6 }}>
          {message}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 20 }}>
          {cancelLabel === null ? null : (
            <button
              ref={cancelRef}
              type="button"
              onClick={onCancel}
              style={{ ...buttonBase, background: "#fff", color: "#0f172a" }}
            >
              {cancelLabel}
            </button>
          )}
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            style={{
              ...buttonBase,
              borderColor: tone === "danger" ? "#b91c1c" : "#0f172a",
              background: tone === "danger" ? "#b91c1c" : "#0f172a",
              color: "#fff"
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
