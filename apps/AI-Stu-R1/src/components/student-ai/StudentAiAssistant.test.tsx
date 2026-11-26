// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const client = vi.hoisted(() => ({
  upsertLearningHistory: vi.fn(),
  listStudentNotes: vi.fn(),
  createStudentNote: vi.fn(),
  createNoteFromHistory: vi.fn(),
  updateStudentNote: vi.fn(),
  deleteStudentNote: vi.fn()
}));

const authState = vi.hoisted(() => ({
  status: "authenticated",
  profile: { displayName: "小明", profileCompleted: true } as unknown
}));

vi.mock("../../studentClient", () => ({
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
vi.mock("../../student-auth", () => ({
  useStudentAuth: () => authState
}));

import { DashboardShell } from "../dashboard/DashboardShell";
import { applyRelayIntake, StudentAiAssistant } from "./StudentAiAssistant";
import type { LearningHistoryEntry } from "../../learningHistory";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  authState.status = "authenticated";
  client.upsertLearningHistory.mockResolvedValue({ entries: [] });
  client.listStudentNotes.mockResolvedValue({ notes: [], nextOffset: null });
  client.deleteStudentNote.mockResolvedValue({ deleted: true });
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

function toMarkup(node: React.ReactNode): string {
  return renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);
}

function findButton(label: string, scope: ParentNode = document): HTMLButtonElement {
  const element = [...scope.querySelectorAll("button")].find((item) => item.textContent === label);
  if (!element) throw new Error(`button ${label} not found`);
  return element;
}

function setReactTextareaValue(element: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Channel B: a native paste carrying only a text/plain payload. */
async function pasteText(text: string): Promise<void> {
  const event = new Event("paste", { bubbles: true }) as ClipboardEvent;
  Object.defineProperty(event, "clipboardData", {
    value: { getData: (type: string) => (type === "text/plain" ? text : "") }
  });
  await act(async () => {
    window.dispatchEvent(event);
  });
}

function entry(overrides: Partial<LearningHistoryEntry> = {}): LearningHistoryEntry {
  return {
    id: "entry-1",
    askedAt: "2026-10-20T10:00:00.000Z",
    question: "什麼是重力加速度？",
    category: "auto",
    sourceType: "manual",
    strategy: "google-ai",
    syncVersion: 1,
    ...overrides
  };
}

const savedNote = {
  id: "note-1", studentId: "s1", entryId: "entry-1", bookId: "book-9",
  chapterId: null, pageNumber: null, type: "ai_answer" as const,
  title: "什麼是重力加速度？", content: "重力加速度約為 9.8 m/s²。",
  canvasData: null, tags: [] as string[], source: "google-ai-relay" as const,
  sourceDetail: null, createdAt: "", updatedAt: "", deletedAt: null, syncVersion: 1
};

const ANSWER_TEXT = "重力加速度約為 9.8 m/s²。";

async function askQuestion(): Promise<void> {
  const textarea = document.querySelector<HTMLTextAreaElement>('[data-testid="student-ai-question"]');
  expect(textarea).not.toBeNull();
  act(() => setReactTextareaValue(textarea as HTMLTextAreaElement, "什麼是重力加速度？"));
  await act(async () => {
    findButton("提問並開啟 Google 視窗").click();
  });
}

describe("authenticated dashboard (R23 F9/F10)", () => {
  it("hides the guest-remaining metric and shows the Google AI assistant + notes block", () => {
    const markup = toMarkup(
      <DashboardShell profile={{ name: "小明", points: null, authenticated: true }} />
    );
    expect(markup).toContain("已登入學員");
    expect(markup).toContain("Google AI 課業助教");
    expect(markup).toContain("我的課業筆記");
    expect(markup).not.toContain("訪客剩餘提問");
    // Phase 1: the unimplemented platform-API option must not be offered.
    expect(markup).not.toContain("平台 AI");
  });

  it("keeps the guest metric for unauthenticated profiles", () => {
    const markup = toMarkup(
      <DashboardShell profile={{ name: null, points: null, authenticated: false }} />
    );
    expect(markup).toContain("訪客剩餘提問");
  });

  it("surfaces a version conflict when the dashboard note was concurrently updated", async () => {
    client.listStudentNotes.mockResolvedValue({
      notes: [{
        id: "note-1", studentId: "s1", entryId: null, bookId: null, chapterId: null,
        pageNumber: null, type: "text", title: "手動", content: "內容", canvasData: null,
        tags: [], source: "manual", sourceDetail: null, createdAt: "", updatedAt: "",
        deletedAt: null, syncVersion: 5
      }],
      nextOffset: null
    });
    client.deleteStudentNote.mockResolvedValue({
      deleted: false,
      note: { syncVersion: 6, deletedAt: null }
    });
    mount(
      <MemoryRouter>
        <DashboardShell profile={{ name: "小明", points: null, authenticated: true }} />
      </MemoryRouter>
    );
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });
    await act(async () => {
      findButton("刪除").click();
    });
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    await act(async () => {
      findButton("確定", dialog as HTMLElement).click();
      await Promise.resolve();
      await Promise.resolve();
    });
    // The panel deletes with the version it rendered (5), not a hardcoded 1.
    expect(client.deleteStudentNote).toHaveBeenCalledWith("note-1", 5);
    // deleted=false -> explicit conflict message and a list reload.
    expect(document.querySelector('[data-testid="student-notes-section"]')?.textContent).toContain("版本衝突");
    expect(client.listStudentNotes).toHaveBeenCalledTimes(2);
  });
});

describe("StudentAiAssistant intake (relay channels, R23 CR fix 1)", () => {
  it("offers only the Google AI relay mode; no platform-API option anywhere", () => {
    mount(<StudentAiAssistant />);
    const html = document.body.innerHTML;
    expect(html).toContain("Google AI 課業助教");
    expect(html).not.toContain("平台 AI");
  });

  it("syncs the question with a positive-integer syncVersion and opens the relay modal", async () => {
    mount(<StudentAiAssistant />);
    await askQuestion();
    expect(client.upsertLearningHistory).toHaveBeenCalledTimes(1);
    const [batch] = client.upsertLearningHistory.mock.calls[0];
    expect(batch).toHaveLength(1);
    expect(batch[0]).toMatchObject({ question: "什麼是重力加速度？", strategy: "google-ai" });
    expect(Number.isInteger(batch[0].syncVersion)).toBe(true);
    expect(batch[0].syncVersion).toBeGreaterThanOrEqual(1);
    expect(document.body.innerHTML).toContain("Google AI 問答接力模擬器");
  });

  it("accepts a plain-text answer pasted into the modal even with no bound source", async () => {
    mount(<StudentAiAssistant />);
    await askQuestion();
    expect(document.querySelector('[data-testid="student-ai-answer"]')).toBeNull();
    await pasteText(ANSWER_TEXT);
    expect(document.querySelector('[data-testid="student-ai-answer"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="student-ai-answer"]')?.textContent).toContain(ANSWER_TEXT);
    // The answer revision is re-upserted with an incremented version.
    expect(client.upsertLearningHistory).toHaveBeenCalledTimes(2);
    const [secondBatch] = client.upsertLearningHistory.mock.calls[1];
    expect(secondBatch[0]).toMatchObject({ rawAnswer: ANSWER_TEXT, syncVersion: 2 });
    expect(findButton("存為課業筆記")).toBeTruthy();
  });

  it("completes the two-phase flow: bound source URL first, then the pure-text answer", async () => {
    const relayUrl = "https://www.google.com/search?udm=50&aep=11&hl=zh-TW&q=" + encodeURIComponent("什麼是重力加速度？");
    mount(<StudentAiAssistant />);
    await askQuestion();
    await pasteText(relayUrl);
    // Step 1: only the source is bound; the answer section stays empty.
    expect(document.querySelector('[data-testid="student-ai-answer"]')).toBeNull();
    expect(client.upsertLearningHistory).toHaveBeenCalledTimes(2);
    expect(client.upsertLearningHistory.mock.calls[1][0][0]).toMatchObject({ syncVersion: 2 });
    // Step 2: the plain-text answer is accepted on its own.
    await pasteText(ANSWER_TEXT);
    expect(document.querySelector('[data-testid="student-ai-answer"]')?.textContent).toContain(ANSWER_TEXT);
    expect(client.upsertLearningHistory).toHaveBeenCalledTimes(3);
    expect(client.upsertLearningHistory.mock.calls[2][0][0]).toMatchObject({ rawAnswer: ANSWER_TEXT, syncVersion: 3 });
    expect(findButton("存為課業筆記")).toBeTruthy();
  });

  it("ignores a paste that carries neither an answer nor a same-question URL", async () => {
    mount(<StudentAiAssistant />);
    await askQuestion();
    await pasteText("https://example.com/not-a-udm50-link");
    expect(document.querySelector('[data-testid="student-ai-answer"]')).toBeNull();
    expect(client.upsertLearningHistory).toHaveBeenCalledTimes(1);
  });
});

describe("StudentAiAssistant note conversion (R23 CR fix 2)", () => {
  it("transforms into a note only after the history upsert succeeded", async () => {
    client.createNoteFromHistory.mockResolvedValue({ note: savedNote });
    const onNoteSaved = vi.fn();
    mount(
      <StudentAiAssistant
        initialEntry={entry()}
        initialAnswer={ANSWER_TEXT}
        bookId="book-9"
        onNoteSaved={onNoteSaved}
      />
    );
    await act(async () => {
      findButton("存為課業筆記").click();
    });
    expect(client.createNoteFromHistory).toHaveBeenCalledWith({
      entryId: "entry-1",
      bookId: "book-9",
      chapterId: null,
      pageNumber: null
    });
    expect(client.createStudentNote).not.toHaveBeenCalled();
    expect(onNoteSaved).toHaveBeenCalledTimes(1);
    expect(document.body.innerHTML).toContain("已存為課業筆記");
  });

  it("explicitly reports a failed history sync and never silently rebuilds the note", async () => {
    // initialEntry lacks a server-confirmed version -> saving requires a sync;
    // the sync fails -> the save is gated with a visible, retryable error.
    client.upsertLearningHistory.mockRejectedValue(new Error("500"));
    mount(
      <StudentAiAssistant
        initialEntry={entry({ id: "entry-unsynced", syncVersion: undefined, rawAnswer: ANSWER_TEXT })}
        initialAnswer={ANSWER_TEXT}
      />
    );
    await act(async () => {
      findButton("存為課業筆記").click();
    });
    expect(client.createNoteFromHistory).not.toHaveBeenCalled();
    expect(client.createStudentNote).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="student-ai-note-error"]')?.textContent).toContain("無法轉存");
    // Retry path exists for the learner.
    expect(findButton("重試同步")).toBeTruthy();
  });

  it("retries a failed from-history call as the same contract (no manual-note fallback on 500)", async () => {
    client.createNoteFromHistory
      .mockRejectedValueOnce(new Error("503"))
      .mockResolvedValueOnce({ note: savedNote });
    mount(
      <StudentAiAssistant
        initialEntry={entry()}
        initialAnswer={ANSWER_TEXT}
      />
    );
    await act(async () => {
      findButton("存為課業筆記").click();
    });
    expect(client.createStudentNote).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="student-ai-note-error"]')?.textContent).toContain("存為筆記失敗");
    await act(async () => {
      findButton("存為課業筆記").click();
    });
    expect(client.createNoteFromHistory).toHaveBeenCalledTimes(2);
    expect(document.body.innerHTML).toContain("已存為課業筆記");
  });

  it("falls back to createStudentNote only for a genuinely missing history entry", async () => {
    // Server-confirmed entry version -> the gate is open, but the server has
    // since lost the entry: from-history answers 404 and the narrow fallback
    // runs (status is reported, never silent). A manual 500 keeps retrying.
    client.createNoteFromHistory.mockRejectedValue({ status: 404, code: "ENTRY_NOT_FOUND" });
    client.createStudentNote.mockResolvedValue({
      note: { ...savedNote, id: "note-2" }
    });
    mount(
      <StudentAiAssistant
        initialEntry={entry({ syncVersion: 2 })}
        initialAnswer={ANSWER_TEXT}
      />
    );
    await act(async () => {
      findButton("存為課業筆記").click();
    });
    expect(client.createStudentNote).toHaveBeenCalledTimes(1);
    expect(client.createStudentNote.mock.calls[0][0]).toMatchObject({
      type: "ai_answer",
      entryId: "entry-1",
      content: ANSWER_TEXT
    });
    expect(document.body.innerHTML).toContain("已存為課業筆記");
  });
});

