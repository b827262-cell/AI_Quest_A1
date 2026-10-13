// Dedicated execution context for the local Transformers.js generation pass.
// Cache Storage is origin-scoped, so this worker uses the same pinned artifacts
// as the page without copying the model into a second cache.
import { createModelCacheFetch, markLocalModelCacheReady } from "./local-model-cache";

// Vite's `define` replacement folds Transformers.js' `typeof window` probe
// before this dedicated worker evaluates the dependency. Give that probe a
// worker-local global object, deliberately without `document`, so it remains
// a Web Worker rather than being mistaken for a browser page.
const workerGlobal = globalThis as typeof globalThis & { window?: typeof globalThis };
workerGlobal.window ??= globalThis;

// Do not turn this into a static import: the compatibility shim above must
// execute before Vite evaluates the transformed Transformers.js module.
const loadTransformers = () => import("@huggingface/transformers");

type WorkerMessageBase = {
  prompt: string;
  modelId: string;
  revision: string;
  device: "webgpu" | "wasm";
  dtypes: string[];
  wasmPaths: string;
};

type RunMessage = WorkerMessageBase & {
  type: "run";
  /** Optional and used only by the structured-practice completion path. */
  systemPrompt?: string;
  assistantPrefix?: string;
};
type PreloadMessage = Omit<WorkerMessageBase, "prompt"> & { type: "preload"; prompt?: never };
type WorkerMessage = RunMessage | PreloadMessage;

type WorkerStatus =
  | { type: "status"; status: "local fallback loading" | "local model download" | "local model ready" | "generating"; loaded?: number; total?: number | null }
  | { type: "result"; text: string }
  | { type: "preloaded" }
  | { type: "error"; message: string };

const send = (message: WorkerStatus) => postMessage(message);

self.addEventListener("message", async ({ data }: MessageEvent<WorkerMessage>) => {
  if (data?.type !== "run" && data?.type !== "preload") return;
  const { modelId, revision, device, dtypes, wasmPaths } = data;
  send({ type: "status", status: "local fallback loading" });
  try {
    const { env, pipeline } = await loadTransformers();
    env.allowLocalModels = false;
    env.useFS = false;
    env.useFSCache = false;
    // `env.fetch` below is the sole revision-pinned Cache Storage layer.
    // Leaving Transformers.js Browser Cache enabled duplicates full ONNX artifacts.
    env.useBrowserCache = false;
    env.backends.onnx.wasm!.wasmPaths = wasmPaths;
    env.fetch = createModelCacheFetch(
      { modelId, revision },
      globalThis.fetch.bind(globalThis),
      { onDownloadProgress: ({ loaded, total }) => send({ type: "status", status: "local model download", loaded, total }) },
    );

    let generator: Awaited<ReturnType<typeof pipeline<"text-generation">>> | undefined;
    let lastError: unknown;
    for (const dtype of dtypes) {
      try {
        generator = await pipeline("text-generation", modelId, {
          revision,
          device,
          dtype: dtype as never,
          progress_callback: () => send({ type: "status", status: "local model download" }),
        });
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (!generator) throw lastError ?? new Error("Unable to initialize local model.");

    const cacheReady = await markLocalModelCacheReady({ modelId, revision }).catch(() => false);
    if (!cacheReady) {
      send({ type: "error", message: "本機模型快取尚未完整，請重新載入模型後再試。" });
      return;
    }
    send({ type: "status", status: "local model ready" });
    if (data.type === "preload") {
      send({ type: "preloaded" });
      return;
    }
    send({ type: "status", status: "generating" });
    const tokenizer = generator.tokenizer;
    const messages = [
      ...(data.systemPrompt ? [{ role: "system", content: data.systemPrompt }] : []),
      { role: "user", content: data.prompt },
    ];
    const chatPrompt = tokenizer.apply_chat_template(
      messages,
      // Qwen3 otherwise spends this small deterministic output budget in its
      // reasoning preamble, leaving no complete JSON answer for the parser.
      { tokenize: false, add_generation_prompt: true, enable_thinking: false },
    ) + (data.assistantPrefix ?? "");
    const output = await generator(chatPrompt, {
      // A concise Traditional-Chinese answer must complete inside the page's
      // bounded 45-second generation window on the supported local hardware.
      max_new_tokens: 64,
      do_sample: false,
      return_full_text: false,
      add_special_tokens: false,
    });
    send({ type: "result", text: output[0]?.generated_text ?? "" });
  } catch (error) {
    send({ type: "error", message: error instanceof Error ? error.message : "Local model execution failed." });
  }
});
