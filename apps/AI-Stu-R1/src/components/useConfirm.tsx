import { useCallback, useSyncExternalStore, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ConfirmDialog, type ConfirmDialogTone } from "./ConfirmDialog";

export interface ConfirmOptions {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: ConfirmDialogTone;
}

export interface NoticeOptions {
  title?: string;
  message: ReactNode;
  confirmLabel?: string;
}

type DialogRequest =
  | { kind: "confirm"; options: ConfirmOptions; resolve: (value: boolean) => void }
  | { kind: "notice"; options: NoticeOptions; resolve: () => void };

let queue: DialogRequest[] = [];
let active: DialogRequest | null = null;
const listeners = new Set<() => void>();
let hostContainer: HTMLDivElement | null = null;
let hostRoot: Root | null = null;

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot() {
  return active;
}

function showNext() {
  active = queue.shift() ?? null;
  emit();
}

function settle(confirmed: boolean) {
  const request = active;
  if (!request) return;
  showNext();
  if (request.kind === "confirm") request.resolve(confirmed);
  else request.resolve();
}

function DialogHost() {
  const request = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  if (!request) return null;
  if (request.kind === "notice") {
    return (
      <ConfirmDialog
        open
        title={request.options.title ?? "提示"}
        message={request.options.message}
        confirmLabel={request.options.confirmLabel}
        cancelLabel={null}
        onConfirm={() => settle(true)}
        onCancel={() => settle(false)}
      />
    );
  }
  return (
    <ConfirmDialog
      open
      title={request.options.title}
      message={request.options.message}
      confirmLabel={request.options.confirmLabel}
      cancelLabel={request.options.cancelLabel}
      tone={request.options.tone}
      onConfirm={() => settle(true)}
      onCancel={() => settle(false)}
    />
  );
}

/**
 * Mounts the dialog host on demand so the hook works without changing the app
 * root. Recreates the host when its container was removed (e.g. test cleanup).
 */
function ensureHost() {
  if (hostRoot && hostContainer?.isConnected) return;
  if (hostRoot) {
    hostRoot.unmount();
    hostRoot = null;
    hostContainer = null;
  }
  hostContainer = document.createElement("div");
  hostContainer.setAttribute("data-confirm-dialog-root", "");
  document.body.appendChild(hostContainer);
  hostRoot = createRoot(hostContainer);
  hostRoot.render(<DialogHost />);
}

function enqueue(request: DialogRequest) {
  if (typeof document === "undefined") {
    if (request.kind === "confirm") request.resolve(false);
    else request.resolve();
    return;
  }
  queue.push(request);
  if (!active) showNext();
  ensureHost();
}

/** Resolves true when confirmed and false on cancel, Escape or close. */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    enqueue({ kind: "confirm", options, resolve });
  });
}

/** Resolves when the notice is dismissed. */
export function noticeDialog(options: NoticeOptions): Promise<void> {
  return new Promise<void>((resolve) => {
    enqueue({ kind: "notice", options, resolve });
  });
}

export function useConfirm() {
  return useCallback((options: ConfirmOptions) => confirmDialog(options), []);
}

export function useNotice() {
  return useCallback((options: NoticeOptions) => noticeDialog(options), []);
}
