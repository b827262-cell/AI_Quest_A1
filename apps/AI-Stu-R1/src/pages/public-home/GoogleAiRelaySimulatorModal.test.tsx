import { MemoryRouter } from "react-router-dom";
// @vitest-environment happy-dom
// R16-T4: Google AI relay simulator tests — permissionless paste (plain+html),
// XSS-safe HTML parsing, drag & drop, focus auto-read, URL-only two-phase,
// question locking with conflicting-URL protection, and desktop popup wiring.
import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyRelayPayload,
  extractRelayAnswerFromHtml,
  GOOGLE_RELAY_WINDOW_NAME,
  GoogleAiRelaySimulatorModal,
  googleRelayPopupFeatures,
  shouldIgnoreClipboardForFocus
} from "./GoogleAiRelaySimulatorModal";
import {
  addLearningHistoryEntry,
  googleAiSearchUrl,
  readLearningHistory,
  updateLearningHistoryContent,
  type LearningHistoryEntry
} from "../../learningHistory";
import { useGuestQuestion } from "./useGuestQuestion";
import { useShareIntake } from "./useShareIntake";
import { DEFAULT_CONFIG } from "./constants";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  localStorage.clear();
  vi.restoreAllMocks();
  window.open = originalOpen;
});

const originalOpen = window.open;

function render(node: ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  return act(async () => { root?.render(node); });
}

function flushMicrotasks() {
  return act(async () => { await Promise.resolve(); });
}

function stubWindowOpen() {
  const open = vi.fn((...args: unknown[]) => null);
  window.open = open as unknown as typeof window.open;
  return open;
}

function pasteEvent(plain: string, html = ""): ClipboardEvent {
  const event = new Event("paste") as ClipboardEvent;
  const data = {
    getData: (type: string) => {
      if (type === "text/plain") return plain;
      if (type === "text/html") return html;
      return "";
    }
  };
  Object.defineProperty(event, "clipboardData", { value: data });
  return event;
}

const QUESTION = "什麼是光合作用？";
const ANSWER = "光合作用分成光反應與碳反應，在葉綠體中把光能轉成化學能。";

function makeEntry(overrides: Partial<LearningHistoryEntry> = {}): LearningHistoryEntry {
  const entries = addLearningHistoryEntry({ question: QUESTION, category: "auto", sourceType: "manual", strategy: "google-ai" });
  return { ...entries.entry, ...overrides };
}

async function renderModal(entry: LearningHistoryEntry, onIntake = vi.fn((..._args: unknown[]) => ({ saved: true })), onClose = vi.fn()) {
  const open = stubWindowOpen();
  await render(
    <GoogleAiRelaySimulatorModal
      entry={entry}
      url={googleAiSearchUrl(QUESTION)}
      onClose={onClose}
      onIntake={onIntake as never}
    />
  );
  return { onIntake, onClose, open };
}

/**
 * F2 integration harness: the modal is wired to a REAL useShareIntake()
 * acceptIncomingAnswer, so the relay's step-1 state reflects the actual
 * localStorage storage outcome rather than a vi.fn() stub.
 */
function IntakeHarness({ entry }: { entry: LearningHistoryEntry }) {
  const [, setEntries] = useState<LearningHistoryEntry[]>([]);
  const intake = useShareIntake(setEntries);
  return (
    <GoogleAiRelaySimulatorModal
      entry={entry}
      url={googleAiSearchUrl(entry.question)}
      onClose={() => undefined}
      onIntake={intake.acceptIncomingAnswer}
    />
  );
}

describe("extractRelayAnswerFromHtml (XSS-safe)", () => {
  it("reduces html to textContent and never runs script/onerror handlers", () => {
    const html = `<div><p>${ANSWER}</p><a href="https://www.google.com/search?udm=50&q=${encodeURIComponent(QUESTION)}">來源</a><script>window.__relay_pwned = true;</script><img src="x" onerror="window.__relay_pwned = true"><style>.a{}</style></div>`;
    const parsed = extractRelayAnswerFromHtml(html);
    expect(parsed.text).toBe(ANSWER);
    expect(parsed.sourceUrl).toContain("udm=50");
    expect(parsed.text.includes("__relay_pwned")).toBe(false);
    expect((window as unknown as { __relay_pwned?: boolean }).__relay_pwned).toBeUndefined();
  });
});

