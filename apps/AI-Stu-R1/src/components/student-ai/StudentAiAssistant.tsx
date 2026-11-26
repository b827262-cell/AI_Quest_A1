import { useCallback, useEffect, useRef, useState } from "react";
import { StudentApiError, studentClient } from "../../studentClient";
import type { StudentNote } from "@ai-smartbook/schema";
import {
  extractGoogleAiSourceUrl,
  extractSharedAnswerText,
  googleAiSearchUrl,
  normalizeQuestion,
  organizeRawAnswer,
  type LearningHistoryEntry
} from "../../learningHistory";
import { GoogleAiRelaySimulatorModal } from "../../pages/public-home/GoogleAiRelaySimulatorModal";
import type { AnswerIntakeOptions } from "../../pages/public-home/useShareIntake";

type ShareIntakeResult = { saved: boolean } | null;

/** R24 Phase 2: two answer channels with the same note-conversion sink. */
export type StudentAiMode = "google-relay" | "platform";

export interface StudentAiAssistantProps {
  /** Optional question text injected by the reader's selection bar. */
  prefill?: { text: string; nonce: number } | null;
  bookId?: string | null;
  chapterId?: string | null;
  pageNumber?: number | null;
  /** Fired after a note is successfully saved (assistant or reader consumers). */
  onNoteSaved?: (note: StudentNote) => void;
  onClose?: () => void;
  /**
   * Test/preview hook: preset the relay answer so note-saving can be verified
   * without the real clipboard relay. Production callers never pass it.
   */
  initialAnswer?: string | null;
  /** Test/preview hook: preset the locked learning-history entry. */
  initialEntry?: LearningHistoryEntry | null;
}

/** History sync lifecycle driving the「存為課業筆記」gate. */
export type HistorySyncState = "idle" | "syncing" | "synced" | "failed";

/**
 * Pure classification of one relay payload (same contract as the public-home
 * share intake, but writing into caller state instead of browser storage).
 * Answer text and the same-question udm=50 source URL are judged separately:
 * each alone is accepted (the modal's step-1 URL binding, then the answer).
 * Exported so unit tests can prove binding without a DOM.
 */
export function applyRelayIntake(
  preferredEntry: LearningHistoryEntry,
  rawIncoming: string,
  options?: AnswerIntakeOptions
): { entry: LearningHistoryEntry; answer: string | null; sourceUrlJustBound: boolean } {
  const sharedUrl = typeof options?.sharedUrl === "string" ? options.sharedUrl : undefined;
  const source = extractGoogleAiSourceUrl(rawIncoming, sharedUrl);
  const extraction = extractSharedAnswerText(rawIncoming, sharedUrl);
  if (extraction.status === "accepted") {
    // Channel A/B/C answered with answer prose — pure-text channels included.
    // A previously bound (or simultaneous) source URL is preserved alongside.
    return {
      entry: {
        ...preferredEntry,
        rawAnswer: extraction.rawAnswer,
        rawAnswerCapturedAt: new Date().toISOString(),
        organizedAnswer: organizeRawAnswer(extraction.rawAnswer),
        sourceUrl: source?.sourceUrl ?? preferredEntry.sourceUrl
      },
      answer: extraction.rawAnswer,
      sourceUrlJustBound: Boolean(source)
    };
  }
  // Step 1: the payload was only the udm=50 URL of the same question. Bind the
  // source and keep waiting for the answer prose.
  if (source && normalizeQuestion(source.question) === normalizeQuestion(preferredEntry.question)) {
    return { entry: { ...preferredEntry, sourceUrl: source.sourceUrl }, answer: null, sourceUrlJustBound: true };
  }
  return { entry: preferredEntry, answer: null, sourceUrlJustBound: false };
}

function nextHistoryVersion(current: LearningHistoryEntry): number {
  const currentVersion = typeof current.syncVersion === "number" && Number.isSafeInteger(current.syncVersion)
    ? current.syncVersion
    : 0;
  return currentVersion + 1;
}

