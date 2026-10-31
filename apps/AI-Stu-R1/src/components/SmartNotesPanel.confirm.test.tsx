// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const client = vi.hoisted(() => ({
  listNotes: vi.fn(),
  deleteNote: vi.fn(),
  createNote: vi.fn()
}));

vi.mock("../studentClient", () => ({ studentClient: client }));

import { SmartNotesPanel } from "./SmartNotesPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function findButton(label: string, scope: ParentNode = document): HTMLButtonElement {
  const element = [...scope.querySelectorAll("button")].find((item) => item.textContent === label);
  if (!element) throw new Error(`button ${label} not found`);
  return element;
}

beforeEach(() => {
  vi.clearAllMocks();
  client.listNotes.mockResolvedValue({
    notes: [
      {
        id: "note-1",
        bookId: "book-1",
        chapterId: null,
        pageNumber: 1,
        type: "text",
        title: "重點",
        content: "筆記內容",
        canvasData: null,
        canvasImageUrl: null,
        sourceMessageId: null,
        createdAt: "2026-10-31T00:00:00.000Z",
        updatedAt: "2026-10-31T00:00:00.000Z"
      }
    ]
  });
  client.deleteNote.mockResolvedValue(undefined);
  client.createNote.mockResolvedValue(undefined);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.innerHTML = "";
});

describe("SmartNotesPanel destructive confirmation", () => {
  it("does not delete on cancel and deletes on confirm", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <SmartNotesPanel bookId="book-1" pageNumber={1} chapterId={null} chapterTitle={null} />
      );
    });

    await act(async () => {
      findButton("刪除", container!).click();
    });
    const cancelDialog = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(cancelDialog?.textContent).toContain("刪除這則筆記？");
    await act(async () => {
      findButton("取消", cancelDialog!).click();
      await Promise.resolve();
    });
    expect(client.deleteNote).not.toHaveBeenCalled();

    await act(async () => {
      findButton("刪除", container!).click();
    });
    const confirmDialog = document.querySelector<HTMLElement>('[role="dialog"]');
    await act(async () => {
      findButton("確定", confirmDialog!).click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(client.deleteNote).toHaveBeenCalledWith("book-1", "note-1");
  });
});
