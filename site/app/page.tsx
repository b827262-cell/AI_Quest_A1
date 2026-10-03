"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { AutoAiRuntimeLayer, AutoAiStatus, createAutoSubmitter, DownloadProgress, LOCAL_FALLBACK_MODEL_REVISION, QWEN3_TEST_MODEL_ID, runtimeLayerForStatus } from "./chrome-built-in-ai";
import { buildGoogleAiModeUrl, createAutoFallbackGuard } from "./auto-fallback";
import { openGoogleAiAfterLocalFailure } from "./auto-handoff";
import {
  AUTO_ROUTE_WITHHELD_COPY,
  buildPracticeAssistantPrefix,
  buildPracticeQuestionPrompt,
  formatPracticeContinuation,
  PRACTICE_SYSTEM_PROMPT,
  runAutoRouteInference,
  validatePracticeQuestion,
} from "./auto-route";
import { deleteLocalModelCache, probeLocalModelCache, requestLocalModelPersistence } from "./local-model-cache";

const features = [["01", "智慧書庫", "在同一個閱讀脈絡中整理教材、章節與你的學習入口。"], ["02", "閱讀輔助", "把問題留在正在閱讀的位置，讓理解和複習能接續進行。"], ["03", "學習進度", "回到個人工作台查看已閱讀的內容與下一步。"], ["04", "管理工作台", "管理端集中處理帳號、書籍內容與站台設定。"]] as const;
const quickModes = ["可選提示", "教材解釋", "陪練", "錯題引導"];
const studentRoute = "https://b827262-e500-g9-ws760t.tailc359df.ts.net:8443";
const localModel = { modelId: QWEN3_TEST_MODEL_ID, revision: LOCAL_FALLBACK_MODEL_REVISION };
const DOWNLOAD_STALL_MS = 90_000;
export const BRAND_MARK_ACTIVATION_WINDOW_MS = 2_000;
// A config/tokenizer request is a real byte transfer, but not evidence that
// the model itself is downloaded. Do not turn a completed tiny asset into a
// completed model bar. The Qwen artifact is hundreds of MiB; 16 MiB leaves
// plenty of room for legitimate model shards without inventing a total.
export const MODEL_SCALE_DOWNLOAD_BYTES = 16 * 1024 * 1024;

function BrandMark() { return <span className="v2-brand-mark" aria-hidden="true">✦</span>; }

/** Keep only consecutive activations in the locked two-second discovery window. */
export function recordBrandMarkActivation(activationTimes: number[], now: number) {
  return [...activationTimes.filter((time) => now >= time && now - time <= BRAND_MARK_ACTIVATION_WINDOW_MS), now];
}

// Model artifacts cannot plausibly have a one-byte total. Polyfill monitor
// events commonly use a 0..1 ratio with total=1, which is progress metadata,
// not a byte count.
function isTrustworthyKnownTotalByteProgress(bytes: DownloadProgress | null | undefined) {
  return Boolean(
    bytes
    && Number.isFinite(bytes.loaded)
    && Number.isFinite(bytes.total)
    && Number.isInteger(bytes.loaded)
    && Number.isInteger(bytes.total)
    && bytes.loaded >= 0
    && (bytes.total as number) > 1
    && bytes.loaded <= (bytes.total as number),
  );
}

// A response without Content-Length has no truthful percentage, but a byte
// count from its body is still useful once it is clearly model-sized. Keep
// this distinct from the normalized 0..1 monitor ratios handled above.
export function isTrustworthyUnknownTotalByteProgress(bytes: DownloadProgress | null | undefined) {
  return Boolean(
    bytes
    && Number.isFinite(bytes.loaded)
    && Number.isInteger(bytes.loaded)
    && bytes.loaded >= 0
    && bytes.total === null,
  );
}

export function isTrustworthyByteProgress(bytes: DownloadProgress | null | undefined) {
  return isTrustworthyKnownTotalByteProgress(bytes) || isTrustworthyUnknownTotalByteProgress(bytes);
}

export function isModelScaleDownloadProgress(bytes: DownloadProgress | null | undefined) {
  return Boolean(
    (isTrustworthyKnownTotalByteProgress(bytes) && (bytes?.total as number) >= MODEL_SCALE_DOWNLOAD_BYTES)
    || (isTrustworthyUnknownTotalByteProgress(bytes) && (bytes?.loaded as number) >= MODEL_SCALE_DOWNLOAD_BYTES),
  );
}

