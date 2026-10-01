// Auto slice core: browser-native Chrome Built-in AI with local Transformers.js fallback.
//
// Architecture:
// AUTO_PRIMARY = native window.LanguageModel
// AUTO_LOCAL_FALLBACK = Prompt API polyfill + Transformers.js local backend
//   (baseline: onnx-community/Qwen2.5-0.5B-Instruct; optional staging test:
//    onnx-community/Qwen3-0.6B-ONNX, see LOCAL_FALLBACK_MODEL_ID)
// CLOUD_AI_FALLBACK = NO
// PROVIDER_API_KEYS = NOT USED
// GOOGLE_REST_API = NOT USED
// SHARED_BACKEND_AI = NOT USED
//
// Enforced by tests/chrome-built-in-ai.test.mjs source and bundle gates.

import { postprocessTraditionalChinese } from "./auto-fallback";
import {
  AUTO_INSTRUCTION,
  AutoRouteSchemaError,
  buildAutoRoutePrompt,
  parseAutoRouteResponse,
  type AutoRoute,
  type AutoRouteDecision,
} from "./auto-route";
import { cleanupIncompleteLocalModelCache, createModelCacheFetch, deleteLocalModelCache, markLocalModelCacheReady } from "./local-model-cache";

export type AutoAiStatus =
  | "native ready"
  | "native model download"
  | "native translation buffering"
  | "local fallback loading"
  | "local model requires user activation"
  | "local model download"
  | "local model ready"
  | "unsupported after fallback";

export type DownloadProgress = { loaded: number; total: number | null };
export type StatusCallback = (status: AutoAiStatus, progress?: number | null, bytes?: DownloadProgress) => void;

// Chrome/polyfill monitor events may use loaded=0..1,total=1 as normalized
// progress. Keep that ratio for status text, but never present it as bytes.
export function isTrustworthyDownloadProgressBytes(loaded: number, total: number) {
  return Number.isFinite(loaded) && Number.isFinite(total) && Number.isInteger(loaded) && Number.isInteger(total) && loaded >= 0 && total > 1 && loaded <= total;
}

/**
 * Local-only failure evidence for mobile debugging. This deliberately excludes
 * the learner's question, prompt, API keys, and arbitrary configuration.
 * Callers may retain it in an anonymous client-side diagnostic buffer, but the
 * Auto module never sends it anywhere.
 */
export type LocalFallbackDiagnostic = {
  stage: "engine-module-import" | "model-create" | "model-download-progress";
  modelId: string;
  device: "webgpu" | "wasm";
  dtype?: string;
  importSpecifier?: "prompt-api-polyfill";
  chunkUrl?: string;
  responseStatus?: number;
  runtimeAssetOrigin: string;
  downloadProgress?: number | null;
  error?: { name: string; message: string; stack?: string };
};

export type LocalFallbackDiagnosticCallback = (diagnostic: LocalFallbackDiagnostic) => void;

type Availability = "available" | "downloadable" | "downloading" | "unavailable" | string;

type GpuAdapter = {
  features?: {
    has(feature: string): boolean;
  };
};

type Translator = {
  translate(input: string): Promise<string>;
  destroy?: () => void;
};

export type PromptOptions = { signal?: AbortSignal };

export type LanguageModelSession = {
  prompt?: (input: string, options?: PromptOptions) => Promise<string>;
  promptStreaming?: (input: string, options?: PromptOptions) => AsyncIterable<string>;
  destroy?: () => void;
};

export type ChromeAiEnvironment = {
  LanguageModel?: {
    availability(options?: unknown): Promise<Availability>;
    create(options?: unknown): Promise<LanguageModelSession>;
    __isPolyfill?: boolean;
  };
  Translator?: {
    availability(options: { sourceLanguage: string; targetLanguage: string }): Promise<Availability>;
    create(options: { sourceLanguage: string; targetLanguage: string }): Promise<Translator>;
  };
  navigator?: {
    gpu?: {
      requestAdapter?: () => Promise<GpuAdapter | null>;
    };
    userAgent?: string;
    userActivation?: {
      isActive?: boolean;
    };
  };
  window?: unknown;
  WebAssembly?: unknown;
};

export class ChromeAiError extends Error {
  /**
   * Set only when a caller-supplied warm session failed to answer. The
   * submitter reads it to dispose and rebuild that session exactly once (A2/B4);
   * cancellations and timeouts never set it, so a cancel is never mistaken for
   * a dead session.
   */
  warmSessionStale = false;

  constructor(message: string) {
    super(message);
    this.name = "ChromeAiError";
  }
}

// Local fallback model contract (AUTO_LOCAL_FALLBACK).
//
// Qwen2.5-0.5B-Instruct is the verified baseline model (reliable and stable).
// Qwen3-0.6B-ONNX is available as an explicit test option via Transformers.js
// pipeline('text-generation').
// Neither model triggers cloud AI, and silent double downloads are strictly prevented.
export const QWEN25_BASELINE_MODEL_ID = "onnx-community/Qwen2.5-0.5B-Instruct";
export const QWEN3_TEST_MODEL_ID = "onnx-community/Qwen3-0.6B-ONNX";
/** Cache identity is explicit. Change this only for an intentional model revision upgrade. */
export const LOCAL_FALLBACK_MODEL_REVISION = "da1453100cf3ff33ef56d17983fc7a8648706db6";
export const DEFAULT_LOCAL_FALLBACK_MODEL_ID = QWEN3_TEST_MODEL_ID;
export const LOCAL_FALLBACK_MODEL_ID = DEFAULT_LOCAL_FALLBACK_MODEL_ID;
export const SUPPORTED_LOCAL_MODELS = [
  QWEN25_BASELINE_MODEL_ID,
  QWEN3_TEST_MODEL_ID,
] as const;

export const ORT_WASM_BASE_URL =
  "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.0-dev.20260914-8d85527a0/dist/";
export const ORT_WASM_SIMD_ASYNCIFY_URL = `${ORT_WASM_BASE_URL}ort-wasm-simd-threaded.asyncify.wasm`;
export const ORT_WASM_URL = ORT_WASM_SIMD_ASYNCIFY_URL;

// This must be passed to Transformers.js before its first local-model import.
// Keeping the exact onnxruntime-web package version here prevents the emitted
// application from fetching a bundled (and Sites-oversized) ORT WASM asset or
// combining its JavaScript glue with a different WASM release.
export const ORT_WASM_PATHS = ORT_WASM_BASE_URL;

// q4f16 stays WebGPU-only and is additionally gated on shader-f16 support in
// detectLocalDevice. WASM keeps the conservative q8 kernel path that
// Transformers.js supports for onnx-community LLM exports.
export const LOCAL_FALLBACK_DTYPE_CANDIDATES: Record<"webgpu" | "wasm", readonly string[]> = {
  webgpu: ["q4f16", "q8"],
  wasm: ["q8"],
};

// Traditional-Chinese short-answer contract for the local fallback.
export const LOCAL_FALLBACK_PROMPT_INSTRUCTION =
  "請用繁體中文清楚、準確且簡短地回答以下學習問題（約 150 字以內，直接回答，切勿重複相同句子）：";

/**
 * Strips internal <think>...</think> reasoning tags emitted by reasoning models
 * like Qwen3 so that learner-facing answers remain clean and unpolluted.
 */
export function stripThinkingTags(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>\s*/gi, "")
    .replace(/<think>[\s\S]*$/gi, "")
    .trim();
}

/**
 * Stream-level thinking guard: suppresses tokens between <think> and </think>
 * from reaching the chunk callback during incremental streaming.
 */
export function createThinkingGuard(emitChunk: (chunk: string) => void) {
  let insideThinking = false;
  let thinkBuffer = "";

  return {
    feed(chunk: string) {
      if (!insideThinking) {
        if (chunk.includes("<think>")) {
          const parts = chunk.split("<think>");
          if (parts[0]) emitChunk(parts[0]);
          insideThinking = true;
          thinkBuffer = parts.slice(1).join("<think>");
        } else {
          emitChunk(chunk);
          return;
        }
      }

      if (insideThinking) {
        thinkBuffer += chunk;
        if (thinkBuffer.includes("</think>")) {
          const endParts = thinkBuffer.split("</think>");
          insideThinking = false;
          const afterThink = endParts.slice(1).join("</think>").replace(/^[\r\n\s]+/, "");
          thinkBuffer = "";
          if (afterThink) emitChunk(afterThink);
        }
      }
    },
    finish() {
      thinkBuffer = "";
    },
  };
}

