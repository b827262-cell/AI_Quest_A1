"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { AutoAiStatus, createAutoSubmitter, DownloadProgress, LOCAL_FALLBACK_MODEL_REVISION, QWEN3_TEST_MODEL_ID } from "./chrome-built-in-ai";
import { buildGoogleAiModeUrl, createAutoFallbackGuard, shouldUseLocalTutor, validateLocalAnswer } from "./auto-fallback";
import { deleteLocalModelCache, probeLocalModelCache, requestLocalModelPersistence } from "./local-model-cache";
import { classifySubject, subjectCategoryLabel, type SubjectCategory } from "./subject-triage";

const features = [["01", "智慧書庫", "在同一個閱讀脈絡中整理教材、章節與你的學習入口。"], ["02", "閱讀輔助", "把問題留在正在閱讀的位置，讓理解和複習能接續進行。"], ["03", "學習進度", "回到個人工作台查看已閱讀的內容與下一步。"], ["04", "管理工作台", "管理端集中處理帳號、書籍內容與站台設定。"]] as const;
const quickModes = ["可選提示", "教材解釋", "陪練", "錯題引導"];
const studentRoute = "/signin-with-chatgpt";
const localModel = { modelId: QWEN3_TEST_MODEL_ID, revision: LOCAL_FALLBACK_MODEL_REVISION };
const DOWNLOAD_STALL_MS = 90_000;
const fixedFaq: Array<[RegExp, string]> = [
  [/什麼是 AI-SmartBook|AI-SmartBook.*是什麼/i, "AI-SmartBook 是以教材閱讀為中心的學習工作台；你可以在閱讀脈絡中提問、整理理解並回顧進度。"],
  [/怎麼使用|如何使用/i, "先登入學員入口、開啟教材，再在閱讀脈絡中提出問題並回到工作台查看進度。"],
];
const tutorPrefix: Record<string, string> = {
  "可選提示": "請只給下一步提示，不要給完整解答。\n",
  "教材解釋": "請依教材概念用繁體中文解釋，並舉一個短例子。\n",
  "陪練": "請用提問引導我思考，一次只問一個問題，不要直接公布完整答案。\n",
  "錯題引導": "請指出可能的觀念缺口並給下一步提示，不要直接公布完整答案。\n",
};

function BrandMark() { return <span className="v2-brand-mark" aria-hidden="true">✦</span>; }

