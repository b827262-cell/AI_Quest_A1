import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { askWithChromeBuiltInAi, ChromeAiError, createAutoSubmitter } from "../app/chrome-built-in-ai.ts";

function stream(chunks) {
  return (async function* () { for (const chunk of chunks) yield chunk; })();
}

function availableEnvironment({ chunks = ["本", "機回答"], translator } = {}) {
  let createCalls = 0;
  return {
    env: {
      LanguageModel: {
        async availability() { return "available"; },
        async create() { createCalls += 1; return { promptStreaming: () => stream(chunks) }; },
      },
      Translator: translator,
    },
    createCalls: () => createCalls,
  };
}

test("missing LanguageModel fails closed without a network call", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error("network must not be used"); };
  try {
    await assert.rejects(() => askWithChromeBuiltInAi("問題", () => {}, { env: {} }), /不支援 Chrome 內建 AI/);
    assert.equal(calls, 0);
  } finally { globalThis.fetch = originalFetch; }
});

for (const [status, expected] of [["downloadable", /需要先下載/], ["downloading", /正在下載中/], ["unavailable", /不支援 Chrome/]]) {
  test(`LanguageModel availability=${status} fails closed`, async () => {
    let creates = 0;
    await assert.rejects(
      () => askWithChromeBuiltInAi("question", () => {}, { env: { LanguageModel: { async availability() { return status; }, async create() { creates += 1; return {}; } } } }),
      expected,
    );
    assert.equal(creates, 0);
  });
}

test("available Prompt API creates a session and progressively renders promptStreaming", async () => {
  const { env, createCalls } = availableEnvironment();
  const chunks = [];
  const answer = await askWithChromeBuiltInAi("explain this", (chunk) => chunks.push(chunk), { env });
  assert.equal(answer, "本機回答");
  assert.deepEqual(chunks, ["本", "機回答"]);
  assert.equal(createCalls(), 1);
});

test("uses prompt only when promptStreaming is not exposed", async () => {
  const chunks = [];
  const answer = await askWithChromeBuiltInAi("question", (chunk) => chunks.push(chunk), { env: {
    LanguageModel: {
      async availability() { return "available"; },
      async create() { return { async prompt() { return "non-stream answer"; } }; },
    },
  } });
  assert.equal(answer, "non-stream answer");
  assert.deepEqual(chunks, ["non-stream answer"]);
});

test("Traditional Chinese uses feature-detected on-device translators in both directions", async () => {
  const translations = [];
  const translator = {
    async availability() { return "available"; },
    async create({ sourceLanguage, targetLanguage }) {
      return { async translate(value) { translations.push([sourceLanguage, targetLanguage, value]); return sourceLanguage === "zh-Hant" ? "English question" : "繁中答案"; } };
    },
  };
  const { env } = availableEnvironment({ chunks: ["English answer"], translator });
  const rendered = [];
  assert.equal(await askWithChromeBuiltInAi("請解釋這題", (chunk) => rendered.push(chunk), { env }), "繁中答案");
  assert.deepEqual(translations, [["zh-Hant", "en", "請解釋這題"], ["en", "zh-Hant", "English answer"]]);
  assert.deepEqual(rendered, ["繁中答案"]);
});

test("Translator absence does not block a native Prompt API answer", async () => {
  const { env } = availableEnvironment({ chunks: ["直接繁中回答"] });
  assert.equal(await askWithChromeBuiltInAi("繁中問題", () => {}, { env }), "直接繁中回答");
});

test("duplicate submits and cancellation fail closed", async () => {
  let release;
  const submitter = createAutoSubmitter({ LanguageModel: {
    async availability() { return "available"; },
    async create() { return { promptStreaming: async function* () { await new Promise((resolve) => { release = resolve; }); yield "late"; } }; },
  } });
  const first = submitter.submit("first", () => {});
  await assert.rejects(() => submitter.submit("second", () => {}), /處理中/);
  submitter.cancel();
  release();
  await assert.rejects(first, ChromeAiError);
});

test("browser AI errors never fall back to a network service", async () => {
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = async () => { networkCalls += 1; return Response.json({ answer: "not allowed" }); };
  try {
    await assert.rejects(() => askWithChromeBuiltInAi("question", () => {}, { env: { LanguageModel: { async availability() { return "available"; }, async create() { throw new Error("device error"); } } } }), /未使用其他 AI 服務/);
    assert.equal(networkCalls, 0);
  } finally { globalThis.fetch = originalFetch; }
});

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]);
}

test("client source and built bundle contain no cloud-AI endpoint or key dependency", () => {
  const source = readFileSync(new URL("../app/chrome-built-in-ai.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /GEMINI_API_KEY|generativelanguage\.googleapis\.com|guest-ask/);
  const dist = join(process.cwd(), "dist");
  assert.ok(existsSync(dist), "build must run before this test");
  const bundle = files(dist).map((file) => readFileSync(file, "utf8")).join("\n");
  assert.doesNotMatch(bundle, /GEMINI_API_KEY|generativelanguage\.googleapis\.com/);
});