describe("classifyRelayPayload (locking + conflict protection)", () => {
  it("binds same-question URLs and answers; blocks conflicting-question URLs", () => {
    const sameUrl = classifyRelayPayload(googleAiSearchUrl(QUESTION), QUESTION);
    expect(sameUrl.kind).toBe("same-question-url");

    const answer = classifyRelayPayload(`${ANSWER} ${googleAiSearchUrl(QUESTION)}`, QUESTION);
    expect(answer.kind).toBe("answer");
    expect((answer as { rawAnswer: string }).rawAnswer).toBe(ANSWER);

    const conflictText = classifyRelayPayload(
      `${ANSWER} https://www.google.com/search?udm=50&q=${encodeURIComponent("完全不同的另一題怎麼解？")}`,
      QUESTION
    );
    expect(conflictText.kind).toBe("conflicting-url");

    const conflictUrl = classifyRelayPayload(
      `https://www.google.com/search?udm=50&q=${encodeURIComponent("另一題？")}`,
      QUESTION
    );
    expect(conflictUrl.kind).toBe("conflicting-url");

    const plainUrl = classifyRelayPayload("https://example.com/page", QUESTION);
    expect(plainUrl.kind).toBe("non-google-url");
  });
});

describe("GoogleAiRelaySimulatorModal", () => {
  it("channel B: permissionless global paste parses text/plain and text/html together", async () => {
    const entry = makeEntry();
    const { onIntake } = await renderModal(entry);
    const readText = vi.fn();
    Object.defineProperty(navigator, "clipboard", { value: { readText }, configurable: true });
    const readTextSpy = readText as ReturnType<typeof vi.fn>;

    const html = `<div><p>${ANSWER}</p><a href="https://www.google.com/search?udm=50&q=${encodeURIComponent(QUESTION)}">來源</a></div>`;
    await act(async () => { window.dispatchEvent(pasteEvent(`${ANSWER}\nhttps://www.google.com/search?udm=50&q=${encodeURIComponent(QUESTION)}`, html)); });

    expect(onIntake).toHaveBeenCalledOnce();
    const [rawAnswer, , options] = onIntake.mock.calls[0] as [string, LearningHistoryEntry, { explicitTargetEntry?: boolean; sharedUrl?: unknown }];
    expect(rawAnswer).toBe(ANSWER);
    expect(options.explicitTargetEntry).toBe(true);
    expect(String(options.sharedUrl)).toContain("udm=50");
    expect(container?.textContent).toContain("已收到回答");
    // channel B must not depend on the clipboard-read permission
    expect(readTextSpy).not.toHaveBeenCalled();
  });

  it("channel C: cross-window drop with plain+html intake", async () => {
    const entry = makeEntry();
    const { onIntake } = await renderModal(entry);
    const drop = new Event("drop", { bubbles: true, cancelable: true }) as unknown as DragEvent;
    const data = {
      getData: (type: string) => (type === "text/plain" ? ANSWER : ""),
      files: [],
      items: []
    };
    Object.defineProperty(drop, "dataTransfer", { value: data });
    Object.defineProperty(drop, "preventDefault", { value: () => undefined });
    await act(async () => { container?.querySelector(".google-relay-modal")?.dispatchEvent(drop); });
    expect(onIntake).toHaveBeenCalledOnce();
    expect((onIntake.mock.calls[0] as unknown[])[0]).toBe(ANSWER);
  });

  it("channel A: window focus auto-reads clipboard; failures degrade silently", async () => {
    const entry = makeEntry();
    const { onIntake } = await renderModal(entry);

    // happy path: readable, non-empty, not the old question → zero-key intake
    const readText = vi.fn().mockResolvedValue(ANSWER);
    Object.defineProperty(navigator, "clipboard", { value: { readText }, configurable: true });
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await flushMicrotasks();
    expect(onIntake).toHaveBeenCalledOnce();
    expect((onIntake.mock.calls[0] as unknown[])[0]).toBe(ANSWER);

    // failure: rejected read must degrade silently (same intake count, no throw)
    Object.defineProperty(navigator, "clipboard", {
      value: { readText: vi.fn().mockRejectedValue(new DOMException("denied", "NotAllowedError")) },
      configurable: true
    });
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await flushMicrotasks();
    expect(onIntake).toHaveBeenCalledOnce();
    expect(container?.textContent).not.toContain("無法讀取剪貼簿");
  });

  it("channel A F1: clipboard still holding the current question text is silently ignored", async () => {
    const entry = makeEntry();
    const { onIntake } = await renderModal(entry);
    // both the literal question text and a punctuation/spacing variant
    Object.defineProperty(navigator, "clipboard", { value: { readText: vi.fn().mockResolvedValue(QUESTION) }, configurable: true });
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await flushMicrotasks();
    expect(onIntake).not.toHaveBeenCalled();
    expect(container?.querySelector(".google-relay-status")).toBeNull();

    // pure-function surface shared with the channel: normalized question
    // variants are caught even before the trim/round-trips differ
    expect(shouldIgnoreClipboardForFocus("什麼是 光合作用 ？！", QUESTION, null)).toBe(true);
    expect(shouldIgnoreClipboardForFocus(QUESTION.toUpperCase(), QUESTION, null)).toBe(true);
    expect(shouldIgnoreClipboardForFocus(ANSWER, QUESTION, null)).toBe(false);
    expect(shouldIgnoreClipboardForFocus("   ", QUESTION, null)).toBe(true);
  });

  it("channel A F1: stale clipboard identical to the modal-open snapshot is ignored; a genuinely new answer is imported", async () => {
    const entry = makeEntry();
    const stale = "上一次關閉視窗前殘留的舊剪貼簿文字";
    // the clipboard already holds the stale text BEFORE the modal opens
    Object.defineProperty(navigator, "clipboard", { value: { readText: vi.fn().mockResolvedValue(stale) }, configurable: true });
    const { onIntake } = await renderModal(entry);
    await flushMicrotasks(); // let the modal-open snapshot land

    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await flushMicrotasks();
    expect(onIntake).not.toHaveBeenCalled();
    expect(container?.querySelector(".google-relay-status")).toBeNull();

    // the learner copies a fresh answer from the Google window → imported
    Object.defineProperty(navigator, "clipboard", { value: { readText: vi.fn().mockResolvedValue(ANSWER) }, configurable: true });
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await flushMicrotasks();
    expect(onIntake).toHaveBeenCalledOnce();
    expect((onIntake.mock.calls[0] as unknown[])[0]).toBe(ANSWER);
  });

  it("channel D: URL-only first paste saves the source and asks for the answer next", async () => {
    const entry = makeEntry();
    const { onIntake } = await renderModal(entry);
    const url = googleAiSearchUrl(QUESTION);

    await act(async () => { window.dispatchEvent(pasteEvent(url)); });
    expect(onIntake).toHaveBeenCalledOnce();
    const [rawAnswer] = onIntake.mock.calls[0] as [string];
    expect(rawAnswer).toBe(url);
    expect(container?.textContent).toContain("第 1 步");
    // modal stays open for the second segment
    await act(async () => { window.dispatchEvent(pasteEvent(ANSWER)); });
    expect(onIntake).toHaveBeenCalledTimes(2);
    expect((onIntake.mock.calls[1] as unknown[])[0]).toBe(ANSWER);
    expect(container?.textContent).toContain("完成並關閉");
  });

  it("F2 (integration): step-1 success reflects acceptIncomingAnswer's real saved result", async () => {
    // real intake pipeline — no vi.fn() standing in for onIntake here
    const record = addLearningHistoryEntry({ question: QUESTION, category: "auto", sourceType: "manual", strategy: "google-ai" });
    stubWindowOpen();
    await render(<IntakeHarness entry={record.entry} />);
    await act(async () => { window.dispatchEvent(pasteEvent(googleAiSearchUrl(QUESTION))); });
    expect(container?.querySelector(".google-relay-status")?.textContent).toContain("第 1 步完成");
    expect(readLearningHistory().some((e) => e.id === record.entry.id && e.sourceUrl?.includes("udm=50"))).toBe(true);
  });

  it("F2 (integration): no false step-1 success when acceptIncomingAnswer does not store the source URL", async () => {
    // two same-question google-ai entries, both already holding rawAnswer and
    // sourceUrl → findGoogleAiSourceEntry returns null → nothing is stored
    const first = addLearningHistoryEntry({ question: QUESTION, category: "auto", sourceType: "manual", strategy: "google-ai" });
    const second = addLearningHistoryEntry({ question: QUESTION, category: "auto", sourceType: "manual", strategy: "google-ai" });
    const url = googleAiSearchUrl(QUESTION);
    updateLearningHistoryContent(first.entry.id, { rawAnswer: ANSWER, sourceUrl: url });
    updateLearningHistoryContent(second.entry.id, { rawAnswer: `${ANSWER}（第二次）`, sourceUrl: url });
    const boundFirst = readLearningHistory().find((e) => e.id === first.entry.id)!;
    expect(boundFirst.rawAnswer).toBe(ANSWER);
    expect(boundFirst.sourceUrl).toContain("udm=50");

    stubWindowOpen();
    await render(<IntakeHarness entry={boundFirst} />);
    await act(async () => { window.dispatchEvent(pasteEvent(url)); });
    const status = container?.querySelector(".google-relay-status")?.textContent ?? "";
    expect(status).not.toContain("第 1 步完成");
    expect(status).toContain("第 1 步未完成");
    // nothing was overwritten: the two pre-bound entries keep their own
    // rawAnswer evidence and the single stored sourceUrl
    const bound = readLearningHistory().filter((e) => e.question === QUESTION);
    expect(bound).toHaveLength(2);
    expect(new Set(bound.map((e) => e.rawAnswer))).toEqual(new Set([ANSWER, `${ANSWER}（第二次）`]));
    expect(bound.every((e) => e.sourceUrl?.includes("udm=50"))).toBe(true);
  });

  it("locks the active question and protects conflicting-question URLs from binding", async () => {
    const entry = makeEntry();
    const { onIntake } = await renderModal(entry);

    expect(container?.textContent).toContain(QUESTION);
    const conflictingUrl = `https://www.google.com/search?udm=50&q=${encodeURIComponent("一題完全不同的化學計算？")}`;
    await act(async () => { window.dispatchEvent(pasteEvent(`${ANSWER} ${conflictingUrl}`)); });
    expect(onIntake).not.toHaveBeenCalled();
    expect(container?.textContent).toContain("保護規則");

    // same-question URL is allowed as the phase-1 source binding
    await act(async () => { window.dispatchEvent(pasteEvent(googleAiSearchUrl(QUESTION))); });
    expect(onIntake).toHaveBeenCalledOnce();
  });

  it("reopen button reuses the named relay popup window with desktop geometry", async () => {
    const entry = makeEntry();
    const { open } = await renderModal(entry);
    open.mockClear();
    const reopen = Array.from(container?.querySelectorAll("button") ?? []).find((b) => b.textContent?.includes("重新開啟 Google 視窗"));
    await act(async () => { reopen?.click(); });
    expect(open).toHaveBeenCalledOnce();
    expect(open.mock.calls[0][0]).toBe(googleAiSearchUrl(QUESTION));
    expect(open.mock.calls[0][1]).toBe(GOOGLE_RELAY_WINDOW_NAME);
    expect(String(open.mock.calls[0][2])).toContain("popup=yes");
    expect(String(open.mock.calls[0][2])).toContain("width=900");
  });
});