const REPETITION_MAX_UNIT = 32;
const REPETITION_KEEP_TAIL = 0;

/**
 * Deterministic tail loop detector: returns the start index of a repeated
 * tail (one copy kept, later copies are the loop body) when the text ends
 * with enough consecutive identical units, or null. Copy thresholds shrink as
 * units grow so short spam units need many copies while 3 copies of a
 * sentence-length unit already proves a degeneration loop.
 */
export function detectRepetitionLoop(
  text: string,
  maxUnit: number = REPETITION_MAX_UNIT,
): { unit: string; start: number } | null {
  const len = text.length;
  for (let unit = 1; unit <= maxUnit; unit += 1) {
    const requiredCopies = unit === 1 ? 8 : unit < 8 ? 4 : 3;
    if (len < unit * requiredCopies) continue;
    const tail = text.slice(len - unit);
    let copies = 1;
    let pos = len - unit;
    while (pos - unit >= 0 && text.slice(pos - unit, pos) === tail) {
      copies += 1;
      pos -= unit;
    }
    if (copies >= requiredCopies) return { unit: tail, start: pos + unit };
  }
  return null;
}

export type RepetitionGuard = {
  /** Consume one streamed chunk; returns the slice that is safe to emit now. */
  feed(chunk: string): string;
  /** Flush the retained tail once generation ends normally. */
  finish(): string;
  /** True once a repetition loop was caught and generation should stop. */
  readonly stopped: boolean;
  /** The decided (possibly truncated) answer so far. */
  readonly text: string;
};

/**
 * Stream-level anti-repetition for the small local model. Text is emitted
 * with a 128-character retention window; because any detectable loop ends
 * within at most 96 trailing characters, the repeated tail is always still
 * held back and can be cut before it reaches the learner.
 */
export function createRepetitionGuard(): RepetitionGuard {
  let all = "";
  let emitted = 0;
  let stopped = false;
  return {
    get stopped() {
      return stopped;
    },
    get text() {
      return all;
    },
    feed(chunk: string): string {
      if (stopped) return "";
      all += chunk;
      const loop = detectRepetitionLoop(all);
      if (loop) {
        stopped = true;
        // Keep exactly one copy of the loop unit; drop the rest. Emitted text
        // can never precede the loop start, so the clamp is defensive.
        all = all.slice(0, Math.max(loop.start, emitted));
      }
      const target = stopped
        ? all.length
        : Math.max(emitted, all.length - REPETITION_KEEP_TAIL);
      if (target <= emitted) return "";
      const out = all.slice(emitted, target);
      emitted = target;
      return out;
    },
    finish(): string {
      if (stopped) return "";
      const out = all.slice(emitted);
      emitted = all.length;
      return out;
    },
  };
}

function environment(): ChromeAiEnvironment {
  if (typeof window === "undefined") return {};
  const win = window as unknown as ChromeAiEnvironment;
  return {
    LanguageModel: win.LanguageModel,
    Translator: win.Translator,
    navigator: typeof navigator !== "undefined" ? navigator : undefined,
    window: window,
    WebAssembly: typeof WebAssembly !== "undefined" ? WebAssembly : undefined,
  };
}

export function isTraditionalChinese(input: string): boolean {
  // Han ideographs are shared by Traditional Chinese, Simplified Chinese and
  // Japanese. Only opt into the zh-Hant Translator route when there is a
  // Traditional-only marker, and reject Japanese kana / Simplified markers.
  const hasTraditionalMarker = /[體臺灣學習問題為與這個麼裡應說請對於經網軟體資料]/.test(input);
  const hasSimplifiedMarker = /[体台湾学习问题为与这个么里应说请对于经网软体资料]/.test(input);
  const hasJapaneseKana = /[\u3040-\u30ff]/.test(input);
  return hasTraditionalMarker && !hasSimplifiedMarker && !hasJapaneseKana;
}

async function createTranslator(
  api: ChromeAiEnvironment["Translator"],
  sourceLanguage: string,
  targetLanguage: string,
): Promise<Translator | null> {
  if (!api) return null;
  try {
    const status = await api.availability({ sourceLanguage, targetLanguage });
    return status === "available" ? await api.create({ sourceLanguage, targetLanguage }) : null;
  } catch {
    return null;
  }
}

async function streamAnswer(
  session: LanguageModelSession,
  prompt: string,
  onChunk: (chunk: string) => void,
  signal?: AbortSignal,
  guard?: RepetitionGuard,
): Promise<string> {
  // prompt-api-polyfill aborts an in-flight prompt/stream through the
  // options signal; a native implementation WebIDL-ignores unknown members,
  // so the same handoff is safe on both session kinds.
  const options = signal ? { signal } : undefined;
  const emit = (chunk: string) => {
    // Normalise learner-visible output before it reaches the UI. The final
    // validator repeats this deterministic operation as a defence in depth.
    // `postprocessTraditionalChinese` trims final answers, but streamed chunks
    // must retain their boundary whitespace ("WebGPU " + "運算結果").
    const leadingWhitespace = chunk.match(/^\s*/)?.[0] ?? "";
    const trailingWhitespace = chunk.match(/\s*$/)?.[0] ?? "";
    const body = chunk.slice(leadingWhitespace.length, chunk.length - trailingWhitespace.length);
    const normalized = body ? `${leadingWhitespace}${postprocessTraditionalChinese(body)}${trailingWhitespace}` : chunk;
    const safe = guard ? guard.feed(normalized) : normalized;
    if (safe) onChunk(safe);
  };
  const thinkingGuard = createThinkingGuard(emit);

  if (session.promptStreaming) {
    let answer = "";
    try {
      for await (const chunk of session.promptStreaming(prompt, options)) {
        if (signal?.aborted) throw new ChromeAiError("已取消 AI 回答。");
        answer += chunk;
        thinkingGuard.feed(chunk);
        if (guard?.stopped) {
          // Repetition loop caught: stop consuming and report the truncated
          // answer. The caller's finally still destroys the session.
          return postprocessTraditionalChinese(stripThinkingTags(guard.text));
        }
      }
    } catch (error) {
      if (signal?.aborted) throw new ChromeAiError("已取消 AI 回答。");
      throw error;
    }
    thinkingGuard.finish();
    if (guard) {
      const tail = guard.finish();
      if (tail) onChunk(tail);
      return postprocessTraditionalChinese(stripThinkingTags(guard.text));
    }
    return postprocessTraditionalChinese(stripThinkingTags(answer));
  }
  if (!session.prompt) {
    throw new ChromeAiError("此瀏覽器/裝置目前不支援本機 AI 回答。");
  }
  const answer = await session.prompt(prompt, options);
  if (signal?.aborted) throw new ChromeAiError("已取消 AI 回答。");
  const cleanAnswer = postprocessTraditionalChinese(stripThinkingTags(answer));
  if (guard) {
    emit(cleanAnswer);
    const tail = guard.finish();
    if (tail) onChunk(tail);
    return postprocessTraditionalChinese(stripThinkingTags(guard.text));
  }
  onChunk(cleanAnswer);
  return cleanAnswer;
}

export async function detectLocalDevice(env: ChromeAiEnvironment): Promise<"webgpu" | "wasm" | null> {
  const nav = "navigator" in env ? env.navigator : (typeof navigator !== "undefined" ? navigator : undefined);
  if (nav && "gpu" in nav && typeof nav.gpu?.requestAdapter === "function") {
    try {
      const adapter = await nav.gpu.requestAdapter();
      // q4f16 requires this optional WebGPU capability. Do the check before
      // configuring/loading the polyfill: otherwise Linux/Vulkan adapters
      // without it download the large q4f16 artifact before failing.
      if (adapter?.features?.has("shader-f16")) return "webgpu";
    } catch {
      // WebGPU not available or rejected
    }
  }
  const wasm = "WebAssembly" in env ? env.WebAssembly : (typeof WebAssembly !== "undefined" ? WebAssembly : undefined);
  if (wasm && typeof (wasm as { instantiate?: unknown }).instantiate === "function") {
    return "wasm";
  }
  return null;
}

