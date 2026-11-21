// R16-T4: Google AI relay simulator modal (Windows side-by-side workbench).
// Left window (this app) hosts the modal; the right window is a controlled
// Google AI popup — never an iframe (Google forbids framing). Four intake
// channels: A) focus/visibility clipboard auto-read, B) permissionless global
// paste, C) cross-window drag & drop, D) URL-only two-phase relay.
//
// XSS boundary (reviewed line-by-line): text/html payloads are parsed with
// DOMParser and reduced to `textContent` plus href attribute values. No
// innerHTML assignment, no document.write, no eval, no
// dangerouslySetInnerHTML anywhere; external URLs are only ever used as a
// saved sourceUrl or an <a href> validated by parseGoogleAiSourceUrl
// (https + www.google.com + /search + udm=50).
import { useCallback, useEffect, useRef, useState } from "react";
import {
  extractGoogleAiSourceUrl,
  extractSharedAnswerText,
  isUrlOnlyText,
  normalizeQuestion,
  parseGoogleAiSourceUrl,
  unwrapSharedUrl,
  type LearningHistoryEntry
} from "../../learningHistory";
import type { AnswerIntakeOptions, ShareIntakeResult } from "./useShareIntake";

/** Named target so a reopened window reuses the same popup instead of stacking tabs. */
export const GOOGLE_RELAY_WINDOW_NAME = "ai_smartbook_google_relay";

/** Desktop side-by-side geometry: right-hand popup, roughly 900x820. */
export function googleRelayPopupFeatures(width = 900, height = 820): string {
  const bounds = typeof window === "undefined" ? { innerWidth: 1280, innerHeight: 800 } : window;
  const left = Math.max(0, Math.floor(bounds.innerWidth) - width - 16);
  const top = Math.max(0, Math.floor(bounds.innerHeight) - height - 16);
  return `popup=yes,width=${width},height=${height},left=${left},top=${top},noopener`;
}

/**
 * Single shared clipboard-read helper for the guest surface. Every caller
 * (the explicit「從剪貼簿帶回回答」button and the relay modal's
 * focus/visibility auto-sense) goes through readClipboardText(); nothing in
 * public-home reads the clipboard on page load.
 */
export async function readClipboardText(): Promise<string | null> {
  try {
    const read = navigator.clipboard?.readText;
    if (typeof read !== "function") return null;
    const text = await read.call(navigator.clipboard);
    return typeof text === "string" ? text : null;
  } catch {
    return null;
  }
}

/**
 * Relay mode is meant for Windows/macOS desktop browsers: a wide viewport with
 * a fine pointer. Coarse-pointer or narrow screens keep the original
 * open-in-new-tab behaviour.
 */
export function isDesktopRelayEnvironment(width = 1024): boolean {
  try {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
    if (!window.matchMedia(`(min-width: ${width}px)`).matches) return false;
    return !window.matchMedia("(pointer: coarse)").matches;
  } catch {
    return false;
  }
}

/**
 * Reduce a text/html clipboard/drag payload to safe pieces: plain text
 * (textContent only, scripts/styles stripped) and a validated Google AI Mode
 * source URL taken from anchor hrefs, then a content-URL regex fallback.
 * The raw HTML is never injected into the DOM.
 */
