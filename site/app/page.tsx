"use client";

// Auto public-answer page — fail-closed to Chrome Built-in AI.
//
// This page renders the learner-facing Auto answer flow for the public
// experience. It deliberately has no network fallback, no server AI endpoint,
// and no shared-backend answer route. It must NEVER reference cloud-AI
// endpoints, provider API keys, or the legacy public-answer guest path. The
// canonical forbidden list (provider keys, cloud-AI hosts, legacy
// public-answer routes) is enforced by the source/bundle gate in
// `tests/chrome-built-in-ai.test.mjs`, which scans both this file and the
// built client bundle. Adding any forbidden token here or shipping one
// through the build will fail that gate.

import { FormEvent, useRef, useState } from "react";
import { AutoAiStatus, createAutoSubmitter } from "./chrome-built-in-ai";

const quickModes = ["程式設計", "數學解題", "教材問答", "資通安全"];

function BrandMark() {
  return <span className="brand-mark" aria-hidden="true">◖◗</span>;
}

export default function Home() {
  const [question, setQuestion] = useState("");
  const [model, setModel] = useState("Auto");
  const [mode, setMode] = useState("自動判斷");
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [aiStatus, setAiStatus] = useState<AutoAiStatus | "">("");
  const [downloadProgress, setDownloadProgress] = useState<number | null>(null);
  const [needsLocalModelGesture, setNeedsLocalModelGesture] = useState(false);
  const autoSubmitter = useRef(createAutoSubmitter());

  async function submit(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const trimmedQuestion = question.trim();
    if (!trimmedQuestion || isLoading) return;

    setAnswer("");
    setError("");
    setAiStatus("");
    setDownloadProgress(null);
    setNeedsLocalModelGesture(false);
    if (model !== "Auto") {
      setError("公開體驗目前僅支援 Auto（Chrome 內建 AI）回答。");
      return;
    }

    setIsLoading(true);
    try {
      const finalAnswer = await autoSubmitter.current.submit(
        trimmedQuestion,
        (chunk) => setAnswer((current) => current + chunk),
        (status, progress) => {
          setAiStatus(status);
          setDownloadProgress(typeof progress === "number" ? progress : null);
          if (status === "local model requires user activation") setNeedsLocalModelGesture(true);
        },
      );
      setAnswer(finalAnswer);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "目前無法取得 AI 回答，請稍後再試。");
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <main className="learning-page">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="AI-SmartBook 首頁">
          <BrandMark />
          <strong>AI-SmartBook</strong>
        </a>
        <nav aria-label="主要導覽">
          <a href="#features">功能介紹</a>
          <a className="login-button" href="#login">學員登入</a>
        </nav>
      </header>

      <section className="learning-hero" id="top">
        <div className="intro">
          <p className="kicker"><span />智慧學習入口 · AI-SMARTBOOK</p>
          <h1>今天想學習什麼？</h1>
          <p className="subtitle">多模型領域智慧解題平台</p>
          <p className="hint">輸入題目、選取教材內容，或上傳圖片開始智慧解題。</p>
        </div>

        <form className="question-card" onSubmit={submit}>
          <label className="question-line">
            <span className="plus" aria-hidden="true">＋</span>
            <input
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              placeholder="輸入你的問題……"
              aria-label="輸入你的問題"
              disabled={isLoading}
            />
          </label>
          <div className="control-row">
            <select value={model} onChange={(event) => setModel(event.target.value)} aria-label="AI 模型" disabled={isLoading}>
              <option>Auto</option><option>OpenAI</option><option>Gemini</option><option>Kimi</option><option>Qwen</option>
            </select>
            <select value={mode} onChange={(event) => setMode(event.target.value)} aria-label="解題模式" disabled={isLoading}>
              <option>自動判斷</option><option>程式設計</option><option>數學解題</option><option>文科問答</option><option>資通安全</option><option>教材問答</option>
            </select>
            <span className="loading-dot" aria-hidden="true" />
            <button type="submit" disabled={!question.trim() || isLoading} aria-label="送出問題">
              {isLoading ? "…" : "➤"}
            </button>
            {isLoading && <button type="button" onClick={() => autoSubmitter.current.cancel()} aria-label="取消 AI 回答">取消</button>}
          </div>
        </form>

        <div className="usage-row">
          <span>訪客每日可體驗 30 題 · 每題最多 2,000 字</span>
          <span>目前模式：{mode}</span>
        </div>

        <div className="quick-modes" aria-label="快速題型">
          {quickModes.map((item) => (
            <button key={item} type="button" onClick={() => setMode(item)} disabled={isLoading}>{item}</button>
          ))}
        </div>

        {(aiStatus === "native model download" || aiStatus === "local model download") && isLoading && (
          <div className="download-progress-box" role="status">
            <span>下載進度：{downloadProgress !== null ? `${Math.round(downloadProgress * 100)}%` : "準備中…"}</span>
            <button type="button" onClick={() => autoSubmitter.current.cancel()} aria-label="取消下載">取消下載</button>
          </div>
        )}
        {isLoading && <p className="submitted-note" role="status">{statusText(aiStatus, downloadProgress)}</p>}
        {error && <p className="submitted-note" role="alert">{aiStatus ? `[${aiStatus}] ` : ""}{error}</p>}
        {needsLocalModelGesture && !isLoading && (
          <button type="button" onClick={() => { void submit(); }} aria-label="開始下載本機模型">
            開始下載本機模型
          </button>
        )}
        {answer && (
          <section className="submitted-note" aria-label="本機 AI 回答">
            <p role="status">本機 AI 回答</p>
            <pre>{answer}</pre>
          </section>
        )}
      </section>

      <section className="feature-strip" id="features" aria-label="AI-SmartBook 功能">
        <article><span>01</span><h2>快速理解</h2><p>把問題整理成清楚、可行動的學習步驟。</p></article>
        <article><span>02</span><h2>教材連結</h2><p>登入後從個人書庫延伸追問與複習。</p></article>
        <article><span>03</span><h2>學習留存</h2><p>保存回答、進度與最近提問，隨時接續。</p></article>
      </section>

      <footer>AI-SmartBook · 公開體驗回答僅供學習參考</footer>
    </main>
  );
}

function statusText(status: AutoAiStatus | "", progress: number | null) {
  const percent = progress === null ? "" : ` (${Math.round(progress * 100)}%)`;
  if (status === "native ready") return "狀態：native ready（Chrome 內建 AI 已就緒）";
  if (status === "native model download") return `狀態：native model download（下載 Chrome 內建模型中${percent}）`;
  if (status === "native translation buffering") return "狀態：native translation buffering（原生回答完成後轉為繁體中文）";
  if (status === "local fallback loading") return "狀態：local fallback loading（正在載入本機 AI 引擎）";
  if (status === "local model requires user activation") return "狀態：local model requires user activation（請按開始下載本機模型）";
  if (status === "local model download") return `狀態：local model download（下載本機模型中${percent}）`;
  if (status === "unsupported after fallback") return "狀態：unsupported after fallback（此裝置不支援 Chrome 內建 AI 且無法執行本機模型）";
  return "正在準備本機 AI…";
}