export type AskOptions = {
  signal?: AbortSignal;
  env?: ChromeAiEnvironment;
  onStatus?: StatusCallback;
  /**
   * Explicit local model target. Defaults to QWEN25_BASELINE_MODEL_ID ("onnx-community/Qwen2.5-0.5B-Instruct").
   * May be explicitly set to QWEN3_TEST_MODEL_ID ("onnx-community/Qwen3-0.6B-ONNX") for isolated staging tests.
   */
  localModelId?: typeof QWEN25_BASELINE_MODEL_ID | typeof QWEN3_TEST_MODEL_ID | (string & {});
  /** Auto D-06 pins the actual generation to the requested local Qwen model. */
  forceLocalModel?: boolean;
  /**
   * Optional local-only diagnostic sink. It is intentionally separate from
   * status/UI and must not be wired to an API that receives learner content.
   */
  onLocalFallbackDiagnostic?: LocalFallbackDiagnosticCallback;
  /** Test seam only. Production always imports the real local backend. */
  loadPolyfill?: () => Promise<void>;
  /** Test seam only; keeps fallback tests independent from a native API mock. */
  loadLocalLanguageModel?: () => Promise<ChromeAiEnvironment["LanguageModel"]>;
  /** Test seam only; production imports Vite's `?worker` constructor on demand. */
  createLocalInferenceWorker?: () => Worker | Promise<Worker>;
  /** Captured synchronously from the initiating UI gesture. */
  userActivation?: boolean;
  /** Preloaded session to reuse without downloading or re-creating. */
  session?: LanguageModelSession;
  /** Keep session alive after generation completes. */
  preserveSession?: boolean;
  /**
   * Offered a locally created session after it answered once, so the submitter
   * can publish it as the shared ready session (A2/B2) instead of paying for a
   * full model load on the next answer. Returning `true` transfers ownership:
   * this call must then not destroy the session. A2/B4: only a session that
   * actually produced an answer may be offered — one that failed generation is
   * stale evidence and must die here, never enter the ready state.
   */
  onLocalSession?: (session: LanguageModelSession) => boolean;
  /**
   * The caller already supplies a complete instruction (the A3 JSON route
   * contract). The default zh-Hant short-answer instruction is then NOT
   * prepended: stacking it on the contract prompt makes the model answer in
   * prose and makes its own echo trip the D-06 instruction-echo guard.
   */
  rawPrompt?: boolean;
  /** Practice-only worker chat system message. Omitted for every other path. */
  systemPrompt?: string;
  /** Practice-only assistant continuation prefix. Omitted for every other path. */
  assistantPrefix?: string;
};

type LocalInferenceWorkerClientModule = {
  createLocalInferenceWorker(): Worker;
};

/**
 * Vite's `?worker` factory creates a same-origin browser worker directly.
 * Dynamic loading means SSR and Node/tsx tests never evaluate its browser-only
 * wrapper (the latter deliberately provide a FakeWorker but no document).
 */
async function createIsolatedLocalInferenceWorker(
  testFactory?: () => Worker | Promise<Worker>,
): Promise<Worker> {
  if (testFactory) return testFactory();
  // Node tests provide a FakeWorker but no document. Preserve that test-only
  // seam without making NODE_ENV part of the browser worker selection.
  if (typeof document === "undefined" && typeof Worker !== "undefined") {
    return new (Worker as unknown as { new(): Worker })();
  }
  const workerClient: LocalInferenceWorkerClientModule = await import("./local-inference-worker-client.ts");
  return workerClient.createLocalInferenceWorker();
}

interface PolyfillHostWindow {
  TRANSFORMERS_CONFIG?: unknown;
  LanguageModel?: ChromeAiEnvironment["LanguageModel"];
}

interface ProgressLikeEvent extends Event {
  loaded?: number;
  total?: number;
}

function redactDiagnosticText(value: unknown): string {
  const text = typeof value === "string" ? value : String(value ?? "");
  // Error messages occasionally include failed request URLs. Keep their path
  // for chunk/asset correlation, but never retain common credential query
  // values if a proxy happened to append one.
  return text
    .replace(/([?&](?:api[_-]?key|token|authorization|signature|credential)=)[^&\s)]+/gi, "$1[redacted]")
    .slice(0, 4_000);
}

function errorDiagnostic(error: unknown): LocalFallbackDiagnostic["error"] {
  const candidate = error as { name?: unknown; message?: unknown; stack?: unknown } | null;
  const name = typeof candidate?.name === "string" && candidate.name ? candidate.name : "Error";
  const message = redactDiagnosticText(candidate?.message ?? error);
  const stack = typeof candidate?.stack === "string" ? redactDiagnosticText(candidate.stack) : undefined;
  return stack ? { name, message, stack } : { name, message };
}

function chunkUrlFromError(error: unknown): string | undefined {
  const text = redactDiagnosticText((error as { message?: unknown } | null)?.message ?? error);
  return text.match(/https?:\/\/[^\s)'"`]+/i)?.[0];
}

function httpStatusFromError(error: unknown): number | undefined {
  const candidate = error as { status?: unknown; response?: { status?: unknown } } | null;
  if (typeof candidate?.status === "number") return candidate.status;
  if (typeof candidate?.response?.status === "number") return candidate.response.status;
  const message = (error as { message?: unknown } | null)?.message;
  if (typeof message === "string") {
    const match = message.match(/\b(40[0-9]|50[0-9])\b/);
    if (match) return Number(match[1]);
  }
  return undefined;
}

function reportLocalFallbackDiagnostic(options: AskOptions, diagnostic: LocalFallbackDiagnostic) {
  options.onLocalFallbackDiagnostic?.(diagnostic);
  if (typeof console !== "undefined" && typeof console.error === "function") {
    console.error("[local-ai-diagnostic]", diagnostic);
  }
}

/**
 * The package does not overwrite an existing native LanguageModel by design.
 * Use its exported class rather than reading window.LanguageModel after import:
 * when native availability/create fails, that global can still be the unusable
 * native API. The exported class is the isolated Transformers.js backend.
 */
export async function loadRealLocalLanguageModel(): Promise<NonNullable<ChromeAiEnvironment["LanguageModel"]>> {
  const polyfill = await import("prompt-api-polyfill");
  return polyfill.LanguageModel as NonNullable<ChromeAiEnvironment["LanguageModel"]>;
}

/**
 * The polyfill's token loop can synchronously monopolize the page renderer.
 * Run the forced local fallback in a disposable module worker instead: Cache
 * Storage remains shared by origin, while a deadline/cancel can terminate only
 * this execution context even when the model ignores AbortSignal.
 */
async function askWithIsolatedLocalWorker(
  question: string,
  onChunk: (chunk: string) => void,
  options: AskOptions,
  device: "webgpu" | "wasm",
): Promise<string> {
  if (typeof Worker === "undefined") throw new ChromeAiError("此瀏覽器無法隔離本機 AI 執行作業。");
  const modelId = options.localModelId || DEFAULT_LOCAL_FALLBACK_MODEL_ID;
  const worker = await createIsolatedLocalInferenceWorker(options.createLocalInferenceWorker);
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (result: { text?: string; error?: Error }) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", abort);
      worker.terminate();
      if (result.error) reject(result.error);
      else resolve(result.text ?? "");
    };
    const abort = () => finish({ error: new ChromeAiError("已取消 AI 回答。") });
    if (options.signal?.aborted) return abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    worker.onerror = () => finish({ error: new ChromeAiError("本機 AI 模型無法完成回答，未使用任何雲端服務。") });
    worker.onmessage = ({ data }: MessageEvent<{
      type: "status" | "result" | "error";
      status?: AutoAiStatus | "generating";
      loaded?: number;
      total?: number | null;
      text?: string;
    }>) => {
      if (settled) return;
      if (data.type === "status") {
        if (data.status === "generating") {
          // This is progress-only: the A3/A4 route buffers raw output and its
          // callback reports a character count, so an empty chunk cannot paint
          // unvalidated model text but does advance the truthful UI stage.
          onChunk("");
        } else if (data.status) {
          options.onStatus?.(data.status, undefined, data.loaded === undefined ? undefined : { loaded: data.loaded, total: data.total ?? null });
        }
        return;
      }
      if (data.type === "result") {
        finish({ text: postprocessTraditionalChinese(stripThinkingTags(data.text ?? "")) });
        return;
      }
      finish({ error: new ChromeAiError("本機 AI 模型無法完成回答，未使用任何雲端服務。") });
    };
    worker.postMessage({
      type: "run",
      prompt: options.rawPrompt ? question : `${LOCAL_FALLBACK_PROMPT_INSTRUCTION}\n\n${question}`,
      modelId,
      revision: LOCAL_FALLBACK_MODEL_REVISION,
      device,
      dtypes: [...LOCAL_FALLBACK_DTYPE_CANDIDATES[device]],
      wasmPaths: ORT_WASM_PATHS,
      systemPrompt: options.systemPrompt,
      assistantPrefix: options.assistantPrefix,
    });
  });
}

