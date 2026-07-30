import { useCallback, useEffect, useRef, useState } from "react";
import type { BookQaLog } from "@ai-smartbook/schema";
import { adminApi } from "../../api";

export function QaTab({ bookId }: { bookId: string }) {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [context, setContext] = useState<string[]>([]);
  const [markdown, setMarkdown] = useState("");
  const [logs, setLogs] = useState<BookQaLog[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const reloadLogs = useCallback(async () => {
    try {
      const r = await adminApi.getQaLogs(bookId);
      setLogs(r.logs);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [bookId]);

  useEffect(() => {
    void reloadLogs();
  }, [reloadLogs]);

  async function ask(e: React.FormEvent) {
    e.preventDefault();
    if (!question.trim()) return;
    setBusy(true);
    setError("");
    setMsg("");
    setAnswer("");
    try {
      const r = await adminApi.ask(bookId, question);
      setAnswer(r.answer);
      setContext(r.context);
      await reloadLogs();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onImport() {
    if (!markdown.trim()) return;
    setBusy(true);
    setError("");
    setMsg("");
    try {
      const r = await adminApi.importQaMarkdown(bookId, markdown);
      setMsg(`已手動上架 ${r.imported} 組 Q&A`);
      setMarkdown("");
      if (fileRef.current) fileRef.current.value = "";
      reloadLogs();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onPickMarkdown(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setError("");
    try {
      setMarkdown(await file.text());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>手動上架 Q&A Markdown</h3>
        <p className="muted" style={{ marginTop: 0 }}>
          老師可上傳 `.md` 檔，內容使用 `Q:` / `A:` 格式即可批次建立問答。
        </p>
        <p className="muted" style={{ marginTop: 0 }}>
          重複上架會新增新的問答紀錄；若需覆蓋，請先清空既有手動 Q&A。
        </p>
        <div className="row" style={{ marginBottom: 12, alignItems: "center" }}>
          <input
            ref={fileRef}
            type="file"
            accept=".md,text/markdown,text/plain"
            onChange={onPickMarkdown}
            style={{ maxWidth: 360 }}
          />
          <button className="btn" type="button" onClick={onImport} disabled={busy || !markdown.trim()}>
            {busy ? "上架中…" : "手動上架"}
          </button>
        </div>
        <textarea
          rows={10}
          value={markdown}
          onChange={(e) => setMarkdown(e.target.value)}
          placeholder={"Q: 這本書在做什麼？\nA: 這是老師整理好的標準答案。\n\nQ: 第二題...\nA: 第二題答案..."}
          style={{ width: "100%", resize: "vertical" }}
        />
        {msg && <p className="muted">{msg}</p>}
        {error && <p className="error">{error}</p>}
      </div>

      <form className="card" onSubmit={ask}>
        <h3 style={{ marginTop: 0 }}>知識問答</h3>
        <div className="row">
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="輸入關於此書的問題…"
            style={{ flex: 1 }}
          />
          <button className="btn" disabled={busy || !question.trim()}>
            {busy ? "詢問中…" : "送出"}
          </button>
        </div>
        {error && <p className="error">{error}</p>}
      </form>

      {answer && (
        <div className="card">
          <strong>回答</strong>
          <div className="chat-answer" style={{ marginTop: 8 }}>
            {answer}
          </div>
          {context.length > 0 && (
            <details style={{ marginTop: 12 }}>
              <summary className="muted">引用內容（{context.length}）</summary>
              <ul>
                {context.map((c, i) => (
                  <li key={i} className="muted">
                    {c}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      <div className="card">
        <h3 style={{ marginTop: 0 }}>已上架問答（{logs.length}）</h3>
        {logs.length === 0 ? (
          <p className="muted">尚無手動或 AI 問答紀錄。</p>
        ) : (
          logs.map((log) => (
            <div key={log.id} style={{ padding: "12px 0", borderTop: "1px solid #e5e7eb" }}>
              <div className="row between" style={{ gap: 12, alignItems: "flex-start" }}>
                <strong style={{ flex: 1 }}>{log.question}</strong>
                <span className="muted" style={{ whiteSpace: "nowrap" }}>
                  {log.provider}/{log.model}
                </span>
              </div>
              <p className="muted" style={{ marginBottom: 0, whiteSpace: "pre-wrap" }}>
                {log.answer}
              </p>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
