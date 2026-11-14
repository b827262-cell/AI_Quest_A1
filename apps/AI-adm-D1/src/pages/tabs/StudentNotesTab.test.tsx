// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { safeImageUrl, StudentNotesTab } from "./StudentNotesTab";
import { adminApi, type AdminBookNote } from "../../api";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

const notes: AdminBookNote[] = [
  {
    id: "n1",
    bookId: "b1",
    chapterId: "c1",
    chapterTitle: "Ch1",
    pageNumber: 1,
    type: "text",
    title: "Note A",
    content: "alpha content",
    canvasData: null,
    canvasImageUrl: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: null
  },
  {
    id: "n2",
    bookId: "b1",
    chapterId: null,
    chapterTitle: null,
    pageNumber: null,
    type: "canvas",
    title: "Sketch",
    content: null,
    canvasData: "data",
    canvasImageUrl: "https://example.invalid/x.png",
    createdAt: "2026-01-02T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z"
  }
];

async function renderTab() {
  vi.spyOn(adminApi, "getBook").mockResolvedValue({
    chapters: [{ id: "c1", title: "Ch1", orderIndex: 0 }]
  } as never);
  vi.spyOn(adminApi, "getBookNotes").mockResolvedValue({
    bookId: "b1",
    totalCount: notes.length,
    notes
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<StudentNotesTab bookId="b1" />);
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("safeImageUrl", () => {
  it("blocks javascript: and svg data URLs while allowing raster/relative/https", () => {
    expect(safeImageUrl("javascript:alert(1)")).toBeNull();
    expect(safeImageUrl("data:image/svg+xml;base64,AAAA")).toBeNull();
    expect(safeImageUrl("data:text/html;base64,AAAA")).toBeNull();
    expect(safeImageUrl("https://example.invalid/a.png")).toBe("https://example.invalid/a.png");
    expect(safeImageUrl("/uploads/a.png")).toBe("/uploads/a.png");
    expect(safeImageUrl("data:image/png;base64,AAAA")).toBe("data:image/png;base64,AAAA");
    expect(safeImageUrl("data:image/webp;base64,AAAA")).toBe("data:image/webp;base64,AAAA");
    expect(safeImageUrl(null)).toBeNull();
  });
});

describe("StudentNotesTab", () => {
  it("renders note rows and a delete button for each note", async () => {
    await renderTab();
    const text = container!.textContent ?? "";
    expect(text).toContain("Note A");
    expect(text).toContain("alpha content");
    expect(text).toContain("Ch1");
    expect(text).toContain("Sketch");

    const deleteButtons = [...container!.querySelectorAll("button")].filter((b) =>
      b.textContent?.includes("刪除")
    );
    expect(deleteButtons).toHaveLength(2);
  });

  it("deletes a note and removes it from the list", async () => {
    await renderTab();
    const del = vi
      .spyOn(adminApi, "deleteBookNote")
      .mockResolvedValue({ deleted: true, noteId: "n1" });

    const deleteButtons = [...container!.querySelectorAll("button")].filter((b) =>
      b.textContent?.includes("刪除")
    );
    await act(async () => {
      deleteButtons[0].click();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(del).toHaveBeenCalledWith("b1", "n1");
    expect(container!.textContent).not.toContain("Note A");
    expect(container!.textContent).toContain("Sketch");
  });
});