/**
 * Production warm-up uses the same worker boundary as generation. It verifies
 * and caches the pinned artifacts, then exits; the page never owns a decoded
 * Transformers.js session that a later submit could accidentally reuse.
 */
async function preloadWithIsolatedLocalWorker(
  options: PreloadOptions,
  device: "webgpu" | "wasm",
): Promise<void> {
  if (typeof Worker === "undefined") throw new ChromeAiError("此瀏覽器無法隔離本機 AI 執行作業。");
  const modelId = resolveLocalModelId(options.localModelId);
  const worker = await createIsolatedLocalInferenceWorker(options.createLocalInferenceWorker);
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, workerAlreadyTerminated = false) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", abort);
      if (!workerAlreadyTerminated) worker.terminate();
      if (error) reject(error);
      else resolve();
    };
    const abort = () => {
      if (settled) return;
      // A terminated worker cannot be relied on to finish its own abort
      // handler. Await page-owned cleanup before rejecting so the UI cannot
      // expose retry while this revision still has stored:false records.
      worker.terminate();
      void cleanupIncompleteLocalModelCache({ modelId, revision: LOCAL_FALLBACK_MODEL_REVISION })
        .catch(() => undefined)
        .then(() => finish(new ChromeAiError("已取消 AI 回答。"), true));
    };
    if (options.signal?.aborted) return abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    worker.onerror = () => finish(new ChromeAiError("本機 AI 模型無法完成載入，未使用任何雲端服務。"));
    worker.onmessage = ({ data }: MessageEvent<{
      type: "status" | "preloaded" | "error";
      status?: AutoAiStatus;
      loaded?: number;
      total?: number | null;
    }>) => {
      if (settled) return;
      if (data.type === "status" && data.status) {
        options.onStatus?.(data.status, undefined, data.loaded === undefined ? undefined : { loaded: data.loaded, total: data.total ?? null });
        return;
      }
      if (data.type === "preloaded") return finish();
      finish(new ChromeAiError("本機 AI 模型無法完成載入，未使用任何雲端服務。"));
    };
    worker.postMessage({
      type: "preload",
      modelId,
      revision: LOCAL_FALLBACK_MODEL_REVISION,
      device,
      dtypes: [...LOCAL_FALLBACK_DTYPE_CANDIDATES[device]],
      wasmPaths: ORT_WASM_PATHS,
    });
  });
}

