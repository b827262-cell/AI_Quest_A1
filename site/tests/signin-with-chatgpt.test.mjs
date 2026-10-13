import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync(new URL("../app/signin-with-chatgpt/page.tsx", import.meta.url), "utf8");

test("signin-with-chatgpt page provides the required learning, recovery, and auth-blocked affordances", () => {
  assert.match(page, /使用 ChatGPT 繼續/);
  assert.match(page, /本頁學習重點/);
  assert.match(page, /返回首頁/);
  assert.match(page, /AI 輔助理解題目與觀念/);
  assert.match(page, /練習與解題：先思考/);
  assert.match(page, /本機 AI 可協助出題與初步學習，完整詳解可接 Google AI/);
  assert.match(page, /自主判斷 AI 回答/);
  assert.match(page, /隱私安全與本機／雲端差異/);
  assert.match(page, /登入後接續 AI-Quest 學習流程/);
  assert.match(page, /取消登入/);
  assert.match(page, /登入暫時沒有完成/);
  assert.match(page, /role="alert"/);
  assert.match(page, /AUTH_BLOCKED/);
  assert.doesNotMatch(page, /chatGPTSignInPath/);
  assert.doesNotMatch(page, /(?:client_secret|access_token|refresh_token|api[_-]?key)\s*[:=]/i);
});
