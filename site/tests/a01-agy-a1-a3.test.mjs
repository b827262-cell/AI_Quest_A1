import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  createAutoSubmitter,
  preloadLocalModel,
  buildInferencePrompt,
  parseInferenceResponse,
  InferenceSchemaError,
} from "../app/chrome-built-in-ai.ts";
import {
  AUTO_ROUTE_WITHHELD_COPY,
  buildPracticeAssistantPrefix,
  buildPracticeQuestionPrompt,
  formatPracticeContinuation,
  LOCAL_ANSWER_MIN_CONFIDENCE,
  PRACTICE_SYSTEM_PROMPT,
  localAnswerWithholdReason,
  runAutoRouteInference,
  shouldDisplayLocalAnswer,
  validatePracticeQuestion,
} from "../app/auto-route.ts";
import {
  closePreopenedGoogleAiTab,
  handoffToGoogleAi,
  openGoogleAiAfterLocalFailure,
  preopenGoogleAiTab,
} from "../app/auto-handoff.ts";
import { formatDownloadProgress, isModelScaleDownloadProgress, isTrustworthyByteProgress, isTrustworthyUnknownTotalByteProgress, MODEL_SCALE_DOWNLOAD_BYTES, resolveProgressPanel } from "../app/page.tsx";

test("T2 progress panel gives inference stage and elapsed time precedence over local fallback initialization", () => {
  assert.equal(
    resolveProgressPanel({ isLoading: true, isPreloading: false, aiStatus: "local fallback loading" }),
    "generation",
    "a submitted local inference must show its action/stage/elapsed panel",
  );
  assert.equal(
    resolveProgressPanel({ isLoading: false, isPreloading: true, aiStatus: "local fallback loading" }),
    "download",
    "background preload may show the preparation/download-resource panel",
  );
  assert.equal(
    resolveProgressPanel({ isLoading: true, isPreloading: false, aiStatus: "local model download" }),
    "download",
    "real local-model artifact transfer overrides generation progress",
  );
  assert.equal(
    resolveProgressPanel({ isLoading: true, isPreloading: true, aiStatus: "local fallback loading" }),
    "generation",
    "submit takes precedence even while a previously-started preload is settling",
  );
});

test("P0 normalized or fractional monitor values never format as fake model bytes", () => {
  for (const bytes of [{ loaded: 0.52, total: 1 }, { loaded: 1, total: 1 }, { loaded: 1, total: 1.5 }]) {
    assert.equal(isTrustworthyByteProgress(bytes), false);
    assert.notEqual(formatDownloadProgress(bytes), "正在下載本機 AI 模型：52% · 0.0 MB / 0.0 MB");
    assert.notEqual(formatDownloadProgress(bytes), "正在下載本機 AI 模型：100% · 0.0 MB / 0.0 MB");
    assert.notEqual(formatDownloadProgress(bytes), "正在下載本機 AI 模型：67% · 0.0 MB / 0.0 MB");
    assert.match(formatDownloadProgress(bytes), /準備／下載模型資源/);
  }
});

test("P0 tiny completed metadata stays indeterminate until the 589MB model transfer arrives", () => {
  const metadata = { loaded: 1_024, total: 1_024 };
  const model = { loaded: 86 * 1024 * 1024, total: 589 * 1024 * 1024 };

  assert.equal(isTrustworthyByteProgress(metadata), true, "metadata bytes remain valid transport data");
  assert.equal(isModelScaleDownloadProgress(metadata), false, "metadata must not become model progress");
  assert.match(formatDownloadProgress(metadata), /準備／下載模型資源/);
  assert.doesNotMatch(formatDownloadProgress(metadata), /100%|0\.0 MB \/ 0\.0 MB/);

  assert.ok(model.total > MODEL_SCALE_DOWNLOAD_BYTES);
  assert.equal(isModelScaleDownloadProgress(model), true);
  assert.equal(formatDownloadProgress(model), "正在下載本機 AI 模型：15% · 86.0 MB / 589.0 MB");
});

test("P0 unknown total exposes only model-scale bytes without inventing completion", () => {
  const metadata = { loaded: 1_024, total: null };
  const model = { loaded: 32 * 1024 * 1024, total: null };
  const normalizedRatio = { loaded: 1, total: 1 };

  assert.equal(isTrustworthyUnknownTotalByteProgress(metadata), true);
  assert.equal(isModelScaleDownloadProgress(metadata), false, "tiny unknown-total metadata is not model progress");
  assert.match(formatDownloadProgress(metadata), /準備／下載模型資源/);
  assert.doesNotMatch(formatDownloadProgress(metadata), /已下載|100%|0\.0 MB \/ 0\.0 MB/);

  assert.equal(isTrustworthyByteProgress(model), true);
  assert.equal(isModelScaleDownloadProgress(model), true);
  assert.equal(formatDownloadProgress(model), "正在下載本機 AI 模型：已下載 32.0 MB；總大小未知");

  assert.equal(isTrustworthyByteProgress(normalizedRatio), false, "normalized monitor ratios are never byte progress");
});

test("P0 progress UI is truthful, accessible, and guards duplicate generation", () => {
  const page = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(page, /role="progressbar"/, "progress uses the semantic progressbar role");
  assert.match(page, /aria-valuenow=\{percent\}/, "only the determinate branch provides a value");
  assert.match(page, /等待模型檔案大小資訊/, "small metadata transfers keep model progress indeterminate");
  assert.doesNotMatch(page, /100%・0\.0 MB \/ 0\.0 MB/, "must never render the false 100% / 0.0 MB state");
  assert.match(page, /AI 正在準備練習題…/, "generation has visible progress copy");
  assert.match(page, /v2-progress-indeterminate/, "generation uses an indeterminate progress bar, not a fabricated percentage");
  assert.match(page, /if \(!prompt \|\| isLoading\) return/, "loading state prevents a second inference submission");
  assert.match(page, /✓ 本機 AI 模型已準備完成/, "ready state converges to a concise completion message");
  assert.match(css, /prefers-reduced-motion:reduce/, "progress animation honours reduced-motion preference");
});

test("P0 inference progress names every local action, reports elapsed time, and never invents generation percent", () => {
  const page = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
  for (const action of ["AI 助手出題", "可選提示", "教材解釋", "陪練", "錯題引導"]) {
    assert.match(page, new RegExp(action), `${action} is represented in the local inference UI`);
  }
  assert.match(page, /已等待 \$\{elapsedSeconds\} 秒/, "elapsed seconds are visible and are not an ETA");
  assert.match(page, /"載入模型"/, "only trustworthy coarse stages are shown");
  assert.match(page, /"分析題目"/, "only trustworthy coarse stages are shown");
  assert.match(page, /"生成內容"/, "only trustworthy coarse stages are shown");
  assert.match(page, /setGenerationStage\("generating"\)/, "generation stage comes from a real stream event");
  assert.match(page, /setIsLoading\(false\)/, "all settled paths restore the controls and hide progress");
  assert.match(page, /await yieldForProgressPaint\(\)/, "the progress panel gets a paint yield before local inference");
  assert.match(page, /Cache Storage，無法安全保存/, "unsupported Cache Storage has an explicit non-download state");
});

