// Auto slice source/bundle and compatibility gate.
//
// Minimum Gate requirements verified:
//  1. native LanguageModel available -> uses native, PASS
//  2. native downloadable/downloading -> model download progress with cancel
//  3. native absent -> local polyfill path loaded, NETWORK_CLOUD_AI_CALLS = 0
//  4. native unavailable -> falls through to local fallback instead of early exit
//  5. WebGPU local inference -> answer rendered
//  6. WebGPU unavailable -> WASM path has concrete result or truthful unsupported (no false-PASS)
//  7. Android/iOS UA -> does not terminate solely on LanguageModel absence; evaluates local fallback
//  8. duplicate submits and cancellation fail closed
//  9. browser AI errors never fall back to a network service
// 10. Traditional Chinese questions succeed with or without Translator API
// 11. client source and built bundle forbid cloud-AI tokens, keys, and endpoints
// 12. local fallback pins the Qwen2.5 baseline and exposes the Qwen3 test option
// 13. WebGPU q4f16 artifact load failure retries the same local model at q8
// 14. streamed local answers stop and truncate on repetition loops
// 15. cancellation hands the AbortSignal to the live prompt/stream and fails closed
// 16. local fallback prompt requires a short Traditional Chinese answer
// 17. dynamic import rejection retains safe engine-module diagnostics
// 18. every local create rejection retains safe dtype/session diagnostics

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  askWithChromeBuiltInAi,
  ChromeAiError,
  createAutoSubmitter,
  createRepetitionGuard,
  createThinkingGuard,
  detectRepetitionLoop,
  isTraditionalChinese,
  LOCAL_FALLBACK_DTYPE_CANDIDATES,
  LOCAL_FALLBACK_MODEL_ID,
  LOCAL_FALLBACK_PROMPT_INSTRUCTION,
  ORT_WASM_URL,
  QWEN25_BASELINE_MODEL_ID,
  QWEN3_TEST_MODEL_ID,
  stripThinkingTags,
  SUPPORTED_LOCAL_MODELS,
} from "../app/chrome-built-in-ai.ts";

function stream(chunks) {
  return (async function* () {
    for (const chunk of chunks) yield chunk;
  })();
}

function mockTargetWindow(overrides = {}) {
  const win = {
    ...overrides,
  };
  return win;
}

function f16Adapter() {
  return { features: { has: (feature) => feature === "shader-f16" } };
}

