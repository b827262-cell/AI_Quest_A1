import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { HomeAIComposer } from "../components/HomeAIComposer";
import { StudentAnswerRenderer } from "../components/GuestAnswerRenderer";
import {
  addLearningHistoryEntry,
  clearLearningHistory,
  googleAiSearchUrl,
  readLearningHistory,
  removeLearningHistoryEntry,
  updateLearningHistoryAnswer,
  type AnswerStrategy,
  type LearningHistoryEntry,
  type LearningSourceType
} from "../learningHistory";
import {
  clearGuestAnswerCredential,
  publicGuestAnswerForHistory,
  readGuestAnswerCredential,
  saveGuestAnswerCredential
} from "../guestAnswerNavigation";
import {
  studentClient,
  type GuestAskResponse,
  type GuestProviderPreference,
  type GuestQuestionCategory,
  type PublicSiteConfig
} from "../studentClient";
import { useStudentAuth } from "../student-auth";

const DEFAULT_CONFIG: PublicSiteConfig = {
  siteTitle: "AI-SmartBook",
  siteSubtitle: "多模型領域智慧解題平台",
  homeGreeting: "今天想學習什麼？",
  homeInputPlaceholder: "輸入你的問題……",
  guestAiEnabled: true,
  guestDailyLimit: 3,
  studentLoginEnabled: true,
  maintenanceNotice: ""
};

const QUICK_STARTS: Array<{ label: string; category: GuestQuestionCategory; question: string }> = [
  { label: "程式設計", category: "programming", question: "如何把一個複雜的程式問題拆成小步驟？" },
  { label: "數學解題", category: "math", question: "數學題目要怎麼整理已知條件？" },
  { label: "教材問答", category: "教材問答", question: "請示範如何從教材整理一個重點。" },
  { label: "資通安全", category: "cybersecurity", question: "Reflected XSS 是否能讀取其他網站的 Cookie？" }
];

function BrandMark() {
  return (
    <span className="public-brand-mark" aria-hidden="true">
      <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M12.5 6.5a5 5 0 0 0-5 5v.6A4.2 4.2 0 0 0 5 16c0 1.4.7 2.7 1.8 3.5a5 5 0 0 0 4.7 5.2h2V6.5Z" />
        <path d="M19.5 6.5a5 5 0 0 1 5 5v.6A4.2 4.2 0 0 1 27 16c0 1.4-.7 2.7-1.8 3.5a5 5 0 0 1-4.7 5.2h-2V6.5Z" />
        <path d="M12 12h2M12 16h2M18 12h2M18 16h2M16 6v20" />
      </svg>
    </span>
  );
}

function PublicHomeHeader({ config, studentName }: { config: PublicSiteConfig; studentName: string }) {
  return (
    <header className="public-home-header">
      <Link to="/" className="public-brand-link" aria-label={`${config.siteTitle} 首頁`}>
        <BrandMark />
        <span>{config.siteTitle}</span>
      </Link>
      <nav className="public-home-nav" aria-label="公開首頁導覽">
        <a href="#features">功能介紹</a>
        {studentName ? <span className="public-welcome-chip">嗨，{studentName}</span> : null}
        {config.studentLoginEnabled ? (
          <Link className="public-login-button" to="/login">
            {studentName ? "學習首頁" : "學員登入"}
          </Link>
        ) : null}
      </nav>
    </header>
  );
}

function GuestAnswer({
  question,
  response,
  onFeedback,
  onReset,
  onRetry
}: {
  question: string;
  response: GuestAskResponse;
  onFeedback: (helpful: boolean) => void;
  onReset: () => void;
  onRetry: () => void;
}) {
  const reachedLimit = response.status === "limit_reached";
  const isMock = response.mode === "mock";
  const isIncomplete = response.status === "incomplete";
  return (
    <section className="public-answer-card" aria-live="polite">
      <div className="public-answer-topline">
        <button type="button" className="public-back-button" onClick={onReset}>
          ← 新問題
        </button>
        <span className="guest-answer-badges">
          <span className="guest-answer-badge">訪客體驗</span>
          <span className={`guest-mode-badge ${isMock ? "mock" : "live"}`}>
            {isMock ? "Mock 示範" : "正式 AI"}
          </span>
        </span>
      </div>
      <div className="guest-question-block">
        <span>訪客問題</span>
        <p>{question}</p>
      </div>
      <div className="guest-answer-body">
        <div className="guest-answer-role">
          <span className="assistant-avatar">✦</span>
          <strong>AI-SmartBook 學習助教</strong>
        </div>
        {response.answer || response.structuredAnswer ? (
          <StudentAnswerRenderer content={response.structuredAnswer} fallback={response.answer} />
        ) : null}
        {response.message ? <p className="guest-answer-message">{response.message}</p> : null}
        {isIncomplete ? (
          <p className="guest-answer-message">
            這次回答可能尚未完整結束，請重新產生以取得完整答案。
            <button type="button" className="guest-retry-button" onClick={onRetry}>重新產生</button>
          </p>
        ) : null}
        {reachedLimit ? (
          <p className="guest-answer-message">登入學員帳號後，可以繼續使用教材解題、學習紀錄與個人化功能。</p>
        ) : null}
      </div>
      {response.status === "success" ? (
        <div className="guest-answer-feedback">
          <span>這個回答有幫助嗎？</span>
          <button type="button" onClick={() => onFeedback(true)}>👍 有幫助</button>
          <button type="button" onClick={() => onFeedback(false)}>👎 需要改進</button>
        </div>
      ) : null}
      <div className="guest-answer-footer">
        <span>
          剩餘訪客體驗次數：{response.remainingGuestQuestions ?? "—"}
        </span>
        <Link className="public-login-button" to="/login">學員登入</Link>
      </div>
    </section>
  );
}