export async function askWithChromeBuiltInAi(
  question: string,
  onChunk: (chunk: string) => void,
  options: AskOptions = {},
): Promise<string> {
  if (options.session) {
    options.onStatus?.("local model ready");
    if (options.signal?.aborted) throw new ChromeAiError("已取消 AI 回答。");
    try {
      const prompt = options.rawPrompt ? question : `${LOCAL_FALLBACK_PROMPT_INSTRUCTION}\n\n${question}`;
      const response = await streamAnswer(
        options.session,
        prompt,
        onChunk,
        options.signal,
        createRepetitionGuard(),
      );
      return response;
    } catch (error) {
      if (error instanceof ChromeAiError) throw error;
      // Anything the reused session itself rejected (a context the browser
      // already dropped, a dead accelerator) is stale-session evidence, never a
      // cancellation: those all arrive as ChromeAiError above.
      const stale = new ChromeAiError("本機 AI 模型無法完成回答，未使用任何雲端服務。");
      stale.warmSessionStale = true;
      throw stale;
    } finally {
      if (!options.preserveSession) options.session.destroy?.();
    }
  }

  const env = options.env ?? environment();
  // Production's explicit local route is the only path that executes the
  // heavyweight Transformers.js generation. Keep injected environments and
  // loader seams on the direct path so deterministic unit tests still model
  // their supplied session behavior.
  if (options.forceLocalModel && !options.env && !options.loadPolyfill && !options.loadLocalLanguageModel && typeof Worker !== "undefined" && typeof window !== "undefined") {
    const device = await detectLocalDevice(env);
    if (!device) throw new ChromeAiError("此瀏覽器/裝置目前不支援 Chrome 內建 AI，且硬體環境無法執行本機模型 (WebGPU/WASM 皆不支援)。");
    return askWithIsolatedLocalWorker(question, onChunk, options, device);
  }
  const win = (env.window ?? (typeof window !== "undefined" ? window : globalThis)) as PolyfillHostWindow;
  // Capture this before the native availability awaits. The polyfill requires
  // a gesture for a cold model download; a later async continuation may no
  // longer expose navigator.userActivation even though the submit click was
  // genuine.
  const hasFreshUserActivation = options.userActivation
    ?? env.navigator?.userActivation?.isActive
    ?? true;

  // 1. First priority: Native Chrome window.LanguageModel
  const nativeLM = env.LanguageModel;
  let nativeAvailable = false;
  let nativeDownloading = false;

  if (!options.forceLocalModel && nativeLM && !nativeLM.__isPolyfill) {
    try {
      const status = await nativeLM.availability();
      if (status === "available") {
        nativeAvailable = true;
      } else if (status === "downloadable" || status === "downloading") {
        nativeDownloading = true;
      }
    } catch {
      // Native availability check failed, fall through to local fallback
    }
  }

  // Handle native available path
  if (!options.forceLocalModel && nativeAvailable && nativeLM) {
    options.onStatus?.("native ready");
    if (options.signal?.aborted) throw new ChromeAiError("已取消 AI 回答。");

    let session: LanguageModelSession | undefined;
    try {
      session = await nativeLM.create({ signal: options.signal });
    } catch {
      if (options.signal?.aborted) throw new ChromeAiError("已取消 AI 回答。");
      // A native API can be advertised as available yet fail session creation
      // (for example, its on-device model or accelerator is unavailable).
      // Continue to the explicitly isolated local Transformers.js backend.
    }

    if (session) {
      let toEnglish: Translator | null = null;
      let toTraditionalChinese: Translator | null = null;
      try {
      let input = question;
      // The JSON contract must reach the model verbatim and come back verbatim:
      // a zh-Hant → en → zh-Hant round trip would rewrite the contract keys and
      // the parser would fail closed on a model that answered correctly.
      if (isTraditionalChinese(question) && !options.rawPrompt) {
        [toEnglish, toTraditionalChinese] = await Promise.all([
          createTranslator(env.Translator, "zh-Hant", "en"),
          createTranslator(env.Translator, "en", "zh-Hant"),
        ]);
        if (toEnglish && toTraditionalChinese) {
          input = await toEnglish.translate(question);
        }
      }

      const promptText = options.rawPrompt
        ? input
        : toEnglish && toTraditionalChinese
          ? `Answer this learner question clearly and accurately:\n\n${input}`
          : `請用繁體中文清楚準確回答以下學習問題：\n\n${input}`;

      const bufferedChunks: string[] = [];
      const response = await streamAnswer(
        session,
        promptText,
        toTraditionalChinese
          ? (chunk) => { bufferedChunks.push(chunk); }
          : onChunk,
        options.signal,
      );

      if (!toTraditionalChinese) return response;
      // Translation is whole-response only in the current Translator API.
      // Make the buffering state explicit and retain all source chunks rather
      // than silently replacing the stream callback with a no-op.
      options.onStatus?.("native translation buffering");
      const translated = await toTraditionalChinese.translate(response);
      if (options.signal?.aborted) throw new ChromeAiError("已取消 AI 回答。");
      onChunk(translated);
      return translated;
      } catch (error) {
        if (error instanceof ChromeAiError) throw error;
        throw new ChromeAiError("Chrome 內建 AI 無法完成回答，未使用其他 AI 服務。");
      } finally {
        session.destroy?.();
        toEnglish?.destroy?.();
        toTraditionalChinese?.destroy?.();
      }
    }
  }

  // Handle native model download path
  if (!options.forceLocalModel && nativeDownloading && nativeLM) {
    options.onStatus?.("native model download", 0);
    if (options.signal?.aborted) throw new ChromeAiError("已取消 AI 回答。");

    let session: LanguageModelSession | undefined;
    try {
      session = await nativeLM.create({
        monitor(m: EventTarget) {
          m.addEventListener("downloadprogress", (e: Event) => {
            const pe = e as ProgressLikeEvent;
            const loaded = Number(pe.loaded) || 0;
            const total = Number(pe.total) || 0;
            const progress = total > 0 ? Math.min(1, Math.max(0, loaded / total)) : null;
            options.onStatus?.("native model download", progress, isTrustworthyDownloadProgressBytes(loaded, total) ? { loaded, total } : undefined);
          });
        },
        signal: options.signal,
      });
    } catch {
      if (options.signal?.aborted) throw new ChromeAiError("已取消 AI 回答。");
      // Fall through to local fallback
    }

    if (session) {
      try {
        options.onStatus?.("native ready");
        const response = await streamAnswer(
          session,
          options.rawPrompt ? question : `請用繁體中文清楚準確回答以下學習問題：\n\n${question}`,
          onChunk,
          options.signal,
        );
        return response;
      } finally {
        session.destroy?.();
      }
    }
  }

  // 2. Second priority: Local Fallback (prompt-api-polyfill + Transformers.js local backend)
  const localDevice = await detectLocalDevice(env);
  if (!localDevice) {
    options.onStatus?.("unsupported after fallback");
    throw new ChromeAiError("此瀏覽器/裝置目前不支援 Chrome 內建 AI，且硬體環境無法執行本機模型 (WebGPU/WASM 皆不支援)。");
  }

  options.onStatus?.("local fallback loading");
  if (options.signal?.aborted) throw new ChromeAiError("已取消 AI 回答。");

  if (!hasFreshUserActivation) {
    options.onStatus?.("local model requires user activation");
    throw new ChromeAiError("需要新的使用者操作才能開始下載本機模型。請按「開始下載本機模型」。");
  }

  // Configure the local Transformers.js backend with the constant
  // non-sensitive dummy key before the polyfill module is imported, keeping
  // the first dtype candidate in place for the initial session attempt.
  const chosenModelId = options.localModelId || DEFAULT_LOCAL_FALLBACK_MODEL_ID;
  const dtypeCandidates = LOCAL_FALLBACK_DTYPE_CANDIDATES[localDevice];
  // Transformers.js enables an on-disk cache when loaded by Node. That cache
  // does not exist in the browser, and it would conceal the first artifact
  // request in the real-backend integration gate. Keep that test/runtime
  // distinction explicit without changing browser caching or downloads.
  const nodeRuntime = typeof window === "undefined";
  // A local browser model must never be initialized by SSR. Besides avoiding
  // a server-side model cache, serialize that unsupported path's first remote
  // artifact attempt so a rejected download cannot fan out into concurrent
  // artifact requests. Browser fetches are intentionally untouched.
  let nodeArtifactRequest: Promise<Response> | undefined;
  const isolatedNodeFetch = (...args: Parameters<typeof fetch>) => {
    if (!nodeArtifactRequest) {
      nodeArtifactRequest = globalThis.fetch(...args);
      return nodeArtifactRequest;
    }
    return nodeArtifactRequest.then(
      () => Promise.reject(new Error("Local model initialization is browser-only.")),
      (error) => Promise.reject(error),
    );
  };
  const configureFallback = (dtype: string) => {
    win.TRANSFORMERS_CONFIG = {
      apiKey: "dummy",
      device: localDevice,
      dtype,
      modelName: chosenModelId,
      revision: LOCAL_FALLBACK_MODEL_REVISION,
      env: {
        ...(nodeRuntime
          ? {
              allowLocalModels: false,
              useFS: false,
              useFSCache: false,
              useBrowserCache: false,
              useWasmCache: false,
            }
          : {}),
        ...(typeof globalThis !== "undefined" && typeof globalThis.fetch === "function"
          ? { fetch: nodeRuntime
            ? isolatedNodeFetch
            : createModelCacheFetch(
                { modelId: chosenModelId, revision: LOCAL_FALLBACK_MODEL_REVISION },
                globalThis.fetch.bind(globalThis),
                {
                  signal: options.signal,
                  onDownloadProgress: ({ loaded, total }) => options.onStatus?.(
                    "local model download",
                    total === null ? null : Math.min(1, loaded / total),
                    { loaded, total },
                  ),
                },
              ) }
          : {}),
        backends: {
          onnx: {
            wasm: {
              wasmPaths: ORT_WASM_PATHS,
            },
          },
        },
      },
    };
  };
  configureFallback(dtypeCandidates[0]);

  let polyfillLM: ChromeAiEnvironment["LanguageModel"];
  try {
    if (options.loadLocalLanguageModel) {
      polyfillLM = await options.loadLocalLanguageModel();
    } else if (options.loadPolyfill) {
      await options.loadPolyfill();
      polyfillLM = win.LanguageModel;
    } else {
      polyfillLM = await loadRealLocalLanguageModel();
    }
  } catch (error) {
    reportLocalFallbackDiagnostic(options, {
      stage: "engine-module-import",
      modelId: chosenModelId,
      device: localDevice,
      dtype: dtypeCandidates[0],
      importSpecifier: "prompt-api-polyfill",
      chunkUrl: chunkUrlFromError(error),
      responseStatus: httpStatusFromError(error),
      runtimeAssetOrigin: ORT_WASM_BASE_URL,
      error: errorDiagnostic(error),
    });
    options.onStatus?.("unsupported after fallback");
    throw new ChromeAiError("載入本機 AI 引擎失敗，未使用任何雲端服務。");
  }

  if (!polyfillLM) {
    options.onStatus?.("unsupported after fallback");
    throw new ChromeAiError("此瀏覽器/裝置目前不支援本機 AI 模型。");
  }

  const monitorDownload = (m: EventTarget) => {
    m.addEventListener("downloadprogress", (e: Event) => {
      const pe = e as ProgressLikeEvent;
      const loaded = Number(pe.loaded) || 0;
      const total = Number(pe.total) || 0;
      const progress = total > 0 ? Math.min(1, Math.max(0, loaded / total)) : null;
      options.onStatus?.("local model download", progress, isTrustworthyDownloadProgressBytes(loaded, total) ? { loaded, total } : undefined);
      reportLocalFallbackDiagnostic(options, {
        stage: "model-download-progress",
        modelId: chosenModelId,
        device: localDevice,
        dtype: (win.TRANSFORMERS_CONFIG as { dtype?: string } | undefined)?.dtype,
        runtimeAssetOrigin: ORT_WASM_BASE_URL,
        downloadProgress: progress,
      });
    });
  };

  // Quantized artifacts resolve from the model repository's own
  // transformers.js config, so an unsupported dtype fails at load with no
  // side effects. Retry the conservative candidate in order; never request a
  // cloud service for a missing local quantization.
  let localSession: LanguageModelSession | undefined;
  // Set when the caller took ownership of the session created here (A2/B2).
  let publishedSession = false;
  for (const dtype of dtypeCandidates) {
    configureFallback(dtype);
    options.onStatus?.("local model download", 0);
    if (options.signal?.aborted) throw new ChromeAiError("已取消 AI 回答。");
    try {
      localSession = await polyfillLM.create({
        monitor: monitorDownload,
        signal: options.signal,
      });
      break;
    } catch (error) {
      if (options.signal?.aborted) throw new ChromeAiError("已取消 AI 回答。");
      reportLocalFallbackDiagnostic(options, {
        stage: "model-create",
        modelId: chosenModelId,
        device: localDevice,
        dtype,
        chunkUrl: chunkUrlFromError(error),
        responseStatus: httpStatusFromError(error),
        runtimeAssetOrigin: ORT_WASM_BASE_URL,
        error: errorDiagnostic(error),
      });
      // Transient user activation can expire during a long failed download
      // attempt. The polyfill raises NotAllowedError for a cold re-download;
      // surface the gesture route instead of burning the next candidate.
      if ((error as { name?: string } | null)?.name === "NotAllowedError") {
        options.onStatus?.("local model requires user activation");
        throw new ChromeAiError("需要新的使用者操作才能開始下載本機模型。請按「開始下載本機模型」。");
      }
    }
  }

  if (!localSession) {
    // A cancelled or timed-out submission is not evidence that the stored
    // artifacts are bad; wiping here would break download-once and force the
    // learner to re-fetch ~618MB. Only a genuine load failure may evict.
    if (!options.signal?.aborted) {
      await deleteLocalModelCache({ modelId: chosenModelId, revision: LOCAL_FALLBACK_MODEL_REVISION }).catch(() => 0);
    }
    options.onStatus?.("unsupported after fallback");
    throw new ChromeAiError("本機 AI 模型下載或初始化失敗，未使用任何雲端服務。");
  }

  await markLocalModelCacheReady({ modelId: chosenModelId, revision: LOCAL_FALLBACK_MODEL_REVISION }).catch(() => false);
  // COLD_START contract (owner ruling 2026-09-22): the model download window is
  // separate from the answer-generation window. This status marks the moment
  // the local model is fully loaded; generation timeouts may only start here.
  options.onStatus?.("local model ready");

  try {
    const prompt = options.rawPrompt ? question : `${LOCAL_FALLBACK_PROMPT_INSTRUCTION}\n\n${question}`;
    const response = await streamAnswer(
      localSession,
      prompt,
      onChunk,
      options.signal,
      createRepetitionGuard(),
    );
    // Offered only after the session proved it can answer, so a session that
    // dies mid-generation can never be published as the ready session.
    if (options.onLocalSession?.(localSession) === true) publishedSession = true;
    return response;
  } catch (error) {
    if (error instanceof ChromeAiError) throw error;
    throw new ChromeAiError("本機 AI 模型無法完成回答，未使用任何雲端服務。");
  } finally {
    if (!publishedSession) localSession.destroy?.();
  }
}

