import { useCallback, useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
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

/** Component instance that issued a request; used to cancel its requests on unmount. */
interface RequestOwner {
  /** True while the owning component is unmounted; StrictMode resets it on remount. */
  disposed: boolean;
}

interface RequestBase {
  id: number;
  owner?: RequestOwner;
  settled: boolean;
}

type DialogRequest =
  | (RequestBase & { kind: "confirm"; options: ConfirmOptions; resolve: (value: boolean) => void })
  | (RequestBase & { kind: "notice"; options: NoticeOptions; resolve: () => void });

let nextRequestId = 1;
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

function finish(request: DialogRequest, confirmed: boolean) {
  if (request.settled) return;
  request.settled = true;
  if (request.kind === "confirm") request.resolve(confirmed);
  else request.resolve();
}

function showNext() {
  active = queue.shift() ?? null;
  emit();
}

/**
 * Settles the request the callback was created for. A stale callback (the host
 * already moved on to the next request) must not settle whatever is active now.
 */
function settle(request: DialogRequest, confirmed: boolean) {
  if (active !== request) return;
  active = null;
  finish(request, confirmed);
  showNext();
}

function DialogHost() {
  const request = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  if (!request) return null;
  if (request.kind === "notice") {
    return (
      <ConfirmDialog
        key={request.id}
        open
        title={request.options.title ?? "提示"}
        message={request.options.message}
        confirmLabel={request.options.confirmLabel}
        cancelLabel={null}
        onConfirm={() => settle(request, true)}
        onCancel={() => settle(request, false)}
      />
    );
  }
  return (
    <ConfirmDialog
      key={request.id}
      open
      title={request.options.title}
      message={request.options.message}
      confirmLabel={request.options.confirmLabel}
      cancelLabel={request.options.cancelLabel}
      tone={request.options.tone}
      onConfirm={() => settle(request, true)}
      onCancel={() => settle(request, false)}
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
  // Requests from an unmounted owner are rejected outright: queueing them would
  // show a dialog nobody is waiting for anymore.
  if (request.owner?.disposed) {
    finish(request, false);
    return;
  }
  if (typeof document === "undefined") {
    if (request.kind === "confirm") request.resolve(false);
    else request.resolve();
    return;
  }
  queue.push(request);
  if (!active) showNext();
  ensureHost();
}

function enqueueConfirm(owner: RequestOwner | undefined, options: ConfirmOptions): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    enqueue({ id: nextRequestId++, kind: "confirm", options, resolve, settled: false, owner });
  });
}

function enqueueNotice(owner: RequestOwner | undefined, options: NoticeOptions): Promise<void> {
  return new Promise<void>((resolve) => {
    enqueue({ id: nextRequestId++, kind: "notice", options, resolve, settled: false, owner });
  });
}

/**
 * Drops every request owned by a component that unmounted: queued requests are
 * removed and the visible one is closed. Both settle as "cancelled" so callers
 * awaiting them never hang and never proceed with the destructive action.
 */
function cancelOwner(owner: RequestOwner) {
  let changed = false;
  for (let index = queue.length - 1; index >= 0; index -= 1) {
    const request = queue[index];
    if (request.owner !== owner) continue;
    queue.splice(index, 1);
    finish(request, false);
    changed = true;
  }
  if (active?.owner === owner) {
    const request = active;
    active = null;
    finish(request, false);
    active = queue.shift() ?? null;
    changed = true;
  }
  if (changed) emit();
}

/** Tears the host down (hot reload / module disposal) and cancels what is left. */
function disposeHost() {
  const pending = active ? [active, ...queue] : [...queue];
  active = null;
  queue = [];
  for (const request of pending) finish(request, false);
  emit();
  if (hostRoot) {
    hostRoot.unmount();
    hostRoot = null;
  }
  hostContainer?.remove();
  hostContainer = null;
}

const hot = (import.meta as ImportMeta & { hot?: { dispose: (callback: () => void) => void } }).hot;
hot?.dispose(disposeHost);

/** Resolves true when confirmed and false on cancel, Escape or close. */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return enqueueConfirm(undefined, options);
}

/** Resolves when the notice is dismissed. */
export function noticeDialog(options: NoticeOptions): Promise<void> {
  return enqueueNotice(undefined, options);
}

function useRequestOwner(): RequestOwner {
  const owner = useMemo<RequestOwner>(() => ({ disposed: false }), []);
  useEffect(() => {
    // StrictMode runs cleanup before re-running the effect, so re-arm the owner
    // here; otherwise the remounted component could never open a dialog again.
    owner.disposed = false;
    return () => {
      owner.disposed = true;
      cancelOwner(owner);
    };
  }, [owner]);
  return owner;
}

export function useConfirm() {
  const owner = useRequestOwner();
  return useCallback((options: ConfirmOptions) => enqueueConfirm(owner, options), [owner]);
}

export function useNotice() {
  const owner = useRequestOwner();
  return useCallback((options: NoticeOptions) => enqueueNotice(owner, options), [owner]);
}
