// Auto slice core: browser-native Chrome Built-in AI only.
//
// This module powers the public Auto answer flow. It exclusively uses the
// learner's device — `window.LanguageModel` (Prompt API) for inference and
// the optional Chrome Translator API as a Traditional-Chinese bridge. It has
// no network fallback, no server AI endpoint, no provider API key, and no
// shared-backend answer route. The source/bundle gate in
// `tests/chrome-built-in-ai.test.mjs` enforces this by scanning both this
// file and the built client bundle for forbidden cloud-AI tokens; adding any
// of them here will fail the gate and block the Auto slice from shipping.

type Availability = "available" | "downloadable" | "downloading" | "unavailable" | string;
type Translator = { translate(input: string): Promise<string>; destroy?: () => void };
type LanguageModelSession = {
  prompt?: (input: string) => Promise<string>;
  promptStreaming?: (input: string) => AsyncIterable<string>;
  destroy?: () => void;
};

export type ChromeAiEnvironment = {
  LanguageModel?: { availability(): Promise<Availability>; create(): Promise<LanguageModelSession> };
  Translator?: {
    availability(options: { sourceLanguage: string; targetLanguage: string }): Promise<Availability>;
    create(options: { sourceLanguage: string; targetLanguage: string }): Promise<Translator>;
  };
};

export class ChromeAiError extends Error {
  constructor(message: string) { super(message); this.name = "ChromeAiError"; }
}

function environment(): ChromeAiEnvironment {
  return typeof window === "undefined" ? {} : window as unknown as ChromeAiEnvironment;
}

function availabilityMessage(status: Availability) {
  if (status === "downloadable") return "Chrome 內建 AI 模型需要先下載，完成後再試。";
  if (status === "downloading") return "Chrome 內建 AI 模型正在下載中，請完成後再試。";
  return "此瀏覽器/裝置目前不支援 Chrome 內建 AI。";
}

function isTraditionalChinese(input: string) { return /[\u3400-\u9fff]/.test(input); }

async function createTranslator(api: ChromeAiEnvironment["Translator"], sourceLanguage: string, targetLanguage: string) {
  if (!api) return null;
  try {
    const status = await api.availability({ sourceLanguage, targetLanguage });
    return status === "available" ? await api.create({ sourceLanguage, targetLanguage }) : null;
  } catch { return null; }
}

async function streamAnswer(session: LanguageModelSession, prompt: string, onChunk: (chunk: string) => void, signal?: AbortSignal) {
  if (session.promptStreaming) {
    let answer = "";
    for await (const chunk of session.promptStreaming(prompt)) {
      if (signal?.aborted) throw new ChromeAiError("已取消 AI 回答。");
      answer += chunk;
      onChunk(chunk);
    }
    return answer;
  }
  if (!session.prompt) throw new ChromeAiError("此瀏覽器/裝置目前不支援 Chrome 內建 AI。");
  const answer = await session.prompt(prompt);
  if (signal?.aborted) throw new ChromeAiError("已取消 AI 回答。");
  onChunk(answer);
  return answer;
}

/** Uses only the device's Chrome Prompt API; it deliberately has no network fallback. */
export async function askWithChromeBuiltInAi(question: string, onChunk: (chunk: string) => void, options: { signal?: AbortSignal; env?: ChromeAiEnvironment } = {}): Promise<string> {
  const env = options.env ?? environment();
  if (!env.LanguageModel) throw new ChromeAiError("此瀏覽器/裝置目前不支援 Chrome 內建 AI。");
  let status: Availability;
  try { status = await env.LanguageModel.availability(); }
  catch { throw new ChromeAiError("Chrome 內建 AI 無法完成回答，未使用其他 AI 服務。"); }
  if (status !== "available") throw new ChromeAiError(availabilityMessage(status));
  if (options.signal?.aborted) throw new ChromeAiError("已取消 AI 回答。");
  let session: LanguageModelSession;
  try { session = await env.LanguageModel.create(); }
  catch { throw new ChromeAiError("Chrome 內建 AI 無法完成回答，未使用其他 AI 服務。"); }
  let toEnglish: Translator | null = null;
  let toTraditionalChinese: Translator | null = null;
  try {
    let input = question;
    // Chrome has no Prompt API language-capability flag. When both on-device
    // translators are ready, they provide a reliable Traditional-Chinese bridge.
    if (isTraditionalChinese(question)) {
      [toEnglish, toTraditionalChinese] = await Promise.all([
        createTranslator(env.Translator, "zh-Hant", "en"),
        createTranslator(env.Translator, "en", "zh-Hant"),
      ]);
      if (toEnglish && toTraditionalChinese) input = await toEnglish.translate(question);
    }
    const response = await streamAnswer(
      session,
      `Answer this learner question clearly and accurately:\n\n${input}`,
      // Translator translates a completed string, so do not expose temporary
      // English chunks before the final Traditional-Chinese result is ready.
      toTraditionalChinese ? () => {} : onChunk,
      options.signal,
    );
    if (!toTraditionalChinese) return response;
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

export function createAutoSubmitter(env?: ChromeAiEnvironment) {
  let controller: AbortController | null = null;
  return {
    get inFlight() { return controller !== null; },
    cancel() { controller?.abort(); },
    async submit(question: string, onChunk: (chunk: string) => void) {
      if (controller) throw new ChromeAiError("AI 回答處理中，請稍候。");
      controller = new AbortController();
      try { return await askWithChromeBuiltInAi(question, onChunk, { env, signal: controller.signal }); }
      finally { controller = null; }
    },
  };
}