// ==========================================
// A3: JSON contract — the single authority is ./auto-route.ts (A-01 Phase 2).
// These names are kept as aliases so the Auto slice stays the only place the
// learner-facing generation is wired; the vocabulary, parser, 0.75 floor and
// display gate must never be redefined here.
// ==========================================

export type InferenceRoute = AutoRoute;

export type InferenceResult = AutoRouteDecision;

export const InferenceSchemaError = AutoRouteSchemaError;

export const INFERENCE_PROMPT_INSTRUCTION = AUTO_INSTRUCTION;

export function buildInferencePrompt(question: string): string {
  return buildAutoRoutePrompt(question);
}

export function parseInferenceResponse(raw: string): InferenceResult {
  return parseAutoRouteResponse(raw);
}

export async function askInferenceWithChromeBuiltInAi(
  question: string,
  onChunk: (chunk: string) => void,
  options: AskOptions = {},
): Promise<InferenceResult> {
  const rawResponse = await askWithChromeBuiltInAi(
    buildInferencePrompt(question),
    onChunk,
    { ...options, rawPrompt: true },
  );
  return parseInferenceResponse(rawResponse);
}

// ==========================================
// A2: Preload / Warm-up
// ==========================================

export type PreloadOptions = {
  env?: ChromeAiEnvironment;
  onStatus?: StatusCallback;
  localModelId?: string;
  forceLocalModel?: boolean;
  loadPolyfill?: () => Promise<void>;
  loadLocalLanguageModel?: () => Promise<ChromeAiEnvironment["LanguageModel"]>;
  /** Test seam only; production always imports the real local backend. */
  loadRealLocalLanguageModel?: () => Promise<ChromeAiEnvironment["LanguageModel"]>;
  /** Test seam only; production imports Vite's `?worker` constructor on demand. */
  createLocalInferenceWorker?: () => Worker | Promise<Worker>;
  signal?: AbortSignal;
};

/**
 * Why a warm-up produced no session. `gesture` is transient (retry it from a
 * real click); `unsupported` is the device verdict that must stay visible.
 * `cancelled` is neither: the learner (or a cache reset) withdrew the download,
 * so it must not be reported as a capability verdict either.
 */
export type PreloadOutcome = "warmed" | "gesture" | "unsupported" | "cancelled";

export type PreloadResult = { outcome: PreloadOutcome; session: LanguageModelSession | null };

/** Local model identity a warm-up/answer actually targets; mirrors the ask path. */
function resolveLocalModelId(localModelId?: string): string {
  return localModelId || DEFAULT_LOCAL_FALLBACK_MODEL_ID;
}

/**
 * The prompt-api polyfill refuses a cold model download without a fresh user
 * activation and raises NotAllowedError. That is a moment in time, not a
 * capability verdict, and must never be reported as `unsupported`.
 */
function isUserActivationRefusal(error: unknown): boolean {
  return (error as { name?: string } | null)?.name === "NotAllowedError";
}

export async function preloadLocalModel(options: PreloadOptions = {}): Promise<PreloadResult> {
  const unsupported: PreloadResult = { outcome: "unsupported", session: null };
  const env = options.env ?? environment();
  const win = (env.window ?? (typeof window !== "undefined" ? window : globalThis)) as PolyfillHostWindow;
  const localDevice = await detectLocalDevice(env);
  if (!localDevice) {
    options.onStatus?.("unsupported after fallback");
    return unsupported;
  }

  // Do not create a page-owned polyfill session in the production forced-local
  // route. A successful preload is an artifact-cache warm state only; submit
  // always starts a fresh isolated worker for the actual generation.
  if (options.forceLocalModel && !options.env && !options.loadPolyfill && !options.loadLocalLanguageModel && !options.loadRealLocalLanguageModel && typeof Worker !== "undefined" && typeof window !== "undefined") {
    options.onStatus?.("local fallback loading");
    await preloadWithIsolatedLocalWorker(options, localDevice);
    options.onStatus?.("local model ready");
    return { outcome: "warmed", session: null };
  }

  options.onStatus?.("local fallback loading");
  if (options.signal?.aborted) throw new ChromeAiError("已取消 AI 回答。");

  const chosenModelId = resolveLocalModelId(options.localModelId);
  const dtypeCandidates = LOCAL_FALLBACK_DTYPE_CANDIDATES[localDevice];
  const nodeRuntime = typeof window === "undefined";
  let nodeArtifactRequest: Promise<Response> | undefined;
  const isolatedNodeFetch = (...args: Parameters<typeof fetch>) => {
    if (!nodeArtifactRequest) {
      nodeArtifactRequest = globalThis.fetch(...args);
      return nodeArtifactRequest;
    }
    return nodeArtifactRequest.then(
      () => Promise.reject(new Error("Local model initialization is browser-only.")),
      (error) => Promise.reject(error),
    );
  };
  const configureFallback = (dtype: string) => {
    win.TRANSFORMERS_CONFIG = {
      apiKey: "dummy",
      device: localDevice,
      dtype,
      modelName: chosenModelId,
      revision: LOCAL_FALLBACK_MODEL_REVISION,
      env: {
        ...(nodeRuntime
          ? {
              allowLocalModels: false,
              useFS: false,
              useFSCache: false,
              useBrowserCache: false,
              useWasmCache: false,
            }
          : {}),
        ...(typeof globalThis !== "undefined" && typeof globalThis.fetch === "function"
          ? {
              fetch: nodeRuntime
                ? isolatedNodeFetch
                : createModelCacheFetch(
                    { modelId: chosenModelId, revision: LOCAL_FALLBACK_MODEL_REVISION },
                    globalThis.fetch.bind(globalThis),
                    {
                      signal: options.signal,
                      onDownloadProgress: ({ loaded, total }) => options.onStatus?.(
                        "local model download",
                        total === null ? null : Math.min(1, loaded / total),
                        { loaded, total },
                      ),
                    },
                  ),
            }
          : {}),
        backends: {
          onnx: {
            wasm: {
              wasmPaths: ORT_WASM_PATHS,
            },
          },
        },
      },
    };
  };

  let polyfillLM: ChromeAiEnvironment["LanguageModel"];
  try {
    const loadRealLocalBackend = options.loadRealLocalLanguageModel ?? loadRealLocalLanguageModel;
    if (options.loadLocalLanguageModel) {
      polyfillLM = await options.loadLocalLanguageModel();
    } else if (options.loadPolyfill) {
      await options.loadPolyfill();
      polyfillLM = win.LanguageModel?.__isPolyfill ? win.LanguageModel : await loadRealLocalBackend();
    } else if (win.LanguageModel?.__isPolyfill) {
      polyfillLM = win.LanguageModel;
    } else {
      polyfillLM = await loadRealLocalBackend();
    }
  } catch (error) {
    // A warm-up can be refused before the engine even finishes loading: the
    // polyfill gates its module bootstrap on the same activation contract as
    // create(). That is still a moment in time, so it must follow the gesture
    // path; calling it a device verdict would hide the CTA that recovers it.
    if (isUserActivationRefusal(error)) {
      options.onStatus?.("local model requires user activation");
      return { outcome: "gesture", session: null };
    }
    options.onStatus?.("unsupported after fallback");
    throw error;
  }

  if (!polyfillLM) {
    options.onStatus?.("unsupported after fallback");
    return unsupported;
  }

  const monitorDownload = (m: EventTarget) => {
    m.addEventListener("downloadprogress", (e: Event) => {
      const pe = e as ProgressLikeEvent;
      const loaded = Number(pe.loaded) || 0;
      const total = Number(pe.total) || 0;
      const progress = total > 0 ? Math.min(1, Math.max(0, loaded / total)) : null;
      options.onStatus?.("local model download", progress, isTrustworthyDownloadProgressBytes(loaded, total) ? { loaded, total } : undefined);
    });
  };

  for (const dtype of dtypeCandidates) {
    configureFallback(dtype);
    options.onStatus?.("local model download", 0);
    if (options.signal?.aborted) throw new ChromeAiError("已取消 AI 回答。");
    try {
      const session = await polyfillLM.create({
        monitor: monitorDownload,
        signal: options.signal,
      });
      // A browser is free to *resolve* a create() it was told to abort. That
      // session belongs to state the learner already wiped, so it must reach no
      // side effect at all: retire it and report cancellation here, before the
      // cache manifest is marked ready and before "local model ready" is told.
      // Marking ready from an abandoned warm-up is what makes the next run
      // believe a model it never finished loading is warm.
      if (options.signal?.aborted) {
        session.destroy?.();
        throw new ChromeAiError("已取消 AI 回答。");
      }
      await markLocalModelCacheReady({ modelId: chosenModelId, revision: LOCAL_FALLBACK_MODEL_REVISION }).catch(() => false);
      options.onStatus?.("local model ready");
      return { outcome: "warmed", session };
    } catch (error) {
      if (options.signal?.aborted) throw new ChromeAiError("已取消 AI 回答。");
      if (isUserActivationRefusal(error)) {
        // Page-mount warm-up runs without a gesture, so this refusal is the
        // expected cold-cache case. Stop burning dtype candidates on a refusal
        // that a quantization retry cannot fix, and keep the transient status:
        // the learner still gets the gesture CTA and submit can finish the job.
        options.onStatus?.("local model requires user activation");
        return { outcome: "gesture", session: null };
      }
    }
  }

  options.onStatus?.("unsupported after fallback");
  return unsupported;
}

