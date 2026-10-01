import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import {
  buildGoogleAiModeUrl,
  createAutoFallbackGuard,
  hasUnresolvedSimplified,
  normalizeToHant,
  postprocessTraditionalChinese,
  shouldUseLocalTutor,
  validateLocalAnswer,
} from "../app/auto-fallback.ts";
import { SIMPLIFIED_ONLY } from "../app/hant-set.ts";
import { askWithChromeBuiltInAi, createAutoSubmitter, LOCAL_FALLBACK_MODEL_REVISION } from "../app/chrome-built-in-ai.ts";
import { createModelCacheFetch, markLocalModelCacheReady, probeLocalModelCache } from "../app/local-model-cache.ts";

class MemoryCache {
  entries = new Map();

  async match(key) {
    return this.entries.get(typeof key === "string" ? key : key.url)?.clone();
  }

  async put(key, response) {
    const url = typeof key === "string" ? key : key.url;
    this.entries.set(url, new Response(await response.arrayBuffer(), { status: response.status, headers: response.headers }));
  }

  async delete(key) { return this.entries.delete(typeof key === "string" ? key : key.url); }
  async keys() { return [...this.entries.keys()].map((url) => new Request(url)); }
}

test("P0-FIX-3: actual local worker accepts preload, pins its revision, and exits before generation", () => {
  const worker = readFileSync(new URL("../app/local-inference.worker.ts", import.meta.url), "utf8");

  // This inspects the production worker protocol, rather than a FakeWorker
  // implementation. In particular, changing the guard back to run-only
  // makes a real page warm-up wait forever for `preloaded`.
  assert.match(worker, /data\?\.type !== "run" && data\?\.type !== "preload"/);
  assert.match(worker, /type: "preload"; prompt\?: never/);
  assert.match(worker, /env\.useBrowserCache = false;/);
  assert.match(worker, /env\.fetch = createModelCacheFetch\(\s*\{ modelId, revision \}/);
  assert.match(worker, /pipeline\("text-generation", modelId, \{\s*revision,/);

  const initialized = worker.indexOf('generator = await pipeline("text-generation", modelId, {');
  const cacheReady = worker.indexOf("const cacheReady = await markLocalModelCacheReady");
  const ready = worker.indexOf('send({ type: "status", status: "local model ready" })');
  const preloaded = worker.indexOf('send({ type: "preloaded" })');
  const generating = worker.indexOf('send({ type: "status", status: "generating" })');
  assert.ok(initialized >= 0 && cacheReady > initialized && ready > cacheReady, "preload initializes and finalizes its cache manifest before reporting ready");
  assert.ok(preloaded > ready && generating > preloaded, "preload reports completion and returns before the generation path");
  assert.match(worker, /if \(!cacheReady\) \{\s*send\(\{ type: "error", message: "[^\"]*本機模型快取[^\"]*" \}\);\s*return;\s*\}/);
  assert.match(worker, /catch \(error\) \{\s*send\(\{ type: "error", message: error instanceof Error \? error\.message : "Local model execution failed\." \}\);/);
  assert.match(worker, /if \(data\.type === "preload"\) \{\s*send\(\{ type: "preloaded" \}\);\s*return;/);
  const cacheFailure = worker.indexOf("if (!cacheReady)");
  assert.ok(cacheFailure < ready && cacheFailure < preloaded,
    "a failed cache-ready result returns with a controlled error before ready or preloaded can be advertised");
});

test("P0-FIX-5: worker installs the window compatibility guard before dynamically loading Transformers.js", () => {
  const worker = readFileSync(new URL("../app/local-inference.worker.ts", import.meta.url), "utf8");

  assert.doesNotMatch(worker, /^import\s+.*?\s+from\s+["']@huggingface\/transformers["'];/m);
  assert.match(worker, /workerGlobal\.window \?\?= globalThis;/);
  assert.match(worker, /const loadTransformers = \(\) => import\("@huggingface\/transformers"\);/);

  const guard = worker.indexOf("workerGlobal.window ??= globalThis;");
  const dynamicImport = worker.indexOf('import("@huggingface/transformers")');
  const load = worker.indexOf("await loadTransformers()");
  assert.ok(guard >= 0 && dynamicImport > guard && load > dynamicImport,
    "the worker shim must exist before Transformers.js is dynamically evaluated");
});

test("T2: production worker disables Qwen thinking before its deterministic 64-token generation", () => {
  const worker = readFileSync(new URL("../app/local-inference.worker.ts", import.meta.url), "utf8");

  const template = worker.indexOf("tokenizer.apply_chat_template(");
  const disableThinking = worker.indexOf("enable_thinking: false");
  const generation = worker.indexOf("const output = await generator(chatPrompt, {");
  assert.ok(template >= 0 && disableThinking > template && generation > disableThinking,
    "the production chat template must disable Qwen thinking before generation");
  assert.match(worker, /max_new_tokens:\s*64,/);
  assert.doesNotMatch(worker, /max_new_tokens:\s*128,/);
  assert.doesNotMatch(worker, /max_new_tokens:\s*512,/);
  assert.match(worker, /max_new_tokens:\s*64,\s*do_sample:\s*false,/);
});

test("T2: practice worker transports the optional system turn and assistant prefix", () => {
  const worker = readFileSync(new URL("../app/local-inference.worker.ts", import.meta.url), "utf8");
  const bridge = readFileSync(new URL("../app/chrome-built-in-ai.ts", import.meta.url), "utf8");

  assert.match(worker, /systemPrompt\?: string;/);
  assert.match(worker, /assistantPrefix\?: string;/);
  assert.match(worker, /\.\.\.\(data\.systemPrompt \? \[\{ role: "system", content: data\.systemPrompt \}\] : \[\]\),/);
  assert.match(worker, /\{ role: "user", content: data.prompt \}/);
  assert.match(worker, /\) \+ \(data.assistantPrefix \?\? ""\)/);
  assert.match(bridge, /systemPrompt: options\.systemPrompt,/);
  assert.match(bridge, /assistantPrefix: options\.assistantPrefix,/);
});

test("P0-FIX-4: built isolated-worker factory stays Vite-owned and emits its worker asset", () => {
  const chunks = readdirSync(new URL("../dist/client/_next/static/chunks/", import.meta.url))
    .filter((name) => name.endsWith(".js"));
  const built = chunks.map((name) => readFileSync(new URL(`../dist/client/_next/static/chunks/${name}`, import.meta.url), "utf8")).join("\n");
  const workerFactory = built.match(/local-inference-worker-client-[\w-]+\.js/);
  assert.ok(workerFactory, "page lazy-loads the browser-only Vite worker factory");
  const factory = readFileSync(new URL(`../dist/client/_next/static/chunks/${workerFactory[0]}`, import.meta.url), "utf8");
  assert.match(factory, /new Worker\(/, "Vite emits a worker constructor factory");
  assert.match(factory, /local-inference\.worker-[\w-]+\.js/, "factory references Vite's emitted worker asset");
  assert.doesNotMatch(factory, /file:\/\/\/ROOT\//, "worker factory never derives a browser URL from a file URL");
});

test("Gate 5b: local submit timeout fails closed with a truthful timeout error", async () => {
  const env = {
    LanguageModel: {
      async availability() { return "available"; },
      async create() {
        return {
          prompt: (_input, opts) => new Promise((_resolve, reject) => {
            opts?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
        };
      },
    },
  };
  const submitter = createAutoSubmitter(env);
  await assert.rejects(
    submitter.submit("什麼是光合作用？", () => {}, undefined, { timeoutMs: 30 }),
    /逾時/,
  );
  assert.equal(submitter.inFlight, false);
});

test("P0-FIX-3: isolated worker survives a stalled local generation deadline, cancel, and retry", async () => {
  const originalWorker = globalThis.Worker;
  const originalWindow = globalThis.window;
  const workers = [];
  let behavior = "stall";
  class FakeWorker {
    constructor() { workers.push(this); }
    terminate() { this.terminated = true; }
    postMessage() {
      queueMicrotask(() => {
        this.onmessage?.({ data: { type: "status", status: "local model ready" } });
        this.onmessage?.({ data: { type: "status", status: "generating" } });
        if (behavior === "success") this.onmessage?.({ data: { type: "result", text: '{"route":"INFO","answer":"重試成功","confidence":0.9}' } });
      });
    }
  }
  try {
    globalThis.window = {};
    globalThis.Worker = FakeWorker;
    const submitter = createAutoSubmitter();
    await assert.rejects(
      submitter.submit("逾時", () => {}, undefined, { forceLocalModel: true, timeoutMs: 20 }),
      /逾時/,
    );
    assert.equal(workers[0].terminated, true, "deadline terminates only the stuck worker");
    assert.equal(submitter.inFlight, false, "deadline restores the submit slot");

    const pending = submitter.submit("取消", () => {}, undefined, { forceLocalModel: true, timeoutMs: 500 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    submitter.cancel();
    await assert.rejects(pending, /取消/);
    assert.equal(workers[1].terminated, true, "cancel terminates the active worker");
    assert.equal(submitter.inFlight, false, "cancel restores retry eligibility");

    behavior = "success";
    const retry = await submitter.submit("重試", () => {}, undefined, { forceLocalModel: true, timeoutMs: 500 });
    assert.match(retry, /重試成功/);
    assert.equal(workers[2].terminated, true, "completed worker is released without touching cache");
  } finally {
    if (originalWorker === undefined) delete globalThis.Worker;
    else globalThis.Worker = originalWorker;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

test("P0-FIX-3: production forced-local preload and submit stay worker-owned", async () => {
  const originalWorker = globalThis.Worker;
  const originalWindow = globalThis.window;
  const originalCaches = globalThis.caches;
  const cache = new MemoryCache();
  const storage = { open: async () => cache };
  const identity = { modelId: "onnx-community/Qwen3-0.6B-ONNX", revision: LOCAL_FALLBACK_MODEL_REVISION };
  const artifact = `https://huggingface.co/${identity.modelId}/resolve/main/onnx/model_q4f16.onnx`;
  let networkFetches = 0;
  let warmPromptCalls = 0;
  let warmDestroyCalls = 0;
  const workers = [];
  class FakeWorker {
    constructor() { workers.push(this); }
    terminate() { this.terminated = true; }
    postMessage(message) {
      this.message = message;
      queueMicrotask(() => {
        this.onmessage?.({ data: { type: "status", status: "local model ready" } });
        if (message.type === "preload") this.onmessage?.({ data: { type: "preloaded" } });
        else this.onmessage?.({ data: { type: "result", text: '{"route":"information","confidence":0.9,"answer":"worker answer"}' } });
      });
    }
  }
  try {
    // Seed a complete pinned artifact exactly as a prior warm-up would leave
    // it. The worker is expected to use this origin-scoped cache, not a second
    // model download, after the renderer session is retired.
    await (await createModelCacheFetch(identity, async () => {
      networkFetches += 1;
      return new Response("model-bytes", { headers: { "content-length": "11" } });
    }, { storage })(artifact)).arrayBuffer();
    assert.equal(await markLocalModelCacheReady(identity, { storage }), true);

    globalThis.caches = storage;
    globalThis.window = {
      LanguageModel: {
        __isPolyfill: true,
        async create() {
          return {
            promptStreaming: () => {
              warmPromptCalls += 1;
              return (async function* () { yield "renderer answer"; })();
            },
            destroy() { warmDestroyCalls += 1; },
          };
        },
      },
    };
    globalThis.Worker = FakeWorker;
    const submitter = createAutoSubmitter();
    assert.equal(await submitter.preload(undefined, { localModelId: identity.modelId, forceLocalModel: true }), "warmed");
    assert.equal(submitter.isPreloaded, true);

    const answer = await submitter.submit("test", () => {}, undefined, {
      forceLocalModel: true,
      localModelId: identity.modelId,
      systemPrompt: "structured practice system",
      assistantPrefix: '{"route":"information","confidence":0.99,"answer":"如何',
    });
    assert.match(answer, /worker answer/);
    assert.equal(warmPromptCalls, 0, "no renderer session may reach the generation path");
    assert.equal(warmDestroyCalls, 0, "production preload must not create a renderer session to retire");
    assert.equal(workers.length, 2, "preload and inference each use an isolated worker lifecycle");
    assert.equal(workers[0].message.type, "preload", "warm state is prepared by the worker");
    assert.equal(workers[1].message.type, "run", "forced production submit starts the worker generation route");
    assert.equal(workers[1].message.systemPrompt, "structured practice system", "the worker receives the optional practice system turn");
    assert.equal(workers[1].message.assistantPrefix, '{"route":"information","confidence":0.99,"answer":"如何', "the worker receives the exact assistant completion prefix");
    assert.equal(workers[0].terminated, true, "preload worker is released after artifacts are ready");
    assert.equal(workers[1].terminated, true, "generation worker is released after its answer");

    const cachedReload = createModelCacheFetch(identity, async () => {
      networkFetches += 1;
      return new Response("unexpected network", { headers: { "content-length": "18" } });
    }, { storage });
    assert.equal(await (await cachedReload(artifact)).text(), "model-bytes");
    assert.equal(networkFetches, 1, "retiring the renderer session preserves artifacts for the worker/cache reload");
    assert.equal((await probeLocalModelCache(identity, { storage })).complete, true);
  } finally {
    if (originalWorker === undefined) delete globalThis.Worker;
    else globalThis.Worker = originalWorker;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    if (originalCaches === undefined) delete globalThis.caches;
    else globalThis.caches = originalCaches;
  }
});

test("COLD_START: download timeout is separate from the 45s generation window", async () => {
  const env = {
    WebAssembly: { instantiate: () => ({}) },
    window: {
      LanguageModel: {
        __isPolyfill: true,
        create({ signal }) {
          return new Promise((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(new Error("download aborted")));
          });
        },
      },
    },
  };
  const submitter = createAutoSubmitter(env, async () => {});
  const statuses = [];
  await assert.rejects(
    submitter.submit("什麼是恐龍？", () => {}, (s) => statuses.push(s), { timeoutMs: 45_000, downloadTimeoutMs: 60 }),
    /下載逾時/,
  );
  assert.equal(submitter.inFlight, false);
  assert.equal(statuses.includes("local model ready"), false);
});

test("COLD_START: the submit abort signal reaches the browser model-artifact fetch", async () => {
  const artifactUrl = "https://huggingface.co/onnx-community/Qwen3-0.6B-ONNX/resolve/main/onnx/model_quantized.onnx";
  const observed = [];
  // B1: the cleanup handles are hoisted so the finally can always abort and
  // drain, even when an assertion throws before the in-try abort. An
  // un-aborted artifact fetch or an un-awaited rejecting submit either stalls
  // node:test with a still-pending promise or surfaces later as an unrelated
  // unhandled rejection.
  let controller = null;
  let fetchPromise = null;
  let pending = null;
  const drain = [];
  const track = (promise) => {
    if (promise) drain.push(Promise.resolve(promise).catch(() => {}));
    return promise;
  };
  const env = {
    WebAssembly: { instantiate: () => ({}) },
    window: {
      LanguageModel: {
        __isPolyfill: true,
        async create() {
          const cfg = env.window.TRANSFORMERS_CONFIG;
          assert.equal(typeof cfg.env.fetch, "function");
          fetchPromise = track(cfg.env.fetch(artifactUrl, {}));
          await fetchPromise;
          return { async prompt() { return "x"; } };
        },
      },
    },
  };
  const originalFetch = globalThis.fetch;
  // The durable-cache adapter may hand the merged signal on the Request or on
  // init; observe both so a regression that drops either one fails here.
  globalThis.fetch = (input, init) => {
    const signal = init?.signal ?? (typeof Request !== "undefined" && input instanceof Request ? input.signal : null);
    // Keep the actual cloned/merged Request signal strongly reachable while
    // this fake network request is parked. Node's Request signal-following
    // implementation may otherwise be collected because a boolean snapshot
    // alone does not retain the signal that must receive the later abort.
    observed.push({ url: input instanceof Request ? input.url : String(input), signal });
    return new Promise((_resolve, reject) => {
      if (!signal) return reject(new Error("artifact fetch lost the abort signal"));
      signal.addEventListener("abort", () => reject(new Error("artifact download aborted")));
    });
  };
  try {
    // The signal-merging fetch wrapper is the browser branch; force it by
    // defining window (Node otherwise takes the isolated nodeRuntime path).
    globalThis.window = env.window;
    controller = new AbortController();
    pending = track(askWithChromeBuiltInAi("什麼是恐龍？", () => {}, {
      env,
      signal: controller.signal,
      forceLocalModel: true,
      userActivation: true,
      loadPolyfill: async () => {},
    }));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(fetchPromise instanceof Promise, true, "model fetch must be in flight");
    assert.equal(Boolean(observed.at(-1).signal), true, "the submit signal must be merged into the artifact fetch");
    controller.abort();
    await assert.rejects(fetchPromise, /artifact download aborted/);
    await assert.rejects(pending, /已取消/);
  } finally {
    controller?.abort();
    await Promise.allSettled(drain);
    globalThis.fetch = originalFetch;
    delete globalThis.window;
  }
});

test("COLD_START: model artifacts are fetched from the pinned immutable revision", async () => {
  const observed = [];
  const env = {
    WebAssembly: { instantiate: () => ({}) },
    window: {
      LanguageModel: {
        __isPolyfill: true,
        async create() {
          const cfg = env.window.TRANSFORMERS_CONFIG;
          await cfg.env.fetch("https://huggingface.co/onnx-community/Qwen3-0.6B-ONNX/resolve/main/tokenizer.json", {});
          return { async prompt() { return "恐龍已滅絕。"; } };
        },
      },
    },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    observed.push({ url: input instanceof Request ? input.url : String(input), status: init?.status });
    return Promise.resolve(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
  };
  try {
    globalThis.window = env.window;
    await askWithChromeBuiltInAi("什麼是恐龍？", () => {}, {
      env,
      forceLocalModel: true,
      userActivation: true,
      loadPolyfill: async () => {},
    });
    assert.equal(observed.length, 1, "the artifact request must reach fetch");
    assert.match(observed[0].url, new RegExp(`/resolve/${LOCAL_FALLBACK_MODEL_REVISION}/`), "main must be pinned to the recorded revision");
    assert.doesNotMatch(observed[0].url, /\/resolve\/main\//);
  } finally {
    globalThis.fetch = originalFetch;
    delete globalThis.window;
  }
});

test("COLD_START: generation timeout only starts after the local model is ready", async () => {
  const env = {
    WebAssembly: { instantiate: () => ({}) },
    window: {
      LanguageModel: {
        __isPolyfill: true,
        async create() {
          await new Promise((r) => setTimeout(r, 150));
          return {
            async prompt() {
              await new Promise((r) => setTimeout(r, 100));
              return "恐龍是中生代的大型爬蟲類動物，早已滅絕。";
            },
          };
        },
      },
    },
  };
  const submitter = createAutoSubmitter(env, async () => {});
  const statuses = [];
  const answer = await submitter.submit(
    "什麼是恐龍？",
    () => {},
    (s) => statuses.push(s),
    { timeoutMs: 200, downloadTimeoutMs: 10_000, forceLocalModel: true },
  );
  assert.match(answer, /恐龍/);
  assert.equal(statuses.includes("local model ready"), true);
});

test("Gate C VALID stays local with zero Google navigation", () => {
  const result = validateLocalAnswer("什麼是光合作用？", "植物利用光能把水和二氧化碳轉成養分，並釋放氧氣。");
  assert.equal(result.status, "VALID");
  const guard = createAutoFallbackGuard();
  assert.equal(guard.begin(), true);
  guard.done();
  assert.equal(guard.navigateOnce(), false);
});

test("Gate C INVALID is immediate, URL-encoded, and only navigates once", () => {
  const result = validateLocalAnswer("2 + 2 等於多少？", "2 + 2 等於多少？");
  assert.equal(result.status, "INVALID");
  assert.equal(result.reason, "question-echo");
  assert.equal(buildGoogleAiModeUrl("a & b? 中文"), "https://www.google.com/search?q=a%20%26%20b%3F%20%E4%B8%AD%E6%96%87&udm=50&aep=11&hl=zh-TW");
  const guard = createAutoFallbackGuard();
  guard.begin();
  assert.equal(guard.navigateOnce(), true);
  assert.equal(guard.navigateOnce(), false);
});

test("validator rejects short, looping, and unresolved simplified output; safe conversion precedes validation", () => {
  assert.equal(validateLocalAnswer("問題", "好").reason, "too-short");
  assert.equal(validateLocalAnswer("問題", "答案答案答案答案").reason, "repetition-loop");
  // 龙 is unambiguous Simplified-only and must be CONVERTED, never kept as a
  // sentinel: real answers containing it (e.g. 恐龙) are legitimate content.
  const dragon = validateLocalAnswer("有什麼恐龍？", "恐龙是中生代的大型爬蟲類動物。");
  assert.equal(dragon.status, "VALID");
  assert.match(dragon.answer, /恐龍/);
  assert.doesNotMatch(dragon.answer, /恐龙/);
  // The defence-in-depth predicate itself still fails closed on raw residue.
  assert.equal(hasUnresolvedSimplified("龙"), true);
  const converted = validateLocalAnswer("問題", "这是一个学习问题的回答。" );
  assert.equal(converted.status, "VALID");
  assert.match(converted.answer, /這是一個學習問題/);
});

test("Gate B preserves legitimate short numerals, names, and Traditional shared characters", () => {
  assert.deepEqual(validateLocalAnswer("12 + 1 等於多少？", "13"), { status: "VALID", answer: "13" });
  assert.deepEqual(validateLocalAnswer("五減零？", "5"), { status: "VALID", answer: "5" });
  const name = validateLocalAnswer("這是誰？", "于右任是近代書法家。");
  assert.equal(name.status, "VALID");
  assert.match(name.answer, /于右任/);
  assert.equal(validateLocalAnswer("詞義", "資料放在裡面。 ").status, "VALID");
});

test("Gate B converts a complete Simplified answer before leakage validation", () => {
  const result = validateLocalAnswer("什麼是經營策略？", "经营策略是企业的长期规划。");
  assert.deepEqual(result, { status: "VALID", answer: "經營策略是企業的長期規劃。" });
});

test("Qwen audit 6a: Taiwan-usage CORE_PHRASES override the auto-generated table", () => {
  // Auto-table contextual variants must not shadow the curated Taiwan terms.
  assert.equal(postprocessTraditionalChinese("数据备份很重要。"), "資料備份很重要。");
  assert.equal(postprocessTraditionalChinese("系統會供数据完整性檢查。"), "系統會供資料完整性檢查。");
  assert.equal(postprocessTraditionalChinese("数据结构是用來組織資料的方式。"), "資料結構是用來組織資料的方式。");
  assert.equal(postprocessTraditionalChinese("变量 `x` 會遞增。"), "變數 `x` 會遞增。");
  assert.equal(postprocessTraditionalChinese("这里有一张桌子。"), "這裡有一張桌子。");
  assert.equal(postprocessTraditionalChinese("和面积相關的公式。"), "和面積相關的公式。");
  assert.equal(postprocessTraditionalChinese("长和面的比例。"), "長和面的比例。");
  assert.equal(postprocessTraditionalChinese("递回函式會把結果递回上一層。"), "遞回函式會把結果遞回上一層。");
});

test("Gate B residue probes: canonical Simplified sentences convert with zero residue", () => {
  const residueOf = (served) => [...new Set([...served].filter((c) => SIMPLIFIED_ONLY.includes(c)))];
  const cases = [
    "产业升级是指产业结构改善。",
    "电脑是一种计算设备。",
    "台湾位于东亚。",
    "软体是电脑程序。",
    "经营策略是企业的长期规划。",
  ];
  for (const raw of cases) {
    const result = validateLocalAnswer("測試", raw);
    assert.equal(result.status, "VALID", raw);
    assert.deepEqual(residueOf(result.answer), [], `${raw} -> ${result.answer}`);
  }
});

test("Gate B documented tradeoff: neutral shared chars may remain (寧可漏改、不可改壞姓名)", () => {
  // 台后干几云划准咸郁范于涌 are deliberately NOT in SIMPLIFIED_ONLY
  // (Big5-legal shared characters; see hant-set.ts provenance). Mixed forms
  // like 證据/根据/位于/计划 therefore stay VALID — these assertions pin that
  // documented tradeoff so it is visible instead of accidental.
  assert.equal(postprocessTraditionalChinese("证据显示该操作有效。"), "證据顯示該操作有效。");
  assert.equal(postprocessTraditionalChinese("根据目前资料判断。"), "根据目前資料判斷。");
  assert.equal(postprocessTraditionalChinese("计划明年上线。"), "計划明年上線。");
  const name = validateLocalAnswer("這是誰？", "于右任是近代書法家。");
  assert.equal(name.status, "VALID");
  assert.match(name.answer, /于右任/);
});

test("cancelled flow cannot navigate or restart the same submission", () => {
  const guard = createAutoFallbackGuard();
  guard.begin(); guard.cancel();
  assert.equal(guard.navigateOnce(), false);
  assert.equal(guard.begin(), false);
});

test("Gate B regression: numeric answers 13 and 5 are valid and never falsely flagged as echo or too-short", () => {
  assert.deepEqual(validateLocalAnswer("3 + 4 + 6 = ？請直接算出答案。", "13"), { status: "VALID", answer: "13" });
  assert.deepEqual(validateLocalAnswer("一個圓的直徑是 10，它的半徑是幾？", "5"), { status: "VALID", answer: "5" });
  assert.equal(validateLocalAnswer("13", "13").reason, "question-echo");
});

test("Gate B regression: 于右任 and historical variants are preserved without destructive substitution", () => {
  const r1 = validateLocalAnswer("誰是于右任？", "于右任是中華民國的一位書法家。");
  assert.equal(r1.status, "VALID");
  assert.match(r1.answer, /于右任/);
  assert.doesNotMatch(r1.answer, /於右任/);

  const r2 = validateLocalAnswer("地理問題", "阿里山位于嘉義縣。");
  assert.equal(r2.status, "VALID");
  assert.match(r2.answer, /位于/);
});

test("Gate B regression: technical and business Simplified terms convert reliably to Traditional without residue", () => {
  const comp = validateLocalAnswer("什麼是電腦？", "电脑是一种计算设备。");
  assert.equal(comp.status, "VALID");
  assert.equal(comp.answer, "電腦是一種計算設備。");

  const biz = validateLocalAnswer("請說明經營策略。", "经营策略是企业的长期规划。");
  assert.equal(biz.status, "VALID");
  assert.equal(biz.answer, "經營策略是企業的長期規劃。");
});

test("Gate B invariant: normalizeToHant covers the entire SIMPLIFIED_ONLY rewrite set", () => {
  // Conversion-first contract: no character the table promises to rewrite may
  // survive normalization, otherwise VALID answers could serve residue.
  const uncovered = [];
  for (const ch of SIMPLIFIED_ONLY) {
    if (hasUnresolvedSimplified(normalizeToHant(ch).text)) uncovered.push(ch);
  }
  assert.deepEqual(uncovered, []);
});

test("COLD_START: createAutoSubmitter forwards download bytes to the caller's onStatus", async () => {
  const TOTAL = 617687575;
  const HALF = 308843787;
  const env = {
    WebAssembly: { instantiate: () => ({}) },
    window: {
      LanguageModel: {
        __isPolyfill: true,
        async availability() { return "available"; },
        async create(options) {
          if (options?.monitor) {
            const target = new EventTarget();
            options.monitor(target);
            target.dispatchEvent(Object.assign(new Event("downloadprogress"), { loaded: HALF, total: TOTAL }));
          }
          return { promptStreaming: () => (async function* () { yield "13"; })() };
        },
      },
    },
  };
  const submitter = createAutoSubmitter(env, async () => {});
  const seen = [];
  const answer = await submitter.submit("十三加五等於多少？", () => {}, (s, p, b) => seen.push({ s, p, b }), {
    timeoutMs: 45_000,
    downloadTimeoutMs: 15 * 60_000,
    forceLocalModel: true,
    localModelId: "test-model",
  });
  assert.equal(answer, "13");
  const byteEvents = seen.filter((x) => x.s === "local model download" && x.b);
  assert.ok(byteEvents.length >= 1, "createAutoSubmitter must forward bytes to onStatus");
  assert.equal(byteEvents[0].b.loaded, HALF);
  assert.equal(byteEvents[0].b.total, TOTAL);
});

test("IT and ACCOUNTING stay tutor-only while OTHER/UNKNOWN and 完整解題 go to the consent-gated handoff", () => {
  assert.equal(shouldUseLocalTutor("IT", "自動判斷"), true);
  assert.equal(shouldUseLocalTutor("ACCOUNTING", "教材解釋"), true);
  assert.equal(shouldUseLocalTutor("OTHER", "自動判斷"), false);
  assert.equal(shouldUseLocalTutor("UNKNOWN", "自動判斷"), false);
  assert.equal(shouldUseLocalTutor("IT", "完整解題（Google）"), false);
});

test("A1: Auto label is simplified and old consent and manual-route UI are removed (DOM=0)", () => {
  const page = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /<option value="Auto">Auto<\/option>/);
  assert.doesNotMatch(page, /Auto \(Qwen3-0\.6B\)/);
  assert.doesNotMatch(page, /googleConsent/);
  assert.doesNotMatch(page, /我同意將原題送往 Google AI/);
  assert.doesNotMatch(page, /先同意後提供備援連結/);
  assert.doesNotMatch(page, /改以資訊科試解/);
  assert.doesNotMatch(page, /改以會計科試解/);
  assert.doesNotMatch(page, /改以本機模型試解/);
  assert.doesNotMatch(page, /明確同意並點擊後/);
});

test("cold-start UI keeps byte progress, the stall escape hatch and the practice answer notice", () => {
  const page = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /DOWNLOAD_STALL_MS = 90_000/);
  assert.match(page, /下載停滯（連續 90 秒無新資料）/);
  assert.match(page, /onClick=\{retryDownload\}>重新下載</);
  assert.match(page, /if \(isTrustworthyByteProgress\(bytes\)\) \{/);
  assert.match(page, /\(bytes\.total as number\) > 1/);
  assert.match(page, /先自行作答，詳解答案請由 Google AI 查看。/);
});

function fakeCacheStorage() {
  const entries = new Map();
  const deletes = [];
  const cache = {
    async match() { return undefined; },
    async put() {},
    async delete(key) { deletes.push(typeof key === "string" ? key : key.url); return true; },
    async keys() { return [...entries.keys()].map((url) => new Request(url)); },
  };
  return { cache, deletes, storage: { open: async () => cache } };
}

test("COLD_START: cancelling a model download never evicts the stored model cache", async () => {
  const { cache, deletes } = fakeCacheStorage();
  const originalCaches = globalThis.caches;
  globalThis.caches = { open: async () => cache };
  const env = {
    WebAssembly: { instantiate: () => ({}) },
    window: {
      LanguageModel: {
        __isPolyfill: true,
        create({ signal }) {
          return new Promise((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(new Error("download aborted")));
          });
        },
      },
    },
  };
  try {
    globalThis.window = env.window;
    const controller = new AbortController();
    const pending = askWithChromeBuiltInAi("什麼是恐龍？", () => {}, {
      env,
      signal: controller.signal,
      forceLocalModel: true,
      userActivation: true,
      loadPolyfill: async () => {},
    });
    await new Promise((r) => setTimeout(r, 20));
    controller.abort();
    await assert.rejects(pending, /已取消/);
    assert.deepEqual(deletes, [], "cancel/timeout must not force a re-download of ~618MB");
  } finally {
    globalThis.caches = originalCaches;
    delete globalThis.window;
  }
});

test("COLD_START: a genuine model load failure still evicts for a clean retry", async () => {
  const { cache, deletes } = fakeCacheStorage();
  const originalCaches = globalThis.caches;
  globalThis.caches = { open: async () => cache };
  const env = {
    WebAssembly: { instantiate: () => ({}) },
    window: {
      LanguageModel: {
        __isPolyfill: true,
        async create() { throw new Error("incompatible onnx graph"); },
      },
    },
  };
  try {
    globalThis.window = env.window;
    await assert.rejects(
      askWithChromeBuiltInAi("什麼是恐龍？", () => {}, {
        env,
        forceLocalModel: true,
        userActivation: true,
        loadPolyfill: async () => {},
      }),
      /下載或初始化失敗/,
    );
    assert.ok(deletes.length >= 1, "a failed load must clear the unusable cache manifest");
  } finally {
    globalThis.caches = originalCaches;
    delete globalThis.window;
  }
});

test("A2: page mount preload warms up local model; submit waits for inflight preload and never initiates duplicate download", async () => {
  let createCount = 0;
  let destroyCount = 0;
  const TOTAL = 617687575;
  const HALF = 308843787;

  // B1: every create parks on its own deferred, and each release handle is
  // registered here so the finally can settle it even when an assertion fails
  // midway. A deferred nobody releases is a promise that outlives the test:
  // node:test then cancels the whole file with "Promise resolution is still
  // pending but the event loop has already resolved" and a non-zero exit.
  const pendingDownloads = new Set();
  const releaseAllDownloads = () => {
    const releases = [...pendingDownloads];
    pendingDownloads.clear();
    for (const release of releases) release();
  };
  // Anything still running when an assertion throws must be drained, not
  // abandoned: late rejections would surface as unhandled rejections.
  const background = [];
  const track = (promise) => {
    const sink = Promise.resolve(promise).catch(() => {});
    background.push(sink);
    return promise;
  };

  const env = {
    WebAssembly: { instantiate: () => ({}) },
    window: {
      LanguageModel: {
        __isPolyfill: true,
        async availability() { return "available"; },
        async create(options) {
          createCount += 1;
          if (options?.monitor) {
            const target = new EventTarget();
            options.monitor(target);
            target.dispatchEvent(Object.assign(new Event("downloadprogress"), { loaded: HALF, total: TOTAL }));
          }
          await new Promise((release) => { pendingDownloads.add(release); });
          return {
            promptStreaming: () => (async function* () { yield "13"; })(),
            destroy() { destroyCount += 1; },
          };
        },
      },
    },
  };

  const submitter = createAutoSubmitter(env, async () => {});
  try {
    assert.equal(submitter.isPreloaded, false);
    assert.equal(submitter.isPreloading, false);

    const seenStatuses = [];
    // 1. Page mount starts preload (cache miss background download)
    const preloadPromise = track(submitter.preload(
      (status, progress, bytes) => seenStatuses.push({ status, bytes }),
      { localModelId: "test-model", forceLocalModel: true },
    ));
    assert.equal(submitter.isPreloading, true);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(createCount, 1, "preload must trigger model creation/download");

    // 2. Submit while preload is in flight: submit waits for preload and does NOT start a second download
    const submitPromise = track(submitter.submit("十三加五等於多少？", () => {}, undefined, {
      localModelId: "test-model",
      forceLocalModel: true,
    }));

    // Ensure no second create was triggered by submit
    assert.equal(createCount, 1, "submit must wait for inflight preload and never start a second download");

    // Release the download
    releaseAllDownloads();
    assert.equal(await preloadPromise, "warmed");
    assert.equal(submitter.isPreloaded, true);
    assert.equal(submitter.isPreloading, false);
    assert.ok(
      seenStatuses.some((entry) => entry.status === "local model download" && entry.bytes?.loaded === HALF),
      "preload must surface byte progress while the download is in flight",
    );
    assert.ok(seenStatuses.some((entry) => entry.status === "local model ready"), "preload must publish 'local model ready'");

    const answer = await submitPromise;
    assert.equal(answer, "13");
    assert.equal(createCount, 1, "total create calls must be exactly 1");
    assert.equal(destroyCount, 0, "the shared warm session stays alive for the next answer");

    // 3. Cache hit for the SAME model: readiness answers without a new download
    const repeatStatuses = [];
    const repeat = await submitter.preload((st) => repeatStatuses.push(st), { localModelId: "test-model" });
    assert.equal(repeat, "warmed", "an already-ready model returns immediately");
    assert.equal(createCount, 1, "cache hit / ready must not trigger additional download");
    assert.ok(repeatStatuses.includes("local model ready"), "the join path still tells the learner the model is ready");

    // 4. Reset lifecycle: deleting readiness destroys the published session exactly once
    submitter.resetPreload();
    assert.equal(submitter.isPreloaded, false);
    assert.equal(submitter.isPreloading, false);
    assert.equal(destroyCount, 1, "resetPreload must destroy the ready session exactly once");
    assert.equal(createCount, 1);
  } finally {
    releaseAllDownloads();
    await Promise.allSettled(background);
  }
});
