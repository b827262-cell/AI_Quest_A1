import assert from "node:assert/strict";
import {
  askWithChromeBuiltInAi,
  ChromeAiError,
  createRepetitionGuard,
  detectRepetitionLoop,
  isTraditionalChinese,
  LOCAL_FALLBACK_DTYPE_CANDIDATES,
  LOCAL_FALLBACK_MODEL_ID,
  LOCAL_FALLBACK_PROMPT_INSTRUCTION,
} from "../app/chrome-built-in-ai.ts";

async function runVerification() {
  console.log("=== QWEN3.5 LOCAL FALLBACK REPRODUCIBILITY VERIFICATION ===");
  console.log(`[CONTRACT] Model ID: ${LOCAL_FALLBACK_MODEL_ID}`);
  console.log(`[CONTRACT] Prompt Instruction: ${LOCAL_FALLBACK_PROMPT_INSTRUCTION}`);
  console.log(`[CONTRACT] WebGPU Candidates: ${JSON.stringify(LOCAL_FALLBACK_DTYPE_CANDIDATES.webgpu)}`);
  console.log(`[CONTRACT] WASM Candidates: ${JSON.stringify(LOCAL_FALLBACK_DTYPE_CANDIDATES.wasm)}`);

  // Evidence 1: "你好嗎？" Traditional Chinese short answer via local fallback
  console.log("\n--- Evidence 1: '你好嗎？' Traditional Chinese short answer ---");
  const cloudAiRequests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const urlStr = String(url);
    if (/generativelanguage\.googleapis\.com|api\.openai\.com|firebase/i.test(urlStr)) {
      cloudAiRequests.push(urlStr);
    }
    return originalFetch(url, init);
  };

  const winMock = {
    TRANSFORMERS_CONFIG: null,
    LanguageModel: {
      __isPolyfill: true,
      async create() {
        return {
          async *promptStreaming(prompt) {
            assert.ok(prompt.startsWith(LOCAL_FALLBACK_PROMPT_INSTRUCTION), "Prompt must include short instruction");
            yield "我很好，";
            yield "謝謝你的關心！";
            yield "今天有什麼學習問題我可以協助你解答呢？";
          },
        };
      },
    },
  };

  const streamedChunks = [];
  const statusUpdates = [];
  const answer1 = await askWithChromeBuiltInAi(
    "你好嗎？",
    (chunk) => streamedChunks.push(chunk),
    {
      env: { window: winMock, navigator: { gpu: undefined } }, // WASM path
      loadPolyfill: async () => {},
      onStatus: (status, progress) => statusUpdates.push({ status, progress }),
    }
  );

  console.log("Question: 你好嗎？");
  console.log(`Full Answer: "${answer1}"`);
  console.log(`Streamed Chunks: ${JSON.stringify(streamedChunks)}`);
  console.log(`Is Traditional Chinese: ${isTraditionalChinese(answer1)}`);
  assert.equal(answer1, "我很好，謝謝你的關心！今天有什麼學習問題我可以協助你解答呢？");
  assert.equal(isTraditionalChinese(answer1), true);
  assert.equal(winMock.TRANSFORMERS_CONFIG.dtype, "q8", "WASM must use q8 dtype mapping");
  assert.equal(winMock.TRANSFORMERS_CONFIG.device, "wasm");

  // Evidence 2: Repeated output termination (Anti-repetition guard)
  console.log("\n--- Evidence 2: Repeated output termination (loop guard) ---");
  const loopDetectorResult = detectRepetitionLoop("這是重點。這是重點。這是重點。這是重點。");
  console.log("Loop Detection Test (4 repetitions):", JSON.stringify(loopDetectorResult));
  assert.ok(loopDetectorResult !== null, "Must detect 4 repetitions");

  const guard = createRepetitionGuard();
  const rawLoopChunks = [
    "二元搜尋樹是一種資料結構。",
    "其特點是左子節點小於根節點。",
    "其特點是左子節點小於根節點。",
    "其特點是左子節點小於根節點。",
    "其特點是左子節點小於根節點。",
  ];
  const emittedChunks = [];
  for (const c of rawLoopChunks) {
    const emitted = guard.feed(c);
    if (emitted) emittedChunks.push(emitted);
    if (guard.stopped) {
      console.log(`[GUARD STOPPED] Loop intercepted! Truncated text: "${guard.text}"`);
      break;
    }
  }
  assert.equal(guard.stopped, true, "Guard must be stopped on repetition");
  assert.ok(emittedChunks.length < rawLoopChunks.length, "Must truncate repeated chunks");
  console.log("Emitted Chunks before stop:", JSON.stringify(emittedChunks));

  // Evidence 3: Cancellation fails closed
  console.log("\n--- Evidence 3: Cancellation fails closed ---");
  const ac = new AbortController();
  const cancelPromise = askWithChromeBuiltInAi(
    "請詳細說明微積分基本定理",
    () => {
      console.log("Stream chunk received -> Triggering abort signal");
      ac.abort();
    },
    {
      env: {
        window: {
          LanguageModel: {
            __isPolyfill: true,
            async create() {
              return {
                async *promptStreaming(prompt, opts) {
                  yield "微積分基本定理連結了微分與積分……";
                  if (opts?.signal?.aborted) throw new Error("aborted");
                  yield "第二部分……";
                },
              };
            },
          },
        },
      },
      loadPolyfill: async () => {},
      signal: ac.signal,
    }
  );

  await assert.rejects(
    cancelPromise,
    (err) => err instanceof ChromeAiError && /已取消/.test(err.message),
    "Must throw ChromeAiError with cancellation message"
  );
  console.log("Cancellation successfully rejected with ChromeAiError('已取消 AI 回答。')");

  // Evidence 4: Download progress tracking
  console.log("\n--- Evidence 4: Download progress tracking ---");
  const progressReported = [];
  const winProgressMock = {
    TRANSFORMERS_CONFIG: null,
    LanguageModel: {
      __isPolyfill: true,
      async create(opts) {
        // Simulate downloadprogress events
        if (opts?.monitor) {
          const fakeTarget = new EventTarget();
          opts.monitor(fakeTarget);
          fakeTarget.dispatchEvent(Object.assign(new Event("downloadprogress"), { loaded: 250, total: 1000 }));
          fakeTarget.dispatchEvent(Object.assign(new Event("downloadprogress"), { loaded: 750, total: 1000 }));
          fakeTarget.dispatchEvent(Object.assign(new Event("downloadprogress"), { loaded: 1000, total: 1000 }));
        }
        return {
          prompt: async () => "下載完成後回答",
        };
      },
    },
  };

  await askWithChromeBuiltInAi(
    "測試下載進度",
    () => {},
    {
      env: { window: winProgressMock },
      loadPolyfill: async () => {},
      onStatus: (status, progress) => {
        if (status === "local model download") {
          progressReported.push(progress);
        }
      },
    }
  );
  console.log("Download Progress Milestones:", progressReported);
  assert.deepEqual(progressReported, [0, 0.25, 0.75, 1.0]);

  // Evidence 5: Zero cloud AI requests
  console.log("\n--- Evidence 5: Zero cloud AI requests ---");
  console.log(`Cloud AI requests intercepted: ${cloudAiRequests.length}`);
  assert.equal(cloudAiRequests.length, 0, "Zero cloud AI network requests must be made");

  globalThis.fetch = originalFetch;
  console.log("\n=== ALL REPRODUCIBILITY CHECKS PASSED ===");
}

runVerification().catch((err) => {
  console.error("Verification failed:", err);
  process.exit(1);
});