const SOURCE_LABELS: Record<LearningSourceType, string> = {
  manual: "手動輸入",
  image: "圖片",
  file: "文件"
};

function LearningHistoryPanel({
  entries,
  onEntriesChange,
  onStatusChange,
  statuses
}: {
  entries: LearningHistoryEntry[];
  onEntriesChange: (entries: LearningHistoryEntry[]) => void;
  onStatusChange: (id: string, message: string) => void;
  statuses: Record<string, string>;
}) {
  async function pasteGoogleAnswer(entry: LearningHistoryEntry) {
    try {
      if (!navigator.clipboard?.readText) throw new Error("clipboard unavailable");
      const answer = await navigator.clipboard.readText();
      if (!answer.trim()) throw new Error("clipboard empty");
      onEntriesChange(updateLearningHistoryAnswer(entry.id, answer));
      onStatusChange(entry.id, "已從剪貼簿儲存 Google AI 解答。");
    } catch {
      onStatusChange(entry.id, "無法讀取剪貼簿；請允許權限，或在下方手動貼上 Google AI 解答。");
    }
  }

  return (
    <section className="learning-history" aria-labelledby="learning-history-heading">
      <div className="learning-history-heading">
        <div>
          <span className="public-eyebrow">我的學習</span>
          <h2 id="learning-history-heading">學習紀錄</h2>
          <p>只儲存在這台裝置的瀏覽器，最多保留 50 筆。</p>
        </div>
        <button type="button" className="learning-history-clear" onClick={() => onEntriesChange(clearLearningHistory())} disabled={!entries.length}>
          清除全部
        </button>
      </div>
      {!entries.length ? <p className="learning-history-empty">尚無提問紀錄。送出問題後會顯示在這裡。</p> : (
        <ol className="learning-history-list">
          {entries.map((entry) => (
            <li key={entry.id} className="learning-history-entry">
              <div className="learning-history-entry-topline">
                <div>
                  <span className={`learning-history-strategy ${entry.strategy}`}>{entry.strategy === "google-ai" ? "Google AI" : "API 模式"}</span>
                  <span>{entry.category === "auto" ? "自動判斷" : entry.category} · {SOURCE_LABELS[entry.sourceType]}</span>
                </div>
                <button type="button" className="learning-history-delete" onClick={() => onEntriesChange(removeLearningHistoryEntry(entry.id))} aria-label={`刪除問題：${entry.question}`}>
                  刪除
                </button>
              </div>
              <p className="learning-history-question">{entry.question}</p>
              <time dateTime={entry.askedAt}>{new Intl.DateTimeFormat("zh-TW", { dateStyle: "medium", timeStyle: "short" }).format(new Date(entry.askedAt))}</time>
              {entry.strategy === "google-ai" ? (
                <div className="learning-history-google-workflow">
                  <div className="learning-history-actions">
                    <a href={googleAiSearchUrl(entry.question)} target="_blank" rel="noopener noreferrer">重新開啟 Google AI</a>
                    <button type="button" onClick={() => void pasteGoogleAnswer(entry)}>從剪貼簿貼上 Google AI 解答</button>
                  </div>
                  <label>
                    <span className="sr-only">Google AI 解答</span>
                    <textarea
                      value={entry.answer ?? ""}
                      onChange={(event) => onEntriesChange(updateLearningHistoryAnswer(entry.id, event.target.value))}
                      placeholder="將 Google AI 解答貼在這裡…"
                      rows={4}
                    />
                  </label>
                  {statuses[entry.id] ? <p className="learning-history-status" role="status" aria-live="polite">{statuses[entry.id]}</p> : null}
                </div>
              ) : entry.answer ? <p className="learning-history-answer">{entry.answer}</p> : <p className="learning-history-pending">API 解答會在成功取得後儲存在這裡。</p>}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export function PublicHomePage() {
  const location = useLocation();
  const navigate = useNavigate();
  const isAnswerRoute = location.pathname === "/guest-answer";
  const [config, setConfig] = useState<PublicSiteConfig>(DEFAULT_CONFIG);
  const [question, setQuestion] = useState("");
  const [category, setCategory] = useState<GuestQuestionCategory>("auto");
  const [strategy, setStrategy] = useState<AnswerStrategy>("google-ai");
  const [providerPreference, setProviderPreference] = useState<GuestProviderPreference>("auto");
  const [response, setResponse] = useState<GuestAskResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");
  const [lastSourceType, setLastSourceType] = useState<"manual" | "image" | "file">("manual");
  const [restoringAnswer, setRestoringAnswer] = useState(isAnswerRoute);
  const [learningHistory, setLearningHistory] = useState<LearningHistoryEntry[]>(() => readLearningHistory());
  const [googleStatus, setGoogleStatus] = useState("");
  const [historyStatuses, setHistoryStatuses] = useState<Record<string, string>>({});
  const requestAbortRef = useRef<AbortController | null>(null);
  const { user } = useStudentAuth();
  const studentName = user?.displayName || "";

  useEffect(() => {
    let active = true;
    studentClient
      .getPublicSiteConfig()
      .then((next) => active && setConfig({ ...DEFAULT_CONFIG, ...next }))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

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
      setResponse(result);
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
        state: { guestResponse: publicGuestAnswerForHistory(result) }
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
    setGoogleStatus("已將問題送往 Google AI；若新分頁未自動開啟，請使用下方紀錄中的「重新開啟 Google AI」。返回後可將解答貼回學習紀錄。");
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

  return (
    <div className="public-home-page">
      <PublicHomeHeader config={config} studentName={studentName} />
      <main className="public-home-main">
        {config.maintenanceNotice ? <div className="public-maintenance-notice">{config.maintenanceNotice}</div> : null}
        <section className="public-hero" aria-labelledby="public-home-heading">
          <div className="public-hero-orbit public-hero-orbit-one" />
          <div className="public-hero-orbit public-hero-orbit-two" />
          <span className="public-eyebrow">智慧學習入口 · AI-SmartBook</span>
          <h1 id="public-home-heading">
            {studentName ? `${studentName}，${config.homeGreeting}` : config.homeGreeting}
          </h1>
          <p className="public-hero-subtitle">{config.siteSubtitle}</p>
          <p className="public-hero-copy">輸入題目、選取教材內容，或上傳圖片開始智慧解題。</p>

        {!response && !restoringAnswer ? (
            <>
              <HomeAIComposer
                value={question}
                onChange={setQuestion}
                onSubmit={(nextSourceType) => {
                  if (strategy === "google-ai") submitGoogleAiQuestion(nextSourceType);
                  else void submitGuestQuestion(nextSourceType);
                }}
                placeholder={config.homeInputPlaceholder}
                category={category}
                onCategoryChange={setCategory}
                strategy={strategy}
                onStrategyChange={setStrategy}
                providerPreference={providerPreference}
                onProviderPreferenceChange={setProviderPreference}
                busy={busy}
                autoFocus={!busy}
              />
              <div className="public-composer-meta">
                <span>{strategy === "google-ai" ? "Google AI 不需 API 金鑰 · 每題最多 2,000 字" : `訪客每日可體驗 ${config.guestDailyLimit} 題 · 每題最多 2,000 字`}</span>
                <span>目前模式：{category === "auto" ? "自動判斷" : category}</span>
              </div>
              {error ? <p className="public-form-error" role="alert">{error}</p> : null}
              {googleStatus ? <p className="public-google-status" role="status" aria-live="polite">{googleStatus}</p> : null}
              {feedback ? <p className="public-feedback-text" role="status">{feedback}</p> : null}
              {busy ? (
                <button type="button" className="public-back-button public-cancel-question-button" onClick={resetQuestion}>
                  ← 取消並返回首頁
                </button>
              ) : null}
              <div className="public-quick-starts" aria-label="快速題型">
                {QUICK_STARTS.map((item) => (
                  <button
                    type="button"
                    key={item.label}
                    onClick={() => {
                      setQuestion(item.question);
                      setCategory(item.category);
                    }}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
              <LearningHistoryPanel
                entries={learningHistory}
                onEntriesChange={setLearningHistory}
                onStatusChange={(id, message) => setHistoryStatuses((current) => ({ ...current, [id]: message }))}
                statuses={historyStatuses}
              />
            </>
        ) : restoringAnswer ? (
          <p className="public-answer-loading" role="status">正在載入回答…</p>
        ) : response ? (
            <GuestAnswer
              question={question}
              response={response}
              onFeedback={(helpful) => void submitFeedback(helpful)}
              onReset={resetQuestion}
              onRetry={retryGuestQuestion}
            />
          ) : null}
        </section>

        <section id="features" className="public-feature-strip" aria-label="AI-SmartBook 功能">
          <div><span>01</span><strong>快速理解</strong><p>把問題整理成清楚、可行動的學習步驟。</p></div>
          <div><span>02</span><strong>教材連結</strong><p>登入後從個人書庫延伸追問與複習。</p></div>
          <div><span>03</span><strong>學習留存</strong><p>保存回答、進度與最近提問，隨時接續。</p></div>
        </section>
      </main>
      <footer className="public-home-footer">AI-SmartBook · 公開體驗回答僅供學習參考</footer>
    </div>
  );
}
