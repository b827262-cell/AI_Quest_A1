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

export type AutoAiStatus =
  | "native ready"
  | "native model download"
  | "native translation buffering"
  | "local fallback loading"
  | "local model requires user activation"
  | "local model download"
  | "unsupported after fallback";

export type StatusCallback = (status: AutoAiStatus, progress?: number | null) => void;

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
    const safe = guard ? guard.feed(chunk) : chunk;
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
          return stripThinkingTags(guard.text);
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
      return stripThinkingTags(guard.text);
    }
    return stripThinkingTags(answer);
  }
  if (!session.prompt) {
    throw new ChromeAiError("此瀏覽器/裝置目前不支援本機 AI 回答。");
  }
  const answer = await session.prompt(prompt, options);
  if (signal?.aborted) throw new ChromeAiError("已取消 AI 回答。");
  const cleanAnswer = stripThinkingTags(answer);
  if (guard) {
    emit(cleanAnswer);
    const tail = guard.finish();
    if (tail) onChunk(tail);
    return stripThinkingTags(guard.text);
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
  /** Captured synchronously from the initiating UI gesture. */
  userActivation?: boolean;
};

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

export async function askWithChromeBuiltInAi(
  question: string,
  onChunk: (chunk: string) => void,
  options: AskOptions = {},
): Promise<string> {
  const env = options.env ?? environment();
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
      if (isTraditionalChinese(question)) {
        [toEnglish, toTraditionalChinese] = await Promise.all([
          createTranslator(env.Translator, "zh-Hant", "en"),
          createTranslator(env.Translator, "en", "zh-Hant"),
        ]);
        if (toEnglish && toTraditionalChinese) {
          input = await toEnglish.translate(question);
        }
      }

      const promptText = toEnglish && toTraditionalChinese
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
            const total = Number(pe.total) || 1;
            const progress = total > 0 ? Math.min(1, Math.max(0, loaded / total)) : null;
            options.onStatus?.("native model download", progress);
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
        const response = await streamAnswer(
          session,
          `請用繁體中文清楚準確回答以下學習問題：\n\n${question}`,
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
          ? { fetch: nodeRuntime ? isolatedNodeFetch : (...args: Parameters<typeof fetch>) => globalThis.fetch(...args) }
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
      const total = Number(pe.total) || 1;
      const progress = total > 0 ? Math.min(1, Math.max(0, loaded / total)) : null;
      options.onStatus?.("local model download", progress);
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
    options.onStatus?.("unsupported after fallback");
    throw new ChromeAiError("本機 AI 模型下載或初始化失敗，未使用任何雲端服務。");
  }

  try {
    const prompt = `${LOCAL_FALLBACK_PROMPT_INSTRUCTION}\n\n${question}`;
    const response = await streamAnswer(
      localSession,
      prompt,
      onChunk,
      options.signal,
      createRepetitionGuard(),
    );
    return response;
  } catch (error) {
    if (error instanceof ChromeAiError) throw error;
    throw new ChromeAiError("本機 AI 模型無法完成回答，未使用任何雲端服務。");
  } finally {
    localSession.destroy?.();
  }
}

export function createAutoSubmitter(env?: ChromeAiEnvironment, loader?: () => Promise<void>) {
  let controller: AbortController | null = null;
  return {
    get inFlight() {
      return controller !== null;
    },
    cancel() {
      controller?.abort();
    },
    async submit(
      question: string,
      onChunk: (chunk: string) => void,
      onStatus?: StatusCallback,
      submitOptions?: { localModelId?: string; timeoutMs?: number; forceLocalModel?: boolean } | string,
    ) {
      if (controller) throw new ChromeAiError("AI 回答處理中，請稍候。");
      controller = new AbortController();
      const userActivation = env?.navigator?.userActivation?.isActive
        ?? (typeof navigator !== "undefined" ? navigator.userActivation?.isActive : true);
      const localModelId =
        typeof submitOptions === "string"
          ? submitOptions
          : submitOptions?.localModelId;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      if (typeof submitOptions !== "string" && submitOptions?.timeoutMs) {
        timeout = setTimeout(() => { timedOut = true; controller?.abort(); }, submitOptions.timeoutMs);
      }
      try {
        return await askWithChromeBuiltInAi(question, onChunk, {
          env,
          signal: controller.signal,
          onStatus,
          loadPolyfill: loader,
          userActivation,
          localModelId,
          forceLocalModel: typeof submitOptions === "string" ? false : submitOptions?.forceLocalModel,
        });
      } catch (error) {
        if (timedOut) throw new ChromeAiError("本機 AI 回答逾時。");
        throw error;
      } finally {
        if (timeout) clearTimeout(timeout);
        controller = null;
      }
    },
  };
}