describe("applyRelayIntake pure intake", () => {
  it("stores the raw answer for a pure-text payload without any URL", () => {
    const result = applyRelayIntake(entry(), ANSWER_TEXT, { explicitTargetEntry: true });
    expect(result.answer).toBe(ANSWER_TEXT);
    expect(result.entry.rawAnswer).toBe(ANSWER_TEXT);
    expect(result.entry.organizedAnswer).toBe(ANSWER_TEXT);
    expect(result.sourceUrlJustBound).toBe(false);
  });

  it("binds a same-question udm=50 URL without an answer", () => {
    const url = "https://www.google.com/search?udm=50&aep=11&hl=zh-TW&q=" + encodeURIComponent("什麼是重力加速度？");
    const result = applyRelayIntake(entry(), url, { explicitTargetEntry: true });
    expect(result.answer).toBeNull();
    expect(result.sourceUrlJustBound).toBe(true);
    expect(result.entry.sourceUrl).toBe(url);
  });

  it("keeps a previously bound source when the plain-text answer finally arrives", () => {
    const url = "https://www.google.com/search?udm=50&aep=11&hl=zh-TW&q=" + encodeURIComponent("什麼是重力加速度？");
    const afterUrl = applyRelayIntake(entry(), url, { explicitTargetEntry: true });
    const afterAnswer = applyRelayIntake(afterUrl.entry, ANSWER_TEXT, { explicitTargetEntry: true });
    expect(afterAnswer.answer).toBe(ANSWER_TEXT);
    expect(afterAnswer.entry.sourceUrl).toBe(url);
    expect(afterAnswer.entry.rawAnswer).toBe(ANSWER_TEXT);
  });
});