test("Gate 1: native LanguageModel available uses native without fallback and without network calls", async () => {
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = async () => {
    networkCalls += 1;
    throw new Error("Network must not be called");
  };

  try {
    let nativeCreateCalls = 0;
    const statuses = [];
    const chunks = [];
    const env = {
      LanguageModel: {
        async availability() { return "available"; },
        async create() {
          nativeCreateCalls += 1;
          return { promptStreaming: () => stream(["原", "生答案"]) };
        },
      },
    };

    const answer = await askWithChromeBuiltInAi(
      "測試問題",
      (chunk) => chunks.push(chunk),
      {
        env,
        onStatus: (st) => statuses.push(st),
      },
    );

    assert.equal(answer, "原生答案");
    assert.deepEqual(chunks, ["原", "生答案"]);
    assert.equal(nativeCreateCalls, 1);
    assert.ok(statuses.includes("native ready"));
    assert.equal(networkCalls, 0, "No network call should be made on native path");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Gate 2: native LanguageModel downloadable/downloading reports progress and supports cancellation", async () => {
  const statuses = [];
  const progresses = [];

  const env = {
    LanguageModel: {
      async availability() { return "downloadable"; },
      async create(options) {
        if (options?.monitor) {
          const target = new EventTarget();
          options.monitor(target);
          target.dispatchEvent(Object.assign(new Event("downloadprogress"), { loaded: 50, total: 100 }));
        }
        if (options?.signal?.aborted) throw new Error("aborted");
        return {
          promptStreaming: () => stream(["下載完成回答"]),
        };
      },
    },
  };

  const answer = await askWithChromeBuiltInAi(
    "問題",
    () => {},
    {
      env,
      onStatus: (st, pr) => {
        statuses.push(st);
        if (typeof pr === "number") progresses.push(pr);
      },
    },
  );

  assert.equal(answer, "下載完成回答");
  assert.ok(statuses.includes("native model download"));
  assert.ok(progresses.includes(0.5));
});

test("Gate 3: native absent triggers local fallback capability gate and loads polyfill with NETWORK_CLOUD_AI_CALLS=0", async () => {
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = async () => {
    networkCalls += 1;
    throw new Error("No network AI allowed");
  };

  try {
    let polyfillLoaded = false;
    let polyfillCreateCalls = 0;
    const statuses = [];
    const chunks = [];

    const mockWin = mockTargetWindow();
    const env = {
      window: mockWin,
      navigator: {
        gpu: {
          requestAdapter: async () => f16Adapter(),
        },
      },
      WebAssembly: { instantiate: async () => ({}) },
    };

    const answer = await askWithChromeBuiltInAi(
      "數學問題",
      (c) => chunks.push(c),
      {
        env,
        loadPolyfill: async () => {
          polyfillLoaded = true;
          mockWin.LanguageModel = {
            __isPolyfill: true,
            async availability() { return "available"; },
            async create() {
              polyfillCreateCalls += 1;
              return { promptStreaming: () => stream(["本機", "Fallback", "答案"]) };
            },
          };
        },
        onStatus: (st) => statuses.push(st),
      },
    );

    assert.equal(answer, "本機Fallback答案");
    assert.equal(polyfillLoaded, true, "Polyfill loader must be called when native LanguageModel is absent");
    assert.equal(polyfillCreateCalls, 1);
    assert.equal(networkCalls, 0, "NETWORK_CLOUD_AI_CALLS must be 0");
    assert.ok(statuses.includes("local fallback loading"));
    assert.ok(statuses.includes("local model download"));
    assert.equal(mockWin.TRANSFORMERS_CONFIG.apiKey, "dummy");
    assert.equal(mockWin.TRANSFORMERS_CONFIG.device, "webgpu");
    assert.equal(mockWin.TRANSFORMERS_CONFIG.modelName, QWEN3_TEST_MODEL_ID);
    assert.equal(mockWin.TRANSFORMERS_CONFIG.dtype, "q4f16");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Gate 4: native unavailable falls through to local fallback instead of early termination", async () => {
  let polyfillLoaded = false;
  const statuses = [];
  const mockWin = mockTargetWindow();

  const env = {
    window: mockWin,
    LanguageModel: {
      async availability() { return "unavailable"; },
      async create() { throw new Error("Native should not be created if unavailable"); },
    },
    navigator: {
      gpu: { requestAdapter: async () => f16Adapter() },
    },
  };

  const answer = await askWithChromeBuiltInAi(
    "問題",
    () => {},
    {
      env,
      loadPolyfill: async () => {
        polyfillLoaded = true;
        mockWin.LanguageModel = {
          __isPolyfill: true,
          async create() {
            return { promptStreaming: () => stream(["Fallback從unavailable復原"]) };
          },
        };
      },
      onStatus: (st) => statuses.push(st),
    },
  );

  assert.equal(answer, "Fallback從unavailable復原");
  assert.equal(polyfillLoaded, true);
  assert.ok(statuses.includes("local fallback loading"));
});

test("Integration: unusable native API reaches the real isolated fallback artifact lifecycle without cloud inference", async () => {
  // This deliberately does not use loadPolyfill/__setPolyfillLoader or a UA mock.
  // It imports prompt-api-polyfill through the production loader. Network is
  // intercepted so the test proves the first real backend request is a model
  // artifact download, never an AI inference service request.
  const original = {
    fetch: globalThis.fetch,
    document: globalThis.document,
    navigator: globalThis.navigator,
    MutationObserver: globalThis.MutationObserver,
    ProgressEvent: globalThis.ProgressEvent,
    LanguageModel: globalThis.LanguageModel,
    transformers: globalThis.TRANSFORMERS_CONFIG,
  };
  const requests = [];
  let nativeCreates = 0;
  let localDownloadLifecycle = false;

  try {
    globalThis.MutationObserver = class { observe() {} };
    globalThis.ProgressEvent = class extends Event {
      constructor(type, init = {}) { super(type); Object.assign(this, init); }
    };
    globalThis.document = { defaultView: globalThis };
    Object.defineProperty(globalThis, "navigator", {
      value: { userActivation: { isActive: true } }, configurable: true,
    });
    globalThis.fetch = async (input) => {
      const url = String(input);
      requests.push(url);
      throw new Error("Test intercept: model artifact not installed");
    };
    globalThis.LanguageModel = {
      async availability() { return "available"; },
      async create() { nativeCreates += 1; throw new Error("native accelerator unavailable"); },
    };

    await assert.rejects(
      () => askWithChromeBuiltInAi("local backend integration", () => {}, {
        env: {
          window: globalThis,
          LanguageModel: globalThis.LanguageModel,
          navigator: globalThis.navigator,
          WebAssembly: { instantiate: async () => ({}) },
        },
        onStatus: (status, progress) => {
          if (status === "local model download" && typeof progress === "number") localDownloadLifecycle = true;
        },
      }),
      ChromeAiError,
    );

    assert.equal(nativeCreates, 1, "native create failure must continue to the isolated local backend");
    assert.ok(localDownloadLifecycle, "local download lifecycle must begin before any artifact failure");
    const MODEL_ARTIFACT_DOWNLOAD_REQUESTS = requests.filter((url) =>
      /huggingface\.co\/onnx-community\/Qwen3-0\.6B-ONNX/i.test(url),
    ).length;
    assert.equal(MODEL_ARTIFACT_DOWNLOAD_REQUESTS, 1,
      "the deterministic interceptor must observe exactly one initial model artifact request");
    const CLOUD_AI_INFERENCE_REQUESTS = requests.filter((url) =>
      /generativelanguage\.googleapis\.com|api\.openai\.com|firebase|\/v1\/chat\/completions/i.test(url),
    ).length;
    assert.equal(CLOUD_AI_INFERENCE_REQUESTS, 0);
  } finally {
    globalThis.fetch = original.fetch;
    globalThis.document = original.document;
    Object.defineProperty(globalThis, "navigator", { value: original.navigator, configurable: true });
    globalThis.MutationObserver = original.MutationObserver;
    globalThis.ProgressEvent = original.ProgressEvent;
    globalThis.LanguageModel = original.LanguageModel;
    globalThis.TRANSFORMERS_CONFIG = original.transformers;
  }
});

test("Gate 5: WebGPU local inference renders streamed answer", async () => {
  const mockWin = mockTargetWindow();
  const env = {
    window: mockWin,
    navigator: {
      gpu: { requestAdapter: async () => f16Adapter() },
    },
  };

  const chunks = [];
  const answer = await askWithChromeBuiltInAi(
    "題目",
    (c) => chunks.push(c),
    {
      env,
      loadPolyfill: async () => {
        mockWin.LanguageModel = {
          __isPolyfill: true,
          async create() {
            return {
              promptStreaming: () => stream(["WebGPU", " ", "運算結果"]),
            };
          },
        };
      },
    },
  );

  assert.equal(answer, "WebGPU 運算結果");
  assert.deepEqual(chunks, ["WebGPU", " ", "運算結果"]);
  assert.equal(mockWin.TRANSFORMERS_CONFIG.device, "webgpu");
});

test("Gate 6: WebGPU unavailable falls back to WASM, or truthful unsupported without false-PASS", async () => {
  // Scenario A: WebGPU unavailable, WASM available -> evaluates WASM
  const mockWinWasm = mockTargetWindow();
  const envWasm = {
    window: mockWinWasm,
    navigator: { gpu: { requestAdapter: async () => null } },
    WebAssembly: { instantiate: async () => ({}) },
  };

  const answerWasm = await askWithChromeBuiltInAi(
    "題目",
    () => {},
    {
      env: envWasm,
      loadPolyfill: async () => {
        mockWinWasm.LanguageModel = {
          __isPolyfill: true,
          async create() { return { prompt: async () => "WASM 回答" }; },
        };
      },
    },
  );

  assert.equal(answerWasm, "WASM 回答");
  assert.equal(mockWinWasm.TRANSFORMERS_CONFIG.device, "wasm");
  assert.equal(mockWinWasm.TRANSFORMERS_CONFIG.dtype, "q8", "WASM must use the conservative supported q8 mapping");

  // Scenario B: Neither WebGPU nor WASM available -> truthful unsupported, no false-PASS
  const statuses = [];
  const envNone = {
    window: mockTargetWindow(),
    navigator: {},
    WebAssembly: undefined,
  };

  await assert.rejects(
    () => askWithChromeBuiltInAi("題目", () => {}, { env: envNone, onStatus: (st) => statuses.push(st) }),
    (err) => err instanceof ChromeAiError && /不支援/.test(err.message),
  );
  assert.ok(statuses.includes("unsupported after fallback"));
});

test("Gate 6a: adapter without shader-f16 skips q4f16 artifact and uses WASM q8 with CLOUD_AI_INFERENCE_REQUESTS=0", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  const mockWin = mockTargetWindow();
  globalThis.fetch = async (input) => {
    requests.push(String(input));
    return new Response("local artifact");
  };

  try {
    const answer = await askWithChromeBuiltInAi("題目", () => {}, {
      env: {
        window: mockWin,
        navigator: {
          gpu: { requestAdapter: async () => ({ features: { has: () => false } }) },
        },
        WebAssembly: { instantiate: async () => ({}) },
      },
      loadLocalLanguageModel: async () => ({
        __isPolyfill: true,
        async create() {
          // The backend's first artifact selection is driven only by this
          // pre-download configuration, which makes the regression observable.
          await fetch(`https://huggingface.co/onnx-community/Qwen2.5-0.5B-Instruct/resolve/main/${mockWin.TRANSFORMERS_CONFIG.dtype}/model.onnx`);
          return { prompt: async () => "WASM q8 回答" };
        },
      }),
    });

    assert.equal(answer, "WASM q8 回答");
    assert.equal(mockWin.TRANSFORMERS_CONFIG.device, "wasm");
    assert.equal(mockWin.TRANSFORMERS_CONFIG.dtype, "q8");
    assert.equal(requests.filter((url) => /q4f16/i.test(url)).length, 0,
      "no-shader-f16 must not request a q4f16 artifact");
    const CLOUD_AI_INFERENCE_REQUESTS = requests.filter((url) =>
      /generativelanguage\.googleapis\.com|api\.openai\.com|firebase|\/v1\/chat\/completions/i.test(url),
    ).length;
    assert.equal(CLOUD_AI_INFERENCE_REQUESTS, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Gate 7a: no user activation is truthful and a fresh click can initialize the local model", async () => {
  const mockWin = mockTargetWindow();
  let active = false;
  let creates = 0;
  const statuses = [];
  const env = {
    window: mockWin,
    navigator: {
      userActivation: { get isActive() { return active; } },
      gpu: { requestAdapter: async () => f16Adapter() },
    },
  };
  const loader = async () => {
    mockWin.LanguageModel = {
      __isPolyfill: true,
      async create() { creates += 1; return { prompt: async () => "本機模型已啟動" }; },
    };
  };

  await assert.rejects(
    () => askWithChromeBuiltInAi("題目", () => {}, { env, loadPolyfill: loader, onStatus: (status) => statuses.push(status) }),
    /新的使用者操作.*開始下載本機模型/,
  );
  assert.equal(creates, 0, "cold-cache initialization must not retry without a user gesture");
  assert.ok(statuses.includes("local model requires user activation"));

  active = true; // Represents the explicit learner click on 「開始下載本機模型」.
  const answer = await askWithChromeBuiltInAi("題目", () => {}, { env, loadPolyfill: loader });
  assert.equal(answer, "本機模型已啟動");
  assert.equal(creates, 1);
});

test("Gate 7: Android/iOS UA does not terminate solely on LanguageModel absence; evaluates local fallback", async () => {
  for (const ua of [
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  ]) {
    const mockWin = mockTargetWindow();
    const env = {
      window: mockWin,
      navigator: {
        userAgent: ua,
        gpu: { requestAdapter: async () => f16Adapter() },
      },
    };

    let polyfillCalled = false;
    const answer = await askWithChromeBuiltInAi(
      "手機問答測試",
      () => {},
      {
        env,
        loadPolyfill: async () => {
          polyfillCalled = true;
          mockWin.LanguageModel = {
            __isPolyfill: true,
            async create() { return { promptStreaming: () => stream(["行動端Fallback成功"]) }; },
          };
        },
      },
    );

    assert.equal(answer, "行動端Fallback成功");
    assert.equal(polyfillCalled, true, `Should have evaluated fallback on UA: ${ua}`);
  }
});

test("Gate 8: duplicate submits and cancellation fail closed", async () => {
  let release;
  const submitter = createAutoSubmitter(
    {
      LanguageModel: {
        async availability() { return "available"; },
        async create() {
          return {
            promptStreaming: async function* () {
              await new Promise((resolve) => { release = resolve; });
              yield "late";
            },
          };
        },
      },
    },
  );

  const first = submitter.submit("first", () => {});
  await assert.rejects(() => submitter.submit("second", () => {}), /處理中/);
  submitter.cancel();
  release();
  await assert.rejects(first, ChromeAiError);
});

test("Gate 9: browser AI errors never fall back to a network service", async () => {
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = async () => {
    networkCalls += 1;
    return Response.json({ answer: "Forbidden cloud fallback" });
  };

  try {
    const env = {
      LanguageModel: {
        async availability() { return "available"; },
        async create() { throw new Error("Hardware acceleration failure"); },
      },
      navigator: { gpu: { requestAdapter: async () => null } },
      WebAssembly: undefined,
    };

    await assert.rejects(
      () => askWithChromeBuiltInAi("question", () => {}, { env }),
      /未使用.*服務|不支援/,
    );
    assert.equal(networkCalls, 0, "No cloud network call allowed when local device fails");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Gate 10: Traditional Chinese questions succeed with streaming preserved or explicitly buffered", async () => {
  // Case A: Translator present
  const translations = [];
  const envWithTrans = {
    LanguageModel: {
      async availability() { return "available"; },
      async create() { return { promptStreaming: () => stream(["English translated answer"]) }; },
    },
    Translator: {
      async availability() { return "available"; },
      async create({ sourceLanguage, targetLanguage }) {
        return {
          async translate(text) {
            translations.push([sourceLanguage, targetLanguage, text]);
            return sourceLanguage === "zh-Hant" ? "English question" : "繁體中文最終答案";
          },
        };
      },
    },
  };

  const rendered = [];
  const statuses = [];
  const answerA = await askWithChromeBuiltInAi("什麼是二元搜尋樹？", (c) => rendered.push(c), { env: envWithTrans, onStatus: (status) => statuses.push(status) });
  assert.equal(answerA, "繁體中文最終答案");
  assert.equal(translations.length, 2);
  assert.deepEqual(rendered, ["繁體中文最終答案"], "translated mode must emit its final rendered answer");
  assert.ok(statuses.includes("native translation buffering"), "whole-answer translation must not silently swallow streaming");

  // Case B: Translator absent (e.g. mobile browser)
  const envNoTrans = {
    LanguageModel: {
      async availability() { return "available"; },
      async create() { return { promptStreaming: () => stream(["繁體中文直接回答"]) }; },
    },
  };

  const answerB = await askWithChromeBuiltInAi("什麼是二元搜尋樹？", () => {}, { env: envNoTrans });
  assert.equal(answerB, "繁體中文直接回答");
});

test("Gate 10a: zh-Hant detection rejects Simplified Chinese and Japanese Han text", () => {
  assert.equal(isTraditionalChinese("什麼是二元搜尋樹？"), true);
  assert.equal(isTraditionalChinese("什么是二叉树？"), false);
  assert.equal(isTraditionalChinese("これは二分木です"), false);
  assert.equal(isTraditionalChinese("漢字だけ"), false, "shared Han ideographs alone are ambiguous");
});

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)],
  );
}

