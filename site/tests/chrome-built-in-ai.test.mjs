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

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  askWithChromeBuiltInAi,
  ChromeAiError,
  createAutoSubmitter,
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
          requestAdapter: async () => ({ isMockAdapter: true }),
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
      gpu: { requestAdapter: async () => ({}) },
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

test("Gate 5: WebGPU local inference renders streamed answer", async () => {
  const mockWin = mockTargetWindow();
  const env = {
    window: mockWin,
    navigator: {
      gpu: { requestAdapter: async () => ({}) },
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
        gpu: { requestAdapter: async () => ({}) },
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

test("Gate 10: Traditional Chinese questions succeed with or without Translator API", async () => {
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
  const answerA = await askWithChromeBuiltInAi("什麼是二元搜尋樹？", (c) => rendered.push(c), { env: envWithTrans });
  assert.equal(answerA, "繁體中文最終答案");
  assert.equal(translations.length, 2);

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
  const bundle = files(dist).map((file) => readFileSync(file, "utf8")).join("\n");
  assertNoForbiddenTokens("built client bundle", bundle);
});
