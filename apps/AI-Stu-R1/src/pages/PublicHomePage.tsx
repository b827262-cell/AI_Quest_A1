import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { HomeAIComposer } from "../components/HomeAIComposer";
import { StudentAnswerRenderer } from "../components/GuestAnswerRenderer";
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

export function PublicHomePage() {
  const location = useLocation();
  const navigate = useNavigate();
  const isAnswerRoute = location.pathname === "/guest-answer";
  const [config, setConfig] = useState<PublicSiteConfig>(DEFAULT_CONFIG);
  const [question, setQuestion] = useState("");
  const [category, setCategory] = useState<GuestQuestionCategory>("auto");
  const [providerPreference, setProviderPreference] = useState<GuestProviderPreference>("auto");
  const [response, setResponse] = useState<GuestAskResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");
  const [lastSourceType, setLastSourceType] = useState<"manual" | "image" | "file">("manual");
  const [restoringAnswer, setRestoringAnswer] = useState(isAnswerRoute);
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
                  void submitGuestQuestion(nextSourceType);
                }}
                placeholder={config.homeInputPlaceholder}
                category={category}
                onCategoryChange={setCategory}
                providerPreference={providerPreference}
                onProviderPreferenceChange={setProviderPreference}
                busy={busy}
                autoFocus={!busy}
              />
              <div className="public-composer-meta">
                <span>訪客每日可體驗 {config.guestDailyLimit} 題 · 每題最多 2,000 字</span>
                <span>目前模式：{category === "auto" ? "自動判斷" : category}</span>
              </div>
              {error ? <p className="public-form-error" role="alert">{error}</p> : null}
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
