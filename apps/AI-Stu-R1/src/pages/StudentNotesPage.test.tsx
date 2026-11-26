// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StudentNote } from "@ai-smartbook/schema";

const client = vi.hoisted(() => ({
  listStudentNotes: vi.fn(),
  updateStudentNote: vi.fn(),
  deleteStudentNote: vi.fn(),
  createStudentNote: vi.fn(),
  createNoteFromHistory: vi.fn(),
  upsertLearningHistory: vi.fn(),
  askStudentAi: vi.fn()
}));

vi.mock("../studentClient", () => ({
  studentClient: client,
  StudentApiError: class MockStudentApiError extends Error {
    constructor(
      public status: number,
      public code: string,
      message: string
    ) {
      super(message);
      this.name = "StudentApiError";
    }
  }
}));

import { StudentNotesPage } from "./StudentNotesPage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function note(overrides: Partial<StudentNote>): StudentNote {
  return {
    id: "note-1", studentId: "s1", entryId: null, bookId: null, chapterId: null,
    pageNumber: null, type: "text", title: "重力筆記", content: "g = 9.8 m/s²",
    canvasData: null, tags: ["物理", "公式"], source: "manual", sourceDetail: null,
    createdAt: "2026-11-01T08:00:00.000Z", updatedAt: "2026-11-01T08:00:00.000Z",
    deletedAt: null, syncVersion: 3,
    ...overrides
  };
}

const fixtureNotes: StudentNote[] = [
  note({}),
  note({ id: "note-2", title: "數學錯題", content: "畢氏定理：a² + b² = c²", tags: ["數學"], syncVersion: 1 })
];

beforeEach(() => {
  vi.clearAllMocks();
  client.listStudentNotes.mockResolvedValue({ notes: fixtureNotes, nextOffset: null });
  client.updateStudentNote.mockImplementation((_id: string, input: { title?: string; content?: string; tags?: string[] }) =>
    Promise.resolve({ note: note({ title: input.title, content: input.content, tags: input.tags }) }));
  client.deleteStudentNote.mockResolvedValue({ deleted: true, note: fixtureNotes[0] });
  client.upsertLearningHistory.mockResolvedValue({ entries: [] });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.innerHTML = "";
});

function mount(node: React.ReactNode): HTMLDivElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container as HTMLElement);
    root?.render(node);
  });
  return container;
}

async function flush(times = 3): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await act(async () => { await Promise.resolve(); });
  }
}

function findButton(label: string, scope: ParentNode = document): HTMLButtonElement {
  const element = [...scope.querySelectorAll("button")].find((item) => item.textContent === label);
  if (!element) throw new Error(`button ${label} not found`);
  return element;
}

function setReactInputValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("StudentNotesPage (/notes, R24)", () => {
  it("renders every personal note as plain text", async () => {
    mount(<StudentNotesPage />);
    await flush();
    expect(client.listStudentNotes).toHaveBeenCalled();
    const items = [...document.querySelectorAll('[data-testid="student-notes-item"]')];
    expect(items).toHaveLength(2);
    expect(document.body.innerHTML).toContain("重力筆記");
    expect(document.body.innerHTML).toContain("畢氏定理：a² + b² = c²");
  });

  it("filters by a tag chip and resets with the 全部 chip", async () => {
    mount(<StudentNotesPage />);
    await flush();
    const callsAfterMount = client.listStudentNotes.mock.calls.length;
    client.listStudentNotes.mockResolvedValue({ notes: [fixtureNotes[0]], nextOffset: null });
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="notes-tag-chip-物理"]')?.click();
    });
    await flush();
    expect(client.listStudentNotes.mock.calls[callsAfterMount]?.[0]).toMatchObject({ tag: "物理" });
    // 全部 resets the tag filter.
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="notes-tag-all"]')?.click();
    });
    await flush();
    const lastCall = client.listStudentNotes.mock.calls.at(-1);
    expect(lastCall?.[0]?.tag).toBeUndefined();
  });

  it("sends the keyword search as the q parameter", async () => {
    mount(<StudentNotesPage />);
    await flush();
    const input = document.querySelector<HTMLInputElement>('[data-testid="notes-search-input"]');
    expect(input).not.toBeNull();
    act(() => setReactInputValue(input as HTMLInputElement, "畢氏"));
    client.listStudentNotes.mockResolvedValue({ notes: [fixtureNotes[1]], nextOffset: null });
    await act(async () => {
      findButton("搜尋").click();
    });
    await flush();
    const lastCall = client.listStudentNotes.mock.calls.at(-1);
    expect(lastCall?.[0]).toMatchObject({ q: "畢氏" });
    expect(document.body.innerHTML).toContain("數學錯題");
  });

  it("edits title, content and comma-separated tags inline via updateStudentNote", async () => {
    mount(<StudentNotesPage />);
    await flush();
    await act(async () => {
      findButton("編輯", document.querySelector('[data-testid="student-notes-item"]') as HTMLElement).click();
    });
    const title = document.querySelector<HTMLInputElement>('[data-testid="notes-edit-title"]');
    const content = document.querySelector<HTMLTextAreaElement>('[data-testid="notes-edit-content"]');
    const tags = document.querySelector<HTMLInputElement>('[data-testid="notes-edit-tags"]');
    expect(title).not.toBeNull();
    expect((title as HTMLInputElement).value).toBe("重力筆記");
    expect((content as HTMLTextAreaElement).value).toBe("g = 9.8 m/s²");
    expect((tags as HTMLInputElement).value).toBe("物理,公式");
    act(() => setReactInputValue(title as HTMLInputElement, "重力筆記 v2"));
    act(() => setReactInputValue(content as HTMLTextAreaElement, "g = 9.81 m/s²"));
    act(() => setReactInputValue(tags as HTMLInputElement, "物理, 新標籤, ,"));
    await act(async () => {
      findButton("儲存").click();
    });
    await flush();
    expect(client.updateStudentNote).toHaveBeenCalledWith("note-1", {
      title: "重力筆記 v2",
      content: "g = 9.81 m/s²",
      tags: ["物理", "新標籤"]
    });
  });

  it("deletes with the note's actual syncVersion after confirmation", async () => {
    mount(<StudentNotesPage />);
    await flush();
    await act(async () => {
      findButton("刪除", document.querySelector('[data-testid="student-notes-item"]') as HTMLElement).click();
    });
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog).not.toBeNull();
    await act(async () => {
      findButton("確定", dialog as HTMLElement).click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await flush();
    // The page sends the version it rendered (3), never a hardcoded 1.
    expect(client.deleteStudentNote).toHaveBeenCalledWith("note-1", 3);
  });

  it("surfaces a version conflict when delete answers deleted=false", async () => {
    client.deleteStudentNote.mockResolvedValue({ deleted: false, note: note({ syncVersion: 4 }) });
    mount(<StudentNotesPage />);
    await flush();
    await act(async () => {
      findButton("刪除", document.querySelector('[data-testid="student-notes-item"]') as HTMLElement).click();
    });
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    await act(async () => {
      findButton("確定", dialog as HTMLElement).click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await flush();
    expect(document.body.innerHTML).toContain("版本衝突");
    expect(client.listStudentNotes.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("prefills the assistant with the note summary via 針對此筆記追問", async () => {
    mount(<StudentNotesPage />);
    await flush();
    await act(async () => {
      findButton("針對此筆記追問", document.querySelector('[data-testid="student-notes-item"]') as HTMLElement).click();
    });
    const panel = document.querySelector('[data-testid="student-notes-ask-panel"]');
    expect(panel).not.toBeNull();
    const textarea = panel?.querySelector<HTMLTextAreaElement>('[data-testid="student-ai-question"]');
    expect(textarea?.value).toContain("重力筆記");
    expect(textarea?.value).toContain("g = 9.8");
    await act(async () => {
      findButton("提問並開啟 Google 視窗").click();
    });
    await flush();
    expect(client.upsertLearningHistory).toHaveBeenCalledTimes(1);
    const [batch] = client.upsertLearningHistory.mock.calls[0];
    expect(batch[0].question).toContain("重力筆記");
    expect(Number.isInteger(batch[0].syncVersion)).toBe(true);
    expect(batch[0].syncVersion).toBeGreaterThanOrEqual(1);
  });

  it("shows an explicit error when the list fails to load", async () => {
    client.listStudentNotes.mockRejectedValue(new Error("503 Service Unavailable"));
    mount(<StudentNotesPage />);
    await flush();
    expect(document.body.innerHTML).toContain("503 Service Unavailable");
    // The empty state must not masquerade as success.
    expect(document.querySelector('[data-testid="student-notes-empty"]')).toBeNull();
  });

  it("shows the filtered empty state when no note matches the search", async () => {
    client.listStudentNotes.mockResolvedValue({ notes: [], nextOffset: null });
    mount(<StudentNotesPage />);
    await flush();
    const input = document.querySelector<HTMLInputElement>('[data-testid="notes-search-input"]');
    act(() => setReactInputValue(input as HTMLInputElement, "不存在的關鍵字"));
    await act(async () => {
      findButton("搜尋").click();
    });
    await flush();
    expect(document.querySelector('[data-testid="student-notes-empty"]')?.textContent).toContain("沒有符合篩選條件的筆記");
  });
});
