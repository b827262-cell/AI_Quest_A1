"use client";

import { FormEvent, useRef, useState } from "react";
import { AutoAiStatus, createAutoSubmitter } from "./chrome-built-in-ai";
import { buildGoogleAiModeUrl, createAutoFallbackGuard, validateLocalAnswer } from "./auto-fallback";

const features = [["01", "智慧書庫", "在同一個閱讀脈絡中整理教材、章節與你的學習入口。"], ["02", "閱讀輔助", "把問題留在正在閱讀的位置，讓理解和複習能接續進行。"], ["03", "學習進度", "回到個人工作台查看已閱讀的內容與下一步。"], ["04", "管理工作台", "管理端集中處理帳號、書籍內容與站台設定。"]] as const;
const quickModes = ["程式設計", "數學解題", "教材問答", "資通安全"];
const studentRoute = "/signin-with-chatgpt";

function BrandMark() { return <span className="v2-brand-mark" aria-hidden="true">✦</span>; }

export default function Home() {
  const [question, setQuestion] = useState("");
  const [model, setModel] = useState("Auto");
  const [mode, setMode] = useState("自動判斷");
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [aiStatus, setAiStatus] = useState<AutoAiStatus | "">("");
  const [downloadProgress, setDownloadProgress] = useState<number | null>(null);
  const [needsGesture, setNeedsGesture] = useState(false);
  const [backupGoogleUrl, setBackupGoogleUrl] = useState("");
  const autoSubmitter = useRef(createAutoSubmitter());

  async function submit(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const prompt = question.trim();
    if (!prompt || isLoading) return;
    setAnswer(""); setError(""); setAiStatus(""); setDownloadProgress(null); setNeedsGesture(false); setBackupGoogleUrl("");
    if (model !== "Auto" && model !== "Qwen3-0.6B") {
      setError("公開體驗目前僅支援 Auto（Chrome 內建 AI / Qwen2.5 保底）與 Qwen3-0.6B（本機測試選項）回答。");
      return;
    }
    const fallbackGuard = createAutoFallbackGuard();
    if (!fallbackGuard.begin()) return;
    setIsLoading(true);
    try {
      const finalAnswer = await autoSubmitter.current.submit(
        prompt,
        (chunk) => setAnswer((current) => current + chunk),
        (status, progress) => {
          setAiStatus(status);
          setDownloadProgress(typeof progress === "number" ? progress : null);
          setNeedsGesture(status === "local model requires user activation");
        },
        { localModelId: "onnx-community/Qwen3-0.6B-ONNX", timeoutMs: 45_000, forceLocalModel: true },
      );
      const verdict = validateLocalAnswer(prompt, finalAnswer);
      if (verdict.status === "VALID") {
        setAnswer(verdict.answer);
        fallbackGuard.done();
        return;
      }
      handOffToGoogle(prompt, verdict.reason, fallbackGuard);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "目前無法取得 AI 回答。";
      if (/已取消/.test(message)) {
        fallbackGuard.cancel();
        setError(message);
      } else {
        handOffToGoogle(prompt, /逾時|abort/i.test(message) ? "timeout" : "local-error", fallbackGuard);
      }
    } finally {
      setIsLoading(false);
    }

    function handOffToGoogle(originalQuestion: string, reason: string, guard: ReturnType<typeof createAutoFallbackGuard>) {
      const url = buildGoogleAiModeUrl(originalQuestion);
      if (!guard.navigateOnce()) return;
      setError(`地端 AI 無法完成（${reason}），正在自動開啟 Google AI 解答。本站不會讀取或回填 Google 的回答。`);
      try {
        window.location.assign(url);
      } catch {
        // A policy/browser navigation block is the only case that exposes the backup link.
        setBackupGoogleUrl(url);
        setError(`地端 AI 無法完成（${reason}）。Google AI 導航遭阻擋，請使用備援連結。`);
      }
    }
  }

  return <main className="v2-page">
    <header className="v2-nav shell"><a className="v2-brand" href="#top" aria-label="AI-SmartBook 首頁"><BrandMark /><strong>AI-SmartBook</strong></a><nav aria-label="主要導覽"><a href="#features">功能</a><a href="#auto-answer">公開問答</a><a href="#workflow">使用方式</a><a href="#structure">系統架構</a></nav><a className="v2-nav-login" href={studentRoute}>學員登入 <span aria-hidden="true">↗</span></a></header>
    <section className="v2-hero shell" id="top"><div className="v2-hero-copy v2-reveal"><p className="v2-eyebrow"><span />學習，不必在工具之間來回切換</p><h1>把閱讀、提問與<br /><em>下一步</em>放在一起。</h1><p className="v2-lead">AI-SmartBook 是以教材閱讀為中心的學習工作台。從進入書庫，到理解內容與回顧進度，每一步都有清楚的位置。</p><div className="v2-actions"><a className="v2-button v2-button-primary" href={studentRoute}>開始學習 <span aria-hidden="true">→</span></a><a className="v2-button v2-button-secondary" href="#auto-answer">體驗公開問答 <span aria-hidden="true">↓</span></a></div><p className="v2-note">使用既有學員帳號登入即可進入個人學習工作台。</p></div><div className="v2-hero-art v2-reveal v2-delay-1" role="img" aria-label="AI-SmartBook 學習介面示意"><div className="v2-orbit v2-orbit-one" /><div className="v2-orbit v2-orbit-two" /><div className="v2-product-card"><div className="v2-product-top"><span className="v2-mini-brand">✦</span><span>我的學習工作台</span><i /></div><div className="v2-product-body"><aside><span className="active" /><span /><span /><span /></aside><div className="v2-product-content"><p>正在閱讀</p><h2>從教材開始整理你的理解</h2><div className="v2-reading-lines"><b /><b /><b /><b /></div><div className="v2-question"><span>✦</span><p>針對這一段提出問題</p><span aria-hidden="true">↑</span></div></div></div></div><div className="v2-float-card v2-float-progress"><span>◔</span><div><small>學習脈絡</small><b>接續上次閱讀</b></div></div><div className="v2-float-card v2-float-answer"><span>✦</span><div><small>閱讀輔助</small><b>把疑問留在此處</b></div></div></div></section>
    <section className="v2-trust shell" aria-label="產品重點"><span>READ</span><i /><span>ASK</span><i /><span>ORGANIZE</span><i /><span>CONTINUE</span></section>
    <section className="v2-auto shell" id="auto-answer" aria-labelledby="auto-heading"><div><p className="v2-eyebrow"><span />Chrome Built-in AI</p><h2 id="auto-heading">直接在這裡，開始你的問題。</h2><p>Auto 會先以此裝置的 Qwen3-0.6B 與本地繁中後處理作答；地端 AI 無法完成時，問題將自動送往 Google AI 開啟解答（無逐題確認）。</p></div><form className="v2-auto-form" onSubmit={submit}><label htmlFor="auto-question">輸入你的問題</label><textarea id="auto-question" value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="例如：請解釋這個段落的重點……" disabled={isLoading} /><div className="v2-auto-controls"><select value={model} onChange={(event) => setModel(event.target.value)} aria-label="AI 模型" disabled={isLoading}><option value="Auto">Auto (Qwen3-0.6B)</option><option value="Qwen3-0.6B">Qwen3-0.6B</option><option>OpenAI</option><option>Gemini</option><option>Kimi</option><option>Qwen</option></select><select value={mode} onChange={(event) => setMode(event.target.value)} aria-label="解題模式" disabled={isLoading}><option>自動判斷</option><option>程式設計</option><option>數學解題</option><option>文科問答</option><option>資通安全</option><option>教材問答</option></select><button className="v2-button v2-button-primary" type="submit" disabled={!question.trim() || isLoading}>{isLoading ? "處理中…" : "送出問題"}</button></div><div className="v2-quick-modes" aria-label="快速題型">{quickModes.map((item) => <button key={item} type="button" aria-pressed={mode === item} onClick={() => setMode(item)} disabled={isLoading}>{item}</button>)}</div>{isLoading && <p className="v2-auto-status" role="status">{statusText(aiStatus, downloadProgress)}</p>}{(aiStatus === "native model download" || aiStatus === "local model download") && isLoading && <button className="v2-gesture-button" type="button" onClick={() => autoSubmitter.current.cancel()}>取消下載</button>}{error && <p className="v2-auto-status" role="alert">{aiStatus ? `[${aiStatus}] ` : ""}{error}</p>}{backupGoogleUrl && <a className="v2-gesture-button" href={backupGoogleUrl}>開啟 Google AI 備援連結</a>}{needsGesture && !isLoading && <button className="v2-gesture-button" type="button" onClick={() => { void submit(); }}>開始下載本機模型</button>}{answer && <section className="v2-auto-answer" aria-label="本機 AI 回答"><p role="status">本機 AI 回答</p><pre>{answer}</pre></section>}</form></section>
    <section className="v2-section shell" id="features"><div className="v2-section-heading v2-reveal"><p className="v2-eyebrow"><span />為學習流程而設計</p><h2>不只回答問題，<br />更讓學習能夠接續。</h2></div><div className="v2-feature-grid">{features.map(([number, title, description], index) => <article className={`v2-feature-card v2-reveal v2-delay-${index + 1}`} key={title}><span>{number}</span><div className="v2-feature-icon" aria-hidden="true">{["▤", "✦", "◒", "⌘"][index]}</div><h3>{title}</h3><p>{description}</p><a href={index === 3 ? "/admin" : studentRoute}>前往{index === 3 ? "管理入口" : "學員入口"} <b aria-hidden="true">→</b></a></article>)}</div></section>
    <section className="v2-workflow-wrap" id="workflow"><div className="v2-workflow shell"><div className="v2-section-heading v2-reveal"><p className="v2-eyebrow"><span />一條清楚的使用路徑</p><h2>從開啟教材，<br />到回到自己的節奏。</h2></div><ol className="v2-steps"><li><span>01</span><div><h3>登入學員入口</h3><p>從個人工作台進入已授權的學習內容。</p></div></li><li><span>02</span><div><h3>在書庫開啟教材</h3><p>以章節和閱讀位置建立當下的學習脈絡。</p></div></li><li><span>03</span><div><h3>閱讀、提問、回顧</h3><p>讓閱讀中的問題與後續進度留在同一個工作台。</p></div></li></ol></div></section>
    <section className="v2-structure shell" id="structure"><div className="v2-section-heading"><p className="v2-eyebrow"><span />各司其職，保持連結</p><h2>從學習現場到內容管理，<br />每個角色都有自己的入口。</h2></div><div className="v2-architecture"><article><small>STUDENT</small><h3>學員工作台</h3><p>閱讀、書庫與學習進度。</p><a href={studentRoute}>學員登入 →</a></article><div className="v2-arch-link" aria-hidden="true">→</div><article className="v2-arch-backend"><small>BACKEND</small><h3>服務層</h3><p>以既有帳號、內容與資料流程支援產品運作。</p><span>既有系統服務</span></article><div className="v2-arch-link" aria-hidden="true">→</div><article><small>ADMIN</small><h3>管理工作台</h3><p>帳號、書籍與站台設定管理。</p><a href="/admin">管理員登入 →</a></article></div></section>
    <section className="v2-value shell"><div className="v2-value-inner"><p className="v2-eyebrow"><span />讓工具退到背景</p><h2>把注意力留給<br /><em>真正想理解的事。</em></h2><p>你不需要為了學習拼湊一套流程；閱讀、整理與回顧，應該自然地發生在同一個地方。</p><a className="v2-button v2-button-primary" href={studentRoute}>進入學習工作台 <span aria-hidden="true">→</span></a></div></section>
    <footer className="v2-footer"><div className="shell"><div className="v2-footer-cta"><div><p>準備好回到你的學習節奏了嗎？</p><h2>從下一頁開始。</h2></div><a className="v2-button v2-button-light" href={studentRoute}>學員登入 <span aria-hidden="true">→</span></a></div><div className="v2-footer-bottom"><a className="v2-brand" href="#top"><BrandMark /><strong>AI-SmartBook</strong></a><p>以教材為中心的 AI 學習工作台</p><a href="/admin">管理員入口</a></div></div></footer>
  </main>;
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