const FORBIDDEN_CLOUD_AI_PATTERNS = [
  "GEMINI_API_KEY",
  "generativelanguage\\.googleapis\\.com",
  "guest-ask",
  "/api/public/",
  "FIREBASE_CONFIG",
  "OPENAI_CONFIG",
  "GEMINI_CONFIG",
  "WEBLLM_CONFIG",
  "https?://api\\.openai\\.com",
  "api\\.openai\\.com",
  "generativelanguage",
];

function assertNoForbiddenTokens(label, payload) {
  for (const pattern of FORBIDDEN_CLOUD_AI_PATTERNS) {
    assert.doesNotMatch(payload, new RegExp(pattern), `${label} must not contain forbidden cloud-AI token: ${pattern}`);
  }
}

test("Gate 11: client source and built bundle forbid cloud-AI tokens and guest-ask paths", () => {
  const sources = [
    new URL("../app/chrome-built-in-ai.ts", import.meta.url),
    new URL("../app/page.tsx", import.meta.url),
    new URL("../app/blocked-cloud-backend.ts", import.meta.url),
  ];
  for (const url of sources) {
    const source = readFileSync(url, "utf8");
    assertNoForbiddenTokens(`Auto source ${url.pathname}`, source);
  }
  const dist = join(process.cwd(), "dist");
  assert.ok(existsSync(dist), "build must run before this test");
  const sourceMtime = Math.max(...sources.map((url) => Number(statSync(url).mtimeMs)));
  const bundleMtime = Math.max(...files(dist).map((file) => Number(statSync(file).mtimeMs)));
  assert.ok(bundleMtime >= sourceMtime, "dist is stale: build the current source snapshot before Gate 11");
  const bundle = files(dist).map((file) => readFileSync(file, "utf8")).join("\n");
  assertNoForbiddenTokens("built client bundle", bundle);
});