test("A runtime routing exposes the selected layer and records a cloud handoff before navigation", () => {
  const page = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /目前 AI 執行層：/);
  assert.match(page, /runtimeLayerForStatus\(status\)/);
  const handoff = page.indexOf('setRuntimeLayer("cloud-handoff")');
  const navigate = page.indexOf("openGoogleAiAfterLocalFailure(prompt, window)");
  assert.ok(handoff >= 0 && navigate > handoff, "runtime must record the handoff before leaving this page");
});

// ====================================================================
// A1: UI Auto label 簡化 + 移除舊 consent/manual-route UI
// ====================================================================

test("A1: Auto label is simplified to 'Auto'", () => {
  const page = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /<option value="Auto">Auto<\/option>/, "Dropdown option must be simplified to 'Auto'");
  assert.doesNotMatch(page, /Auto \(Qwen3-0\.6B\)/, "Old 'Auto (Qwen3-0.6B)' label must not exist in page.tsx");
});

test("A1: Old consent checkbox and manual-route UI are completely removed (DOM = 0)", () => {
  const page = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
  // Consent checkbox & related state DOM = 0
  assert.doesNotMatch(page, /googleConsent/, "googleConsent state must be removed");
  assert.doesNotMatch(page, /我同意將原題送往 Google AI/, "Consent checkbox text must be removed");
  assert.doesNotMatch(page, /先同意後提供備援連結/, "Old consent fallback text must be removed");
  assert.doesNotMatch(page, /明確同意並點擊後/, "Old consent paragraph text must be removed");

  // Manual route buttons & state DOM = 0
  assert.doesNotMatch(page, /forceLocalTutor/, "forceLocalTutor handler must be removed");
  assert.doesNotMatch(page, /manualOverrideRef/, "manualOverrideRef must be removed");
  assert.doesNotMatch(page, /改以資訊科試解/, "Manual route button for IT must be removed");
  assert.doesNotMatch(page, /改以會計科試解/, "Manual route button for ACCOUNTING must be removed");
  assert.doesNotMatch(page, /改以本機模型試解/, "Manual route aria-label must be removed");
});

// ====================================================================
// A2: Preload / Warm-up (Mount, Cache Hit, Submit In-Flight Dedup)
// ====================================================================

test("A2: Page mount triggers preload / warm-up", () => {
  const page = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(
    page,
    /autoSubmitter\.current\.preload/,
    "page.tsx must invoke preload() on autoSubmitter during mount useEffect",
  );
});

test("A2: preloadLocalModel downloads model and marks local model ready", async () => {
  const statuses = [];
  let createCalled = 0;

  const env = {
    WebAssembly: { instantiate: () => ({}) },
    window: {
      LanguageModel: {
        __isPolyfill: true,
        async create(opts) {
          createCalled += 1;
          if (opts?.monitor) {
            const target = new EventTarget();
            opts.monitor(target);
            target.dispatchEvent(Object.assign(new Event("downloadprogress"), { loaded: 100, total: 100 }));
          }
          return { destroy() {} };
        },
      },
    },
  };

  await preloadLocalModel({
    env,
    onStatus: (st) => statuses.push(st),
    forceLocalModel: true,
  });

  assert.equal(createCalled, 1, "preloadLocalModel must create local model session once");
  assert.ok(statuses.includes("local model ready"), "Preload must reach 'local model ready'");
});

test("A2: cache hit 不重下載 (cached artifacts complete warm-up with 0 network fetch)", async () => {
  let networkFetches = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    networkFetches += 1;
    return new Response("dummy");
  };

  const fakeCache = {
    async match() {
      // Cache hit: all requests matched in cache
      return new Response(JSON.stringify({ version: 1, ready: true, assets: [] }), {
        headers: { "content-type": "application/json" },
      });
    },
    async put() {},
    async delete() { return true; },
  };
  const originalCaches = globalThis.caches;
  globalThis.caches = { open: async () => fakeCache };

  const env = {
    WebAssembly: { instantiate: () => ({}) },
    window: {
      LanguageModel: {
        __isPolyfill: true,
        async create() { return { destroy() {} }; },
      },
    },
  };

  try {
    const submitter = createAutoSubmitter(env, async () => {});
    const statuses = [];
    await submitter.preload((st) => statuses.push(st));

    assert.equal(submitter.isPreloaded, true, "Submitter should be marked preloaded");
    assert.ok(statuses.includes("local model ready"), "Status should reach 'local model ready'");
    assert.equal(networkFetches, 0, "Cache hit must not make network requests");
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.caches = originalCaches;
  }
});

test("A2: preload inflight + submit 不另起第二下載 (submit awaits in-flight preload)", async () => {
  let createCalls = 0;
  let resolveCreate;
  const createPromise = new Promise((resolve) => { resolveCreate = resolve; });

  const env = {
    WebAssembly: { instantiate: () => ({}) },
    window: {
      LanguageModel: {
        __isPolyfill: true,
        async create() {
          createCalls += 1;
          await createPromise;
          return {
            prompt: async () => '{"route":"information","confidence":0.95,"answer":"演算法是..."}',
            destroy() {},
          };
        },
      },
    },
  };

  const submitter = createAutoSubmitter(env, async () => {});

  // Start preload (in flight)
  const preloadTask = submitter.preload();
  assert.equal(submitter.isPreloading, true, "Submitter isPreloading must be true");

  // Call submit while preload is in-flight
  const submitTask = submitter.submit("什麼是演算法？", () => {}, undefined, { forceLocalModel: true });

  // Resolve the single create call
  resolveCreate();

  await Promise.all([preloadTask, submitTask]);

  // Model creation/download MUST NOT be started twice
  assert.equal(createCalls, 1, "submit must not launch a second download when preload is in flight");
  assert.equal(submitter.isPreloaded, true);
});

test("A1: Google AI fallback link on download stall is removed from DOM", () => {
  const page = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(page, /改用 Google AI 求解/, "Google AI solve link must be removed from DOM");
  assert.doesNotMatch(page, /完整解題（Google）/, "Google AI solve mode option must be removed from DOM");
  assert.doesNotMatch(page, /此題歸類為/, "Unclassified subject triage copy must be removed from DOM");
});

test("A2: resetPreload clears preloaded ready state for cache invalidation", () => {
  const submitter = createAutoSubmitter();
  assert.equal(submitter.isPreloaded, false);
  submitter.resetPreload();
  assert.equal(submitter.isPreloaded, false);
  assert.equal(submitter.isPreloading, false);
});

