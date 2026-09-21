import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGoogleAiModeUrl,
  createAutoFallbackGuard,
  validateLocalAnswer,
} from "../app/auto-fallback.ts";

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
  assert.equal(validateLocalAnswer("問題", "这里有一个未转换字符龙").reason, "unresolved-simplified");
  const converted = validateLocalAnswer("問題", "这是一个学习问题的回答。" );
  assert.equal(converted.status, "VALID");
  assert.match(converted.answer, /這是一個學習問題/);
});

test("cancelled flow cannot navigate or restart the same submission", () => {
  const guard = createAutoFallbackGuard();
  guard.begin(); guard.cancel();
  assert.equal(guard.navigateOnce(), false);
  assert.equal(guard.begin(), false);
});
