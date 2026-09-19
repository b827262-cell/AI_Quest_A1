import assert from "node:assert/strict";
import test from "node:test";

const { CONTENT_SECURITY_POLICY, withSecurityHeaders } = await import("../app/security/csp.ts");

test("CSP permits the exact CDN, Hugging Face, and WASM execution paths used by local fallback", () => {
  assert.match(CONTENT_SECURITY_POLICY, /connect-src[^;]*https:\/\/cdn\.jsdelivr\.net/);
  assert.match(CONTENT_SECURITY_POLICY, /connect-src[^;]*https:\/\/huggingface\.co/);
  assert.match(CONTENT_SECURITY_POLICY, /connect-src[^;]*https:\/\/\*\.hf\.co/);
  assert.match(CONTENT_SECURITY_POLICY, /script-src[^;]*'wasm-unsafe-eval'/);
  assert.match(CONTENT_SECURITY_POLICY, /worker-src 'self' blob:/);
  assert.doesNotMatch(CONTENT_SECURITY_POLICY, /script-src[^;]*'unsafe-eval'/);
});

test("CSP is attached without discarding the application response", async () => {
  const response = withSecurityHeaders(new Response("ok", { status: 201, headers: { "x-test": "yes" } }));
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("x-test"), "yes");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("content-security-policy"), CONTENT_SECURITY_POLICY);
  assert.equal(await response.text(), "ok");
});
