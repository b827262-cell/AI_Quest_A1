import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGoogleAiModeUrl,
  createAutoFallbackGuard,
  hasUnresolvedSimplified,
  normalizeToHant,
  postprocessTraditionalChinese,
  validateLocalAnswer,
} from "../app/auto-fallback.ts";
import { SIMPLIFIED_ONLY } from "../app/hant-set.ts";
import { createAutoSubmitter, askWithChromeBuiltInAi } from "../app/chrome-built-in-ai.ts";

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
  const env = {
    WebAssembly: { instantiate: () => ({}) },
    window: {
      LanguageModel: {
        __isPolyfill: true,
        async create() {
          const cfg = env.window.TRANSFORMERS_CONFIG;
          assert.equal(typeof cfg.env.fetch, "function");
          fetchPromise = cfg.env.fetch("https://huggingface.co/onnx-community/Qwen3-0.6B-ONNX/resolve/main/onnx/model_quantized.onnx", {});
          await fetchPromise;
          return { async prompt() { return "x"; } };
        },
      },
    },
  };
  let fetchPromise = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (_input, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("artifact download aborted")));
  });
  try {
    // The signal-merging fetch wrapper is the browser branch; force it by
    // defining window (Node otherwise takes the isolated nodeRuntime path).
    globalThis.window = env.window;
    const controller = new AbortController();
    const pending = askWithChromeBuiltInAi("什麼是恐龍？", () => {}, {
      env,
      signal: controller.signal,
      forceLocalModel: true,
      userActivation: true,
      loadPolyfill: async () => {},
    });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(fetchPromise instanceof Promise, true, "model fetch must be in flight");
    controller.abort();
    await assert.rejects(fetchPromise, /artifact download aborted/);
    await assert.rejects(pending, /已取消/);
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
  assert.equal(byteEvents[0].b.received, HALF);
  assert.equal(byteEvents[0].b.total, TOTAL);
});