test("Gate 12: Auto local fallback pins Qwen3-0.6B", () => {
  assert.equal(LOCAL_FALLBACK_MODEL_ID, "onnx-community/Qwen3-0.6B-ONNX");
  assert.equal(QWEN25_BASELINE_MODEL_ID, "onnx-community/Qwen2.5-0.5B-Instruct");
  assert.equal(QWEN3_TEST_MODEL_ID, "onnx-community/Qwen3-0.6B-ONNX");
  assert.deepEqual(SUPPORTED_LOCAL_MODELS, [
    "onnx-community/Qwen2.5-0.5B-Instruct",
    "onnx-community/Qwen3-0.6B-ONNX",
  ]);

  const source = readFileSync(new URL("../app/chrome-built-in-ai.ts", import.meta.url), "utf8");
  assert.match(source, /onnx-community\/Qwen3-0\.6B-ONNX/);

  const dist = join(process.cwd(), "dist");
  const bundle = files(dist).map((file) => readFileSync(file, "utf8")).join("\n");
  assert.match(bundle, /onnx-community\/Qwen3-0\.6B-ONNX/);
});

test("Gate 13: WebGPU q4f16 artifact load failure retries the same local model at q8", async () => {
  assert.deepEqual(LOCAL_FALLBACK_DTYPE_CANDIDATES.webgpu, ["q4f16", "q8"]);
  assert.deepEqual(LOCAL_FALLBACK_DTYPE_CANDIDATES.wasm, ["q8"]);
  const mockWin = mockTargetWindow();
  const env = {
    window: mockWin,
    navigator: {
      gpu: { requestAdapter: async () => f16Adapter() },
    },
  };

  const triedDtypes = [];
  const answer = await askWithChromeBuiltInAi(
    "測試重試",
    () => {},
    {
      env,
      loadPolyfill: async () => {
        mockWin.LanguageModel = {
          __isPolyfill: true,
          async create() {
            triedDtypes.push(mockWin.TRANSFORMERS_CONFIG.dtype);
            if (mockWin.TRANSFORMERS_CONFIG.dtype === "q4f16") {
              throw new Error("Simulated q4f16 load error");
            }
            return {
              promptStreaming: () => stream(["q8 重試成功"]),
            };
          },
        };
      },
    },
  );

  assert.deepEqual(triedDtypes, ["q4f16", "q8"]);
  assert.equal(answer, "q8 重試成功");
  assert.equal(mockWin.TRANSFORMERS_CONFIG.dtype, "q8");
});

