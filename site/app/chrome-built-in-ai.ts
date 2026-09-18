// Auto slice core: browser-native Chrome Built-in AI with local Transformers.js fallback.
//
// Architecture:
// AUTO_PRIMARY = native window.LanguageModel
// AUTO_LOCAL_FALLBACK = Prompt API polyfill + Transformers.js local backend
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

export type LanguageModelSession = {
  prompt?: (input: string) => Promise<string>;
  promptStreaming?: (input: string) => AsyncIterable<string>;
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
): Promise<string> {
  if (session.promptStreaming) {
    let answer = "";
    for await (const chunk of session.promptStreaming(prompt)) {
      if (signal?.aborted) throw new ChromeAiError("已取消 AI 回答。");
      answer += chunk;
      onChunk(chunk);
    }
    return answer;
  }
  if (!session.prompt) {
    throw new ChromeAiError("此瀏覽器/裝置目前不支援本機 AI 回答。");
  }
  const answer = await session.prompt(prompt);
  if (signal?.aborted) throw new ChromeAiError("已取消 AI 回答。");
  onChunk(answer);
  return answer;
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

  if (nativeLM && !nativeLM.__isPolyfill) {
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
  if (nativeAvailable && nativeLM) {
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
  if (nativeDownloading && nativeLM) {
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

  // Configure local Transformers.js backend with constant non-sensitive dummy key
  win.TRANSFORMERS_CONFIG = {
    apiKey: "dummy",
    device: localDevice,
    // q8 is the conservative WASM path supported by Transformers.js. Do not
    // attempt q4 WASM just to discover an unsupported kernel after a large
    // artifact download. WebGPU retains the upstream q4f16 default.
    dtype: localDevice === "webgpu" ? "q4f16" : "q8",
    modelName: "onnx-community/Qwen2.5-0.5B-Instruct",
  };

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
  } catch {
    options.onStatus?.("unsupported after fallback");
    throw new ChromeAiError("載入本機 AI 引擎失敗，未使用任何雲端服務。");
  }

  if (!polyfillLM) {
    options.onStatus?.("unsupported after fallback");
    throw new ChromeAiError("此瀏覽器/裝置目前不支援本機 AI 模型。");
  }

  options.onStatus?.("local model download", 0);
  if (options.signal?.aborted) throw new ChromeAiError("已取消 AI 回答。");

  let localSession: LanguageModelSession;
  try {
    localSession = await polyfillLM.create({
      monitor(m: EventTarget) {
        m.addEventListener("downloadprogress", (e: Event) => {
          const pe = e as ProgressLikeEvent;
          const loaded = Number(pe.loaded) || 0;
          const total = Number(pe.total) || 1;
          const progress = total > 0 ? Math.min(1, Math.max(0, loaded / total)) : null;
          options.onStatus?.("local model download", progress);
        });
      },
      signal: options.signal,
    });
  } catch {
    if (options.signal?.aborted) throw new ChromeAiError("已取消 AI 回答。");
    options.onStatus?.("unsupported after fallback");
    throw new ChromeAiError("本機 AI 模型下載或初始化失敗，未使用任何雲端服務。");
  }

  try {
    const prompt = `請用繁體中文清楚準確回答以下問題：\n\n${question}`;
    const response = await streamAnswer(localSession, prompt, onChunk, options.signal);
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
    ) {
      if (controller) throw new ChromeAiError("AI 回答處理中，請稍候。");
      controller = new AbortController();
      const userActivation = env?.navigator?.userActivation?.isActive
        ?? (typeof navigator !== "undefined" ? navigator.userActivation?.isActive : true);
      try {
        return await askWithChromeBuiltInAi(question, onChunk, {
          env,
          signal: controller.signal,
          onStatus,
          loadPolyfill: loader,
          userActivation,
        });
      } finally {
        controller = null;
      }
    },
  };
}