export function extractRelayAnswerFromHtml(html: string): { text: string; sourceUrl: string | null } {
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    let sourceUrl: string | null = null;
    for (const anchor of Array.from(doc.querySelectorAll("a[href]"))) {
      const parsed = parseGoogleAiSourceUrl(anchor.getAttribute("href") ?? "");
      if (parsed) {
        sourceUrl = parsed.sourceUrl;
        break;
      }
    }
    // Anchors are navigation aids; the answer prose stays, link markup goes.
    doc.querySelectorAll("script, style, noscript, iframe, object, embed, a[href]").forEach((node) => node.remove());
    if (!sourceUrl) {
      const candidates = html.match(/https:\/\/www\.google\.com\/search\?[^"'\s<>]+/giu) ?? [];
      for (const candidate of candidates) {
        const parsed = parseGoogleAiSourceUrl(candidate);
        if (parsed) {
          sourceUrl = parsed.sourceUrl;
          break;
        }
      }
    }
    const text = (doc.body?.textContent ?? "").replace(/\s+/g, " ").trim();
    return { text, sourceUrl };
  } catch {
    return { text: "", sourceUrl: null };
  }
}

export type RelayPayloadDecision =
  | { kind: "empty" }
  | { kind: "same-question-url"; sourceUrl: string }
  | { kind: "conflicting-url"; sourceUrl: string }
  | { kind: "non-google-url"; sourceUrl: string }
  | { kind: "answer"; rawAnswer: string; sourceUrl: string | null };

/**
 * Classify one paste/drop/clipboard payload against the locked question.
 * The locked entry binds directly (the 67% token gate is waived by the
 * caller), but a `udm=50` URL naming a different question is still protected
 * against before any binding.
 */
export function classifyRelayPayload(text: string, entryQuestion: string): RelayPayloadDecision {
  const trimmed = text.trim();
  if (!trimmed) return { kind: "empty" };
  const direct = parseGoogleAiSourceUrl(trimmed) ?? parseGoogleAiSourceUrl(unwrapSharedUrl(trimmed));
  if (direct) {
    return normalizeQuestion(direct.question) === normalizeQuestion(entryQuestion)
      ? { kind: "same-question-url", sourceUrl: direct.sourceUrl }
      : { kind: "conflicting-url", sourceUrl: direct.sourceUrl };
  }
  if (isUrlOnlyText(trimmed)) return { kind: "non-google-url", sourceUrl: unwrapSharedUrl(trimmed) };
  const source = extractGoogleAiSourceUrl(trimmed);
  if (source && normalizeQuestion(source.question) !== normalizeQuestion(entryQuestion)) {
    return { kind: "conflicting-url", sourceUrl: source.sourceUrl };
  }
  const extraction = extractSharedAnswerText(trimmed);
  if (extraction.status !== "accepted") return { kind: "empty" };
  return { kind: "answer", rawAnswer: extraction.rawAnswer, sourceUrl: source?.sourceUrl ?? null };
}

/**
 * Channel A guard (R16-T3 F1). A focus/visibility-triggered clipboard read
 * must never absorb prose that is not a fresh answer. Ignore, silently:
 * - empty text;
 * - text whose question-surface equals the locked entry's question
 *   (normalizeQuestion on both sides — punctuation/width/case variants match);
 * - text identical to the clipboard snapshot taken when the modal opened
 *   (the learner did not copy a new answer since opening the relay).
 * Pure and exported so the channel and the tests share one implementation.
 */
export function shouldIgnoreClipboardForFocus(text: string, entryQuestion: string, clipboardAtOpen: string | null): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  const normalizedClipboard = normalizeQuestion(trimmed);
  if (normalizedClipboard && normalizedClipboard === normalizeQuestion(entryQuestion)) return true;
  const baseline = clipboardAtOpen?.trim();
  return Boolean(baseline) && trimmed === baseline;
}

