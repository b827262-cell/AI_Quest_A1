import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  LOCAL_MODEL_CACHE_SCHEMA_VERSION,
  cacheKey,
  createModelCacheFetch,
  deleteLocalModelCache,
  ensureLocalModelCache,
  probeLocalModelCache,
  readManifest,
  verifyAsset,
} from "../app/local-model-cache.ts";

const IDENTITY = { modelId: "onnx-community/Qwen3-0.6B-ONNX", revision: "revA" };
const URL_A = "https://hf.example/model_q4f16.onnx";
const URL_B = "https://hf.example/tokenizer.json";

function manifestKeyOf(identity) {
  return `https://local-cache.invalid/meta/${encodeURIComponent(`${identity.modelId}@${identity.revision}`)}.json`;
}

function bytesFor(url, size) {
  const fill = url === URL_A ? 7 : 13;
  return new Uint8Array(size).fill(fill);
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** In-memory Cache API stand-in that reconstructs a fresh Response per match. */
function makeCache() {
  const store = new Map();
  const cache = {
    store,
    failPut: null,
    async match(request) {
      const entry = store.get(request);
      if (!entry) return undefined;
      return new Response(entry.bytes.slice(), {
        status: entry.status,
        headers: entry.headers,
      });
    },
    async put(request, response) {
      if (cache.failPut && cache.failPut(request)) {
        throw new DOMException("quota exceeded", "QuotaExceededError");
      }
      const buffer = await response.arrayBuffer();
      store.set(request, {
        bytes: new Uint8Array(buffer),
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
      });
    },
    async delete(request) {
      return store.delete(request);
    },
  };
  return cache;
}

function makeStorage(usage = 618_000_000) {
  return {
    async estimate() {
      return { usage, quota: 2_000_000_000 };
    },
    async persisted() {
      return true;
    },
    async persist() {
      return true;
    },
  };
}

async function seedAsset(cache, identity, url, size) {
  const body = bytesFor(url, size);
  await cache.put(cacheKey(identity, url), new Response(body));
  return body;
}

async function seedManifest(cache, identity, assets, revision = identity.revision, schema = LOCAL_MODEL_CACHE_SCHEMA_VERSION) {
  const record = {
    schemaVersion: schema,
    modelId: identity.modelId,
    revision,
    updatedAt: new Date().toISOString(),
    assets,
  };
  await cache.put(
    manifestKeyOf(identity),
    new Response(JSON.stringify(record), { headers: { "content-type": "application/json" } }),
  );
}

function makeFetch(handler) {
  const calls = [];
  const fn = async (input) => {
    const url = typeof input === "string" ? input : input.url;
    calls.push(url);
    return handler(url, calls.length);
  };
  fn.calls = calls;
  return fn;
}

test("model Cache API key is revision-qualified and keeps the original artifact URL opaque", () => {
  const asset = "https://huggingface.co/onnx-community/Qwen3-0.6B-ONNX/resolve/main/onnx/model_q4f16.onnx";
  const key = cacheKey({ modelId: "onnx-community/Qwen3-0.6B-ONNX", revision: "abc123" }, asset);
  assert.match(key, /^https:\/\/local-cache\.invalid\/asset\//);
  assert.match(key, /onnx-community%2FQwen3-0\.6B-ONNX%40abc123/);
  assert.match(key, /model_q4f16\.onnx/);
  assert.notEqual(key, cacheKey({ modelId: "onnx-community/Qwen3-0.6B-ONNX", revision: "next" }, asset));
});

test("verifyAsset checks real bytes, not just presence (size mismatch = corrupt)", async () => {
  const cache = makeCache();
  await seedAsset(cache, IDENTITY, URL_A, 100); // only 100 bytes cached
  const declared = { url: URL_A, expectedBytes: 600_000_000 };
  const result = await verifyAsset(IDENTITY, declared, { cache });
  assert.equal(result.state, "corrupt");
  assert.equal(result.bytes, 100);
});

test("verifyAsset detects content corruption via SHA-256 at the correct size", async () => {
  const cache = makeCache();
  await seedAsset(cache, IDENTITY, URL_A, 128); // real bytes are fill(7)
  const wrongDigest = sha256Hex(bytesFor("other", 128)); // same length, different content
  const result = await verifyAsset(IDENTITY, { url: URL_A, expectedBytes: 128, digest: wrongDigest }, { cache });
  assert.equal(result.state, "corrupt");
  const okDigest = sha256Hex(bytesFor(URL_A, 128));
  const ok = await verifyAsset(IDENTITY, { url: URL_A, expectedBytes: 128, digest: okDigest }, { cache });
  assert.equal(ok.state, "ok");
});

test("probe verifies full integrity on page open and aggregates artifact bytes (warm)", async () => {
  const cache = makeCache();
  const a = await seedAsset(cache, IDENTITY, URL_A, 300);
  const b = await seedAsset(cache, IDENTITY, URL_B, 200);
  await seedManifest(cache, IDENTITY, [
    { url: URL_A, expectedBytes: 300, digest: sha256Hex(a) },
    { url: URL_B, expectedBytes: 200, digest: sha256Hex(b) },
  ]);
  const state = await probeLocalModelCache(IDENTITY, { cache, storage: makeStorage() });
  assert.equal(state.supported, true);
  assert.equal(state.complete, true);
  assert.equal(state.stale, false);
  assert.equal(state.revisionMatches, true);
  assert.equal(state.presentCount, 2);
  assert.equal(state.missingCount, 0);
  assert.equal(state.corruptCount, 0);
  assert.equal(state.totalBytes, 500);
  assert.equal(state.usage, 618_000_000);
  assert.equal(state.persisted, true);
});

test("probe reports missing and corrupt artifacts without any network request", async () => {
  const cache = makeCache();
  await seedAsset(cache, IDENTITY, URL_A, 300);
  // manifest declares A (ok, wrong expected size => corrupt) + B (never downloaded => missing)
  await seedManifest(cache, IDENTITY, [
    { url: URL_A, expectedBytes: 999 },
    { url: URL_B, expectedBytes: 200 },
  ]);
  const state = await probeLocalModelCache(IDENTITY, { cache });
  assert.equal(state.complete, false);
  assert.equal(state.corruptCount, 1);
  assert.equal(state.missingCount, 1);
});

test("probe flags version drift (revision / schema change) as stale, not complete", async () => {
  const cache = makeCache();
  await seedAsset(cache, IDENTITY, URL_A, 300);
  await seedManifest(cache, IDENTITY, [{ url: URL_A, expectedBytes: 300 }], "OLD-REV");
  let state = await probeLocalModelCache(IDENTITY, { cache });
  assert.equal(state.revisionMatches, false);
  assert.equal(state.stale, true);
  assert.equal(state.complete, false);

  const cache2 = makeCache();
  await seedAsset(cache2, IDENTITY, URL_A, 300);
  await seedManifest(cache2, IDENTITY, [{ url: URL_A, expectedBytes: 300 }], IDENTITY.revision, 1);
  state = await probeLocalModelCache(IDENTITY, { cache: cache2 });
  assert.equal(state.stale, true, "lower schema version must be treated as stale");
});

test("warm auto-load returns cached bytes with NO network GET", async () => {
  const cache = makeCache();
  await seedAsset(cache, IDENTITY, URL_A, 300);
  const network = makeFetch(() => {
    throw new Error("network must not be hit for a warm cache entry");
  });
  const fetchImpl = createModelCacheFetch(IDENTITY, network, { cache });
  const response = await fetchImpl(URL_A);
  const body = await response.arrayBuffer();
  assert.equal(body.byteLength, 300);
  assert.equal(network.calls.length, 0);
});

test("createModelCacheFetch repairs a missing entry and records measured bytes", async () => {
  const cache = makeCache();
  const network = makeFetch(() => new Response(bytesFor(URL_A, 300)));
  const stored = [];
  const fetchImpl = createModelCacheFetch(IDENTITY, network, { cache }, (asset) => stored.push(asset));
  await fetchImpl(URL_A);
  assert.equal(network.calls.length, 1);
  assert.deepEqual(stored[0], { url: URL_A, expectedBytes: 300, digest: undefined });
  // second call is now warm: no additional GET
  await fetchImpl(URL_A);
  assert.equal(network.calls.length, 1);
});

test("ensure downloads a fresh model (background, non-blocking, streams progress)", async () => {
  const cache = makeCache();
  const network = makeFetch((url) => new Response(bytesFor(url, url === URL_A ? 300 : 200)));
  const progress = [];
  const result = await ensureLocalModelCache({
    identity: IDENTITY,
    assets: [
      { url: URL_A, expectedBytes: 300 },
      { url: URL_B, expectedBytes: 200 },
    ],
    env: { cache, fetch: network },
    onProgress: (p) => progress.push(p.status),
  });
  assert.equal(result.status, "downloaded");
  assert.equal(result.downloadedCount, 2);
  assert.equal(result.totalBytes, 500);
  assert.deepEqual(progress.filter((s) => s === "stored"), ["stored", "stored"]);
  const state = await probeLocalModelCache(IDENTITY, { cache });
  assert.equal(state.complete, true);
});

test("ensure is warm: verified assets are skipped with zero network GET", async () => {
  const cache = makeCache();
  await seedManifest(cache, IDENTITY, []); // ensure rewrites manifest
  await seedAsset(cache, IDENTITY, URL_A, 300);
  const network = makeFetch(() => {
    throw new Error("warm asset must not be re-fetched");
  });
  const result = await ensureLocalModelCache({
    identity: IDENTITY,
    assets: [{ url: URL_A, expectedBytes: 300 }],
    env: { cache, fetch: network },
  });
  assert.equal(result.status, "warm");
  assert.equal(result.downloadedCount, 0);
  assert.equal(network.calls.length, 0);
});

test("ensure retries transient failures then succeeds", async () => {
  const cache = makeCache();
  let attempt = 0;
  const network = makeFetch((url) => {
    attempt += 1;
    if (attempt === 1) throw new Error("ephemeral network error");
    return new Response(bytesFor(url, 300));
  });
  const result = await ensureLocalModelCache({
    identity: IDENTITY,
    assets: [{ url: URL_A, expectedBytes: 300 }],
    maxRetries: 3,
    env: { cache, fetch: network },
  });
  assert.equal(result.status, "downloaded");
  assert.equal(result.downloadedCount, 1);
  assert.ok(network.calls.length >= 2, "should have retried at least once");
});

test("ensure surfaces quota exhaustion as a graceful non-blocking result", async () => {
  const cache = makeCache();
  cache.failPut = (req) => req.startsWith("https://local-cache.invalid/asset/");
  const network = makeFetch((url) => new Response(bytesFor(url, 300)));
  const result = await ensureLocalModelCache({
    identity: IDENTITY,
    assets: [{ url: URL_A, expectedBytes: 300 }],
    env: { cache, fetch: network },
  });
  assert.equal(result.status, "quota");
  assert.equal(result.downloadedCount, 0);
});

test("ensure honours abort and keeps already-verified bytes", async () => {
  const cache = makeCache();
  const controller = new AbortController();
  const network = makeFetch((url) => {
    if (url === URL_A) return new Response(bytesFor(url, 300));
    controller.abort(); // user cancelled before the second asset
    throw new DOMException("Aborted", "AbortError");
  });
  const result = await ensureLocalModelCache({
    identity: IDENTITY,
    assets: [
      { url: URL_A, expectedBytes: 300 },
      { url: URL_B, expectedBytes: 200 },
    ],
    signal: controller.signal,
    env: { cache, fetch: network },
  });
  assert.equal(result.status, "aborted");
  assert.equal(result.downloadedCount, 1);
  const aState = await verifyAsset(IDENTITY, { url: URL_A, expectedBytes: 300 }, { cache });
  assert.equal(aState.state, "ok", "the completed asset must survive the abort");
});

test("F5 / new tab: a re-run resumes and never re-GETs the verified first asset", async () => {
  const cache = makeCache();
  const controller = new AbortController();
  const first = makeFetch((url) => {
    if (url === URL_A) return new Response(bytesFor(url, 300));
    controller.abort();
    throw new DOMException("Aborted", "AbortError");
  });
  await ensureLocalModelCache({
    identity: IDENTITY,
    assets: [
      { url: URL_A, expectedBytes: 300 },
      { url: URL_B, expectedBytes: 200 },
    ],
    signal: controller.signal,
    env: { cache, fetch: first },
  });
  // Simulate reload: brand-new signal + fetch spy over the SAME persistent cache.
  const resumed = makeFetch((url) => new Response(bytesFor(url, url === URL_A ? 300 : 200)));
  const result = await ensureLocalModelCache({
    identity: IDENTITY,
    assets: [
      { url: URL_A, expectedBytes: 300 },
      { url: URL_B, expectedBytes: 200 },
    ],
    env: { cache, fetch: resumed },
  });
  assert.equal(result.status, "downloaded");
  assert.equal(result.downloadedCount, 1);
  assert.equal(resumed.calls.includes(URL_A), false, "URL_A is verified warm and must not be re-fetched");
  assert.deepEqual(resumed.calls, [URL_B]);
  const state = await probeLocalModelCache(IDENTITY, { cache });
  assert.equal(state.complete, true);
});

test("readManifest tolerates legacy string-array manifests and delete is revision-scoped", async () => {
  const cache = makeCache();
  const other = { modelId: "other/model", revision: "r1" };
  await seedAsset(cache, IDENTITY, URL_A, 300);
  await seedAsset(cache, other, URL_B, 200);
  // legacy v1 manifest: assets as plain string[]
  await cache.put(
    manifestKeyOf(IDENTITY),
    new Response(JSON.stringify({ assets: [URL_A], updatedAt: "x" }), {
      headers: { "content-type": "application/json" },
    }),
  );
  const manifest = await readManifest(IDENTITY, { cache });
  assert.equal(manifest.assets.length, 1);
  assert.equal(manifest.assets[0].url, URL_A);
  assert.equal(manifest.assets[0].expectedBytes, 0);

  const removed = await deleteLocalModelCache(IDENTITY, { cache });
  assert.equal(removed, 1);
  assert.equal(cache.store.has(cacheKey(IDENTITY, URL_A)), false);
  assert.equal(cache.store.has(manifestKeyOf(IDENTITY)), false);
  assert.equal(cache.store.has(cacheKey(other, URL_B)), true, "other identity bytes must be untouched");
});

test("a 206 slice is served but never persisted; a 200 to the same request is", async () => {
  const cache = makeCache();
  const network = makeFetch(
    () => new Response(bytesFor(URL_A, 100), { status: 206, headers: { "content-range": "bytes 0-99/618000000" } }),
  );
  const fetchImpl = createModelCacheFetch(IDENTITY, network, { cache });
  const first = await fetchImpl(URL_A, { headers: { Range: "bytes=0-99" } });
  assert.equal((await first.arrayBuffer()).byteLength, 100, "the caller still gets the partial body");
  assert.equal(
    cache.store.has(cacheKey(IDENTITY, URL_A)),
    false,
    "a truncated slice must never become a warm entry under the full-artifact key",
  );
  await fetchImpl(URL_A);
  assert.equal(network.calls.length, 2, "nothing was poisoned, so the next read still goes to the network");

  // A compliant server answers a Range request with 200 + the whole resource;
  // that must still be cached, or ranged artifact loads would never warm up.
  const whole = makeFetch(() => new Response(bytesFor(URL_A, 300), { status: 200 }));
  const rangedCache = makeCache();
  const rangedImpl = createModelCacheFetch(IDENTITY, whole, { cache: rangedCache });
  const stored = await rangedImpl(URL_A, { headers: { Range: "bytes=0-" } });
  assert.equal((await stored.arrayBuffer()).byteLength, 300);
  assert.equal(rangedCache.store.has(cacheKey(IDENTITY, URL_A)), true);
  await rangedImpl(URL_A);
  assert.equal(whole.calls.length, 1, "the whole body replays from cache with zero re-GET");
});

test("warm replay drops transport headers so decoded bytes are not decoded twice", async () => {
  const cache = makeCache();
  const network = makeFetch(
    () =>
      new Response(bytesFor(URL_A, 300), {
        headers: {
          "content-type": "application/octet-stream",
          "content-encoding": "gzip",
          "content-length": "118",
          "transfer-encoding": "chunked",
        },
      }),
  );
  const fetchImpl = createModelCacheFetch(IDENTITY, network, { cache });
  await fetchImpl(URL_A);

  const stored = cache.store.get(cacheKey(IDENTITY, URL_A));
  assert.ok(stored, "the whole 200 body is persisted");
  assert.equal(stored.headers["content-encoding"], undefined, "body is stored decoded, not gzip");
  assert.equal(stored.headers["content-length"], undefined, "stale length must not outlive the body");
  assert.equal(stored.headers["transfer-encoding"], undefined);
  assert.equal(stored.headers["content-type"], "application/octet-stream", "content metadata is preserved");
  assert.equal(stored.bytes.byteLength, 300);

  const warm = await fetchImpl(URL_A);
  assert.equal((await warm.arrayBuffer()).byteLength, 300);
  assert.equal(warm.headers.get("content-encoding"), null);
  assert.equal(network.calls.length, 1, "the sanitized entry replays with zero re-GET");
});

test("an unreadable warm entry falls back to the network instead of failing the load", async () => {
  const cache = makeCache();
  await seedAsset(cache, IDENTITY, URL_A, 300);
  cache.match = async () => {
    throw new DOMException("read failed");
  };
  const network = makeFetch(() => new Response(bytesFor(URL_A, 300)));
  const fetchImpl = createModelCacheFetch(IDENTITY, network, { cache });
  const response = await fetchImpl(URL_A);
  assert.equal((await response.arrayBuffer()).byteLength, 300);
  assert.equal(network.calls.length, 1);
});

test("ensure fails closed on a 206 instead of persisting a truncated model file", async () => {
  const cache = makeCache();
  const network = makeFetch(
    () => new Response(bytesFor(URL_A, 100), { status: 206 }),
  );
  const result = await ensureLocalModelCache({
    identity: IDENTITY,
    assets: [{ url: URL_A, expectedBytes: 0 }],
    env: { cache, fetch: network },
  });
  assert.equal(result.status, "failed");
  assert.equal(result.downloadedCount, 0);
  assert.equal(result.failedCount, 1);
  assert.equal(cache.store.has(cacheKey(IDENTITY, URL_A)), false);
});