test("A2: Submit when already preloaded immediately proceeds without second download", async () => {
  let createCalls = 0;
  const env = {
    WebAssembly: { instantiate: () => ({}) },
    window: {
      LanguageModel: {
        __isPolyfill: true,
        async create() {
          createCalls += 1;
          return {
            promptStreaming: () => (async function* () { yield "已就緒回答"; })(),
            destroy() {},
          };
        },
      },
    },
  };

  const submitter = createAutoSubmitter(env, async () => {});
  // Preload first
  await submitter.preload();
  assert.equal(submitter.isPreloaded, true);
  assert.equal(createCalls, 1);

  // Submit after preloaded
  const answer = await submitter.submit("測試問題", () => {}, undefined, { forceLocalModel: true });
  assert.equal(answer, "已就緒回答");
  // Cached session used / no second create/download
  assert.equal(createCalls, 1, "submit after preload must not call create again");
});

test("A2: Cache clear and retry controls exist in page.tsx", () => {
  const page = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /檢查模型快取/, "Must retain check cache control");
  assert.match(page, /申請長期保存/, "Must retain persistent cache control");
  assert.match(page, /刪除本機模型/, "Must retain clear cache control");
  assert.match(page, /retryDownload/, "Must retain retry download control");
  assert.match(page, /autoSubmitter\.current\.cancel\(\)/, "Must retain cancel download control");
  // A2/B4: deleting the durable cache must also retire the in-memory ready
  // state, or the next answer reads from a session whose artifacts are gone.
  assert.match(page, /autoSubmitter\.current\.resetPreload\(\)/, "Cache deletion must reset the shared preload state");
});

// ====================================================================
// A3: JSON Contract (route, confidence, answer) + fail-closed
// ====================================================================

test("A3: buildInferencePrompt produces valid prompt with schema instructions", () => {
  const prompt = buildInferencePrompt("什麼是二元搜尋樹？");
  assert.match(prompt, /"route":"information"\|"accounting"\|"other"/);
  assert.match(prompt, /"confidence"/);
  assert.match(prompt, /"answer"/);
  assert.match(prompt, /什麼是二元搜尋樹？/);
});

test("A3: parseInferenceResponse parses valid 'information' response", () => {
  const raw = JSON.stringify({
    route: "information",
    confidence: 0.95,
    answer: "二元搜尋樹是一種二元樹資料結構。",
  });
  const res = parseInferenceResponse(raw);
  assert.equal(res.route, "information");
  assert.equal(res.confidence, 0.95);
  assert.equal(res.answer, "二元搜尋樹是一種二元樹資料結構。");
});

test("A3: parseInferenceResponse parses valid 'accounting' response", () => {
  const raw = JSON.stringify({
    route: "accounting",
    confidence: 0.88,
    answer: "借貸法則是會計記帳的基本原則，借方等於貸方。",
  });
  const res = parseInferenceResponse(raw);
  assert.equal(res.route, "accounting");
  assert.equal(res.confidence, 0.88);
  assert.equal(res.answer, "借貸法則是會計記帳的基本原則，借方等於貸方。");
});

test("A3: parseInferenceResponse parses valid 'other' response with empty answer", () => {
  const raw = JSON.stringify({
    route: "other",
    confidence: 0.99,
    answer: "",
  });
  const res = parseInferenceResponse(raw);
  assert.equal(res.route, "other");
  assert.equal(res.confidence, 0.99);
  assert.equal(res.answer, "");
});

test("A3 fail-closed: 'other' with non-empty answer fails closed", () => {
  const raw = JSON.stringify({
    route: "other",
    confidence: 0.9,
    answer: "這是一題歷史題目，答案是唐朝。",
  });
  assert.throws(
    () => parseInferenceResponse(raw),
    (err) => err instanceof InferenceSchemaError && /route 'other' must have empty answer/.test(err.message),
    "route 'other' with non-empty answer must fail closed",
  );
});

test("A3 fail-closed: malformed JSON fails closed", () => {
  assert.throws(
    () => parseInferenceResponse("{route: broken json..."),
    (err) => err instanceof InferenceSchemaError && /Malformed JSON/.test(err.message),
    "Malformed JSON must fail closed",
  );
  assert.throws(
    () => parseInferenceResponse(""),
    (err) => err instanceof InferenceSchemaError,
    "Empty string must fail closed",
  );
});

test("A3 fail-closed: invalid route fails closed", () => {
  const raw = JSON.stringify({ route: "math", confidence: 0.9, answer: "數學答案" });
  assert.throws(
    () => parseInferenceResponse(raw),
    (err) => err instanceof InferenceSchemaError && /Invalid route/.test(err.message),
    "Invalid route must fail closed",
  );
});

test("A3 fail-closed: non-numeric or out-of-range confidence fails closed", () => {
  assert.throws(
    () => parseInferenceResponse(JSON.stringify({ route: "information", confidence: "high", answer: "ans" })),
    (err) => err instanceof InferenceSchemaError && /Invalid confidence/.test(err.message),
    "String confidence must fail closed",
  );
  assert.throws(
    () => parseInferenceResponse(JSON.stringify({ route: "information", confidence: 1.5, answer: "ans" })),
    (err) => err instanceof InferenceSchemaError && /Invalid confidence/.test(err.message),
    "Confidence > 1 must fail closed",
  );
  assert.throws(
    () => parseInferenceResponse(JSON.stringify({ route: "information", confidence: -0.1, answer: "ans" })),
    (err) => err instanceof InferenceSchemaError && /Invalid confidence/.test(err.message),
    "Confidence < 0 must fail closed",
  );
  assert.throws(
    () => parseInferenceResponse(JSON.stringify({ route: "information", confidence: NaN, answer: "ans" })),
    (err) => err instanceof InferenceSchemaError && /Invalid confidence/.test(err.message),
    "NaN confidence must fail closed",
  );
});

test("A3 fail-closed: missing or non-string answer fails closed", () => {
  assert.throws(
    () => parseInferenceResponse(JSON.stringify({ route: "information", confidence: 0.8 })),
    (err) => err instanceof InferenceSchemaError && /Invalid answer/.test(err.message),
    "Missing answer must fail closed",
  );
  assert.throws(
    () => parseInferenceResponse(JSON.stringify({ route: "information", confidence: 0.8, answer: 12345 })),
    (err) => err instanceof InferenceSchemaError && /Invalid answer/.test(err.message),
    "Numeric answer must fail closed",
  );
});

test("A3 resilience: markdown-fenced JSON and <think> tags parse cleanly", () => {
  const raw = `<think>
This is an algorithm question, so route is information.
</think>
\`\`\`json
{
  "route": "information",
  "confidence": 0.92,
  "answer": "快速排序法（Quick Sort）是一種分治演算法。"
}
\`\`\``;
  const res = parseInferenceResponse(raw);
  assert.equal(res.route, "information");
  assert.equal(res.confidence, 0.92);
  assert.match(res.answer, /快速排序法/);
});

