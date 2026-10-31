// @vitest-environment happy-dom
import { act, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "./ConfirmDialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function render(element: ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(element));
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.innerHTML = "";
});

function dialog(): HTMLElement {
  const element = document.querySelector<HTMLElement>('[role="dialog"]');
  if (!element) throw new Error("dialog not rendered");
  return element;
}

function findButton(label: string, scope: ParentNode = document): HTMLButtonElement {
  const element = [...scope.querySelectorAll("button")].find((item) => item.textContent === label);
  if (!element) throw new Error(`button ${label} not found`);
  return element;
}

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>
        開啟
      </button>
      <ConfirmDialog
        open={open}
        title="確認刪除"
        message="確定要刪除嗎？"
        tone="danger"
        onConfirm={() => setOpen(false)}
        onCancel={() => setOpen(false)}
      />
    </div>
  );
}

describe("ConfirmDialog", () => {
  it("renders a modal dialog labelled by its title", () => {
    render(
      <ConfirmDialog open title="確認刪除" message="確定要刪除嗎？" onConfirm={vi.fn()} onCancel={vi.fn()} />
    );
    const element = dialog();
    expect(element.getAttribute("aria-modal")).toBe("true");
    const titleId = element.getAttribute("aria-labelledby");
    expect(titleId).toBeTruthy();
    expect(document.getElementById(titleId!)?.textContent).toBe("確認刪除");
    expect(element.textContent).toContain("確定要刪除嗎？");
  });

  it("calls onConfirm when the confirm button is clicked", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<ConfirmDialog open title="確認" message="內容" onConfirm={onConfirm} onCancel={onCancel} />);
    act(() => findButton("確定").click());
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("calls onCancel when the cancel button is clicked", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<ConfirmDialog open title="確認" message="內容" onConfirm={onConfirm} onCancel={onCancel} />);
    act(() => findButton("取消").click());
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("treats Escape as cancel", () => {
    const onCancel = vi.fn();
    render(<ConfirmDialog open title="確認" message="內容" onConfirm={vi.fn()} onCancel={onCancel} />);
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("focuses the confirm button for non-destructive actions", () => {
    render(<ConfirmDialog open title="提示" message="內容" onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(document.activeElement?.textContent).toBe("確定");
  });

  it("focuses cancel for destructive actions and returns focus on close", () => {
    render(<Harness />);
    const trigger = findButton("開啟");
    trigger.focus();
    act(() => trigger.click());
    expect(document.activeElement?.textContent).toBe("取消");
    act(() => findButton("取消", dialog()).click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