export function formatDownloadProgress(bytes: DownloadProgress | null) {
  if (isTrustworthyKnownTotalByteProgress(bytes) && isModelScaleDownloadProgress(bytes)) {
    return `正在下載本機 AI 模型：${Math.min(100, Math.round(bytes.loaded / (bytes.total as number) * 100))}% · ${formatDownloadBytes(bytes.loaded)} / ${formatDownloadBytes(bytes.total as number)}`;
  }
  if (isTrustworthyUnknownTotalByteProgress(bytes) && isModelScaleDownloadProgress(bytes)) {
    return `正在下載本機 AI 模型：已下載 ${formatDownloadBytes(bytes.loaded)}；總大小未知`;
  }
  return "正在準備／下載模型資源：等待模型檔案大小資訊";
}

export type ProgressPanel = "download" | "generation" | "none";

/**
 * An active inference owns the panel while the local engine initializes.
 * A real artifact download always takes precedence, including one discovered
 * after submit has started. Warm-up alone may use the preparation panel.
 */
export function resolveProgressPanel({
  isLoading,
  isPreloading,
  aiStatus,
}: {
  isLoading: boolean;
  isPreloading: boolean;
  aiStatus: AutoAiStatus | "";
}): ProgressPanel {
  const hasActualDownload = (isLoading || isPreloading)
    && (aiStatus === "local model download" || aiStatus === "native model download");
  if (hasActualDownload) return "download";
  if (isLoading) return "generation";
  if (isPreloading && aiStatus === "local fallback loading") return "download";
  return "none";
}

/** Let React commit the loading panel, then let the browser paint it once. */
export function yieldForProgressPaint() {
  return new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => window.requestAnimationFrame(resolve));
  });
}

function ProgressBar({ determinate, value, label }: { determinate: boolean; value?: number; label: string }) {
  const percent = determinate ? Math.min(100, Math.max(0, Math.round((value ?? 0) * 100))) : undefined;
  return <div className={`v2-progress ${determinate ? "v2-progress-determinate" : "v2-progress-indeterminate"}`} role="progressbar" aria-label={label} aria-valuemin={determinate ? 0 : undefined} aria-valuemax={determinate ? 100 : undefined} aria-valuenow={percent}>
    <span className="v2-progress-fill" style={determinate ? { width: `${percent}%` } : undefined} />
  </div>;
}