test("A3: autoSubmitter.infer executes prompt, waits for preload, and returns InferenceResult", async () => {
  const env = {
    WebAssembly: { instantiate: () => ({}) },
    window: {
      LanguageModel: {
        __isPolyfill: true,
        async create() {
          return {
            prompt: async () => JSON.stringify({
              route: "information",
              confidence: 0.95,
              answer: "Python 是一種直譯式高階程式語言。",
            }),
            destroy() {},
          };
        },
      },
    },
  };

  const submitter = createAutoSubmitter(env, async () => {});
  const res = await submitter.infer("Python 是什麼？", () => {}, undefined, { forceLocalModel: true });

  assert.equal(res.route, "information");
  assert.equal(res.confidence, 0.95);
  assert.equal(res.answer, "Python 是一種直譯式高階程式語言。");
});

// ====================================================================
// A4: Local-answer display gate — only a high-confidence (>= 0.75),
// non-empty, D-06-valid information/accounting answer may be displayed.
// Everything else is withheld fail-closed. A4 never navigates and never
// paints raw contract JSON (A5 handoff/navigation is out of scope here).
// ====================================================================

function alwaysValidValidate() {
  return { status: "VALID" };
}

function validateSpy() {
  const calls = [];
  return {
    calls,
    validate: (question, answer) => {
      calls.push({ question, answer });
      return { status: "VALID" };
    },
  };
}

function fakeGenerate(chunks) {
  return async (onChunk) => {
    for (const chunk of chunks) onChunk(chunk);
    return chunks.join("");
  };
}

test("A4: information with confidence >= 0.75 and a non-empty answer is displayed", () => {
  assert.equal(LOCAL_ANSWER_MIN_CONFIDENCE, 0.75);
  const q = "什麼是二元搜尋樹？";
  const shown = { route: "information", confidence: 0.95, answer: "二元搜尋樹是一種排序的二元樹結構。" };
  assert.equal(localAnswerWithholdReason(shown, q, alwaysValidValidate), null);
  assert.equal(shouldDisplayLocalAnswer(shown, q, alwaysValidValidate), true);
  assert.equal(
    shouldDisplayLocalAnswer({ ...shown, confidence: 0.75 }, q, alwaysValidValidate),
    true,
    "the 0.75 floor is inclusive (>=)",
  );
  assert.equal(
    localAnswerWithholdReason({ ...shown, confidence: 0.7499 }, q, alwaysValidValidate),
    "low-confidence",
    "just below the floor must withhold",
  );
});

test("A4: accounting with confidence >= 0.75 and a non-empty answer is displayed", () => {
  assert.equal(
    localAnswerWithholdReason(
      { route: "accounting", confidence: 0.8, answer: "借貸法則要求借方總額等於貸方總額。" },
      "什麼是借貸法則？",
      alwaysValidValidate,
    ),
    null,
  );
  assert.equal(
    shouldDisplayLocalAnswer(
      { route: "accounting", confidence: 0.99, answer: "分錄同時記錄借方與貸方。" },
      "會計分錄怎麼寫？",
      alwaysValidValidate,
    ),
    true,
  );
});

test("A4: route other is withheld even at confidence 1", () => {
  const d = { route: "other", confidence: 1, answer: "" };
  assert.equal(localAnswerWithholdReason(d, "今天天氣怎麼樣？", alwaysValidValidate), "route-other");
  assert.equal(shouldDisplayLocalAnswer(d, "今天天氣怎麼樣？", alwaysValidValidate), false);
});

test("A4: low-confidence answers are withheld", () => {
  assert.equal(
    localAnswerWithholdReason({ route: "information", confidence: 0.5, answer: "答案內容。" }, "q", alwaysValidValidate),
    "low-confidence",
  );
  assert.equal(
    localAnswerWithholdReason({ route: "accounting", confidence: 0, answer: "答案內容。" }, "q", alwaysValidValidate),
    "low-confidence",
  );
});

test("A4: empty or whitespace-only answers are withheld; a missing decision withholds as no-decision", () => {
  assert.equal(
    localAnswerWithholdReason({ route: "information", confidence: 0.99, answer: "" }, "q", alwaysValidValidate),
    "empty-answer",
  );
  assert.equal(
    localAnswerWithholdReason({ route: "accounting", confidence: 0.99, answer: "  \n\t " }, "q", alwaysValidValidate),
    "empty-answer",
  );
  assert.equal(localAnswerWithholdReason(null, "q", alwaysValidValidate), "no-decision");
  assert.equal(localAnswerWithholdReason(undefined, "q", alwaysValidValidate), "no-decision");
});

test("A4: D-06 validator rejection withholds, and the default wiring really uses validateLocalAnswer", () => {
  const d = { route: "information", confidence: 0.9, answer: "任何回答。" };
  assert.equal(localAnswerWithholdReason(d, "q", () => ({ status: "INVALID" })), "validator-invalid");
  assert.equal(
    localAnswerWithholdReason(
      { route: "information", confidence: 0.9, answer: "請用繁體中文清楚回答，約 150 字以內。" },
      "q",
    ),
    "validator-invalid",
    "instruction-echo copy must be caught by the wired-in default validateLocalAnswer",
  );
});

test("A4 run: the shown path writes the gated answer exactly once and streams counts only", async () => {
  const raw = JSON.stringify({ route: "information", confidence: 0.95, answer: "快速排序法是一種分治演算法。" });
  const streamArgs = [];
  const answerArgs = [];
  const spy = validateSpy();
  const result = await runAutoRouteInference(
    "什麼是快速排序法？",
    fakeGenerate([raw.slice(0, 20), raw.slice(20)]),
    { onStream: (value) => streamArgs.push(value), onAnswer: (text) => answerArgs.push(text) },
    spy.validate,
  );
  assert.equal(result.outcome, "shown");
  assert.equal(result.withhold, null);
  assert.equal(result.display, "快速排序法是一種分治演算法。");
  assert.deepEqual(answerArgs, ["快速排序法是一種分治演算法。"], "onAnswer must fire exactly once, post-gate");
  assert.equal(streamArgs.length, 2);
  assert.ok(
    streamArgs.every((value) => typeof value === "number"),
    "stream hook must receive character counts only — raw contract text cannot pass through here",
  );
  assert.equal(streamArgs[streamArgs.length - 1], raw.length);
});

test("A4 run: validateLocalAnswer receives only the extracted answer, never the raw JSON", async () => {
  const raw = JSON.stringify({ route: "accounting", confidence: 0.9, answer: "分錄必須同時記錄借方與貸方金額。" });
  const spy = validateSpy();
  const result = await runAutoRouteInference("借貸怎麼記錄？", fakeGenerate([raw]), {}, spy.validate);
  assert.equal(result.outcome, "shown");
  assert.equal(spy.calls.length, 1);
  assert.equal(spy.calls[0].question, "借貸怎麼記錄？");
  assert.equal(spy.calls[0].answer, "分錄必須同時記錄借方與貸方金額。");
  assert.doesNotMatch(spy.calls[0].answer, /"route"|"confidence"|^\{|}\s*$/);
});