function newEntryId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `learning-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Logged-in student's course Q&A assistant (R24 Phase 2, dual mode):
 * - 「Google AI 中繼（免金鑰）」（default）: question -> learning history upsert
 *   (syncVersion >= 1, incremented per revision) -> relay answer intake
 *   increments the version and re-upserts -> /notes/from-history (source stays
 *   google-ai-relay).
 * - 「平台 AI（伺服器代理）」: the browser only sends the question to
 *   /api/student/ai-ask; the server picks the model (never a client key),
 *   writes the answer into learning history and returns { entryId, answer }.
 *   The same「存為課業筆記」button then converts that entry; 429 surfaces a
 *   friendly cooldown notice.
 */
export function StudentAiAssistant({
  prefill,
  bookId = null,
  chapterId = null,
  pageNumber = null,
  onNoteSaved,
  onClose,
  initialAnswer = null,
  initialEntry = null
}: StudentAiAssistantProps) {
  const [mode, setMode] = useState<StudentAiMode>("google-relay");
  const [question, setQuestion] = useState("");
  const [entry, setEntry] = useState<LearningHistoryEntry | null>(initialEntry);
  const [answer, setAnswer] = useState<string | null>(initialAnswer);
  const [relayUrl, setRelayUrl] = useState<string | null>(null);
  const [syncState, setSyncState] = useState<HistorySyncState>(initialEntry?.syncVersion ? "synced" : "idle");
  const [platformEntryId, setPlatformEntryId] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [noteStatus, setNoteStatus] = useState("");
  const [noteError, setNoteError] = useState("");
  const [saving, setSaving] = useState(false);
  const pendingSyncRef = useRef<Promise<boolean> | null>(null);

  // Reader selection bar can push the selected text in as the question.
  useEffect(() => {
    if (prefill && prefill.text.trim()) setQuestion(prefill.text.trim());
  }, [prefill?.nonce, prefill?.text]);

  // Allow "存為課業筆記" for initialAnswer even without a replayed relay entry.
  useEffect(() => {
    if (initialAnswer && !answer) setAnswer(initialAnswer);
  }, [initialAnswer, answer]);

  function switchMode(next: StudentAiMode) {
    if (next === mode) return;
    // Mode switch resets the answer text so relay and platform answers never
    // mix; each mode keeps its own entry bookkeeping.
    setMode(next);
    setAnswer(null);
    setNoteStatus("");
    setNoteError("");
    setRelayUrl(null);
    setPlatformEntryId(null);
  }

  /**
   * Upsert one revision of `record` into the server learning history.
   * Resolves true only on success; failures surface in the UI and keep
   * 「存為課業筆記」gated (no silent degradation).
   */
  const syncHistory = useCallback((record: LearningHistoryEntry): Promise<boolean> => {
    const version = typeof record.syncVersion === "number" && record.syncVersion >= 1
      ? record.syncVersion
      : 1;
    setSyncState("syncing");
    setNoteError("");
    const pending = studentClient
      .upsertLearningHistory([{ ...record, syncVersion: version }])
      .then((result) => {
        const serverVersion = result.entries[0]?.syncVersion ?? version;
        setEntry((current) => (current && current.id === record.id
          ? { ...current, syncVersion: serverVersion }
          : current));
        setSyncState("synced");
        setNoteStatus("已同步學習紀錄");
        return true;
      })
      .catch(() => {
        setSyncState("failed");
        setNoteError("學習紀錄同步失敗；請使用「重試同步」再轉存為筆記。");
        return false;
      });
    pendingSyncRef.current = pending;
    return pending;
  }, []);

  function askGoogleAi(nextSourceType: LearningHistoryEntry["sourceType"] = "manual") {
    const trimmed = question.trim();
    if (!trimmed) return;
    const newEntry: LearningHistoryEntry = {
      id: newEntryId(),
      askedAt: new Date().toISOString(),
      question: trimmed,
      category: "auto",
      sourceType: nextSourceType,
      strategy: "google-ai",
      // The history contract requires a positive integer version on upload.
      syncVersion: 1
    };
    setEntry(newEntry);
    setAnswer(null);
    setNoteStatus("");
    setNoteError("");
    void syncHistory(newEntry);
    setRelayUrl(googleAiSearchUrl(trimmed));
  }

  /** Platform-AI (server proxy) submit; the server syncs history for us. */
  async function askPlatform() {
    const trimmed = question.trim();
    if (!trimmed || asking) return;
    setAsking(true);
    setAnswer(null);
    setPlatformEntryId(null);
    setNoteStatus("");
    setNoteError("");
    try {
      const response = await studentClient.askStudentAi({
        question: trimmed,
        category: "auto",
        bookId: bookId ?? null,
        chapterId: chapterId ?? null,
        pageNumber: pageNumber ?? null
      });
      setPlatformEntryId(response.entryId);
      setAnswer(response.answer);
      setSyncState("synced");
      setNoteStatus("已收到平台 AI 解答；學習紀錄已由伺服器同步。");
    } catch (e) {
      if (e instanceof StudentApiError && e.status === 429) {
        setNoteError("提問太頻繁，平台 AI 冷卻中；請稍候片刻再試。");
      } else {
        setNoteError("平台 AI 提問失敗，請稍後再試。");
      }
    } finally {
      setAsking(false);
    }
  }

  function submitQuestion() {
    if (mode === "platform") void askPlatform();
    else askGoogleAi();
  }

  function retrySync() {
    if (entry) void syncHistory(entry);
  }

  /** Sink for the relay modal's four intake channels (A/B/C/D). */
  const acceptRelayIntake = useCallback(
    (rawIncoming: string, preferredEntry: LearningHistoryEntry, options?: AnswerIntakeOptions): ShareIntakeResult => {
      const intake = applyRelayIntake(preferredEntry, rawIncoming, options);
      if (!intake.sourceUrlJustBound && !intake.answer) return { saved: false };
      // Any recognized payload (answer prose, URL binding, or both) updates the
      // note-side state — pure-text paste/drag never requires a URL to stick.
      const updated: LearningHistoryEntry = {
        ...intake.entry,
        // Each accepted revision bumps the version for the next history upload.
        syncVersion: nextHistoryVersion(preferredEntry)
      };
      setEntry(updated);
      if (intake.answer) {
        setAnswer(intake.answer);
        setNoteStatus("已收到回答；學習紀錄同步後即可存為課業筆記。");
      }
      void syncHistory(updated);
      return { saved: true };
    },
    [syncHistory]
  );

  async function saveAsNote() {
    const content = answer?.trim() ?? "";
    if (!content || saving) return;
    setSaving(true);
    setNoteError("");
    try {
      let note: StudentNote | null = null;
      if (mode === "platform") {
        const entryId = platformEntryId;
        if (!entryId) {
          setNoteError("尚無可轉存的平台 AI 解答；請先提問。");
          return;
        }
        // The server already synced history for this entry in ai-ask, so the
        // shared button converts it directly.
        try {
          note = (await studentClient.createNoteFromHistory({
            entryId,
            bookId: bookId ?? null,
            chapterId: chapterId ?? null,
            pageNumber: pageNumber ?? null
          })).note;
        } catch {
          setNoteError("存為筆記失敗，請稍後再試。");
          return;
        }
      } else {
        // R22 §4 F10: wait for (or retry) the history upsert BEFORE from-history.
        if (syncState !== "synced") {
          const syncedNow = pendingSyncRef.current ?? (entry ? syncHistory(entry) : Promise.resolve(false));
          const ok = await syncedNow;
          if (!ok) {
            setNoteError("學習紀錄尚未同步成功，無法轉存為課業筆記；請重試同步。");
            return;
          }
        }
        const entryId = entry?.id ?? null;
        try {
          note = (await studentClient.createNoteFromHistory({
            entryId: entryId ?? "",
            bookId: bookId ?? null,
            chapterId: chapterId ?? null,
            pageNumber: pageNumber ?? null
          })).note;
        } catch (fromHistoryError) {
          const errorShape = fromHistoryError as { status?: unknown; code?: unknown };
          const status = fromHistoryError instanceof StudentApiError
            ? fromHistoryError.status
            : errorShape.status;
          const code = fromHistoryError instanceof StudentApiError
            ? fromHistoryError.code
            : errorShape.code;
          const notFound = status === 404 || code === "ENTRY_NOT_FOUND";
          if (!notFound || !entryId) {
            // Network/server errors stay explicit and retryable — never silently
            // rebuilt as a manual note (which would lose google-ai-relay source).
            setNoteError("存為筆記失敗，請稍後再試。");
            return;
          }
          // Narrow fallback: the history entry genuinely does not exist
          // server-side. Reported in the status, never silent; the server still
          // derives `source` (google-ai-relay) from the linked entry metadata.
          try {
            note = (await studentClient.createStudentNote({
              type: "ai_answer",
              title: (entry?.question ?? content).slice(0, 80),
              content,
              bookId: bookId ?? null,
              chapterId: chapterId ?? null,
              pageNumber: pageNumber ?? null,
              entryId
            })).note;
            setNoteStatus("（歷史紀錄未同步到後台，已改以筆記形式保存）");
          } catch {
            setNoteError("存為筆記失敗，請稍後再試。");
            return;
          }
        }
      }
      setNoteStatus("✅ 已存為課業筆記");
      onNoteSaved?.(note);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="student-ai-assistant" aria-labelledby="student-ai-heading" data-testid="student-ai-assistant">
      <div className="student-ai-head">
        <span className="public-eyebrow">登入學員專屬</span>
        <h3 id="student-ai-heading" className="student-ai-title">🚀 課業助教</h3>
        <p className="muted">
          「Google AI 中繼」免 API 金鑰：提問後到開啟的 Google 視窗詢問，再把回答貼回來即可存成課業筆記；「平台 AI」由伺服器代理提問，無需金鑰。
        </p>
      </div>

      <div className="student-ai-modes" role="group" aria-label="解答模式" data-testid="student-ai-modes">
        <button
          type="button"
          className={`student-ai-mode-button${mode === "google-relay" ? " active" : ""}`}
          data-testid="student-ai-mode-google"
          aria-pressed={mode === "google-relay"}
          onClick={() => switchMode("google-relay")}
        >
          Google AI 中繼（免金鑰）
        </button>
        <button
          type="button"
          className={`student-ai-mode-button${mode === "platform" ? " active" : ""}`}
          data-testid="student-ai-mode-platform"
          aria-pressed={mode === "platform"}
          onClick={() => switchMode("platform")}
        >
          平台 AI（伺服器代理）
        </button>
      </div>

      <label className="student-ai-label" htmlFor="student-ai-question">課業問題</label>
      <textarea
        id="student-ai-question"
        className="student-ai-question"
        data-testid="student-ai-question"
        value={question}
        placeholder="輸入想問的課業問題，例如：什麼是重力加速度？"
        rows={3}
        onChange={(event) => setQuestion(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) submitQuestion();
        }}
      />
      <div className="student-ai-actions">
        {mode === "google-relay" ? (
          <button
            type="button"
            className="google-ai-ask"
            data-testid="student-ai-submit"
            onClick={() => askGoogleAi()}
            disabled={!question.trim()}
          >
            提問並開啟 Google 視窗
          </button>
        ) : (
          <button
            type="button"
            className="platform-ai-ask"
            data-testid="student-ai-platform-submit"
            onClick={() => void askPlatform()}
            disabled={!question.trim() || asking}
          >
            {asking ? "平台 AI 回答中…" : "提問（平台 AI）"}
          </button>
        )}
        <br />
        {syncState === "failed" ? (
          <button type="button" className="student-ai-retry-sync" data-testid="student-ai-retry-sync" onClick={retrySync}>
            重試同步
          </button>
        ) : null}
        {onClose ? (
          <button type="button" className="student-ai-close" onClick={onClose}>關閉</button>
        ) : null}
      </div>

      {asking ? <p className="student-ai-status" role="status" aria-live="polite">平台 AI 回答中…</p> : null}
      {syncState === "syncing" ? <p className="student-ai-status" role="status" aria-live="polite">正在同步學習紀錄…</p> : null}
      {syncState === "synced" && !noteStatus ? <p className="student-ai-status" role="status" aria-live="polite">已同步學習紀錄</p> : null}
      {noteError ? (
        <p className="student-ai-error" role="alert" data-testid="student-ai-note-error">{noteError}</p>
      ) : null}

      {answer ? (
        <div className="student-ai-answer" data-testid="student-ai-answer">
          <h4>解答</h4>
          {/* Plain-text rendering only: no innerHTML, no dangerouslySetInnerHTML. */}
          <p className="student-ai-answer-text">{answer}</p>
          <button
            type="button"
            className="student-ai-save-note"
            data-testid="student-ai-save-note"
            onClick={() => void saveAsNote()}
            disabled={saving}
          >
            存為課業筆記
          </button>
          {saving ? <p className="student-ai-status" role="status">正在儲存筆記…</p> : null}
        </div>
      ) : (
        <p className="muted" data-testid="student-ai-no-answer">
          {mode === "platform"
            ? "尚未收到解答。送出問題後，平台 AI 會直接回覆，並可一鍵存為課業筆記。"
            : "尚未收到解答。貼回 Google AI 的回答後，就能一鍵存為課業筆記。"}
        </p>
      )}
      {noteStatus ? <p className="student-ai-saved" role="status" data-testid="student-ai-note-status">{noteStatus}</p> : null}

      {relayUrl && entry ? (
        <GoogleAiRelaySimulatorModal
          entry={entry}
          url={relayUrl}
          onClose={() => setRelayUrl(null)}
          onIntake={acceptRelayIntake}
        />
      ) : null}
    </section>
  );
}
