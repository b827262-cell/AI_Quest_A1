import { useEffect, useRef, useState } from "react";
import {
  canAutoBindAnswer,
  clearPendingRawAnswer,
  extractGoogleAiSourceUrl,
  extractSharedAnswerText,
  findAnswerBinding,
  findGoogleAiSourceEntry,
  normalizeQuestion,
  readLearningHistory,
  readPendingRawAnswer,
  saveGoogleAiSourceUrl,
  savePendingRawAnswerOnce,
  saveRawAnswerOnce,
  type LearningHistoryEntry
} from "../../learningHistory";

/** Options for an explicit-target intake (R16 relay simulator / per-entry paste). */
export type AnswerIntakeOptions = {
  sharedUrl?: unknown;
  explicitTargetEntry?: boolean;
};

/**
 * R17-T4 (R16-T3 F2): acceptIncomingAnswer reports what actually happened so a
 * caller's UI state (e.g. the relay modal's「第 1 步完成」) can follow the real
 * storage outcome instead of assuming success.
 */
export type ShareIntakeResult = { saved: boolean } | null;

export function useShareIntake(setLearningHistory: (entries: LearningHistoryEntry[]) => void) {
  const [googleStatus, setGoogleStatus] = useState("");
  const [historyStatuses, setHistoryStatuses] = useState<Record<string, string>>({});
  const [pendingIntake, setPendingIntake] = useState<{ rawAnswer: string; candidates: LearningHistoryEntry[] } | null>(() => {
    const pending = readPendingRawAnswer();
    if (!pending) return null;
    return { rawAnswer: pending.rawAnswer, candidates: readLearningHistory().filter((entry) => entry.strategy === "google-ai" && !entry.rawAnswer).slice(0, 3) };
  });
  const pendingIntakeHeadingRef = useRef<HTMLHeadingElement | null>(null);

  function saveIntake(entry: LearningHistoryEntry, rawAnswer: string) {
    const result = saveRawAnswerOnce(entry.id, rawAnswer);
    setLearningHistory(result.entries);
    const message = result.status === "saved"
      ? "已保留原始回覆；整理後版本另行顯示。"
      : result.status === "already_imported"
        ? "此題已有保留的原始回覆，未重複匯入或覆寫。"
        : result.status === "rejected_url_only"
          ? "來源只分享了連結；沒有儲存回答。請使用「從剪貼簿帶回回答」。"
        : "找不到這筆題目，未儲存回覆。";
    setHistoryStatuses((messages) => ({ ...messages, [entry.id]: message }));
    return result.status;
  }

  function saveSourceIntake(entry: LearningHistoryEntry, sourceUrl: string) {
    const result = saveGoogleAiSourceUrl(entry.id, sourceUrl);
    setLearningHistory(result.entries);
    return result.status;
  }

  function requireExplicitChoice(rawAnswer: string, candidates: LearningHistoryEntry[]) {
    const pending = savePendingRawAnswerOnce(rawAnswer);
    if (!pending) return;
    setPendingIntake({ rawAnswer: pending.rawAnswer, candidates: candidates.slice(0, 3) });
    setGoogleStatus("無法高信心自動對應；原始回覆暫留在本頁，請明確選擇題目。" );
  }

  function acceptIncomingAnswer(rawAnswer: string, preferredEntry?: LearningHistoryEntry, options?: AnswerIntakeOptions): ShareIntakeResult {
    const current = readLearningHistory();
    const sharedUrl = options?.sharedUrl;
    const source = extractGoogleAiSourceUrl(rawAnswer, sharedUrl);
    const sourceEntry = source ? findGoogleAiSourceEntry(current, source) : null;
    const extraction = extractSharedAnswerText(rawAnswer, sharedUrl);
    if (extraction.status !== "accepted") {
      if (source && sourceEntry) {
        const sourceStatus = saveSourceIntake(sourceEntry, source.sourceUrl);
        const message = "已保存搜尋好朋友來源連結；尚未保存回答文字。請使用「從剪貼簿帶回回答」，或展開手動貼上備援。";
        setGoogleStatus(message);
        setHistoryStatuses((messages) => ({ ...messages, [sourceEntry.id]: message }));
        return { saved: sourceStatus === "saved" || sourceStatus === "already_saved" };
      }
      const message = "來源只分享了連結；沒有儲存回答。請使用「從剪貼簿帶回回答」，或展開手動貼上備援。";
      setGoogleStatus(message);
      if (preferredEntry) setHistoryStatuses((messages) => ({ ...messages, [preferredEntry.id]: message }));
      return { saved: false };
    }
    rawAnswer = extraction.rawAnswer;
    // The validated `q` parameter gives an exact, local question binding.
    if (source && sourceEntry) {
      const sourceStatus = saveSourceIntake(sourceEntry, source.sourceUrl);
      const result = saveIntake(sourceEntry, rawAnswer);
      setGoogleStatus(result === "saved" ? "已保存搜尋好朋友來源連結與原始回答。" : "已保存搜尋好朋友來源連結；原始回答未覆寫。" );
      return { saved: sourceStatus === "saved" || sourceStatus === "already_saved" || result === "saved" };
    }
    const binding = findAnswerBinding(current, rawAnswer);
    if (preferredEntry) {
      if (options?.explicitTargetEntry) {
        // R16: the learner (or the locked relay simulator) explicitly picked
        // this entry, so the 67% token gate is waived. A udm=50 URL naming a
        // different question is still protected: it never binds implicitly.
        if (source && normalizeQuestion(source.question) !== normalizeQuestion(preferredEntry.question)) {
          requireExplicitChoice(rawAnswer, [preferredEntry, ...binding.matches.filter((entry) => entry.id !== preferredEntry.id)].slice(0, 3));
          return { saved: false };
        }
        return { saved: saveIntake(preferredEntry, rawAnswer) === "saved" };
      }
      const candidates = [preferredEntry, ...binding.matches.filter((entry) => entry.id !== preferredEntry.id)].slice(0, 3);
      if (!canAutoBindAnswer(binding) || binding.matches[0]?.id !== preferredEntry.id) {
        requireExplicitChoice(rawAnswer, candidates);
        return { saved: false };
      }
      return { saved: saveIntake(preferredEntry, rawAnswer) === "saved" };
    }
    if (binding.hasExplicitMismatch || !binding.matches.length) {
      const candidates = current.filter((entry) => entry.strategy === "google-ai" && !entry.rawAnswer).slice(0, 3);
      if (candidates.length) requireExplicitChoice(rawAnswer, candidates);
      else setGoogleStatus("沒有可對應的待處理題目；請先提出問題後再帶回回覆。");
      return { saved: false };
    }
    if (canAutoBindAnswer(binding)) {
      const target = binding.matches[0];
      const result = saveIntake(target, rawAnswer);
      setGoogleStatus(result === "saved" ? "已安全帶回回覆。" : "回覆沒有重複儲存。" );
      return { saved: result === "saved" };
    }
    requireExplicitChoice(rawAnswer, binding.matches);
    return { saved: false };
  }

  useEffect(() => {
    function requestIntake() { navigator.serviceWorker.controller?.postMessage({ type: "consume-share-intake" }); }
    function receiveIntake(event: MessageEvent<unknown>) {
      const data = event.data as { type?: unknown; payload?: { text?: unknown; url?: unknown } } | null;
      if (data?.type !== "share-intake") return;
      const rawAnswer = typeof data.payload?.text === "string" ? data.payload.text : "";
      if (data.payload) acceptIncomingAnswer(rawAnswer, undefined, { sharedUrl: data.payload.url });
    }
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.addEventListener("message", receiveIntake);
    requestIntake();
    navigator.serviceWorker.addEventListener("controllerchange", requestIntake, { once: true });
    return () => navigator.serviceWorker.removeEventListener("message", receiveIntake);
  // Local service-worker payload is the only POST share intake; title and URL never bind an answer.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (pendingIntake) pendingIntakeHeadingRef.current?.focus();
  }, [pendingIntake]);

  function confirmPendingIntake(entry: LearningHistoryEntry) {
    if (!pendingIntake) return;
    if (saveIntake(entry, pendingIntake.rawAnswer) !== "not_found") {
      clearPendingRawAnswer();
      setPendingIntake(null);
    }
  }

  function dismissPendingIntake() {
    clearPendingRawAnswer();
    setPendingIntake(null);
  }

  return {
    googleStatus,
    setGoogleStatus,
    historyStatuses,
    setHistoryStatuses,
    pendingIntake,
    pendingIntakeHeadingRef,
    acceptIncomingAnswer,
    confirmPendingIntake,
    dismissPendingIntake
  };
}