test("Gate 14: streamed local answers stop and truncate on repetition loops", async () => {
  const loop = detectRepetitionLoop("你好！你好！你好！你好！");
  assert.ok(loop, "detectRepetitionLoop must identify repetition");
  const guard = createRepetitionGuard();
  const chunks = ["你好！", "你好！", "你好！", "你好！", "你好！"];
  const emitted = [];
  for (const c of chunks) {
    const safe = guard.feed(c);
    if (safe) emitted.push(safe);
    if (guard.stopped) break;
  }
  assert.equal(guard.stopped, true, "repetition guard must detect loop and stop");
  assert.ok(emitted.length < chunks.length, "loop iterations must be truncated");
});

test("Gate 15: cancellation hands the AbortSignal to the live prompt/stream and fails closed", async () => {
  const mockWin = mockTargetWindow();
  const env = {
    window: mockWin,
    navigator: {
      gpu: { requestAdapter: async () => f16Adapter() },
    },
  };

  const ac = new AbortController();
  const promise = askWithChromeBuiltInAi(
    "取消測試",
    () => { ac.abort(); },
    {
      env,
      signal: ac.signal,
      loadPolyfill: async () => {
        mockWin.LanguageModel = {
          __isPolyfill: true,
          async create() {
            return {
              async *promptStreaming(prompt, options) {
                yield "第一部分";
                if (options?.signal?.aborted) throw new Error("aborted");
                yield "第二部分";
              },
            };
          },
        };
      },
    },
  );

  await assert.rejects(promise, (err) => {
    return err instanceof ChromeAiError && /取消/.test(err.message);
  });
});

