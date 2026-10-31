import { Link } from "react-router-dom";
import { StudentAnswerRenderer } from "../../components/GuestAnswerRenderer";
import type { GuestAskResponse } from "../../studentClient";

export function GuestAnswer({
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
          <strong>iBrain AI 學習助教</strong>
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