export default function Home() {
  const [question, setQuestion] = useState("");
  const [model, setModel] = useState("Auto");
  const [mode, setMode] = useState("自動判斷");
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [aiStatus, setAiStatus] = useState<AutoAiStatus | "">("");
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgress | null>(null);
  const [needsGesture, setNeedsGesture] = useState(false);
  const [googleUrl, setGoogleUrl] = useState("");
  const [googleConsent, setGoogleConsent] = useState(false);
  const [googleOpened, setGoogleOpened] = useState(false);
  const [cacheStatus, setCacheStatus] = useState("");
  const [downloadStalled, setDownloadStalled] = useState(false);
  const autoSubmitter = useRef(createAutoSubmitter());
  const requestId = useRef(0);
  const lastProgressAt = useRef(0);
  const isLoadingRef = useRef(false);
  const manualOverrideRef = useRef<SubjectCategory | null>(null);

  const downloading = isLoading && (aiStatus === "local model download" || aiStatus === "native model download");

  // P0 cold-start contract: 90 seconds without a single new byte is a visible
  // stall. Silence here would look like a working download, so surface retry
  // and a new-tab Google choice instead.
  useEffect(() => {
    if (!downloading) return;
    const timer = setInterval(() => {
      if (Date.now() - lastProgressAt.current > DOWNLOAD_STALL_MS) setDownloadStalled(true);
    }, 5_000);
    return () => clearInterval(timer);
  }, [downloading]);

  function retryDownload() {
    requestId.current += 1;
    autoSubmitter.current.cancel();
    setDownloadStalled(false);
    // Cannot call the captured `submit` closure: it sees the stale isLoading
    // from the render it was created in. requestSubmit() on the live form
    // triggers the CURRENT render's onSubmit instead.
    const trySubmit = () => {
      const form = document.querySelector("form.v2-auto-form") as HTMLFormElement | null;
      if (form && !isLoadingRef.current) form.requestSubmit();
      else setTimeout(trySubmit, 400);
    };
    setTimeout(trySubmit, 400);
  }

  async function submit(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const prompt = question.trim();
    if (!prompt || isLoading) return;
    const id = ++requestId.current;
    setAnswer(""); setError(""); setAiStatus(""); setDownloadProgress(null); setNeedsGesture(false); setGoogleUrl(""); setGoogleConsent(false); setGoogleOpened(false); setDownloadStalled(false);
    lastProgressAt.current = Date.now();
    const faq = fixedFaq.find(([pattern]) => pattern.test(prompt));
    if (faq) { setAnswer(faq[1]); return; }
    const subject = manualOverrideRef.current ?? classifySubject(prompt);
    manualOverrideRef.current = null;
    if (!shouldUseLocalTutor(subject, mode)) {
      setGoogleUrl(buildGoogleAiModeUrl(prompt));
      setError(`此題歸類為「${subjectCategoryLabel(subject)}」。如需完整解題，請先同意，再按鈕以 Google AI 新分頁開啟。本站不會讀取或回填 Google 回答。`);
      return;
    }
    if (model !== "Auto" && model !== "Qwen3-0.6B") {
      setError("公開體驗目前僅支援 Auto（Chrome 內建 AI / Qwen2.5 保底）與 Qwen3-0.6B（本機測試選項）回答。");
      return;
    }
    const fallbackGuard = createAutoFallbackGuard();
    if (!fallbackGuard.begin()) return;
    setIsLoading(true);
    isLoadingRef.current = true;
    try {
      const finalAnswer = await autoSubmitter.current.submit(
        `${tutorPrefix[mode] ?? ""}${prompt}`,
        (chunk) => { if (requestId.current === id) setAnswer((current) => current + chunk); },
        (status, _progress, bytes) => {
          if (requestId.current !== id) return;
          setAiStatus(status);
          setDownloadProgress(bytes ?? null);
          if (bytes?.loaded) lastProgressAt.current = Date.now();
          setNeedsGesture(status === "local model requires user activation");
        },
        { localModelId: QWEN3_TEST_MODEL_ID, timeoutMs: 45_000, downloadTimeoutMs: 15 * 60_000, forceLocalModel: true },
      );
      if (requestId.current !== id) return;
      const verdict = validateLocalAnswer(prompt, finalAnswer);
      if (verdict.status === "VALID") {
        setAnswer(verdict.answer);
        fallbackGuard.done();
        return;
      }
      offerGoogle(prompt, verdict.reason);
    } catch (reason) {
      if (requestId.current !== id) return;
      const message = reason instanceof Error ? reason.message : "目前無法取得 AI 回答。";
      if (/已取消/.test(message)) {
        fallbackGuard.cancel();
        setError(message);
      } else {
        offerGoogle(prompt, /逾時|abort/i.test(message) ? "timeout" : "local-error");
      }
    } finally {
      isLoadingRef.current = false;
      setIsLoading(false);
    }

    function offerGoogle(originalQuestion: string, reason: string) {
      fallbackGuard.done();
      setGoogleUrl(buildGoogleAiModeUrl(originalQuestion));
      setError(`地端 AI 無法完成（${reason}）。如需完整解題，請確認後以新分頁開啟 Google AI；本站不會讀取或回填 Google 的回答。`);
    }
  }

  function openGoogle() {
    if (!googleConsent || !googleUrl || googleOpened) return;
    window.open(googleUrl, "_blank", "noopener,noreferrer");
    setGoogleOpened(true);
    setError("已送出新分頁開啟請求。若瀏覽器阻擋新分頁，請使用下方備援連結；原題與目前頁面均已保留。");
  }

  /** Manual override: the learner explicitly picks IT/ACCOUNTING after a misclassification. */
  function forceLocalTutor(category: SubjectCategory) {
    manualOverrideRef.current = category;
    setGoogleUrl(""); setGoogleConsent(false); setGoogleOpened(false); setError("");
    const trySubmit = () => {
      const form = document.querySelector("form.v2-auto-form") as HTMLFormElement | null;
      if (form && !isLoadingRef.current) form.requestSubmit();
      else setTimeout(trySubmit, 400);
    };
    setTimeout(trySubmit, 400);
  }

  async function refreshCache() {
    const state = await probeLocalModelCache(localModel);
    const bytes = (value?: number) => value === undefined ? "未知" : `${(value / 1024 / 1024).toFixed(1)} MB`;
    const issue = state.issue === "quota" ? "；快取空間不足，模型仍可重試下載" : state.issue === "corrupt" ? "；快取檔案受損，重試時會重新下載" : state.issue === "incomplete" ? "；下載未完整保存，可重試" : "";
    setCacheStatus(state.supported ? `快取：${state.complete ? "完整可用" : "尚未完整"}（${state.artifactCount} 個檔案）${issue}；使用 ${bytes(state.usage)} / ${bytes(state.quota)}；持久化 ${state.persisted === true ? "已允許" : state.persisted === false ? "未允許" : "未知"}` : "此瀏覽器不支援 Cache Storage。");
  }

  return <main className="v2-page"><span className="sr-only">Chrome Built-in AI</span>
    <header className="v2-nav shell"><a className="v2-brand" href="#top" aria-label="AI-SmartBook 首頁"><BrandMark /><strong>AI-SmartBook</strong></a><nav aria-label="主要導覽"><a href="#features">功能</a><a href="#auto-answer">公開問答</a><a href="#workflow">使用方式</a><a href="#structure">系統架構</a></nav><a className="v2-nav-login" href={studentRoute}>學員登入 <span aria-hidden="true">↗</span></a></header>
    <section className="v2-hero shell" id="top"><div className="v2-hero-copy v2-reveal"><p className="v2-eyebrow"><span />學習，不必在工具之間來回切換</p><h1>把閱讀、提問與<br /><em>下一步</em>放在一起。</h1><p className="v2-lead">AI-SmartBook 是以教材閱讀為中心的學習工作台。從進入書庫，到理解內容與回顧進度，每一步都有清楚的位置。</p><div className="v2-actions"><a className="v2-button v2-button-primary" href={studentRoute}>開始學習 <span aria-hidden="true">→</span></a><a className="v2-button v2-button-secondary" href="#auto-answer">體驗公開問答 <span aria-hidden="true">↓</span></a></div><p className="v2-note">使用既有學員帳號登入即可進入個人學習工作台。</p></div><div className="v2-hero-art v2-reveal v2-delay-1" role="img" aria-label="AI-SmartBook 學習介面示意"><div className="v2-orbit v2-orbit-one" /><div className="v2-orbit v2-orbit-two" /><div className="v2-product-card"><div className="v2-product-top"><span className="v2-mini-brand">✦</span><span>我的學習工作台</span><i /></div><div className="v2-product-body"><aside><span className="active" /><span /><span /><span /></aside><div className="v2-product-content"><p>正在閱讀</p><h2>從教材開始整理你的理解</h2><div className="v2-reading-lines"><b /><b /><b /><b /></div><div className="v2-question"><span>✦</span><p>針對這一段提出問題</p><span aria-hidden="true">↑</span></div></div></div></div><div className="v2-float-card v2-float-progress"><span>◔</span><div><small>學習脈絡</small><b>接續上次閱讀</b></div></div><div className="v2-float-card v2-float-answer"><span>✦</span><div><small>閱讀輔助</small><b>把疑問留在此處</b></div></div></div></section>
    <section className="v2-trust shell" aria-label="產品重點"><span>READ</span><i /><span>ASK</span><i /><span>ORGANIZE</span><i /><span>CONTINUE</span></section>
    <section className="v2-auto shell" id="auto-answer" aria-labelledby="auto-heading"><div><p className="v2-eyebrow"><span />本機 AI 助教</p><h2 id="auto-heading">直接在這裡，開始你的問題。</h2><p>首次使用本機 Qwen3-0.6B 約需下載 618 MB；模型只在 IT／會計題目啟用，可取消下載並保存在此瀏覽器 profile 的 Cache Storage。每次開頁仍需載入 RAM/GPU。完整解題只會在你明確同意並點擊後，以 Google AI 新分頁開啟。</p></div><form className="v2-auto-form" onSubmit={submit}><label htmlFor="auto-question">輸入你的問題</label><textarea id="auto-question" value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="例如：請解釋這個段落的重點……" disabled={isLoading} /><div className="v2-auto-controls"><select value={model} onChange={(event) => setModel(event.target.value)} aria-label="AI 模型" disabled={isLoading}><option value="Auto">Auto (Qwen3-0.6B)</option><option value="Qwen3-0.6B">Qwen3-0.6B</option></select><select value={mode} onChange={(event) => setMode(event.target.value)} aria-label="助教模式" disabled={isLoading}><option>自動判斷</option><option>可選提示</option><option>教材解釋</option><option>陪練</option><option>錯題引導</option><option>完整解題（Google）</option></select><button className="v2-button v2-button-primary" type="submit" disabled={!question.trim() || isLoading}>{isLoading ? "處理中…" : "送出問題"}</button></div><div className="v2-quick-modes" aria-label="快速題型">{quickModes.map((item) => <button key={item} type="button" aria-pressed={mode === item} onClick={() => setMode(item)} disabled={isLoading}>{item}</button>)}</div><div className="v2-quick-modes" aria-label="本機模型快取"><button type="button" onClick={() => { void refreshCache(); }}>檢查模型快取</button><button type="button" onClick={() => { void requestLocalModelPersistence().then(refreshCache); }}>申請長期保存</button><button type="button" onClick={() => { if (window.confirm("確定刪除此模型版本的本機快取？")) void deleteLocalModelCache(localModel).then(refreshCache); }}>刪除本機模型</button></div>{cacheStatus && <p className="v2-auto-status" role="status">{cacheStatus}</p>}{isLoading && <p className="v2-auto-status" role="status">{statusText(aiStatus, downloadProgress)}</p>}{(aiStatus === "native model download" || aiStatus === "local model download") && isLoading && <button className="v2-gesture-button" type="button" onClick={() => { requestId.current += 1; autoSubmitter.current.cancel(); setError("已取消模型下載，原題仍保留。"); }}>取消下載</button>}{downloadStalled && isLoading && <span className="v2-gesture-button" role="alert">下載停滯（連續 90 秒無新資料）</span>}{downloadStalled && isLoading && <button className="v2-gesture-button" type="button" onClick={retryDownload}>重新下載</button>}{downloadStalled && isLoading && <a className="v2-gesture-button" href={buildGoogleAiModeUrl(question)} target="_blank" rel="noopener noreferrer">改用 Google AI 求解（新分頁）</a>}{error && <p className="v2-auto-status" role="alert">{aiStatus ? `[${aiStatus}] ` : ""}{error}</p>}{googleUrl && <div className="v2-auto-status"><label><input type="checkbox" checked={googleConsent} onChange={(event) => setGoogleConsent(event.target.checked)} /> 我同意將原題送往 Google AI，並以新分頁開啟。</label><button className="v2-gesture-button" type="button" disabled={!googleConsent || googleOpened} onClick={openGoogle}>{googleOpened ? "已送出新分頁請求" : "開啟 Google AI 完整解題"}</button>{googleConsent ? <a className="v2-gesture-button" href={googleUrl} target="_blank" rel="noopener noreferrer">備援連結（新分頁）</a> : <button className="v2-gesture-button" type="button" disabled>先同意後提供備援連結</button>}</div>}{googleUrl && !isLoading && <div className="v2-quick-modes" aria-label="改以本機模型試解"><button type="button" onClick={() => forceLocalTutor("IT")}>改以資訊科試解（載入模型）</button><button type="button" onClick={() => forceLocalTutor("ACCOUNTING")}>改以會計科試解（載入模型）</button></div>}{needsGesture && !isLoading && <button className="v2-gesture-button" type="button" onClick={() => { void submit(); }}>開始下載本機模型</button>}{answer && <section className="v2-auto-answer" aria-label="本機 AI 回答"><p role="status">本機 AI 回答</p><pre>{answer}</pre><p className="v2-auto-status" role="status">本機模型回答僅供參考，內容未經外部事實查證（NEEDS_GUARD）；如需確認建議另行查證或前往 Google AI。</p></section>}</form></section>
    <section className="v2-section shell" id="features"><div className="v2-section-heading v2-reveal"><p className="v2-eyebrow"><span />為學習流程而設計</p><h2>不只回答問題，<br />更讓學習能夠接續。</h2></div><div className="v2-feature-grid">{features.map(([number, title, description], index) => <article className={`v2-feature-card v2-reveal v2-delay-${index + 1}`} key={title}><span>{number}</span><div className="v2-feature-icon" aria-hidden="true">{["▤", "✦", "◒", "⌘"][index]}</div><h3>{title}</h3><p>{description}</p><a href={index === 3 ? "/admin" : studentRoute}>前往{index === 3 ? "管理入口" : "學員入口"} <b aria-hidden="true">→</b></a></article>)}</div></section>
    <section className="v2-workflow-wrap" id="workflow"><div className="v2-workflow shell"><div className="v2-section-heading v2-reveal"><p className="v2-eyebrow"><span />一條清楚的使用路徑</p><h2>從開啟教材，<br />到回到自己的節奏。</h2></div><ol className="v2-steps"><li><span>01</span><div><h3>登入學員入口</h3><p>從個人工作台進入已授權的學習內容。</p></div></li><li><span>02</span><div><h3>在書庫開啟教材</h3><p>以章節和閱讀位置建立當下的學習脈絡。</p></div></li><li><span>03</span><div><h3>閱讀、提問、回顧</h3><p>讓閱讀中的問題與後續進度留在同一個工作台。</p></div></li></ol></div></section>
    <section className="v2-structure shell" id="structure"><div className="v2-section-heading"><p className="v2-eyebrow"><span />各司其職，保持連結</p><h2>從學習現場到內容管理，<br />每個角色都有自己的入口。</h2></div><div className="v2-architecture"><article><small>STUDENT</small><h3>學員工作台</h3><p>閱讀、書庫與學習進度。</p><a href={studentRoute}>學員登入 →</a></article><div className="v2-arch-link" aria-hidden="true">→</div><article className="v2-arch-backend"><small>BACKEND</small><h3>服務層</h3><p>以既有帳號、內容與資料流程支援產品運作。</p><span>既有系統服務</span></article><div className="v2-arch-link" aria-hidden="true">→</div><article><small>ADMIN</small><h3>管理工作台</h3><p>帳號、書籍與站台設定管理。</p><a href="/admin">管理員登入 →</a></article></div></section>
    <section className="v2-value shell"><div className="v2-value-inner"><p className="v2-eyebrow"><span />讓工具退到背景</p><h2>把注意力留給<br /><em>真正想理解的事。</em></h2><p>你不需要為了學習拼湊一套流程；閱讀、整理與回顧，應該自然地發生在同一個地方。</p><a className="v2-button v2-button-primary" href={studentRoute}>進入學習工作台 <span aria-hidden="true">→</span></a></div></section>
    <footer className="v2-footer"><div className="shell"><div className="v2-footer-cta"><div><p>準備好回到你的學習節奏了嗎？</p><h2>從下一頁開始。</h2></div><a className="v2-button v2-button-light" href={studentRoute}>學員登入 <span aria-hidden="true">→</span></a></div><div className="v2-footer-bottom"><a className="v2-brand" href="#top"><BrandMark /><strong>AI-SmartBook</strong></a><p>以教材為中心的 AI 學習工作台</p><a href="/admin">管理員入口</a></div></div></footer>
  </main>;
}