test("A4 run: a validator that rejects JSON-shaped text still passes the extracted answer", async () => {
  const raw = JSON.stringify({ route: "information", confidence: 0.85, answer: "堆積樹的建置成本是線性的。" });
  const result = await runAutoRouteInference(
    "堆積樹怎麼建置？",
    fakeGenerate([raw]),
    {},
    (question, answer) => ({ status: answer.includes("{") || answer.includes('"route"') ? "INVALID" : "VALID" }),
  );
  assert.equal(result.outcome, "shown", "if the gate fed raw JSON to the validator this run would be withheld");
});

test("A4 run: the shown path works end-to-end against the real D-06 validator", async () => {
  const raw = JSON.stringify({
    route: "information",
    confidence: 0.9,
    answer: "快速排序法是一種分治演算法，平均複雜度低於氣泡排序。",
  });
  const result = await runAutoRouteInference("什麼是快速排序法？", fakeGenerate([raw]));
  assert.equal(result.outcome, "shown");
  assert.match(result.display, /快速排序法/);
});

test("A4 run: 「一起來森巴舞」 is routed as other and displays no local answer", async () => {
  const raw = JSON.stringify({ route: "other", confidence: 0.95, answer: "" });
  const answerArgs = [];
  const result = await runAutoRouteInference(
    "一起來森巴舞",
    fakeGenerate([raw]),
    { onAnswer: (text) => answerArgs.push(text) },
  );
  assert.equal(result.outcome, "withheld");
  assert.equal(result.withhold, "route-other");
  assert.equal(result.decision.route, "other");
  assert.equal(result.decision.answer, "");
  assert.equal(result.display, "");
  assert.equal(answerArgs.length, 0, "a withheld non-learning question may never paint a local answer");
});

test("A4 run: a model that answers 「一起來森巴舞」 on route other fails closed at the schema", async () => {
  const raw = JSON.stringify({ route: "other", confidence: 0.9, answer: "森巴舞是巴西的傳統舞蹈。" });
  const answerArgs = [];
  const result = await runAutoRouteInference(
    "一起來森巴舞",
    fakeGenerate([raw]),
    { onAnswer: (text) => answerArgs.push(text) },
  );
  assert.equal(result.outcome, "schema-failed");
  assert.equal(result.withhold, "schema-error");
  assert.equal(result.decision, null);
  assert.equal(result.display, "");
  assert.equal(answerArgs.length, 0);
});

test("A4 run: malformed schema yields schema-failed with no display and no thrown parse error", async () => {
  for (const raw of ["", "這不是 JSON", '{"route":"information","confidence":0.9,']) {
    const answerArgs = [];
    const result = await runAutoRouteInference(
      "q",
      fakeGenerate([raw]),
      { onAnswer: (text) => answerArgs.push(text) },
    );
    assert.equal(result.outcome, "schema-failed");
    assert.equal(result.withhold, "schema-error");
    assert.equal(result.decision, null);
    assert.equal(result.display, "");
    assert.equal(answerArgs.length, 0);
  }
});

test("A4 run: low-confidence and empty-answer paths withhold without calling onAnswer", async () => {
  const cases = [
    [JSON.stringify({ route: "information", confidence: 0.3, answer: "有內容但信心不足。" }), "low-confidence"],
    [JSON.stringify({ route: "accounting", confidence: 0.9, answer: "" }), "empty-answer"],
    [JSON.stringify({ route: "information", confidence: 0.99, answer: "   " }), "empty-answer"],
  ];
  for (const [raw, expected] of cases) {
    const answerArgs = [];
    const result = await runAutoRouteInference(
      "試題內容",
      fakeGenerate([raw]),
      { onAnswer: (text) => answerArgs.push(text) },
      alwaysValidValidate,
    );
    assert.equal(result.outcome, "withheld");
    assert.equal(result.withhold, expected);
    assert.equal(result.display, "");
    assert.equal(answerArgs.length, 0);
  }
});

test("A4 run: generation rejections propagate unchanged and never display", async () => {
  const answerArgs = [];
  await assert.rejects(
    () =>
      runAutoRouteInference(
        "q",
        async () => {
          throw new Error("已取消 AI 回答。");
        },
        { onAnswer: (text) => answerArgs.push(text) },
      ),
    /已取消 AI 回答/,
  );
  assert.equal(answerArgs.length, 0);
});

test("A4: withheld copy covers every path and leaks neither contract JSON nor navigation", () => {
  const expectedKeys = [
    "empty-answer",
    "low-confidence",
    "no-decision",
    "route-other",
    "schema-error",
    "validator-invalid",
  ];
  assert.deepEqual(Object.keys(AUTO_ROUTE_WITHHELD_COPY).sort(), expectedKeys);
  for (const [key, copy] of Object.entries(AUTO_ROUTE_WITHHELD_COPY)) {
    assert.ok(copy.trim().length > 0, `${key} copy must be non-empty learner-facing text`);
    assert.doesNotMatch(copy, /"route"|"confidence"|"answer"|<\/?think>/, `${key} must not leak the contract`);
    assert.doesNotMatch(copy, /https?:\/\/|google/i, `${key} must not offer navigation — A5 owns handoff`);
  }
});

