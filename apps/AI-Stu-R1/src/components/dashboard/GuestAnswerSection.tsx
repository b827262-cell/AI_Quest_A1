import { useState, type FormEvent } from "react";
import type { GuestAnswerStatus, GuestAskResponse } from "../../studentClient";
import { StudentAnswerRenderer } from "../GuestAnswerRenderer";

type GuestSectionStatus = "idle" | "loading" | "success" | "error";

interface GuestAnswerSectionProps {
  response: GuestAskResponse | null;
  status: GuestSectionStatus;
  error: string | null;
  onAsk: (question: string) => Promise<void>;
  onFeedback?: (helpful: boolean) => void;
}

function responseMessage(status: GuestAnswerStatus): string | null {
  switch (status) {
    case "limit_reached":
      return "訪客體驗次數已用完；登入後可繼續使用個人化學習功能。";
    case "rate_limited":
      return "目前請求較多，請稍後再試。";
    case "disabled":
      return "訪客問答目前暫停，請登入後繼續。";
    case "incomplete":
      return "這次回答可能尚未完整結束，可以重新產生一次。";
    case "error":
      return "這次回答沒有完成，請重新嘗試。";
    default:
      return null;
  }
}

export function GuestAnswerSection({
  response,
  status,
  error,
  onAsk,
  onFeedback
}: GuestAnswerSectionProps) {
  const [question, setQuestion] = useState("");
  const [lastQuestion, setLastQuestion] = useState("");
  const [feedbackSent, setFeedbackSent] = useState(false);

  async function submitQuestion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = question.trim();
    if (!trimmed || status === "loading") return;
    setLastQuestion(trimmed);
    setFeedbackSent(false);
    await onAsk(trimmed);
  }

  function retry() {
    if (!lastQuestion || status === "loading") return;
    setFeedbackSent(false);
    void onAsk(lastQuestion);
  }

  const answerText = response?.answer || response?.structuredAnswer;
  const responseNotice = response ? responseMessage(response.status) : null;
  const canRetry = Boolean(lastQuestion) && (status === "error" || response?.status === "incomplete" || response?.status === "error");

  return (
    <section className="dashboard-panel dashboard-guest-answer" aria-labelledby="guest-answer-heading">
      <div className="dashboard-section-heading">
        <div>
          <span className="dashboard-eyebrow">Guest Answer</span>
          <h2 id="guest-answer-heading">快速問 AI</h2>
        </div>
        <span className="dashboard-heading-note">公開體驗</span>
      </div>
      <p className="dashboard-panel-copy">
        先輸入一個問題開始；回答會以目前公開問答契約提供的內容為準，不會補造不存在的引用。
      </p>

      <form className="dashboard-guest-form" onSubmit={(event) => void submitQuestion(event)}>
        <label htmlFor="dashboard-guest-question">你的問題</label>
        <textarea
          id="dashboard-guest-question"
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          placeholder="例如：如何把一個複雜的問題拆成幾個學習步驟？"
          maxLength={2000}
          rows={3}
          disabled={status === "loading"}
        />
        <div className="dashboard-form-footer">
          <span>{question.length} / 2,000</span>
          <button className="dashboard-primary-button" type="submit" disabled={status === "loading" || !question.trim()}>
            {status === "loading" ? "回答中…" : "送出問題"}
          </button>
        </div>
      </form>

      {status === "loading" ? (
        <div className="dashboard-answer-state" role="status" aria-live="polite">
          <span className="dashboard-spinner" aria-hidden="true" />
          <span>正在整理回答，請稍候…</span>
        </div>
      ) : null}

      {status === "error" ? (
        <div className="dashboard-answer-state dashboard-state-error" role="alert">
          <strong>回答暫時無法取得</strong>
          <span>{error || "請檢查連線後重試。"}</span>
          {canRetry ? <button className="dashboard-secondary-button" type="button" onClick={retry}>重試</button> : null}
        </div>
      ) : null}

      {status === "idle" && !response ? (
        <div className="dashboard-answer-empty">
          <span aria-hidden="true">✦</span>
          <p>回答會顯示在這裡。請先輸入問題。</p>
        </div>
      ) : null}

      {status === "success" && response ? (
        <article className="dashboard-answer-result" aria-live="polite">
          <div className="dashboard-answer-meta">
            <span className="dashboard-answer-badge">AI 學習助教</span>
            {response.mode === "mock" ? <span className="dashboard-answer-mode">Mock 示範</span> : null}
            {response.remainingGuestQuestions !== undefined ? (
              <span>剩餘體驗：{response.remainingGuestQuestions}</span>
            ) : null}
          </div>
          <div className="dashboard-question-echo">
            <span>你的問題</span>
            <p>{response.question || lastQuestion}</p>
          </div>
          {answerText ? (
            <StudentAnswerRenderer content={response.structuredAnswer} fallback={response.answer} />
          ) : (
            <p className="dashboard-answer-missing">目前沒有可顯示的回答內容。</p>
          )}
          {responseNotice ? (
            <div className="dashboard-answer-notice" role="status">
              <span>{responseNotice}</span>
              {canRetry ? <button className="dashboard-secondary-button" type="button" onClick={retry}>重新產生</button> : null}
            </div>
          ) : null}
          {response.status === "success" && onFeedback ? (
            <div className="dashboard-feedback" role="group" aria-label="回答回饋">
              <span>這個回答有幫助嗎？</span>
              <button type="button" onClick={() => { onFeedback(true); setFeedbackSent(true); }} disabled={feedbackSent}>有幫助</button>
              <button type="button" onClick={() => { onFeedback(false); setFeedbackSent(true); }} disabled={feedbackSent}>需要改進</button>
              {feedbackSent ? <span role="status">謝謝你的回饋。</span> : null}
            </div>
          ) : null}
        </article>
      ) : null}
    </section>
  );
}