export default function Home() {
  const [question, setQuestion] = useState("");
  const [model, setModel] = useState("Auto");
  const [mode, setMode] = useState("自動判斷");
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isPreloading, setIsPreloading] = useState(false);
  const [aiStatus, setAiStatus] = useState<AutoAiStatus | "">("");
  const [runtimeLayer, setRuntimeLayer] = useState<AutoAiRuntimeLayer>("none");
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgress | null>(null);
  const [needsGesture, setNeedsGesture] = useState(false);
  const [cacheStatus, setCacheStatus] = useState("");
  const [cacheSupported, setCacheSupported] = useState<boolean | null>(null);
  const [downloadStalled, setDownloadStalled] = useState(false);
  const [generationStage, setGenerationStage] = useState<"loading" | "analyzing" | "generating">("loading");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const autoSubmitter = useRef(createAutoSubmitter());
  const requestId = useRef(0);
  const preloadRunId = useRef(0);
  const lastProgressAt = useRef(0);
  const isLoadingRef = useRef(false);
  const lastSubmittedPrompt = useRef("");
  const brandMarkActivations = useRef<number[]>([]);
  const [showBrandMarkBadge, setShowBrandMarkBadge] = useState(false);
  const [copied, setCopied] = useState(false);
  const [isFavorite, setIsFavorite] = useState(false);

  useEffect(() => {
    if (!answer || typeof window === "undefined" || !window.localStorage) {
      setIsFavorite(false);
      return;
    }
    try {
      const list = JSON.parse(window.localStorage.getItem("ai_smartbook_favorites") || "[]");
      setIsFavorite(list.some((item: { text?: string }) => item.text === answer));
    } catch {
      setIsFavorite(false);
    }
  }, [answer]);

  const downloading = (isLoading || isPreloading) && (aiStatus === "local model download" || aiStatus === "native model download");
  const hasKnownDownloadTotal = isTrustworthyKnownTotalByteProgress(downloadProgress) && isModelScaleDownloadProgress(downloadProgress);
  const downloadValue = hasKnownDownloadTotal ? (downloadProgress?.loaded ?? 0) / (downloadProgress?.total ?? 1) : undefined;
  const progressPanel = resolveProgressPanel({ isLoading, isPreloading, aiStatus });
  const showDownloadProgress = progressPanel === "download";
  const actionName = mode === "自動判斷" ? "AI 助手出題" : mode;

  function observeAiStatus(status: AutoAiStatus, bytes?: DownloadProgress) {
    setAiStatus(status);
    setRuntimeLayer(runtimeLayerForStatus(status));
    // Polyfill monitor events often start with 0/0. They are not evidence of
    // a real transfer, so only body-counted/native positive values replace the
    // last truthful byte reading.
    if (isTrustworthyByteProgress(bytes)) {
      if (isModelScaleDownloadProgress(bytes)) {
        setDownloadProgress(bytes);
        if (bytes.loaded > 0) lastProgressAt.current = Date.now();
      }
    }
    setNeedsGesture(status === "local model requires user activation");
    if (status === "local model ready" || status === "native ready") setGenerationStage("analyzing");
  }

  // A2: Page mount preload / warm-up. One warm-up path, shared by the mount
  // effect and the gesture continuation below, so both await the same preload
  // promise and one model can never be downloaded twice (A2/B2, A2/B3).
  const warmUpModel = useRef(() => autoSubmitter.current.preload(
    (status, _progress, bytes) => observeAiStatus(status, bytes),
    { localModelId: QWEN3_TEST_MODEL_ID, forceLocalModel: true },
  ));

  useEffect(() => {
    void startModelDownload();
  }, []);

  async function startModelDownload() {
    // Keep the preload call inside the click task. It does not need a question,
    // and the model engine may require the browser's current user activation.
    const runId = ++preloadRunId.current;
    const cache = await probeLocalModelCache(localModel);
    if (!cache.supported) {
      if (runId === preloadRunId.current) {
        setCacheSupported(false);
        setAiStatus("");
        setDownloadProgress(null);
        setError("此瀏覽器不支援 Cache Storage，無法安全保存本機 AI 模型；請改用支援 Cache Storage 的瀏覽器後重試。");
      }
      return;
    }
    setCacheSupported(true);
    setIsPreloading(true);
    setNeedsGesture(false);
    setError("");
    setDownloadStalled(false);
    lastProgressAt.current = Date.now();
    const preload = warmUpModel.current();
    try {
      const outcome = await preload;
      if (runId !== preloadRunId.current) return;
      if (outcome === "gesture" || outcome === "unsupported") setNeedsGesture(true);
      if (outcome === "unsupported") setError("本機模型無法載入，請檢查瀏覽器支援與網路連線後重試。");
    } finally {
      if (runId === preloadRunId.current) setIsPreloading(false);
    }
  }

  // P0 cold-start contract: 90 seconds without a single new byte is visible.
  useEffect(() => {
    if (!downloading) return;
    const timer = setInterval(() => {
      if (Date.now() - lastProgressAt.current > DOWNLOAD_STALL_MS) setDownloadStalled(true);
    }, 5_000);
    return () => clearInterval(timer);
  }, [downloading]);

  useEffect(() => {
    if (!isLoading) return;
    const startedAt = Date.now();
    const timer = setInterval(() => setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000)), 1_000);
    return () => clearInterval(timer);
  }, [isLoading]);

  useEffect(() => {
    if (!showBrandMarkBadge) return;
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        brandMarkActivations.current = [];
        setShowBrandMarkBadge(false);
      }
    };
    window.addEventListener("keydown", dismissOnEscape);
    return () => window.removeEventListener("keydown", dismissOnEscape);
  }, [showBrandMarkBadge]);

  function activateBrandMark() {
    if (showBrandMarkBadge) {
      brandMarkActivations.current = [];
      setShowBrandMarkBadge(false);
      return;
    }
    const activations = recordBrandMarkActivation(brandMarkActivations.current, Date.now());
    brandMarkActivations.current = activations;
    if (activations.length >= 3) {
      brandMarkActivations.current = [];
      setShowBrandMarkBadge(true);
    }
  }

  function dismissBrandMarkBadge() {
    brandMarkActivations.current = [];
    setShowBrandMarkBadge(false);
  }

  function retryDownload() {
    requestId.current += 1;
    autoSubmitter.current.cancel();
    setDownloadStalled(false);
    if (isPreloading && !isLoading) {
      void startModelDownload();
      return;
    }
    const trySubmit = () => {
      const form = document.querySelector("form.v2-auto-form") as HTMLFormElement | null;
      if (form && !isLoadingRef.current) form.requestSubmit();
      else setTimeout(trySubmit, 400);
    };
    setTimeout(trySubmit, 400);
  }

  function cancelInference() {
    // The submitter owns a dedicated local worker for forced generation.
    // Cancelling aborts that submit and terminates only its worker; Cache
    // Storage is deliberately left intact so retry never re-downloads a model.
    requestId.current += 1;
    autoSubmitter.current.cancel();
    setDownloadProgress(null);
    setDownloadStalled(false);
    setError("已取消本機 AI 回答，可直接重新出題。");
  }

  async function submit(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const prompt = question.trim();
    if (!prompt || isLoading) return;
    const id = ++requestId.current;
    if (cacheSupported === false) {
      setError("此瀏覽器不支援 Cache Storage，無法安全執行本機模型下載；請改用支援的瀏覽器。");
      return;
    }
    setAnswer(""); setError(""); setAiStatus(""); setRuntimeLayer("none"); setDownloadProgress(null); setNeedsGesture(false); setDownloadStalled(false); setGenerationStage("loading"); setElapsedSeconds(0);
    lastProgressAt.current = Date.now();
    if (model !== "Auto" && model !== "Qwen3-0.6B") {
      setError("公開體驗目前僅支援 Auto 與 Qwen3-0.6B（本機測試選項）回答。");
      return;
    }
    const fallbackGuard = createAutoFallbackGuard();
    if (!fallbackGuard.begin()) {
      return;
    }
    setIsLoading(true);
    isLoadingRef.current = true;
    try {
      // prompt-api-polyfill can synchronously occupy the renderer while it
      // starts local inference. Yield two frames after state is committed so
      // the learner sees the indeterminate panel before that work begins.
      await yieldForProgressPaint();
      if (requestId.current !== id) return;
      // A3+A4: the model's raw output IS the JSON contract, so nothing may be
      // painted into the answer box while it streams. This run buffers generation,
      // parses once, and writes the learner-facing answer exactly once, and only
      // when the A4 display gate passes. Generation errors still propagate.
      const result = await runAutoRouteInference(
        prompt,
        async (onChunk) => formatPracticeContinuation(
          mode,
          await autoSubmitter.current.submit(
            buildPracticeQuestionPrompt(prompt, mode),
            onChunk,
            (status, _progress, bytes) => {
              if (requestId.current !== id) return;
              observeAiStatus(status, bytes);
            },
            {
              localModelId: QWEN3_TEST_MODEL_ID,
              timeoutMs: 45_000,
              downloadTimeoutMs: 15 * 60_000,
              forceLocalModel: true,
              rawPrompt: true,
              systemPrompt: PRACTICE_SYSTEM_PROMPT,
              assistantPrefix: buildPracticeAssistantPrefix(mode),
            },
          ),
        ),
        {
          onStream: () => { lastProgressAt.current = Date.now(); setGenerationStage("generating"); },
          onAnswer: (text) => { if (requestId.current === id) setAnswer(text); },
        },
        validatePracticeQuestion,
      );
      if (requestId.current !== id) {
        return;
      }
      if (result.outcome === "shown") {
        fallbackGuard.done();
        return;
      }
      fallbackGuard.done();
      setError(AUTO_ROUTE_WITHHELD_COPY[result.withhold ?? "no-decision"]);
    } catch (cause) {
      if (requestId.current !== id) {
        return;
      }
      if (cause instanceof Error && cause.message.includes("本機 AI 模型無法完成回答") && fallbackGuard.navigateOnce()) {
        setRuntimeLayer("cloud-handoff");
        openGoogleAiAfterLocalFailure(prompt, window);
        return;
      }
      fallbackGuard.done();
      setError(cause instanceof Error ? cause.message : "本機 AI 暫時無法出題，請稍後重試。");
    } finally {
      isLoadingRef.current = false;
      setIsLoading(false);
    }
  }

  async function refreshCache() {
    const state = await probeLocalModelCache(localModel);
    setCacheSupported(state.supported);
    const bytes = (value?: number) => value === undefined ? "未知" : `${(value / 1024 / 1024).toFixed(1)} MB`;
    const issue = state.issue === "quota" ? "；快取空間不足，模型仍可重試下載" : state.issue === "corrupt" ? "；快取檔案受損，重試時會重新下載" : state.issue === "incomplete" ? "；下載未完整保存，可重試" : "";
    setCacheStatus(state.supported ? `快取：${state.complete ? "完整可用" : "尚未完整"}（${state.artifactCount} 個檔案）${issue}；使用 ${bytes(state.usage)} / ${bytes(state.quota)}；持久化 ${state.persisted === true ? "已允許" : state.persisted === false ? "未允許" : "未知"}` : "此瀏覽器不支援 Cache Storage。");
  }

  return <main className="v2-page"><span className="sr-only">Chrome Built-in AI</span>
    <header className="v2-nav shell"><div className="v2-brand-area"><div className="v2-brand"><button className="v2-brand-trigger" type="button" aria-label="啟用 BrandMark Sparkle Quest Badge" onClick={activateBrandMark}><BrandMark /></button><a className="v2-brand-home" href="#top" aria-label="AI-SmartBook 首頁"><strong>AI-SmartBook</strong></a></div>{showBrandMarkBadge && <div className="v2-brand-badge" role="status" aria-live="polite"><span>✦ AI Quest A-01: Web AI Ready ✦</span><button type="button" aria-label="關閉 BrandMark Sparkle Quest Badge" onClick={dismissBrandMarkBadge}>×</button></div>}</div><nav aria-label="主要導覽"><a href="#features">功能</a><a href="#auto-answer">公開問答</a><a href="#workflow">使用方式</a><a href="#structure">系統架構</a></nav><a className="v2-nav-login" href={studentRoute}>學員登入 <span aria-hidden="true">↗</span></a></header>
    <section className="v2-hero shell" id="top"><div className="v2-hero-copy v2-reveal"><p className="v2-eyebrow"><span />學習，不必在工具之間來回切換</p><h1>把閱讀、提問與<br /><em>下一步</em>放在一起。</h1><p className="v2-lead">AI-SmartBook 是以教材閱讀為中心的學習工作台。從進入書庫，到理解內容與回顧進度，每一步都有清楚的位置。</p><div className="v2-actions"><a className="v2-button v2-button-primary" href={studentRoute}>開始學習 <span aria-hidden="true">→</span></a><a className="v2-button v2-button-secondary" href="#auto-answer">體驗公開問答 <span aria-hidden="true">↓</span></a></div><p className="v2-note">使用既有學員帳號登入即可進入個人學習工作台。</p></div><div className="v2-hero-art v2-reveal v2-delay-1" role="img" aria-label="AI-SmartBook 學習介面示意"><div className="v2-orbit v2-orbit-one" /><div className="v2-orbit v2-orbit-two" /><div className="v2-product-card"><div className="v2-product-top"><span className="v2-mini-brand">✦</span><span>我的學習工作台</span><i /></div><div className="v2-product-body"><aside><span className="active" /><span /><span /><span /></aside><div className="v2-product-content"><p>正在閱讀</p><h2>從教材開始整理你的理解</h2><div className="v2-reading-lines"><b /><b /><b /><b /></div><div className="v2-question"><span>✦</span><p>針對這一段提出問題</p><span aria-hidden="true">↑</span></div></div></div></div><div className="v2-float-card v2-float-progress"><span>◔</span><div><small>學習脈絡</small><b>接續上次閱讀</b></div></div><div className="v2-float-card v2-float-answer"><span>✦</span><div><small>閱讀輔助</small><b>把疑問留在此處</b></div></div></div></section>
    <section className="v2-trust shell" aria-label="產品重點"><span>READ</span><i /><span>ASK</span><i /><span>ORGANIZE</span><i /><span>CONTINUE</span></section>
    <section className="v2-auto shell" id="auto-answer" aria-labelledby="auto-heading">
      <div><p className="v2-eyebrow"><span />Google AI 解答</p><h2 id="auto-heading">輸入主題，先練題再看詳解。</h2><p>本機 AI 會依主題產生練習題，不直接顯示答案。需要詳解時，可另開 Google AI；本機模型無法完成出題時，會將原題直接帶往 Google AI。首次使用本機模型約需下載 618 MB。</p></div>
      <form className="v2-auto-form" onSubmit={submit}>
        <label htmlFor="auto-question">輸入想練習的主題</label>
        <textarea id="auto-question" value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="例如：資料結構的二元搜尋樹，或會計分錄……" disabled={isLoading} />
        <div className="v2-google-action">{question.trim() ? <a className="v2-button v2-button-primary" href={buildGoogleAiModeUrl(question.trim())} target="_blank" rel="noopener noreferrer">跳頁 Google AI 解答 <span aria-hidden="true">↗</span></a> : <button className="v2-button v2-button-primary" type="button" disabled>跳頁 Google AI 解答 <span aria-hidden="true">↗</span></button>}<span>將原題送往 Google；請在新分頁查看解答。</span></div>
        <div className="v2-auto-controls"><select value={model} onChange={(event) => setModel(event.target.value)} aria-label="AI 模型" disabled={isLoading}><option value="Auto">Auto</option><option value="Qwen3-0.6B">Qwen3-0.6B</option></select><select value={mode} onChange={(event) => setMode(event.target.value)} aria-label="助教模式" disabled={isLoading}><option>自動判斷</option><option>可選提示</option><option>教材解釋</option><option>陪練</option><option>錯題引導</option></select><button className="v2-button v2-button-secondary" type="submit" disabled={!question.trim() || isLoading}>{isLoading ? "AI 正在準備練習題…" : "AI 助手出題"}</button></div>
        <p className="v2-auto-status" role="status">目前 AI 執行層：{runtimeLayer === "chrome-built-in" ? "Chrome Built-in AI" : runtimeLayer === "local-model" ? "本機模型" : runtimeLayer === "cloud-handoff" ? "雲端導向（Google AI）" : "尚未選擇"}</p>
        <p className="v2-auto-status">練習題主要提供學員練題；詳解答案請使用 Google AI。</p>
        <div className="v2-quick-modes" aria-label="快速題型">{quickModes.map((item) => <button key={item} type="button" aria-pressed={mode === item} onClick={() => setMode(item)} disabled={isLoading}>{item}</button>)}</div>
        <div className="v2-quick-modes" aria-label="本機模型快取"><button type="button" onClick={() => { void refreshCache(); }}>檢查模型快取</button><button type="button" onClick={() => { void requestLocalModelPersistence().then(refreshCache); }}>申請長期保存</button><button type="button" onClick={() => { if (window.confirm("確定刪除此模型版本的本機快取？")) { autoSubmitter.current.resetPreload(); void deleteLocalModelCache(localModel).then(refreshCache); } }}>刪除本機模型</button></div>
        {cacheStatus && <p className="v2-auto-status" role="status">{cacheStatus}</p>}
        {showDownloadProgress && <section className="v2-progress-panel" aria-live="polite"><p>{formatDownloadProgress(downloadProgress)}</p><ProgressBar determinate={hasKnownDownloadTotal} value={downloadValue} label="本機 AI 模型下載進度" /></section>}
        {progressPanel === "generation" && <section className="v2-progress-panel" aria-live="polite"><p>{`${actionName}：${generationStage === "loading" ? "載入模型" : generationStage === "analyzing" ? "分析題目" : "生成內容"} · 已等待 ${elapsedSeconds} 秒`}</p><ProgressBar determinate={false} label={`${actionName} 處理中`} /></section>}
        {!isLoading && !isPreloading && aiStatus === "local model ready" && <p className="v2-auto-status v2-model-ready" role="status">✓ 本機 AI 模型已準備完成</p>}
        {downloading && <button className="v2-gesture-button" type="button" onClick={() => { requestId.current += 1; preloadRunId.current += 1; autoSubmitter.current.cancel(); setIsPreloading(false); setDownloadProgress(null); setNeedsGesture(true); setAiStatus("local model requires user activation"); setError("已取消模型下載，可再次按開始下載。"); }}>取消下載</button>}
        {isLoading && !downloading && <button className="v2-gesture-button" type="button" onClick={cancelInference}>取消本機 AI 回答</button>}
        {downloadStalled && (isLoading || isPreloading) && <span className="v2-gesture-button" role="alert">下載停滯（連續 90 秒無新資料）</span>}{downloadStalled && (isLoading || isPreloading) && <button className="v2-gesture-button" type="button" onClick={retryDownload}>重新下載</button>}
        {error && <p className="v2-auto-status" role="alert">{aiStatus ? `[${aiStatus}] ` : ""}{error}</p>}
        {needsGesture && !isLoading && <button className="v2-gesture-button" type="button" onClick={() => { void startModelDownload(); }}>開始下載本機模型</button>}
        {answer && <section className="v2-auto-answer" aria-label="AI 助手練習題"><p role="status">AI 助手練習題</p><pre>{answer}</pre><p className="v2-auto-status">先自行作答，詳解答案請由 Google AI 查看。</p><a className="v2-button v2-button-primary" href={buildGoogleAiModeUrl(`請用繁體中文詳解以下練習題，列出答案與解題步驟：\n${answer}`)} target="_blank" rel="noopener noreferrer">查看 Google AI 詳解 <span aria-hidden="true">↗</span></a></section>}
      </form>
    </section>
    <section className="v2-section shell" id="features"><div className="v2-section-heading v2-reveal"><p className="v2-eyebrow"><span />為學習流程而設計</p><h2>不只回答問題，<br />更讓學習能夠接續。</h2></div><div className="v2-feature-grid">{features.map(([number, title, description], index) => <article className={`v2-feature-card v2-reveal v2-delay-${index + 1}`} key={title}><span>{number}</span><div className="v2-feature-icon" aria-hidden="true">{["▤", "✦", "◒", "⌘"][index]}</div><h3>{title}</h3><p>{description}</p><a href={index === 3 ? "/admin" : studentRoute}>前往{index === 3 ? "管理入口" : "學員入口"} <b aria-hidden="true">→</b></a></article>)}</div></section>
    <section className="v2-workflow-wrap" id="workflow"><div className="v2-workflow shell"><div className="v2-section-heading v2-reveal"><p className="v2-eyebrow"><span />一條清楚的使用路徑</p><h2>從開啟教材，<br />到回到自己的節奏。</h2></div><ol className="v2-steps"><li><span>01</span><div><h3>登入學員入口</h3><p>從個人工作台進入已授權的學習內容。</p></div></li><li><span>02</span><div><h3>在書庫開啟教材</h3><p>以章節和閱讀位置建立當下的學習脈絡。</p></div></li><li><span>03</span><div><h3>閱讀、提問、回顧</h3><p>讓閱讀中的問題與後續進度留在同一個工作台。</p></div></li></ol></div></section>
    <section className="v2-structure shell" id="structure"><div className="v2-section-heading"><p className="v2-eyebrow"><span />各司其職，保持連結</p><h2>從學習現場到內容管理，<br />每個角色都有自己的入口。</h2></div><div className="v2-architecture"><article><small>STUDENT</small><h3>學員工作台</h3><p>閱讀、書庫與學習進度。</p><a href={studentRoute}>學員登入 →</a></article><div className="v2-arch-link" aria-hidden="true">→</div><article className="v2-arch-backend"><small>BACKEND</small><h3>服務層</h3><p>以既有帳號、內容與資料流程支援產品運作。</p><span>既有系統服務</span></article><div className="v2-arch-link" aria-hidden="true">→</div><article><small>ADMIN</small><h3>管理工作台</h3><p>帳號、書籍與站台設定管理。</p><a href="/admin">管理員登入 →</a></article></div></section>
    <section className="v2-value shell"><div className="v2-value-inner"><p className="v2-eyebrow"><span />讓工具退到背景</p><h2>把注意力留給<br /><em>真正想理解的事。</em></h2><p>你不需要為了學習拼湊一套流程；閱讀、整理與回顧，應該自然地發生在同一個地方。</p><a className="v2-button v2-button-primary" href={studentRoute}>進入學習工作台 <span aria-hidden="true">→</span></a></div></section>
    <footer className="v2-footer"><div className="shell"><div className="v2-footer-cta"><div><p>準備好回到你的學習節奏了嗎？</p><h2>從下一頁開始。</h2></div><a className="v2-button v2-button-light" href={studentRoute}>學員登入 <span aria-hidden="true">→</span></a></div><div className="v2-footer-bottom"><a className="v2-brand" href="#top"><BrandMark /><strong>AI-SmartBook</strong></a><p>以教材為中心的 AI 學習工作台</p><a href="/admin">管理員入口</a></div></div></footer>
  </main>;
}

function formatDownloadBytes(value: number) {
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}
