import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGoogleAiModeUrl,
  createAutoFallbackGuard,
  hasUnresolvedSimplified,
  normalizeToHant,
  validateLocalAnswer,
} from "../app/auto-fallback.ts";
import { SIMPLIFIED_ONLY } from "../app/hant-set.ts";
import { createAutoSubmitter } from "../app/chrome-built-in-ai.ts";

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