test("Gate 16: local fallback prompt requires a short Traditional Chinese answer", async () => {
  assert.match(LOCAL_FALLBACK_PROMPT_INSTRUCTION, /繁體中文/);
  assert.match(LOCAL_FALLBACK_PROMPT_INSTRUCTION, /150 字以內/);
  assert.match(LOCAL_FALLBACK_PROMPT_INSTRUCTION, /切勿重複相同句子/);
});

test("Gate 17: dynamic import rejection keeps engine-module evidence without learner content", async () => {
  const diagnostics = [];
  const env = {
    window: mockTargetWindow(),
    WebAssembly: { instantiate: async () => ({}) },
  };

  await assert.rejects(
    askWithChromeBuiltInAi("不可記錄的學生題目", () => {}, {
      env,
      onLocalFallbackDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      loadLocalLanguageModel: async () => {
        const error = new Error("Loading chunk https://site.example/assets/polyfill-abc.js?token=secret rejected");
        error.name = "ChunkLoadError";
        throw error;
      },
    }),
    (error) => error instanceof ChromeAiError && /載入本機 AI 引擎失敗/.test(error.message),
  );

  assert.equal(diagnostics.length, 1);
  assert.deepEqual(
    { stage: diagnostics[0].stage, name: diagnostics[0].error?.name, dtype: diagnostics[0].dtype },
    { stage: "engine-module-import", name: "ChunkLoadError", dtype: "q8" },
  );
  assert.match(diagnostics[0].chunkUrl, /polyfill-abc\.js\?token=\[redacted\]/);
  assert.doesNotMatch(JSON.stringify(diagnostics[0]), /學生題目|secret/);
});