function statusText(status: AutoAiStatus | "", progress: DownloadProgress | null) {
  const formatBytes = (value: number) => `${(value / 1024 / 1024).toFixed(1)} MB`;
  const percent = progress?.total ? `（${Math.min(100, Math.round(progress.loaded / progress.total * 100))}% · ${formatBytes(progress.loaded)} / ${formatBytes(progress.total)}）` : progress ? `（已下載 ${formatBytes(progress.loaded)}；總大小未知）` : "（等待下載資訊）";
  if (status === "native ready") return "狀態：native ready（Chrome 內建 AI 已就緒）";
  if (status === "native model download") return `狀態：native model download（下載 Chrome 內建模型中${percent}）`;
  if (status === "native translation buffering") return "狀態：native translation buffering（原生回答完成後轉為繁體中文）";
  if (status === "local fallback loading") return "狀態：local fallback loading（正在載入本機 AI 引擎）";
  if (status === "local model requires user activation") return "狀態：local model requires user activation（請按開始下載本機模型）";
  if (status === "local model download") return `狀態：local model download（下載本機模型中${percent}）`;
  if (status === "local model ready") return "狀態：local model ready（本機模型已載入；正在生成回答）";
  if (status === "unsupported after fallback") return "狀態：unsupported after fallback（此裝置不支援 Chrome 內建 AI 且無法執行本機模型）";
  return "正在準備本機 AI…";
}
