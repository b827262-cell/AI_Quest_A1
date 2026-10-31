import { useState } from "react";
import {
  clearLearningHistory,
  googleAiSearchUrl,
  removeLearningHistoryEntry,
  updateLearningHistoryContent,
  type LearningHistoryEntry
} from "../../learningHistory";
import { SOURCE_LABELS } from "./constants";

export function LearningHistoryPanel({
  entries,
  onEntriesChange,
  onStatusChange,
  statuses,
  onIntake,
  signedIn
}: {
  entries: LearningHistoryEntry[];
  onEntriesChange: (entries: LearningHistoryEntry[]) => void;
  onStatusChange: (id: string, message: string) => void;
  statuses: Record<string, string>;
  onIntake: (rawAnswer: string, preferredEntry?: LearningHistoryEntry) => void;
  signedIn: boolean;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState({ rawAnswer: "", sourceUrl: "" });

  function startEditing(entry: LearningHistoryEntry) {
    setEditingId(entry.id);
    setDraft({ rawAnswer: entry.rawAnswer ?? "", sourceUrl: entry.sourceUrl ?? "" });
  }

  function cancelEditing() {
    setEditingId(null);
    setDraft({ rawAnswer: "", sourceUrl: "" });
  }

  function saveEditing(entry: LearningHistoryEntry) {
    const result = updateLearningHistoryContent(entry.id, draft);
    if (result.status === "saved") {
      onEntriesChange(result.entries);
      onStatusChange(entry.id, "已儲存這筆紀錄的修改。空白欄位已移除。");
      cancelEditing();
      return;
    }
    const message = result.status === "rejected_url_only"
      ? "回答文字未儲存；請將 Google AI／搜尋網址貼到來源連結欄位。"
      : result.status === "rejected_source_url"
        ? "來源連結無效：請使用 https://www.google.com/search 且包含 udm=50 與這題的 q 參數。"
        : result.status === "question_mismatch"
        ? "來源連結的 q 參數與這筆問題不相符，未儲存修改。"
        : "找不到這筆紀錄，未儲存修改。";
    onStatusChange(entry.id, message);
  }

  async function pasteGoogleAnswer(entry: LearningHistoryEntry) {
    try {
      if (!navigator.clipboard?.readText) throw new Error("clipboard unavailable");
      const answer = await navigator.clipboard.readText();
      if (!answer.trim()) throw new Error("clipboard empty");
      onIntake(answer, entry);
    } catch {
      onStatusChange(entry.id, "無法讀取剪貼簿；請允許權限，或展開下方手動貼上備援。");
    }
  }

  return (
    <section className="learning-history" aria-labelledby="learning-history-heading">
      <div className="learning-history-heading">
        <div>
          <span className="public-eyebrow">我的學習</span>
          <h2 id="learning-history-heading">學習紀錄</h2>
          <p>{signedIn ? "登入紀錄會同步到後台；訪客紀錄需按上方按鈕明確匯入。" : "只儲存在這台裝置。"} 原始回覆會保留，其他待處理紀錄最多保留 50 筆。</p>
        </div>
        <button type="button" className="learning-history-clear" onClick={() => onEntriesChange(clearLearningHistory())} disabled={!entries.length}>
          清除全部
        </button>
      </div>
      {!entries.length ? <p className="learning-history-empty">尚無提問紀錄。送出問題後會顯示在這裡。</p> : (
        <ol className="learning-history-list">
          {entries.map((entry) => {
            const isEditing = editingId === entry.id;
            return <li key={entry.id} className="learning-history-entry">
              <div className="learning-history-entry-topline">
                <div>
                  <span className={`learning-history-strategy ${entry.strategy}`}>{entry.strategy === "google-ai" ? "搜尋好朋友／谷哥" : "API 模式"}</span>
                  <span>{entry.category === "auto" ? "自動判斷" : entry.category} · {SOURCE_LABELS[entry.sourceType]}</span>
                </div>
                <div className="learning-history-entry-actions">
                  <button type="button" className="learning-history-edit" onClick={() => startEditing(entry)} aria-label={`修改問題：${entry.question}`}>
                    修改
                  </button>
                  <button type="button" className="learning-history-delete" onClick={() => onEntriesChange(removeLearningHistoryEntry(entry.id))} aria-label={`刪除問題：${entry.question}`}>
                    刪除
                  </button>
                </div>
              </div>
              <p className="learning-history-question">{entry.question}</p>
              <time dateTime={entry.askedAt}>{new Intl.DateTimeFormat("zh-TW", { dateStyle: "medium", timeStyle: "short" }).format(new Date(entry.askedAt))}</time>
              {isEditing ? <form className="learning-history-edit-form" onSubmit={(event) => { event.preventDefault(); saveEditing(entry); }}>
                <label>
                  <span>原始回覆文字</span>
                  <textarea value={draft.rawAnswer} onChange={(event) => setDraft((current) => ({ ...current, rawAnswer: event.target.value }))} rows={5} />
                </label>
                <label>
                  <span>搜尋好朋友來源連結</span>
                  <input type="text" inputMode="url" value={draft.sourceUrl} onChange={(event) => setDraft((current) => ({ ...current, sourceUrl: event.target.value }))} placeholder="https://www.google.com/search?udm=50&q=…" />
                </label>
                <p className="learning-history-edit-help">原始回覆會在儲存時於裝置上重新整理；清空欄位後儲存會移除該資料。</p>
                <div className="learning-history-actions">
                  <button type="submit">儲存</button>
                  <button type="button" onClick={cancelEditing}>取消</button>
                </div>
                {statuses[entry.id] ? <p className="learning-history-status" role="status" aria-live="polite">{statuses[entry.id]}</p> : null}
              </form> : entry.strategy === "google-ai" ? (
                <div className="learning-history-google-workflow">
                  <div className="learning-history-actions">
                    <a href={entry.sourceUrl ?? googleAiSearchUrl(entry.question)} target="_blank" rel="noopener noreferrer">用搜尋好朋友／谷哥開啟</a>
                    <button type="button" onClick={() => void pasteGoogleAnswer(entry)}>從剪貼簿帶回回答</button>
                  </div>
                  {entry.rawAnswer ? <>
                    <p className="learning-history-raw-label">整理後回覆（僅在裝置上以原始回覆格式化）</p>
                    <p className="learning-history-answer">{entry.organizedAnswer}</p>
                    <details className="learning-history-raw-evidence">
                      <summary>查看原始回覆</summary>
                      <pre>{entry.rawAnswer}</pre>
                    </details>
                  </> : <details className="learning-history-manual-fallback">
                    <summary>手動貼上備援</summary>
                    <p className="learning-history-edit-help">請按「修改」貼上回覆，再按「儲存」；離開欄位不會儲存。</p>
                  </details>}
                  {statuses[entry.id] ? <p className="learning-history-status" role="status" aria-live="polite">{statuses[entry.id]}</p> : null}
                </div>
              ) : entry.answer ? <p className="learning-history-answer">{entry.answer}</p> : <p className="learning-history-pending">API 解答會在成功取得後儲存在這裡。</p>}
            </li>;
          })}
        </ol>
      )}
    </section>
  );
}