describe("desktop relay wiring in useGuestQuestion", () => {
  function matchMediaStub(wide: boolean) {
    return vi.fn().mockImplementation((query: string) => ({ matches: query.includes("min-width") ? wide : false, query, addEventListener: () => undefined, removeEventListener: () => undefined, addListener: () => undefined, removeListener: () => undefined, onchange: null, dispatchEvent: () => false }));
  }

  it("desktop submit opens the side-by-side popup and arms the relay modal", async () => {
    const open = stubWindowOpen();
    window.matchMedia = matchMediaStub(true) as unknown as typeof window.matchMedia;
    function Harness() {
      const guest = useGuestQuestion({ config: DEFAULT_CONFIG, setLearningHistory: () => undefined, setGoogleStatus: () => undefined });
      const relay = guest.activeRelay;
      return (<>
        <button onClick={() => guest.setQuestion(QUESTION)}>輸入</button>
        <button onClick={() => guest.submitGoogleAiQuestion("manual")}>送出</button>
        {relay ? <p data-testid="relay-armed">{relay.entry.question}</p> : null}
      </>);
    }
    await render(<MemoryRouter><Harness /></MemoryRouter>);
    await act(async () => { container!.querySelectorAll("button")[0].click(); });
    await act(async () => { container!.querySelectorAll("button")[1].click(); });
    expect(open).toHaveBeenCalledOnce();
    expect(open.mock.calls[0][0]).toBe(googleAiSearchUrl(QUESTION));
    expect(open.mock.calls[0][1]).toBe(GOOGLE_RELAY_WINDOW_NAME);
    expect(String(open.mock.calls[0][2])).toContain("popup=yes");
    expect(container?.querySelector('[data-testid="relay-armed"]')?.textContent).toBe(QUESTION);
    // the entry was recorded as a pending google-ai question
    expect(readLearningHistory().some((e) => e.strategy === "google-ai" && e.question === QUESTION)).toBe(true);
  });

  it("non-desktop submit keeps the original new-tab behaviour", async () => {
    const open = stubWindowOpen();
    window.matchMedia = matchMediaStub(false) as unknown as typeof window.matchMedia;
    function Harness() {
      const guest = useGuestQuestion({ config: DEFAULT_CONFIG, setLearningHistory: () => undefined, setGoogleStatus: () => undefined });
      return (<>
        <button onClick={() => guest.setQuestion(QUESTION)}>輸入</button>
        <button onClick={() => guest.submitGoogleAiQuestion("manual")}>送出</button>
        {guest.activeRelay ? <p>relay</p> : null}
      </>);
    }
    await render(<MemoryRouter><Harness /></MemoryRouter>);
    await act(async () => { container!.querySelectorAll("button")[0].click(); });
    await act(async () => { container!.querySelectorAll("button")[1].click(); });
    expect(open).toHaveBeenCalledWith(googleAiSearchUrl(QUESTION), "_blank", "noopener,noreferrer");
    expect(container?.textContent ?? "").not.toContain("relay");
  });
});