export function GoogleAiRelaySimulatorModal({
  entry,
  url,
  onClose,
  onIntake
}: {
  entry: LearningHistoryEntry;
  url: string;
  onClose: () => void;
  /** R17-T4 (F2): returns acceptIncomingAnswer's real outcome so the step-1 UI state follows what was actually stored. */
  onIntake: (rawAnswer: string, entry: LearningHistoryEntry, options: AnswerIntakeOptions) => ShareIntakeResult | void;
}) {
  const [status, setStatus] = useState("");
  const [state, setState] = useState<"idle" | "await-answer" | "conflict" | "imported">("idle");
  const [dragging, setDragging] = useState(false);
  const handledRef = useRef<Set<string>>(new Set());
  const clipboardAtOpenRef = useRef<string | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const openRelayPopup = useCallback(() => {
    window.open(url, GOOGLE_RELAY_WINDOW_NAME, googleRelayPopupFeatures());
  }, [url]);

  /**
   * Core sink for every channel. Returns true when the payload was
   * recognized (including protected/phase-1 outcomes); unknown blanks are
   * ignored so focus-triggered reads degrade silently.
   */
  const absorb = useCallback((text: string, sourceUrlHint?: string | null): boolean => {
    const trimmed = text.trim();
    if (!trimmed || handledRef.current.has(trimmed)) return false;
    handledRef.current.add(trimmed);
    const decision = classifyRelayPayload(trimmed, entry.question);
    if (decision.kind === "empty") return false;
    if (decision.kind === "conflicting-url") {
      setState("conflict");
      setStatus("此內容帶有另一題的 udm=50 網址（與目前題目不符），依保護規則不會匯入；請確認後重新複製正確的回答。");
      return true;
    }
    if (decision.kind === "non-google-url") {
      setState("conflict");
      setStatus("這個內容只是網址且不是 Google AI Mode 連結；請貼上右側的回答文字，或回到 Google 視窗分享搜尋連結。");
      return true;
    }
    if (decision.kind === "same-question-url") {
      // R17-T4 (F2): the「第 1 步完成」marker must reflect acceptIncomingAnswer's
      // actual storage result, never an unconditional assumption.
      const result = onIntake(decision.sourceUrl, entry, { explicitTargetEntry: true });
      if (result && result.saved) {
        setState("await-answer");
        setStatus("✅ 第 1 步完成：已自動綁定來源網址！請再複製右側 AI 回答文字（或直接拖曳進來）即可完成。");
      } else {
        setStatus("第 1 步未完成：此題的來源連結沒有重新保存（可能已有舊來源或多筆同題皆已綁定）；請直接複製右側 AI 回答文字貼上。");
      }
      return true;
    }
    const sharedUrl = decision.sourceUrl ?? sourceUrlHint ?? undefined;
    onIntake(decision.rawAnswer, entry, sharedUrl ? { explicitTargetEntry: true, sharedUrl } : { explicitTargetEntry: true });
    setState("imported");
    setStatus("✅ 已收到回答並送出保存；可在下方點「完成並關閉」，或直接關閉本視窗。");
    return true;
  }, [entry, onIntake]);

  /** Combine plain + html flavours from paste/drop into one attempt. */
  const absorbTransfer = useCallback((plain: string, html: string): boolean => {
    if (html.trim()) {
      const parsed = extractRelayAnswerFromHtml(html);
      const payload = parsed.text || parsed.sourceUrl;
      if (payload) {
        const absorbed = absorb(payload, parsed.sourceUrl);
        if (absorbed) return true;
      }
    }
    if (plain.trim()) return absorb(plain);
    return false;
  }, [absorb]);

  // F1 (R16-T3): snapshot whatever is on the clipboard the instant the modal
  // opens. A later focus-read equal to this baseline means the learner has not
  // copied a new answer yet — it must be silently ignored, never absorbed.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const text = await readClipboardText();
      if (!cancelled && typeof text === "string") clipboardAtOpenRef.current = text;
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Channel A: zero-click clipboard sense on focus / visibilitychange.
  // readText() failures degrade silently — no blocking dialog is raised.
  // F1: before absorb(), the read text is checked against the locked question
  // (normalized) and the modal-open clipboard snapshot; matches are ignored.
  useEffect(() => {
    let cancelled = false;
    async function tryClipboardRead() {
      if (cancelled || document.visibilityState !== "visible") return;
      const text = await readClipboardText();
      if (cancelled || typeof text !== "string") return;
      if (shouldIgnoreClipboardForFocus(text, entry.question, clipboardAtOpenRef.current)) return;
      absorb(text);
    }
    const onVisible = () => void tryClipboardRead();
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [absorb, entry.question]);

  // Channel B: global paste listener — the native paste event carries
  // clipboardData without any clipboard-read permission.
  useEffect(() => {
    function onPaste(event: ClipboardEvent) {
      const data = event.clipboardData;
      if (!data) return;
      event.preventDefault();
      const plain = data.getData("text/plain") ?? "";
      const html = data.getData("text/html") ?? "";
      absorbTransfer(plain, html);
    }
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [absorbTransfer]);

  // Channel D: focus the panel so the first Ctrl+V lands predictably.
  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  function onDrop(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    const data = event.dataTransfer;
    if (!data) return;
    const plain = data.getData("text/plain") ?? "";
    const html = data.getData("text/html") ?? "";
    absorbTransfer(plain, html);
  }

  return (
    <div
      className="google-relay-modal"
      role="dialog"
      aria-modal="true"
      aria-label="Google AI 問答接力模擬器"
      data-conflict={state === "conflict" ? "true" : undefined}
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <div className={`google-relay-panel relay-dropzone${dragging ? " is-dragging" : ""}`} tabIndex={-1} ref={panelRef}>
        <header className="google-relay-header">
          <div>
            <span className="public-eyebrow">接力模擬器</span>
            <h2 className="google-relay-title">🚀 Google AI 問答接力模擬器</h2>
          </div>
          <button type="button" className="google-relay-close" onClick={onClose} aria-label="關閉接力模擬器">✕</button>
        </header>
        <p className="google-relay-question" data-testid="relay-question">目前題目：{entry.question}</p>
        <div className="google-relay-actions">
          <button type="button" className="google-relay-reopen" onClick={openRelayPopup}>重新開啟 Google 視窗</button>
        </div>
        <ul className="google-relay-channels">
          <li>通道 A：切回本視窗即自動感測剪貼簿（0 按鍵貼回）</li>
          <li>通道 B：直接按 Ctrl+V 貼上（免剪貼簿權限，支援網頁區塊複製）</li>
          <li>通道 C：從 Google 視窗把回答直接拖曳到本區（免 Ctrl+C／Ctrl+V）</li>
          <li>通道 D：先貼網址也可以——先綁來源，再補回答文字</li>
        </ul>
        <div className="google-relay-receiver" role="region" aria-label="貼上或拖放回答的接收區">
          把 Google AI 的回答<b>貼上（Ctrl+V）</b>或<b>拖曳</b>到這個視窗的任何位置即可
        </div>
        {status ? <p className="google-relay-status" role="status" aria-live="polite">{status}</p> : null}
        {state === "imported" ? (
          <div className="google-relay-actions">
            <button type="button" className="google-relay-done" onClick={onClose}>完成並關閉</button>
          </div>
        ) : null}
        <p className="google-relay-help">貼入內容只在本機解析；Google 頁面以獨立視窗開啟（不用 iframe 嵌入），外部連結僅作為來源連結保存。</p>
      </div>
    </div>
  );
}