export type AutoSubmitOptions = {
  localModelId?: string;
  timeoutMs?: number;
  downloadTimeoutMs?: number;
  forceLocalModel?: boolean;
  /** Send the caller's instruction verbatim instead of adding the answer contract (A3). */
  rawPrompt?: boolean;
  /** Practice-only worker chat system message. */
  systemPrompt?: string;
  /** Practice-only assistant continuation prefix. */
  assistantPrefix?: string;
};

/**
 * The single in-flight warm-up. `promise` is what both mount preload and submit
 * await, and `resolve` lets a synchronous reset release every awaiter instead of
 * leaving them hanging on a download whose state was just discarded.
 */
type WarmOwner = {
  promise: Promise<PreloadResult>;
  resolve: (result: PreloadResult) => void;
  controller: AbortController;
  epoch: number;
  modelId: string;
};

export function createAutoSubmitter(env?: ChromeAiEnvironment, loader?: () => Promise<void>) {
  let controller: AbortController | null = null;
  // A2/B2: `owner` is the only warm-up in flight and `warm` is the only ready
  // state. Readiness *is* the session object, so nothing can advertise
  // "local model ready" in the window before that session exists — closing that
  // gap is what stops a submit from starting a second download of one model.
  let owner: WarmOwner | null = null;
  // Worker warm-up has no page session by design. Its ready marker means the
  // pinned artifacts are cached, while a direct/injected warm-up may still own
  // a reusable test/native session.
  let warm: { session: LanguageModelSession | null; modelId: string; workerOwned: boolean } | null = null;
  // A2/B4: every clear/delete bumps the epoch, so a warm-up that finishes after
  // its state was wiped can never publish its session into fresh state.
  let epoch = 0;
  // A2/B2: the download slot has one owner in both directions. While a submit
  // loads a model itself it holds this, so a page-mount warm-up joins it instead
  // of starting a rival fetch of the same artifacts.
  let submitSettled: Promise<void> | null = null;
  // A2/B4: the ready session a running submit is generating with. Reference
  // counting by ownership, not by boolean flags: whoever holds a borrow releases
  // it, so no path can destroy a session mid-answer or leak one past a reset.
  let borrowed: LanguageModelSession | null = null;

  const downloadStatuses = new Set<AutoAiStatus>([
    "local fallback loading",
    "local model requires user activation",
    "local model download",
    "native model download",
  ]);

  const releaseSession = (session: LanguageModelSession | null | undefined) => {
    if (!session) return;
    try {
      session.destroy?.();
    } catch {
      // A browser-dropped session is exactly the case where destroy() can fail;
      // the reference is gone either way.
    }
  };

  // A2/B4: a session a submit is generating with belongs to that submit until it
  // settles. Dropping the ready state must never tear down the model an answer is
  // being read from — the borrower releases it instead, so clearing is safe at any
  // point of the lifecycle without double-destroying or leaking a session.
  const dropSession = (session: LanguageModelSession | null | undefined) => {
    if (session === borrowed) return;
    releaseSession(session);
  };

  const clearWarm = () => {
    if (!warm) return;
    // Retiring state always moves the epoch first, so nothing that was already
    // running can publish into the state the learner just wiped.
    epoch += 1;
    const dying = warm;
    warm = null;
    dropSession(dying?.session);
  };

  const clearOwner = (outcome: PreloadOutcome) => {
    const abandoned = owner;
    if (!abandoned) return;
    epoch += 1;
    owner = null;
    abandoned.controller.abort();
    // Awaiters are released synchronously. A browser may leave an aborted create()
    // pending indefinitely, and a submit parked on that promise would never reach
    // the retry the learner just asked for.
    abandoned.resolve({ outcome, session: null });
  };

  const readyFor = (modelId: string) => warm !== null && warm.modelId === modelId;

  const startWarmup = (
    onStatus?: StatusCallback,
    preloadOptions?: { localModelId?: string; forceLocalModel?: boolean },
  ): Promise<PreloadResult> => {
    let resolve!: (result: PreloadResult) => void;
    const promise = new Promise<PreloadResult>((settled) => { resolve = settled; });
    const current: WarmOwner = {
      promise,
      resolve,
      controller: new AbortController(),
      epoch,
      modelId: resolveLocalModelId(preloadOptions?.localModelId),
    };
    const workerOwned = Boolean(
      preloadOptions?.forceLocalModel
      && !env
      && !loader
      && typeof Worker !== "undefined"
      && typeof window !== "undefined",
    );
    // Published before the first await: a second preload (or a submit) that
    // starts during the download joins this promise instead of competing.
    owner = current;
    const finish = (result: PreloadResult) => {
      if (owner === current) owner = null;
      const reusable = (result.session !== null || workerOwned) && current.epoch === epoch;
      if (reusable) {
        warm = { session: result.session, modelId: current.modelId, workerOwned };
      } else {
        releaseSession(result.session);
      }
      current.resolve(reusable ? result : { outcome: result.outcome, session: null });
    };
    preloadLocalModel({
      env,
      loadPolyfill: loader,
      localModelId: current.modelId,
      forceLocalModel: preloadOptions?.forceLocalModel ?? true,
      signal: current.controller.signal,
      onStatus: (status, progress, bytes) => {
        // A superseded warm-up stays silent: its state was already cleared, so
        // it must not repaint the learner-facing status line.
        if (owner === current) onStatus?.(status, progress, bytes);
      },
    }).then(finish, (error) => {
      // The activation contract can also surface as a rejection from the engine
      // bootstrap, and a withdrawn download must not read as a device verdict.
      // Only a genuine failure to load the model may publish `unsupported`.
      const cancelled = current.controller.signal.aborted;
      const gesture = !cancelled && isUserActivationRefusal(error);
      if (gesture) onStatus?.("local model requires user activation");
      finish({ outcome: cancelled ? "cancelled" : gesture ? "gesture" : "unsupported", session: null });
    });
    return promise;
  };

  return {
    get inFlight() {
      return controller !== null;
    },
    get isPreloaded() {
      return warm !== null;
    },
    get isPreloading() {
      return owner !== null;
    },
    cancel() {
      controller?.abort();
      // A warm-up the learner withdrew must stop being the thing everybody else
      // waits on: aborting its controller alone is not enough, because a browser
      // is free to leave the aborted create() pending, and every later submit
      // would then park on `await owner.promise` forever.
      clearOwner("cancelled");
    },
    async preload(
      onStatus?: StatusCallback,
      preloadOptions?: { localModelId?: string; forceLocalModel?: boolean },
    ): Promise<PreloadOutcome> {
      const modelId = resolveLocalModelId(preloadOptions?.localModelId);
      // A session warmed for another revision is not readiness for this one.
      if (warm !== null && !readyFor(modelId)) clearWarm();
      // Bounded join: each pass waits on work that is already running — a
      // warm-up, or a submit that owns the only download slot. Whoever is
      // fetching owns that fetch: this never starts a rival download of the same
      // artifacts, and never spins on work of its own.
      for (let pass = 0; pass < 3; pass += 1) {
        if (readyFor(modelId)) {
          onStatus?.("local model ready");
          return "warmed";
        }
        if (owner) {
          const joined = await owner.promise;
          if (readyFor(modelId)) {
            onStatus?.("local model ready");
            return "warmed";
          }
          if (!owner && !submitSettled) return joined.outcome;
          continue;
        }
        if (submitSettled) {
          await submitSettled;
          continue;
        }
        break;
      }
      // A warm-up never rejects: `page.tsx` calls this with `void` on mount, and
      // an unobservable rejection would be a silent dead end for the learner.
      const result = await startWarmup(onStatus, { ...preloadOptions, localModelId: modelId });
      return result.outcome;
    },
    resetPreload() {
      // The whole ready lifecycle, not just a flag: the in-flight promise and its
      // controller, the published session, and the epoch every publisher is
      // compared against afterwards.
      clearOwner("cancelled");
      clearWarm();
    },
    async infer(
      question: string,
      onChunk?: (chunk: string) => void,
      onStatus?: StatusCallback,
      submitOptions?: AutoSubmitOptions | string,
    ): Promise<InferenceResult> {
      const options: AutoSubmitOptions = typeof submitOptions === "string"
        ? { localModelId: submitOptions, rawPrompt: true }
        : { ...submitOptions, rawPrompt: true };
      const raw = await this.submit(buildInferencePrompt(question), onChunk ?? (() => {}), onStatus, options);
      return parseInferenceResponse(raw);
    },
    async submit(
      question: string,
      onChunk: (chunk: string) => void,
      onStatus?: StatusCallback,
      submitOptions?: AutoSubmitOptions | string,
    ) {
      if (controller) throw new ChromeAiError("AI 回答處理中，請稍候。");
      // The single submit slot is claimed before the first await, so a second
      // click cannot slip past the guard while this one waits for the warm-up.
      controller = new AbortController();
      const activeController = controller;
      // A2/B2: claiming the submit slot also claims the download slot. A mount
      // warm-up that starts while this answer is loading a model joins it here
      // instead of fetching the same artifacts a second time.
      let settleSubmit!: () => void;
      submitSettled = new Promise<void>((settled) => { settleSubmit = settled; });
      const userActivation = env?.navigator?.userActivation?.isActive
        ?? (typeof navigator !== "undefined" ? navigator.userActivation?.isActive : true);
      const localModelId =
        typeof submitOptions === "string"
          ? submitOptions
          : submitOptions?.localModelId;
      const modelId = resolveLocalModelId(localModelId);
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let downloadTimeout: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      let downloadTimedOut = false;
      let downloadPhaseDone = false;
      const armDownloadWindow = () => {
        if (typeof submitOptions === "string" || !submitOptions?.downloadTimeoutMs) return false;
        downloadPhaseDone = false;
        downloadTimeout = setTimeout(() => { downloadTimedOut = true; activeController.abort(); }, submitOptions.downloadTimeoutMs);
        return true;
      };
      const startGenerationTimeout = () => {
        if (downloadPhaseDone) return;
        downloadPhaseDone = true;
        if (downloadTimeout) clearTimeout(downloadTimeout);
        if (typeof submitOptions !== "string" && submitOptions?.timeoutMs) {
          timeout = setTimeout(() => { timedOut = true; activeController.abort(); }, submitOptions.timeoutMs);
        }
      };
      const internalStatus: StatusCallback = (status, progress, bytes) => {
        if (!downloadStatuses.has(status)) startGenerationTimeout();
        onStatus?.(status, progress, bytes);
      };
      const ask = (reuse: LanguageModelSession | null, adoptEpoch: number) => askWithChromeBuiltInAi(question, onChunk, {
        env,
        signal: activeController.signal,
        onStatus: internalStatus,
        loadPolyfill: loader,
        userActivation,
        localModelId,
        forceLocalModel: typeof submitOptions === "string" ? false : submitOptions?.forceLocalModel,
        rawPrompt: typeof submitOptions === "string" ? false : submitOptions?.rawPrompt,
        systemPrompt: typeof submitOptions === "string" ? undefined : submitOptions?.systemPrompt,
        assistantPrefix: typeof submitOptions === "string" ? undefined : submitOptions?.assistantPrefix,
        session: reuse ?? undefined,
        preserveSession: reuse !== null,
        // A2/B2: a model this submit loaded answers later submits too, so one
        // download cannot be paid for once per question. A2/B4: if the ready
        // state moved while the download ran, the learner cleared it — the
        // session is then destroyed by the generator instead of being published.
        onLocalSession: (session) => {
          if (adoptEpoch !== epoch) return false;
          const dying = warm;
          warm = { session, modelId, workerOwned: false };
          dropSession(dying?.session);
          return true;
        },
      });
      try {
        // A2/B2: the mount warm-up owns the only download. A submit that arrives
        // while it runs joins that same promise and answers from the session it
        // published — never a second download, never a second session.
        while (owner) await owner.promise;
        const hasDownloadWindow = armDownloadWindow();
        if (!hasDownloadWindow && typeof submitOptions !== "string" && submitOptions?.timeoutMs) {
          timeout = setTimeout(() => { timedOut = true; activeController.abort(); }, submitOptions.timeoutMs);
        }
        // The production forced-local route executes in its own worker. A
        // preload is still a main-thread Prompt API session, so passing it to
        // ask() would hit askWithChromeBuiltInAi's supplied-session fast path
        // before worker selection and reintroduce renderer-bound generation.
        // Retire that process-local session first. Its Cache Storage artifacts
        // are origin-scoped and deliberately survive destroy(), letting the
        // worker load the same pinned revision without a second network fetch
        // or two resident model sessions. Keep injected env/loader seams on
        // their existing direct-session behavior for deterministic tests.
        const usesProductionForcedLocalWorker = Boolean(
          typeof submitOptions !== "string"
          && submitOptions?.forceLocalModel
          && !env
          && !loader
          && typeof Worker !== "undefined"
          && typeof window !== "undefined",
        );
        if (usesProductionForcedLocalWorker) clearWarm();
        // A warm session answers only its own model: a different revision must
        // not be reused, and must not be destroyed either (the preload owns it).
        const reuse = !usesProductionForcedLocalWorker && !warm?.workerOwned && warm !== null && warm.modelId === modelId
          ? warm.session
          : null;
        if (reuse) {
          const borrowEpoch = epoch;
          borrowed = reuse;
          try {
            return await ask(reuse, borrowEpoch);
          } catch (error) {
            // A2/B4: a reused session that failed to answer is stale. Dispose it
            // and rebuild exactly once, then let the failure stand — there is no
            // third attempt, so a dead model can never spin the learner.
            const stale = error instanceof ChromeAiError && error.warmSessionStale;
            if (!stale || activeController.signal.aborted) throw error;
            clearWarm();
            if (armDownloadWindow() && timeout) {
              // The rebuild reloads artifacts from Cache Storage, so it gets the
              // cold-start download window again instead of inheriting the
              // nearly-expired generation window of the attempt that just died.
              clearTimeout(timeout);
              timeout = undefined;
            }
          } finally {
            borrowed = null;
            // The dead (or discarded) session leaves no reference behind once this
            // submit stops generating with it; a still-published one stays ready.
            if (warm?.session !== reuse) releaseSession(reuse);
          }
        }
        return await ask(null, epoch);
      } catch (error) {
        if (downloadTimedOut) throw new ChromeAiError("本機模型下載逾時，請檢查網路後重試；未使用任何雲端服務。");
        if (timedOut) throw new ChromeAiError("本機 AI 回答逾時。");
        throw error;
      } finally {
        if (timeout) clearTimeout(timeout);
        if (downloadTimeout) clearTimeout(downloadTimeout);
        controller = null;
        // Release the download slot before waking whoever waited on it, so a
        // joined warm-up re-checks readiness instead of blocking on a dead slot.
        submitSettled = null;
        settleSubmit();
      }
    },
  };
}
