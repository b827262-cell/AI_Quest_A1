import React, { useState, type FormEvent } from "react";
import { studentClient, StudentApiError, type BookRagAnswer, type BookRagClaim } from "../studentClient";

/**
 * Book-scoped RAG QA panel. Calls the real Student API endpoint
 * POST /api/student/books/:bookId/rag-ask; the browser never supplies
 * identity. Citations are rendered exactly as returned by the API (they are
 * validator-checked server-side). Claim-level grounding is surfaced so
 * reviewers/learners can locate unsupported spans inline.
 */

export type BookRagStatus =
  | "idle"
  | "submitting"
  | "answer"
  | "answer-partial"
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
      if (response.grounding === "unverified" || (response.unsupportedClaimCount ?? 0) > 0) {
        setState({ status: "answer-partial", response, message: null });
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
          <p className="book-rag-grounding-badge book-rag-grounding-verified" role="status">
            <span aria-hidden="true">✓</span> 已驗證
          </p>
          <p>{state.response.answer}</p>
          {renderCitations(state.response)}
        </div>
      ) : null}

      {state.status === "answer-partial" && state.response ? (
        <div className="book-rag-answer book-rag-answer-partial">
          <p className="book-rag-grounding-badge book-rag-grounding-partial" role="alert">
            <span aria-hidden="true">⚠</span> 部分支持 — {state.response.unsupportedClaimCount ?? 0} 個 claim 未獲來源支持
          </p>
          <p className="book-rag-partial-warning" role="alert">
            此回答包含未被來源支持的具體內容，請勿將標示段落視為已驗證事實。
          </p>
          {renderAnnotatedAnswer(state.response)}
          {renderUnsupportedClaims(state.response)}
          {renderCitations(state.response)}
        </div>
      ) : null}
    </section>
  );
}

const HIGH_RISK_LABELS: Record<string, string> = {
  number: "數字",
  date: "日期",
  formula: "公式",
  proper_noun: "專有名詞"
};

/** Render the answer with unsupported claim spans wrapped in <mark>. */
function renderAnnotatedAnswer(response: BookRagAnswer): React.ReactElement {
  const claims = response.claims ?? [];
  const unsupported = claims.filter((c) => c.status === "unsupported");
  if (unsupported.length === 0) {
    return <p>{response.answer}</p>;
  }
  // Sort by start offset; build segments with marks on unsupported spans.
  const sorted = [...unsupported].sort((a, b) => a.answerStart - b.answerStart);
  const segments: React.ReactElement[] = [];
  let cursor = 0;
  for (const claim of sorted) {
    if (claim.answerStart > cursor) {
      segments.push(<span key={`text-${cursor}`}>{response.answer.slice(cursor, claim.answerStart)}</span>);
    }
    const isHighRisk = claim.riskCategory && claim.riskCategory !== "general";
    const riskLabel = claim.riskCategory ? HIGH_RISK_LABELS[claim.riskCategory] : undefined;
    segments.push(
      <mark
        key={`mark-${claim.claimId}`}
        className={isHighRisk ? "rag-unsupported-claim rag-unsupported-claim--high-risk" : "rag-unsupported-claim"}
        aria-label={`此段內容缺乏來源支持${riskLabel ? `（${riskLabel}）` : ""}`}
        data-claim-id={claim.claimId}
      >
        {claim.text}
      </mark>
    );
    cursor = claim.answerEnd;
  }
  if (cursor < response.answer.length) {
    segments.push(<span key={`text-tail`}>{response.answer.slice(cursor)}</span>);
  }
  return <p className="book-rag-annotated-answer">{segments}</p>;
}

/** Render the list of unsupported claims with risk category and claim id. */
function renderUnsupportedClaims(response: BookRagAnswer): React.ReactElement | null {
  const claims = response.claims ?? [];
  const unsupported = claims.filter((c) => c.status === "unsupported");
  if (unsupported.length === 0) return null;
  return (
    <ul className="book-rag-unsupported-claims" aria-label="未獲支持的 claim">
      {unsupported.map((claim: BookRagClaim) => {
        const riskLabel = claim.riskCategory && claim.riskCategory !== "general"
          ? HIGH_RISK_LABELS[claim.riskCategory]
          : null;
        return (
          <li key={claim.claimId}>
            <code className="book-rag-claim-id" aria-label="claim 識別碼">{claim.claimId}</code>
            {riskLabel ? <span className="book-rag-risk-tag" aria-label={`高風險類型：${riskLabel}`}>{riskLabel}</span> : null}
            <span className="book-rag-claim-text">{claim.text}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** Render citations with evidence quote and an expandable audit hash region. */
function renderCitations(response: BookRagAnswer): React.ReactElement | null {
  if (response.citations.length === 0) return null;
  return (
    <ul className="book-rag-citations" aria-label="引用來源">
      {response.citations.map((citation) => (
        <li key={citation.chunkId}>
          <span className="book-rag-citation-label">{citation.label}</span>
          {citation.locator ? <span className="muted"> · {citation.locator}</span> : null}
          {citation.evidenceQuote ? (
            <span className="book-rag-evidence-quote" aria-label="證據原文">「{citation.evidenceQuote}」</span>
          ) : null}
          {citation.contentHash ? (
            <details className="book-rag-audit">
              <summary aria-label="稽核資訊">稽核</summary>
              <dl>
                <dt>hash</dt>
                <dd><code data-content-hash={citation.contentHash}>{citation.contentHash}</code></dd>
                <dt>algorithm</dt>
                <dd>{citation.hashAlgorithm ?? "sha256"}</dd>
              </dl>
            </details>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
