import assert from "node:assert/strict";
import test from "node:test";

const { CONTENT_SECURITY_POLICY, withSecurityHeaders } = await import("../app/security/csp.ts");

test("CSP permits the exact CDN, Hugging Face, and WASM execution paths used by local fallback", () => {
  const ortLoader = new URL("https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.0-dev.20260914-8d85527a0/dist/ort.min.mjs");
  const ortWasm = new URL("https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.0-dev.20260914-8d85527a0/dist/ort-wasm-simd-threaded.asyncify.wasm");
  const scriptSrc = CONTENT_SECURITY_POLICY.match(/script-src([^;]*)/)?.[1] ?? "";
  const connectSrc = CONTENT_SECURITY_POLICY.match(/connect-src([^;]*)/)?.[1] ?? "";
  assert.ok(scriptSrc.includes(ortLoader.origin), "script-src must permit the ORT .mjs dynamic import");
  assert.ok(connectSrc.includes(ortWasm.origin), "connect-src must permit the ORT .wasm fetch");
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