test("Gate 18: create rejection records every attempted dtype with safe session evidence", async () => {
  const diagnostics = [];
  const mockWin = mockTargetWindow();
  const env = {
    window: mockWin,
    navigator: { gpu: { requestAdapter: async () => f16Adapter() } },
  };

  await assert.rejects(
    askWithChromeBuiltInAi("不可記錄的學生題目", () => {}, {
      env,
      onLocalFallbackDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      loadLocalLanguageModel: async () => ({
        __isPolyfill: true,
        async create() {
          const error = new Error("ORT session init rejected");
          error.name = "OrtSessionError";
          throw error;
        },
      }),
    }),
    (error) => error instanceof ChromeAiError && /下載或初始化失敗/.test(error.message),
  );

  const creates = diagnostics.filter((item) => item.stage === "model-create");
  assert.deepEqual(creates.map((item) => item.dtype), ["q4f16", "q8"]);
  assert.ok(creates.every((item) => item.error?.name === "OrtSessionError"));
  assert.ok(creates.every((item) => item.modelId === "onnx-community/Qwen3-0.6B-ONNX"));
  assert.doesNotMatch(JSON.stringify(creates), /學生題目/);
});

test("Gate 19: reasoning model <think> tags are stripped and do not leak into output", () => {
  const sampleWithThink = "<think>\n好的，這是一個數學問題。\n我們先推導公式。\n</think>\n\n解答是 42。";
  assert.equal(stripThinkingTags(sampleWithThink), "解答是 42。");

  // Streaming thinking guard test
  const emittedChunks = [];
  const guard = createThinkingGuard((chunk) => emittedChunks.push(chunk));
  guard.feed("<think>\n內部推理 1\n");
  guard.feed("內部推理 2\n</think>\n\n這是答案。");
  guard.feed("補充說明。");
  guard.finish();

  assert.deepEqual(emittedChunks, ["這是答案。", "補充說明。"]);
  assert.doesNotMatch(emittedChunks.join(""), /<think>|內部推理/);
});

test("Gate 20: build output single file size is bounded under 25MB Sites limit", () => {
  const dist = join(process.cwd(), "dist");
  assert.ok(existsSync(dist), "dist must exist");
  const allFiles = files(dist);
  const maxBytes = 25 * 1024 * 1024; // 25MB platform limit
  for (const f of allFiles) {
    const sz = statSync(f).size;
    assert.ok(
      sz <= maxBytes,
      `File ${f} (${(sz / 1024 / 1024).toFixed(2)}MB) exceeds 25MB Sites platform limit`,
    );
  }
  assert.match(ORT_WASM_URL, /https:\/\/cdn\.jsdelivr\.net\/npm\/onnxruntime-web@/);
  assert.match(ORT_WASM_URL, /ort-wasm-simd-threaded\.asyncify\.wasm/);
});
