import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { GOOGLE_CONFIRM_HINT } from "./constants";
import {
  addLearningHistoryEntry,
  googleAiSearchUrl,
  updateLearningHistoryAnswer,
  type AnswerStrategy,
  type LearningHistoryEntry
} from "../../learningHistory";
import {
  clearGuestAnswerCredential,
  publicGuestAnswerForHistory,
  readGuestAnswerCredential,
  saveGuestAnswerCredential
} from "../../guestAnswerNavigation";
import {
  studentClient,
  type GuestAskResponse,
  type GuestProviderPreference,
  type GuestQuestionCategory,
  type PublicGuestQuota,
  type PublicSiteConfig
} from "../../studentClient";

export function useGuestQuestion({
  config,
  setLearningHistory,
  setGoogleStatus
}: {
  config: PublicSiteConfig;
  setLearningHistory: (entries: LearningHistoryEntry[]) => void;
  setGoogleStatus: (status: string) => void;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const isAnswerRoute = location.pathname === "/guest-answer";
  const [question, setQuestion] = useState("");
  const [category, setCategory] = useState<GuestQuestionCategory>("auto");
  const [strategy, setStrategy] = useState<AnswerStrategy>("google-ai");
  const [providerPreference, setProviderPreference] = useState<GuestProviderPreference>("auto");
  const [response, setResponse] = useState<GuestAskResponse | null>(null);
  const [guestRemaining, setGuestRemaining] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");
  const [lastSourceType, setLastSourceType] = useState<"manual" | "image" | "file">("manual");
  const [restoringAnswer, setRestoringAnswer] = useState(isAnswerRoute);
  const [quota, setQuota] = useState<PublicGuestQuota | null>(null);
  const requestAbortRef = useRef<AbortController | null>(null);

  // Fetch the public per-guest daily quota snapshot once on mount. Optional
  // chaining + catch keep this resilient to minimal mocks and offline/test envs.
  useEffect(() => {
    studentClient.getPublicGuestQuota?.().then(setQuota).catch(() => undefined);
  }, []);

  // Keep quota.remainingCount in sync when a response carries the authoritative
  // remaining count (ask + saved-answer restore).
  function syncQuotaRemaining(remaining: number | undefined) {
    if (typeof remaining !== "number") return;
    setQuota((prev) => (prev ? { ...prev, remainingCount: remaining } : prev));
  }

  useEffect(() => {
    let active = true;
    requestAbortRef.current?.abort();
    requestAbortRef.current = null;

    if (!isAnswerRoute) {
      // The root URL is always a clean compose screen. An old recovery
      // reference must never force the visitor back into a previous answer.
      clearGuestAnswerCredential();
      setQuestion("");
      setResponse(null);
      setBusy(false);
      setError("");
      setFeedback("");
      setLastSourceType("manual");
      setRestoringAnswer(false);
      return () => {
        active = false;
      };
    }

    setRestoringAnswer(true);
    const routeState = location.state as { guestResponse?: GuestAskResponse } | null;
    const stateResponse = routeState?.guestResponse;
    if (stateResponse) {
      setQuestion(stateResponse.question || "");
      setResponse(stateResponse);
    }
    const cred = readGuestAnswerCredential();
    if (!cred) {
      setRestoringAnswer(false);
      if (!stateResponse) navigate("/", { replace: true, state: null });
      return () => {
        active = false;
      };
    }
    studentClient.getSavedGuestAnswer(cred.requestId, cred.recoveryToken).then((saved) => {
      if (!active) return;
      if (!saved.answer) {
        clearGuestAnswerCredential();
        setRestoringAnswer(false);
        if (!stateResponse) navigate("/", { replace: true, state: null });
        return;
      }
      setQuestion(saved.question || "");
      setResponse(saved);
      const savedRemaining = saved.remainingGuestQuestions;
      if (typeof savedRemaining === "number") {
        setQuota((prev) => (prev ? { ...prev, remainingCount: savedRemaining } : prev));
      }
      setRestoringAnswer(false);
    }).catch(() => {
      if (!active) return;
      clearGuestAnswerCredential();
      setRestoringAnswer(false);
      if (!stateResponse) navigate("/", { replace: true, state: null });
    });
    return () => {
      active = false;
    };
  }, [isAnswerRoute, location.key, location.state, navigate]);

  async function submitGuestQuestion(nextSourceType: "manual" | "image" | "file") {
    setLastSourceType(nextSourceType);
    const trimmed = question.trim();
    setError("");
    setFeedback("");
    if (!trimmed) {
      setError("請先輸入問題。這裡最多接受 2,000 字。" );
      return;
    }
    if (trimmed.length > 2000) {
      setError("問題太長，請縮短到 2,000 字以內。" );
      return;
    }
    const historyRecord = addLearningHistoryEntry({
      question: trimmed,
      category,
      sourceType: nextSourceType,
      strategy: "api"
    });
    setLearningHistory(historyRecord.entries);
    if (!config.guestAiEnabled) {
      setError("目前暫停開放訪客問答，請登入後繼續使用。" );
      return;
    }
    const controller = new AbortController();
    requestAbortRef.current?.abort();
    requestAbortRef.current = controller;
    setBusy(true);
    try {
      const result = await studentClient.askAsGuest({
        question: trimmed,
        category,
        sourceType: nextSourceType,
        providerPreference
      }, controller.signal);
      if (controller.signal.aborted) return;
      if (result.status !== "busy") setGuestRemaining(result.remainingGuestQuestions ?? null);
      if (result.status === "rate_limited" || result.status === "busy") {
        setError(result.message || (result.status === "busy" ? "訪客服務目前繁忙，請稍後再試或登入使用" : result.retryAfterSeconds ? `請約 ${result.retryAfterSeconds} 秒後再試。` : "請稍後再試。"));
        return;
      }
      setResponse(result);
      syncQuotaRemaining(result.remainingGuestQuestions);
      if (result.status === "success" && result.answer) {
        setLearningHistory(updateLearningHistoryAnswer(historyRecord.entry.id, result.answer));
      }
      // Persist the one-time recovery token so the answer can survive a
      // refresh. Only the token + requestId are stored; never log the token.
      if (result.requestId && result.recoveryToken) {
        saveGuestAnswerCredential({
          requestId: result.requestId,
          recoveryToken: result.recoveryToken
        });
      }
      navigate("/guest-answer", {
        state: { guestResponse: publicGuestAnswerForHistory({ ...result, question: result.question || trimmed }) }
      });
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(err instanceof Error ? err.message : "訪客問答暫時無法使用，請稍後再試。" );
    } finally {
      if (requestAbortRef.current === controller) {
        requestAbortRef.current = null;
        setBusy(false);
      }
    }
  }

  function submitGoogleAiQuestion(nextSourceType: "manual" | "image" | "file") {
    const trimmed = question.trim();
    setError("");
    setFeedback("");
    setGoogleStatus("");
    if (!trimmed) {
      setError("請先輸入問題。這裡最多接受 2,000 字。");
      return;
    }
    if (trimmed.length > 2000) {
      setError("問題太長，請縮短到 2,000 字以內。");
      return;
    }
    const historyRecord = addLearningHistoryEntry({
      question: trimmed,
      category,
      sourceType: nextSourceType,
      strategy: "google-ai"
    });
    setLearningHistory(historyRecord.entries);
    window.open(googleAiSearchUrl(trimmed), "_blank", "noopener,noreferrer");
    setQuestion("");
    setGoogleStatus(`已用搜尋好朋友／谷哥開啟問題；回來後可用分享、剪貼簿或貼上備援帶回回覆。${GOOGLE_CONFIRM_HINT}`);
  }

  async function submitFeedback(helpful: boolean) {
    if (!response?.requestId) return;
    try {
      await studentClient.sendGuestFeedback({ requestId: response.requestId, helpful });
      setFeedback("謝謝你的回饋！" );
    } catch {
      setFeedback("回饋已記錄在本次體驗中。" );
    }
  }

  function resetQuestion() {
    requestAbortRef.current?.abort();
    requestAbortRef.current = null;
    setBusy(false);
    setQuestion("");
    setResponse(null);
    setError("");
    setFeedback("");
    setLastSourceType("manual");
    clearGuestAnswerCredential();
    navigate("/", { replace: true, state: null });
  }

  function retryGuestQuestion() {
    requestAbortRef.current?.abort();
    setResponse(null);
    setError("");
    void submitGuestQuestion(lastSourceType);
  }

  useEffect(() => () => {
    requestAbortRef.current?.abort();
  }, []);

  return {
    question,
    setQuestion,
    category,
    setCategory,
    strategy,
    setStrategy,
    providerPreference,
    setProviderPreference,
    response,
    guestRemaining,
    busy,
    error,
    feedback,
    restoringAnswer,
    quota,
    submitGuestQuestion,
    submitGoogleAiQuestion,
    submitFeedback,
    resetQuestion,
    retryGuestQuestion
  };
}
