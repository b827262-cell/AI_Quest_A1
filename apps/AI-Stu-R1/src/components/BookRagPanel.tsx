import { useState, type FormEvent } from "react";
import { studentClient, StudentApiError, type BookRagAnswer } from "../studentClient";

/**
 * Book-scoped RAG QA panel. Calls the real Student API endpoint
 * POST /api/student/books/:bookId/rag-ask; the browser never supplies
 * identity. Citations are rendered exactly as returned by the API (they are
 * validator-checked server-side).
 */

export type BookRagStatus =
  | "idle"
  | "submitting"
  | "answer"
  | "no-source"
  | "unsafe-input"
  | "timeout"
  | "rate-limit"
  | "provider-unavailable"
  | "session-expired"
  | "error";

interface BookRagState {
  status: BookRagStatus;
  response: BookRagAnswer | null;
  message: string | null;
}

const INITIAL_STATE: BookRagState = { status: "idle", response: null, message: null };

function failureState(error: unknown): BookRagState {
  if (error instanceof StudentApiError) {
    if (error.status === 401) {
      return { status: "session-expired", response: null, message: "登入狀態已失效，請重新登入後再試。" };
    }
    switch (error.code) {
      case "RAG_INJECTION_BLOCKED":
        return { status: "unsafe-input", response: null, message: "問題未通過安全檢查，請換個方式描述。" };
      case "RAG_PROVIDER_TIMEOUT":
        return { status: "timeout", response: null, message: "AI 服務逾時，請稍後重試。" };
      case "RAG_PROVIDER_RATE_LIMITED":
        return { status: "rate-limit", response: null, message: "目前發問太頻繁，請稍後再試。" };
      case "RAG_PROVIDER_AUTH_FAILED":
      case "RAG_PROVIDER_UNAVAILABLE":
      case "RAG_PROVIDER_INVALID_RESPONSE":
      case "RAG_CITATION_INVALID":
        return { status: "provider-unavailable", response: null, message: "AI 服務暫時無法使用，請稍後再試。" };
      default:
        return { status: "error", response: null, message: error.message || "問答服務暫時無法使用。" };
    }
  }
  return { status: "error", response: null, message: "網路或服務發生問題，請重試。" };
}

export function BookRagPanel({ bookId }: { bookId: string }) {
  const [question, setQuestion] = useState("");
  const [state, setState] = useState<BookRagState>(INITIAL_STATE);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const query = question.trim();
    if (!query || state.status === "submitting") return;
    setState({ status: "submitting", response: null, message: null });
    try {
      const response = await studentClient.askBookRag(bookId, { query });
      if (response.abstained || response.grounding === "abstained") {
        setState({ status: "no-source", response, message: "書本內容中找不到足夠的證據回答這個問題。" });
        return;
      }
      setState({ status: "answer", response, message: null });
    } catch (error) {
      setState(failureState(error));
    }
  }

  const retryable = ["timeout", "rate-limit", "provider-unavailable", "error"].includes(state.status);

  return (
    <section className="book-rag-panel" aria-label="書本 RAG 問答">
      <header className="book-rag-panel-head">
        <h3>書本智慧問答</h3>
        <p className="muted">僅依本書內容回答，並附上來源引用。</p>
      </header>
      <form className="book-rag-form" onSubmit={submit}>
        <input
          className="book-rag-input"
          type="text"
          value={question}
          maxLength={4000}
          placeholder="針對這本書提問……"
          onChange={(event) => setQuestion(event.target.value)}
          disabled={state.status === "submitting"}
          aria-label="書本問題"
        />
        <button className="book-rag-submit" type="submit" disabled={state.status === "submitting" || !question.trim()}>
          {state.status === "submitting" ? "檢索中……" : "提問"}
        </button>
      </form>

      {state.status === "submitting" ? (
        <p className="book-rag-status muted" role="status">正在檢索書本內容並生成回答……</p>
      ) : null}

      {state.status === "no-source" ? (
        <p className="book-rag-status book-rag-nosource" role="status">{state.message}</p>
      ) : null}

      {["unsafe-input", "timeout", "rate-limit", "provider-unavailable", "session-expired", "error"].includes(state.status) ? (
        <p className="book-rag-status book-rag-error" role="alert">
          {state.message}
          {retryable ? (
            <button type="button" className="book-rag-retry" onClick={() => setState(INITIAL_STATE)}>
              重試
            </button>
          ) : null}
        </p>
      ) : null}

      {state.status === "answer" && state.response ? (
        <div className="book-rag-answer">
          <p>{state.response.answer}</p>
          {state.response.citations.length > 0 ? (
            <ul className="book-rag-citations" aria-label="引用來源">
              {state.response.citations.map((citation) => (
                <li key={citation.chunkId}>
                  <span className="book-rag-citation-label">{citation.label}</span>
                  {citation.locator ? <span className="muted"> · {citation.locator}</span> : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