test("A4 UI wiring: local trial stays on the page and paints only a gate-passed answer", () => {
  const page = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /await runAutoRouteInference\(/, "submit must route generation through the A4 gate");
  assert.match(
    page,
    /onStream: \(\) => \{ lastProgressAt\.current = Date\.now\(\); setGenerationStage\("generating"\); \}/,
    "the stream hook may update only coarse progress state, never answer text",
  );
  assert.match(
    page,
    /onAnswer: \(text\) => \{ if \(requestId\.current === id\) setAnswer\(text\); \}/,
    "only the gate-passed answer text may reach setAnswer",
  );
  assert.match(page, /if \(result\.outcome === "shown"\)/, "page must branch on the gate outcome");
  assert.doesNotMatch(page, /preopenGoogleAiTab\(window\)|handoffToGoogleAi\(/, "local trial must never open or navigate a tab");
  assert.match(page, /cause\.message\.includes\("本機 AI 模型無法完成回答"\) && fallbackGuard\.navigateOnce\(\)/,
    "only a failed local model answer triggers the automatic handoff");
  assert.match(page, /openGoogleAiAfterLocalFailure\(prompt, window\)/,
    "the automatic handoff carries the original question");
  assert.match(page, /setError\(AUTO_ROUTE_WITHHELD_COPY\[result\.withhold/, "withheld answers must show a local message");
  assert.match(page, /target="_blank" rel="noopener noreferrer">跳頁 Google AI 解答/, "Google navigation remains a separate explicit action");
  assert.match(page, /buildPracticeQuestionPrompt\(prompt, mode\)/, "local AI receives the concise exercise prompt");
  assert.match(page, /systemPrompt: PRACTICE_SYSTEM_PROMPT/, "practice uses the worker system turn");
  assert.match(page, /assistantPrefix: buildPracticeAssistantPrefix\(mode\)/, "practice uses a mode-specific assistant prefix");
  assert.match(page, /formatPracticeContinuation\(/, "only the deterministic envelope reaches the unchanged parser");
  assert.match(page, /validatePracticeQuestion,/, "exercise gate must reject revealed answers");
  assert.match(page, /buildGoogleAiModeUrl\(`請用繁體中文詳解以下練習題/, "the explanation link must pass the generated exercise to Google AI");
  assert.doesNotMatch(page, /\bchunk\b[^\n]*setAnswer/, "raw model chunks must never be wired to answer state");
  const strayAnswerWrites = page.match(/setAnswer\((?!\s*(?:""|faq\[1\]|text)\s*\))/g) || [];
  assert.deepEqual(strayAnswerWrites, [], "setAnswer may only be called with '', FAQ copy, or the gated text");
});

test("AI 助手出題: every mode uses a concise topic turn and mode seed", () => {
  const modes = ["自動判斷", "可選提示", "教材解釋", "陪練", "錯題引導"];
  const seeds = ["如何", "哪個", "為何", "如何", "哪裡"];
  for (const mode of modes) {
    const topic = "資料結構";
    const prompt = buildPracticeQuestionPrompt(topic, mode);
    assert.equal(prompt, `主題：${topic}\n模式：${mode}`);
    assert.equal(buildPracticeAssistantPrefix(mode), `{"route":"information","confidence":0.99,"answer":"${seeds[modes.indexOf(mode)]}`);
  }
  assert.match(PRACTICE_SYSTEM_PROMPT, /繁體中文/);
  assert.match(PRACTICE_SYSTEM_PROMPT, /不得提供答案/);
});

test("AI 助手出題: continuation formatting creates only the strict three-key envelope", () => {
  const raw = formatPracticeContinuation("教材解釋", "資料結構中的堆疊適合用在哪些情境？\"},\n額外說明");
  assert.equal(raw, '{"route":"information","confidence":0.99,"answer":"為何資料結構中的堆疊適合用在哪些情境？"}');
  assert.deepEqual(Object.keys(JSON.parse(raw)), ["route", "confidence", "answer"]);
  assert.equal(formatPracticeContinuation("錯題引導", "資料結構，\"extra\":true"), '{"route":"information","confidence":0.99,"answer":"哪裡資料結構？"}');
  assert.equal(formatPracticeContinuation("陪練", ""), '{"route":"information","confidence":0.99,"answer":""}', "no continuation must not become a fixed cross-topic answer");
  assert.equal(validatePracticeQuestion("堆疊", JSON.parse(raw).answer).status, "VALID");
});

test("AI 助手出題: existing no-answer validator still withholds disclosed solutions", () => {
  assert.equal(validatePracticeQuestion("二元搜尋樹", "請說明二元搜尋樹的搜尋時間複雜度？").status, "VALID");
  assert.equal(validatePracticeQuestion("二元搜尋樹", "二元搜尋樹搜尋複雜度為何？答案：O(log n)").status, "INVALID");
});

// ====================================================================
// A5: synchronous blank-tab ownership and a single popup-block fallback
// ====================================================================

function makeHandoffBrowser({ popupBlocked = false } = {}) {
  const calls = { open: [], tabReplace: [], currentReplace: [], currentAssign: [], close: 0, opener: [] };
  const tab = {
    closed: false,
    opener: { parent: true },
    close() { calls.close += 1; this.closed = true; },
    location: { replace(url) { calls.tabReplace.push(url); } },
  };
  const browser = {
    open(...args) { calls.open.push(args); return popupBlocked ? null : tab; },
    location: { replace(url) { calls.currentReplace.push(url); }, assign(url) { calls.currentAssign.push(url); } },
  };
  return { browser, calls, tab };
}

test("local answer failure opens Google AI only after failure, using the original question", () => {
  const { browser, calls, tab } = makeHandoffBrowser();
  assert.deepEqual(calls.open, [], "no blank tab is opened during local inference");
  const outcome = openGoogleAiAfterLocalFailure("二元搜尋樹 a & b", browser);
  assert.equal(outcome, "new-tab");
  assert.deepEqual(calls.open, [["about:blank", "_blank"]]);
  assert.equal(tab.opener, null);
  assert.equal(calls.tabReplace[0], "https://www.google.com/search?q=%E4%BA%8C%E5%85%83%E6%90%9C%E5%B0%8B%E6%A8%B9%20a%20%26%20b&udm=50&aep=11&hl=zh-TW");
  assert.deepEqual(calls.currentAssign, []);
});

test("popup-blocked local answer failure navigates the current tab once", () => {
  const { browser, calls } = makeHandoffBrowser({ popupBlocked: true });
  assert.equal(openGoogleAiAfterLocalFailure("會計分錄", browser), "current-tab");
  assert.equal(calls.open.length, 1);
  assert.deepEqual(calls.tabReplace, []);
  assert.deepEqual(calls.currentAssign, ["https://www.google.com/search?q=%E6%9C%83%E8%A8%88%E5%88%86%E9%8C%84&udm=50&aep=11&hl=zh-TW"]);
});

test("A5: submit gesture pre-opens one blank tab; local PASS closes it without Google navigation", () => {
  const { browser, calls, tab } = makeHandoffBrowser();
  const preopened = preopenGoogleAiTab(browser);
  assert.equal(preopened, tab);
  assert.deepEqual(calls.open, [["about:blank", "_blank"]]);
  closePreopenedGoogleAiTab(preopened);
  assert.equal(calls.close, 1);
  assert.deepEqual(calls.tabReplace, []);
  assert.deepEqual(calls.currentReplace, []);
});

test("B5: synchronous pre-open immediately isolates opener while retaining the parent-held tab proxy", () => {
  const { browser, calls, tab } = makeHandoffBrowser();
  Object.defineProperty(tab, "opener", {
    configurable: true,
    get() { return calls.opener.at(-1) ?? { inherited: true }; },
    set(value) { calls.opener.push(value); },
  });

  const preopened = preopenGoogleAiTab(browser);
  assert.equal(preopened, tab, "the parent must retain the opened WindowProxy");
  assert.deepEqual(calls.open, [["about:blank", "_blank"]]);
  assert.deepEqual(calls.opener, [null], "opener must be cleared immediately after about:blank opens");

  const destination = handoffToGoogleAi("原始問題不得改寫", preopened, browser);
  assert.equal(destination, "preopened-tab");
  assert.equal(calls.tabReplace.length, 1, "the isolated proxy must still navigate the pre-opened tab");
  closePreopenedGoogleAiTab(preopened);
  assert.equal(calls.close, 1, "the isolated proxy must still close after a local pass");
});

test("A5: a non-local result replaces the pre-opened blank tab with Google AI Mode carrying the original question", () => {
  const { browser, calls } = makeHandoffBrowser();
  const question = "借貸怎麼記錄？ a & b";
  const destination = handoffToGoogleAi(question, preopenGoogleAiTab(browser), browser);
  assert.equal(destination, "preopened-tab");
  assert.deepEqual(calls.currentReplace, []);
  assert.equal(calls.tabReplace.length, 1);
  assert.equal(calls.tabReplace[0], "https://www.google.com/search?q=%E5%80%9F%E8%B2%B8%E6%80%8E%E9%BA%BC%E8%A8%98%E9%8C%84%EF%BC%9F%20a%20%26%20b&udm=50&aep=11&hl=zh-TW");
});

test("A5: popup-blocked handoff performs one current-tab location.replace fallback and no retry open", () => {
  const { browser, calls } = makeHandoffBrowser({ popupBlocked: true });
  const destination = handoffToGoogleAi("什麼是光合作用？", preopenGoogleAiTab(browser), browser);
  assert.equal(destination, "popup-blocked-fallback");
  assert.equal(calls.open.length, 1, "popup-block handling must not retry window.open");
  assert.equal(calls.tabReplace.length, 0);
  assert.deepEqual(calls.currentReplace, ["https://www.google.com/search?q=%E4%BB%80%E9%BA%BC%E6%98%AF%E5%85%89%E5%90%88%E4%BD%9C%E7%94%A8%EF%BC%9F&udm=50&aep=11&hl=zh-TW"]);
});

test("A6: 13 gate cases preserve a local PASS and hand every other/low/empty/schema failure to the same isolated tab", async () => {
  const question = "原始問題：a & b，不可改寫";
  const cases = [
    ["information at inclusive floor", JSON.stringify({ route: "information", confidence: 0.75, answer: "資訊答案。" }), "shown"],
    ["accounting", JSON.stringify({ route: "accounting", confidence: 0.95, answer: "會計答案。" }), "shown"],
    ["other", JSON.stringify({ route: "other", confidence: 1, answer: "" }), "withheld"],
    ["information below floor", JSON.stringify({ route: "information", confidence: 0.7499, answer: "資訊答案。" }), "withheld"],
    ["accounting below floor", JSON.stringify({ route: "accounting", confidence: 0, answer: "會計答案。" }), "withheld"],
    ["information empty", JSON.stringify({ route: "information", confidence: 0.9, answer: "" }), "withheld"],
    ["accounting whitespace", JSON.stringify({ route: "accounting", confidence: 0.9, answer: " \n\t" }), "withheld"],
    ["empty response", "", "schema-failed"],
    ["non-JSON response", "不是 JSON", "schema-failed"],
    ["unbalanced JSON", '{"route":"information","confidence":0.9,', "schema-failed"],
    ["legacy route", JSON.stringify({ route: "IT", confidence: 0.9, answer: "答案。" }), "schema-failed"],
    ["other with answer", JSON.stringify({ route: "other", confidence: 0.9, answer: "不得顯示。" }), "schema-failed"],
    ["validator rejection", JSON.stringify({ route: "information", confidence: 0.9, answer: "不可信答案。" }), "withheld", () => ({ status: "INVALID" })],
  ];
  assert.equal(cases.length, 13);

  for (const [label, raw, expectedOutcome, validate = alwaysValidValidate] of cases) {
    const { browser, calls, tab } = makeHandoffBrowser();
    const preopened = preopenGoogleAiTab(browser);
    const result = await runAutoRouteInference(question, fakeGenerate([raw]), {}, validate);
    assert.equal(result.outcome, expectedOutcome, label);
    if (result.outcome === "shown") {
      closePreopenedGoogleAiTab(preopened);
      assert.equal(calls.close, 1, `${label}: local PASS must close the isolated blank tab`);
      assert.deepEqual(calls.tabReplace, [], `${label}: local PASS must not navigate`);
    } else {
      assert.equal(handoffToGoogleAi(question, preopened, browser), "preopened-tab", label);
      assert.equal(calls.tabReplace.length, 1, `${label}: non-local result must use the same pre-opened tab`);
      assert.deepEqual(calls.currentReplace, [], `${label}: an available pre-opened tab must avoid current-tab fallback`);
      assert.match(calls.tabReplace[0], /q=%E5%8E%9F%E5%A7%8B%E5%95%8F%E9%A1%8C%EF%BC%9Aa%20%26%20b/,
        `${label}: handoff query must be the exact original question`);
    }
    assert.equal(tab.opener, null, `${label}: opener remains isolated through the outcome`);
  }
});

// ====================================================================
// B1-B4: shared preload/submit lifecycle hardening (A2/B2-B4 evidence)
//
// B1 — every deferred an abandoned test leaves behind must still settle:
// these tests park fake creates on release handles and drain them in a
// finally, so an assertion failure can never dangle a promise past the
// test (the exact "still pending but the event loop has already resolved"
// exit that failed the 13:07 writer).
// B2 — one warm-up in flight, one ready state, joined by preload AND submit.
// B3 — NotAllowedError is a moment in time (transient gesture), never a
// device verdict.
// B4 — a dead warm session is disposed and rebuilt exactly once; cancel is
// not staleness; reset destroys the ready session exactly once and a late
// create can never republish into wiped state.
// ====================================================================

function notAllowedError() {
  return Object.assign(
    new Error("The request is not allowed by the user agent in the current context."),
    { name: "NotAllowedError" },
  );
}

function polyfillEnv(create) {
  return {
    WebAssembly: { instantiate: () => ({}) },
    window: { LanguageModel: { __isPolyfill: true, create } },
  };
}

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

test("A2/B1+B4: resetPreload settles an in-flight warm-up immediately, and a late create is destroyed instead of published", async () => {
  let createCalls = 0;
  let destroyCalls = 0;
  const pendingCreates = [];
  const releaseAll = () => { while (pendingCreates.length > 0) pendingCreates.shift()(); };
  const env = polyfillEnv(async () => {
    createCalls += 1;
    await new Promise((release) => { pendingCreates.push(release); });
    return { destroy() { destroyCalls += 1; } };
  });
  // B1 evidence: the cache manifest is the one side effect an abandoned warm-up
  // must never reach. Nothing else in this path opens Cache Storage, so a single
  // manifest write here means a wiped warm-up told the next run the model is ready.
  const originalCaches = globalThis.caches;
  let manifestWrites = 0;
  globalThis.caches = {
    async open() {
      return {
        async match() { return undefined; },
        async put() { manifestWrites += 1; },
        async delete() { return true; },
      };
    },
  };
  try {
    const submitter = createAutoSubmitter(env, async () => {});
    const pending = submitter.preload(() => {}, { localModelId: "test-model", forceLocalModel: true });
    await tick();
    assert.equal(createCalls, 1);
    assert.equal(submitter.isPreloading, true);

    submitter.resetPreload();
    // The B1 guarantee: the waiter wakes on the reset, not on the download.
    // Without the synchronous resolve this await would hang forever.
    assert.equal(await pending, "cancelled", "a withdrawn warm-up must release its awaiters immediately");
    assert.equal(submitter.isPreloading, false);
    assert.equal(submitter.isPreloaded, false);
    assert.equal(destroyCalls, 0, "nothing was published yet, so there is nothing to destroy here");

    // The browser finishes the abandoned download anyway.
    releaseAll();
    await tick();
    assert.equal(destroyCalls, 1, "a session that arrives after its state was wiped must be destroyed");
    assert.equal(submitter.isPreloaded, false, "the late warm-up must never republish into fresh state");
    assert.equal(manifestWrites, 0, "an abandoned warm-up must not mark the local model cache ready");
  } finally {
    // Drain before restoring: the parked fake create must settle even when this
    // body threw, or the process outlives its own resolved event loop.
    releaseAll();
    await tick();
    globalThis.caches = originalCaches;
  }
});

test("A2/B3: a gesture-refused warm-up is transient — outcome 'gesture', never a device verdict, and the next warm-up recovers", async () => {
  let createCalls = 0;
  let allowDownload = false;
  const statuses = [];
  const env = polyfillEnv(async () => {
    createCalls += 1;
    if (!allowDownload) throw notAllowedError();
    return {
      promptStreaming: () => (async function* () { yield "ok"; })(),
      destroy() {},
    };
  });
  const submitter = createAutoSubmitter(env, async () => {});

  assert.equal(await submitter.preload((st) => statuses.push(st)), "gesture");
  assert.equal(submitter.isPreloaded, false);
  assert.equal(submitter.isPreloading, false, "the refusal must settle the warm-up slot, not strand it");
  assert.ok(statuses.includes("local model requires user activation"));
  assert.equal(statuses.includes("unsupported after fallback"), false, "a missing gesture is a moment in time, not a capability verdict");
  assert.equal(createCalls, 1, "a refusal must stop burning dtype candidates it cannot fix");

  // The learner clicks the CTA: the same shared warm-up path now succeeds.
  allowDownload = true;
  assert.equal(await submitter.preload(() => {}), "warmed");
  assert.equal(submitter.isPreloaded, true);
  assert.equal(createCalls, 2);
  submitter.resetPreload();
  assert.equal(submitter.isPreloaded, false);
});

test("A2/B3: an activation refusal during engine bootstrap is also transient, not 'unsupported'", async () => {
  const statuses = [];
  const submitter = createAutoSubmitter(polyfillEnv(async () => ({ destroy() {} })), async () => {
    throw notAllowedError();
  });
  assert.equal(await submitter.preload((st) => statuses.push(st)), "gesture");
  assert.ok(statuses.includes("local model requires user activation"));
  assert.equal(statuses.includes("unsupported after fallback"), false);
  assert.equal(submitter.isPreloading, false, "the rejection must settle the warm-up slot");
  assert.equal(submitter.isPreloaded, false);
});

test("A2/B4: a warm session that fails to answer is disposed and rebuilt exactly once, then serves the next answer", async () => {
  let createCalls = 0;
  let destroyCalls = 0;
  const env = polyfillEnv(async () => {
    createCalls += 1;
    // The first published session is the one the browser has already dropped;
    // it dies the moment anyone prompts it.
    const stale = createCalls === 1;
    return {
      promptStreaming: () => {
        if (stale) throw new Error("Session is not usable anymore");
        return (async function* () { yield "本機回答"; })();
      },
      destroy() { destroyCalls += 1; },
    };
  });
  const submitter = createAutoSubmitter(env, async () => {});

  assert.equal(await submitter.preload(() => {}), "warmed");
  assert.equal(createCalls, 1);

  const answer = await submitter.submit("測試問題", () => {}, undefined, { forceLocalModel: true });
  assert.equal(answer, "本機回答", "the single-shot rebuild must actually deliver the answer");
  assert.equal(createCalls, 2, "a dead warm session earns exactly one rebuild");
  assert.equal(destroyCalls, 1, "the stale session is destroyed exactly once, never by two owners");
  assert.equal(submitter.isPreloaded, true, "the rebuilt session becomes the new ready state");

  const second = await submitter.submit("第二次提問", () => {}, undefined, { forceLocalModel: true });
  assert.equal(second, "本機回答");
  assert.equal(createCalls, 2, "the rebuilt session is reused, not re-created");
  submitter.resetPreload();
  assert.equal(destroyCalls, 2, "reset retires the published session exactly once");
});

test("A2/B4: a rebuild that also fails is final — exactly two attempts, no third, fail closed", async () => {
  let createCalls = 0;
  let destroyCalls = 0;
  const env = polyfillEnv(async () => {
    createCalls += 1;
    return {
      promptStreaming: () => { throw new Error("dead accelerator"); },
      destroy() { destroyCalls += 1; },
    };
  });
  const submitter = createAutoSubmitter(env, async () => {});

  assert.equal(await submitter.preload(() => {}), "warmed");
  assert.equal(createCalls, 1);
  await assert.rejects(
    submitter.submit("測試問題", () => {}, undefined, { forceLocalModel: true }),
    /本機 AI 模型無法完成回答/,
  );
  assert.equal(createCalls, 2, "stale-then-dead: warm + rebuild, never a third attempt to spin the learner");
  assert.equal(submitter.isPreloaded, false, "a failed rebuild publishes nothing");
  assert.equal(destroyCalls, 2, "both dead sessions leave no reference behind");
});

test("A2/B4: cancelling an answer on a warm session is not stale evidence — no rebuild, readiness survives", async () => {
  let createCalls = 0;
  let destroyCalls = 0;
  const env = polyfillEnv(async () => {
    createCalls += 1;
    return {
      promptStreaming: (_prompt, opts) => (async function* () {
        yield "半";
        await new Promise((_resolve, reject) => {
          opts?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      })(),
      destroy() { destroyCalls += 1; },
    };
  });
  const submitter = createAutoSubmitter(env, async () => {});
  try {
    assert.equal(await submitter.preload(() => {}), "warmed");
    const pending = submitter.submit("測試問題", () => {}, undefined, { forceLocalModel: true });
    pending.catch(() => {});
    await tick();
    submitter.cancel();
    await assert.rejects(pending, /已取消/);
    assert.equal(createCalls, 1, "a cancel must never be mistaken for a dead session");
    assert.equal(destroyCalls, 0, "cancel must not destroy the borrowed session out from under the ready state");
    assert.equal(submitter.isPreloaded, true, "the ready session survives its own cancellation");
  } finally {
    submitter.cancel();
    submitter.resetPreload();
    await tick();
  }
});

test("B: Frontend UX provides accessible copy and favorite controls with mobile RWD", () => {
  const page = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

  assert.match(page, /v2-answer-action-btn/, "page provides answer action buttons");
  assert.match(page, /aria-label=\{copied \? "已複製題目至剪貼簿" : "複製題目文字"\}/, "copy button has accessible aria-label");
  assert.match(page, /aria-pressed=\{isFavorite\}/, "favorite button indicates state with aria-pressed");
  assert.match(page, /aria-label=\{isFavorite \? "已收藏此題目" : "收藏此題目"\}/, "favorite button has accessible aria-label");
  assert.match(css, /\.v2-answer-header/, "CSS styles answer header");
  assert.match(css, /\.v2-answer-action-btn/, "CSS styles answer action buttons");
  assert.match(css, /@media\(max-width:480px\)/, "CSS supports mobile viewports (360px, 390px, 412px)");
});
