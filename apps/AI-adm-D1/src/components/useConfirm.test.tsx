// @vitest-environment happy-dom
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { confirmDialog, useConfirm, type ConfirmOptions } from "./useConfirm";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

const DANGER: ConfirmOptions = { title: "確認刪除", message: "確定要刪除嗎？", tone: "danger" };

function render(element: ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(element));
}

function findButton(label: string, scope: ParentNode = document): HTMLButtonElement {
  const element = [...scope.querySelectorAll("button")].find((item) => item.textContent === label);
  if (!element) throw new Error(`button ${label} not found`);
  return element;
}

function dialog(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[role="dialog"]');
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.innerHTML = "";
});

function Caller({ results, onDelete }: { results: boolean[]; onDelete: () => Promise<void> }) {
  const confirm = useConfirm();
  async function ask() {
    const confirmed = await confirm(DANGER);
    results.push(confirmed);
    if (confirmed) await onDelete();
  }
  return (
    <div>
      <button type="button" onClick={() => void ask()}>
        刪除一筆
      </button>
      <button
        type="button"
        onClick={() => {
          void ask();
          void ask();
        }}
      >
        連續兩筆
      </button>
    </div>
  );
}

describe("useConfirm lifecycle", () => {
  it("cancels the visible request and closes the dialog when the caller unmounts", async () => {
    const onDelete = vi.fn(async () => undefined);
    const results: boolean[] = [];
    render(<Caller results={results} onDelete={onDelete} />);

    await act(async () => {
      findButton("刪除一筆").click();
    });
    expect(dialog()).not.toBeNull();

    await act(async () => {
      root!.unmount();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(results).toEqual([false]);
    expect(onDelete).not.toHaveBeenCalled();
    expect(dialog()).toBeNull();
  });

  it("moves initial focus to cancel for every queued danger request", async () => {
    const onDelete = vi.fn(async () => undefined);
    const results: boolean[] = [];
    render(<Caller results={results} onDelete={onDelete} />);

    await act(async () => {
      findButton("連續兩筆").click();
    });
    const firstDialog = dialog();
    expect(document.activeElement?.textContent).toBe("取消");

    // Focus the confirm button explicitly so the assertion below proves the
    // second request re-applied its initial focus instead of keeping stale focus.
    await act(async () => {
      findButton("確定", firstDialog!).focus();
      findButton("確定", firstDialog!).click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(results).toEqual([true]);
    expect(dialog()).not.toBeNull();
    expect(document.activeElement?.textContent).toBe("取消");
  });

  it("resolves queued requests as cancelled when the caller unmounts", async () => {
    const onDelete = vi.fn(async () => undefined);
    const results: boolean[] = [];
    render(<Caller results={results} onDelete={onDelete} />);

    await act(async () => {
      findButton("連續兩筆").click();
    });

    await act(async () => {
      root!.unmount();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(results).toEqual([false, false]);
    expect(onDelete).not.toHaveBeenCalled();
    expect(dialog()).toBeNull();
  });

  it("keeps module-level confirmDialog alive when a component unmounts", async () => {
    let pending: Promise<boolean> | undefined;
    function Direct() {
      return (
        <button
          type="button"
          onClick={() => {
            pending = confirmDialog(DANGER);
          }}
        >
          直接呼叫
        </button>
      );
    }
    render(<Direct />);

    await act(async () => {
      findButton("直接呼叫").click();
    });
    await act(async () => {
      root!.unmount();
      await Promise.resolve();
    });
    expect(dialog()).not.toBeNull();

    await act(async () => {
      findButton("確定", dialog()!).click();
      await Promise.resolve();
    });
    await expect(pending).resolves.toBe(true);
  });
});
